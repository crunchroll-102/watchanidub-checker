// ================================================================
//  Watchanidubs — Site Monitor (har ghante)
//  - Site khul rahi hai ya nahi (DNS, HTTP, Blogger "blog removed")
//  - Site kisi doosre domain par redirect to nahi ho rahi
//  - SSL certificate aur domain registration expiry ka alert
//  - Koi published post achanak gayab ho jaye (DMCA / draft) to alert
// ================================================================
const admin = require('firebase-admin');
const tls = require('tls');
const dns = require('dns').promises;

const ENV = process.env;
const BLOG_URL = (ENV.BLOG_URL || '').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DAY = 86400e3;
const HOUR = 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

// Blogger jab blog band karta hai to yeh alfaaz page par hote hain
const REMOVED_WORDS = ['blog has been removed', 'blog has been deleted', 'sorry, the blog at', 'blog not found',
  'this blog is open to invited readers only', 'has been removed for violating'];

async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, body); return; }
  const msg = body.length > 3500 ? body.slice(0, 3450) + '\n... aur bhi hain' : body;
  const q = '?title=' + encodeURIComponent(title) + '&tags=' + encodeURIComponent(opts.tags || 'bell') +
            '&priority=' + (opts.priority || 'default') + (opts.click ? '&click=' + encodeURIComponent(opts.click) : '');
  try { const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC + q, { method: 'POST', body: msg }); console.log('ntfy', r.status, title); }
  catch (e) { console.log('ntfy error:', e.message); }
}

async function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal }, opts)); }
  finally { clearTimeout(timer); }
}

// ---------------- 1. Site up / DNS / redirect ----------------
async function checkSite(host) {
  try { await dns.lookup(host); }
  catch (e) {
    await sleep(20000);
    try { await dns.lookup(host); }
    catch (e2) { return { ok: false, reason: 'DNS kaam nahi kar raha (domain expire ho gaya ya DNS settings badal gayi): ' + (e2.code || e2.message) }; }
  }
  let last = '';
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetchT(BLOG_URL + '/', { redirect: 'follow', headers: { 'User-Agent': UA } });
      const finalHost = new URL(r.url).hostname;
      const body = (await r.text()).toLowerCase();
      if (bare(finalHost) !== bare(host)) {
        return { ok: false, reason: `Site doosre domain par redirect ho rahi hai: ${finalHost}\nYeh domain hijack ya DNS change ho sakta hai.` };
      }
      const rm = REMOVED_WORDS.find((w) => body.includes(w));
      if (rm) return { ok: false, reason: `Blogger page keh raha hai: "${rm}"\nBlogger dashboard aur Gmail foran check karo.` };
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      if (body.length < 500) throw new Error('page lagbhag khali hai');
      return { ok: true };
    } catch (e) {
      last = e.name === 'AbortError' ? 'timeout (20 sec)' : String(e.message || e);
      if (t < 3) await sleep(30000);
    }
  }
  return { ok: false, reason: last };
}

// ---------------- 2. SSL expiry ----------------
function sslExpiry(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(443, host, { servername: host, timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c && c.valid_to ? new Date(c.valid_to) : null);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------- 3. Domain expiry (RDAP) ----------------
function apexDomain(host) {
  const p = bare(host).split('.');
  if (p.length >= 3 && /^(com|net|org|edu|gov|co|ac)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
async function domainExpiry(host) {
  const r = await fetchT('https://rdap.org/domain/' + apexDomain(host), { redirect: 'follow', headers: { 'Accept': 'application/rdap+json, application/json' } }, 25000);
  if (!r.ok) throw new Error('RDAP HTTP ' + r.status);
  const j = await r.json();
  const ev = (j.events || []).find((e) => /expiration/i.test(e.eventAction || ''));
  return ev && ev.eventDate ? new Date(ev.eventDate) : null;
}

// expiry warning sirf in din par: pehli dafa jab har threshold cross ho
async function expiryAlert(st, key, name, date, thresholds) {
  const left = Math.ceil((date.getTime() - Date.now()) / DAY);
  const iso = date.toISOString().slice(0, 10);
  const rec = st[key] || {};
  if (rec.date !== iso) {                    // nayi date (renew hua ya pehli dafa)
    if (rec.date && rec.date < iso) await notify(`${name} renew ho gaya`, `Nayi expiry: ${iso} (${left} din baqi)`, { tags: 'white_check_mark', priority: 'low' });
    st[key] = { date: iso, lastTh: 9999 };
  }
  const th = thresholds.filter((t) => left <= t).sort((a, b) => a - b)[0];
  if (th !== undefined && th < st[key].lastTh) {
    const expired = left <= 0;
    await notify(expired ? `${name} EXPIRE ho chuka hai!` : `${name} ${left} din mein expire hoga`,
      `Expiry date: ${iso}\n${expired ? 'Foran renew karo, warna site band ho jaye gi.' : 'Waqt par renew kar lo.'}`,
      { tags: expired ? 'rotating_light' : 'warning', priority: (left <= 3 ? 'urgent' : 'high') });
    st[key].lastTh = th;
  }
  return left;
}

// ---------------- 4. Saari published posts ----------------
async function allPosts() {
  const out = {};
  let start = 1;
  for (let page = 0; page < 200; page++) {
    const url = `${BLOG_URL}/feeds/posts/summary?alt=json&max-results=150&start-index=${start}&_=${Date.now()}`;
    let f = null;
    for (let t = 1; t <= 3; t++) {
      try {
        const r = await fetchT(url, { headers: { 'User-Agent': UA } }, 30000);
        if (!r.ok) throw new Error('feed HTTP ' + r.status);
        f = (await r.json()).feed || {};
        break;
      } catch (e) { if (t === 3) throw e; await sleep(5000); }
    }
    const ents = f.entry || [];
    for (const e of ents) {
      const id = String((e.id && e.id.$t) || '').split('post-').pop();
      if (!id) continue;
      const alt = (e.link || []).find((l) => l.rel === 'alternate');
      out[id] = { t: String((e.title && e.title.$t) || '(no title)').slice(0, 150), u: alt ? alt.href : '' };
    }
    if (ents.length < 150) break;
    start += 150;
  }
  return out;
}

async function main() {
  if (!BLOG_URL) throw new Error('BLOG_URL secret missing');
  const host = new URL(BLOG_URL).hostname;
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const M = admin.database().ref('monitor');
  const st = (await M.child('state').get()).val() || {};
  const firstRun = !st.started;
  const summary = [];

  // ---- 1. site ----
  const site = await checkSite(host);
  if (!site.ok) {
    if (!st.downSince) {
      st.downSince = Date.now(); st.downNotified = Date.now();
      await notify('Site DOWN hai!', `${BLOG_URL}\n${site.reason}`, { tags: 'rotating_light', priority: 'urgent', click: BLOG_URL });
    } else if (Date.now() - st.downNotified > 6 * HOUR) {
      const h = Math.round((Date.now() - st.downSince) / HOUR);
      await notify('Site abhi bhi down hai', `${h} ghante se down\n${site.reason}`, { tags: 'rotating_light', priority: 'high', click: BLOG_URL });
      st.downNotified = Date.now();
    }
    console.log('SITE DOWN:', site.reason);
  } else {
    if (st.downSince) {
      const m = Math.max(1, Math.round((Date.now() - st.downSince) / 60000));
      await notify('Site wapis chal padi', `Takreeban ${m} minute down rahi.`, { tags: 'white_check_mark' });
      st.downSince = 0;
    }
    console.log('Site OK');
    summary.push('Site: chal rahi hai');
  }

  // ---- 2. SSL ----
  try {
    const exp = await sslExpiry(host);
    if (exp) { const d = await expiryAlert(st, 'ssl', 'SSL certificate', exp, [10, 3, 1]); summary.push(`SSL: ${d} din baqi`); console.log('SSL days left', d); }
  } catch (e) { console.log('SSL check error:', e.message); }

  // ---- 3. Domain ----
  if (!/\.blogspot\.com$/i.test(host)) {
    try {
      const exp = await domainExpiry(host);
      if (exp) { const d = await expiryAlert(st, 'domain', 'Domain', exp, [30, 14, 7, 3, 1]); summary.push(`Domain: ${d} din baqi`); console.log('Domain days left', d); }
      else throw new Error('expiry date nahi mili');
    } catch (e) {
      console.log('Domain check error:', e.message);
      if (!st.rdapWarned) {
        await notify('Domain expiry ka automatic check nahi ho saka',
          `${apexDomain(host)} ki expiry date online nahi mil saki (${e.message}). Registrar ki website se date dekh kar khud yaad rakhna.`, { tags: 'information_source', priority: 'low' });
        st.rdapWarned = 1;
      }
    }
  }

  // ---- 4. Posts (sirf jab site chal rahi ho) ----
  if (site.ok) {
    try {
      const now = await allPosts();
      const prev = (await M.child('posts').get()).val();
      const n = Object.keys(now).length;
      if (!prev) {
        await M.child('posts').set(now);
        console.log('Post list pehli dafa save hui:', n);
      } else {
        const prevN = Object.keys(prev).length;
        const missing = Object.keys(prev).filter((id) => !now[id]);
        if (missing.length > 5 && n < prevN * 0.5) {
          // bohot saari posts ek saath gayab: feed masla ya blog par bara action. List overwrite nahi karte.
          if (!st.massWarned || Date.now() - st.massWarned > 6 * HOUR) {
            await notify('Site ki posts bohot kam dikh rahi hain!',
              `Pehle ${prevN} posts thi, abhi sirf ${n} nazar aa rahi hain.\nBlogger dashboard aur Gmail foran check karo.`, { tags: 'rotating_light', priority: 'urgent' });
            st.massWarned = Date.now();
          }
        } else {
          st.massWarned = 0;
          if (missing.length) {
            await notify(`${missing.length} post site se hat gayi`,
              missing.map((id) => `• ${prev[id].t}\n  ${prev[id].u}`).join('\n') +
              '\n\nAgar aapne khud draft ya delete nahi ki, to Blogger dashboard aur Gmail check karo (DMCA ho sakta hai).',
              { tags: 'rotating_light', priority: 'high', click: (prev[missing[0]] || {}).u || BLOG_URL });
          }
          await M.child('posts').set(now);
        }
        console.log(`Posts: ${n} (pehle ${prevN}), gayab: ${missing.length}`);
      }
      summary.push(`Posts: ${n}`);
    } catch (e) { console.log('Post check error:', e.message); }
  }

  if (firstRun) {
    await notify('Site monitor chalu ho gaya', summary.join('\n') + '\n\nAb har ghante check hoga.', { tags: 'white_check_mark' });
    st.started = Date.now();
  }
  st.lastRun = Date.now();
  await M.child('state').set(st);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Site monitor FAIL hua', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
