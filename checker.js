// ================================================================
//  Watchanidubs — Daily Video Link Checker (v2, theme-matched)
//  - Theme ke "ms-data" JSON se har episode ke har server ka link
//    nikalta hai (Season / Episode / Language / Server ke sath)
//  - Har link kholta hai, deleted video pakadta hai
//  - Dead link ko Firebase "rep/" me usi format me likhta hai jo
//    Studio > Link Health me dikhta hai (Fix link button ke sath)
//  - Naya dead link milte hi ntfy alert, aur roz ek daily report
//    (sab theek ho tab bhi)
// ================================================================
const admin = require('firebase-admin');

// ---------------- SETTINGS ----------------
const DEAD_WORDS = [
  'file not found',
  'file was deleted',
  'file has been deleted',
  'video not found',
  'video was deleted',
  'video has been deleted',
  'video is not available',
  'this video does not exist',
  'no longer available',
  'has been removed',
  'not found or deleted'
];
const FEED_PAGE_SIZE = 150;
const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;
// ------------------------------------------

const ENV = process.env;
const BLOG_URL = (ENV.BLOG_URL || '').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const TEST_URL = (ENV.TEST_URL || '').trim();
const FORCE = (ENV.FORCE || '') === 'true';            // manual run: aaj dobara poora check
const RUN_MINUTES = parseInt(ENV.RUN_MINUTES || '40', 10);
const START_HOUR = parseInt(ENV.START_HOUR || '9', 10); // Pakistan time, roz isi waqt se check shuru
const TZ_HOURS = 5;                                     // Pakistan UTC+5
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkNow = () => new Date(Date.now() + TZ_HOURS * 3600e3);
const pkDate = () => pkNow().toISOString().slice(0, 10);
const pkHour = () => pkNow().getUTCHours();

// ---- theme ke functions ki hubahu copy (taake keys Studio se match karein) ----
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
const sClean = (v) => String(v || '').replace(/[^A-Za-z0-9 &().,'+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
const kSafe = (s) => String(s).replace(/[^A-Za-z0-9-]/g, '_').slice(0, 40);
const hash36 = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
const okUrl = (x) => /^https?:\/\/[^\s"'<>]+$/i.test(x || '');

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// theme ka msJson(): post ke text se {"v"... } wala JSON nikalo
function msJson(html) {
  let t = decodeEntities(String(html || '').replace(/<[^>]*>/g, ''));
  t = t.replace(/[\u00a0\u200b\u2028\u2029]/g, ' ');
  const i = t.indexOf('{"v"'), k = t.lastIndexOf('}');
  if (i < 0 || k < i) return null;
  const c = t.slice(i, k + 1);
  try { return JSON.parse(c); } catch (e) {}
  try { return JSON.parse(c.replace(/[\u201c\u201d]/g, '"')); } catch (e) { return null; }
}

// ek post se saare episode-server links
function linksFromPost(entry) {
  const title = (entry.title && entry.title.$t) || '';
  const html = (entry.content && entry.content.$t) || '';
  const alt = (entry.link || []).find((l) => l.rel === 'alternate');
  const post = alt ? alt.href : BLOG_URL;
  const j = msJson(html);
  if (!j || j.k || !title) return { id: null, items: [] };   // site / bg / block / page posts skip
  const id = j.id || slug(title);
  const movie = j.t === 'Movie';
  const items = [];
  Object.keys(j.s || {}).forEach((sk) => {
    const season = sClean(sk) || '1';
    (j.s[sk] || []).forEach((sv, i) => {
      (sv || []).forEach((x) => {
        if (!x || x[4]) return;                // "Off" server skip
        const u = String(x[1] || '').trim();
        if (!okUrl(u)) return;
        items.push({
          key: kSafe(id) + '~' + kSafe(season) + '~' + (i + 1) + '~' + hash36(u),
          a: id, s: season, e: String(i + 1), sv: String(x[0] || 'Server').slice(0, 60),
          lg: String(x[2] || '').slice(0, 60), u, title, post, movie
        });
      });
    });
  });
  return { id, items };
}

const label = (d) => `${d.title}${d.movie ? '' : ` S${d.s} E${d.e}`} · ${d.lg ? d.lg + ' · ' : ''}${d.sv}`;

async function checkUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                 'Accept-Language': 'en-US,en;q=0.9', 'Referer': (BLOG_URL || 'https://www.google.com') + '/' }
    });
    if (res.status === 404 || res.status === 410) return { state: 'dead', reason: 'HTTP ' + res.status };
    if (res.status >= 400) return { state: 'unknown', reason: 'HTTP ' + res.status };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (/video|mpegurl|octet-stream/.test(ct)) {           // direct mp4/m3u8: poori file download na karo
      try { await res.body.cancel(); } catch (e) {}
      return { state: 'ok', reason: 'direct video' };
    }
    const html = (await res.text()).toLowerCase();
    const hit = DEAD_WORDS.find((w) => html.includes(w));
    if (hit) return { state: 'dead', reason: 'page says "' + hit + '"' };
    return { state: 'ok', reason: 'HTTP ' + res.status };
  } catch (e) {
    return { state: 'unknown', reason: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

async function fetchFeedPage(startIndex) {
  const url = `${BLOG_URL}/feeds/posts/default?alt=json&orderby=published&max-results=${FEED_PAGE_SIZE}&start-index=${startIndex}&_=${Date.now()}`;
  for (let t = 1; t <= 3; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('Blogger feed HTTP ' + res.status);
      const feed = (await res.json()).feed || {};
      return { entries: feed.entry || [], total: parseInt((feed['openSearch$totalResults'] || {}).$t || '0', 10) };
    } catch (e) { if (t === 3) throw e; await sleep(5000); }
  }
}

async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) return;
  const msg = body.length > 3500 ? body.slice(0, 3450) + '\n... aur bhi hain (Studio > Link Health dekhein)' : body;
  const q = '?title=' + encodeURIComponent(title) + '&tags=' + encodeURIComponent(opts.tags || 'bell') +
            '&priority=' + (opts.priority || 'default') + (opts.click ? '&click=' + encodeURIComponent(opts.click) : '');
  try { const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC + q, { method: 'POST', body: msg }); console.log('ntfy', r.status); }
  catch (e) { console.log('ntfy error:', e.message); }
}

async function main() {
  if (TEST_URL) {
    const r = await checkUrl(TEST_URL);
    console.log('TEST RESULT =>', r.state.toUpperCase(), '|', r.reason, '|', TEST_URL);
    return;
  }
  if (!BLOG_URL) throw new Error('BLOG_URL secret missing');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const db = admin.database();
  const LC = db.ref('linkChecker');
  const REP = db.ref('rep');

  let st = (await LC.child('state').get()).val() || {};
  const today = pkDate();
  let cursor = st.cursor || 1;

  // ---- naya daily cycle shuru karna hai ya nahi ----
  if (cursor === 1) {
    if (!FORCE && st.lastDoneDate === today) { console.log('Aaj ka poora check ho chuka hai. Kal phir.'); return; }
    if (!FORCE && pkHour() < START_HOUR) { console.log(`Abhi ${START_HOUR} baje (PK) se pehle ka waqt hai, intezar.`); return; }
    st = { cursor: 1, cycleStart: Date.now(), cycleDate: today, lastDoneDate: st.lastDoneDate || '',
           lastProgress: '', stats: { posts: 0, links: 0, ok: 0, dead: 0, unknown: 0, newDead: 0, fixed: 0 } };
    console.log('Naya daily check shuru:', today);
  }
  const S = st.stats;
  const deadMap = (await LC.child('dead').get()).val() || {};
  const results = new Map();               // same URL ek hi baar check ho
  const newlyDead = [], fixedList = [];
  const deadline = T0 + RUN_MINUTES * 60e3;
  let wrapped = false, total = 0;

  const checkCached = async (u) => {
    if (!results.has(u)) results.set(u, (async () => {
      let r = await checkUrl(u);
      if (r.state === 'dead') { await sleep(10000); r = await checkUrl(u); }   // double check
      return r;
    })());
    return results.get(u);
  };

  async function clearDead(k, replaced) {
    const rec = deadMap[k]; delete deadMap[k];
    if (!replaced) fixedList.push(rec); else S.fixed++;
    await LC.child('dead/' + k).remove();
    const ex = (await REP.child(k).get()).val();
    if (ex && String(ex.w || '').startsWith('Auto-check')) await REP.child(k).remove();
  }
  while (Date.now() < deadline) {
    const page = await fetchFeedPage(cursor);
    total = page.total;
    if (!page.entries.length) { wrapped = true; break; }

    const posts = page.entries.map(linksFromPost);
    let next = 0, stopAt = posts.length;
    const worker = async () => {
      while (true) {
        if (Date.now() >= deadline) { stopAt = Math.min(stopAt, next); return; }
        const pi = next++; if (pi >= posts.length) return;
        const P = posts[pi];
        const cur = new Set(P.items.map((x) => x.key));
        for (const it of P.items) {
          const r = await checkCached(it.u);
          S.links++;
          if (r.state === 'dead') {
            S.dead++;
            if (!deadMap[it.key]) {
              const rec = { a: it.a, s: it.s, e: it.e, sv: it.sv, lg: it.lg, u: it.u, title: it.title,
                            post: it.post, movie: it.movie ? 1 : 0, reason: r.reason, since: Date.now() };
              deadMap[it.key] = rec; newlyDead.push(rec); S.newDead++;
              await LC.child('dead/' + it.key).set(rec);
              const ex = (await REP.child(it.key).get()).val();
              if (!ex) await REP.child(it.key).set({ a: it.a.slice(0, 100), s: it.s, e: it.e, sv: it.sv, lg: it.lg,
                u: it.u.slice(0, 600), w: ('Auto-check: ' + r.reason).slice(0, 240), m: 2, n: 1,
                t: admin.database.ServerValue.TIMESTAMP });
            }
            console.log('DEAD    |', label(it), '|', r.reason, '|', it.u);
          } else if (r.state === 'ok') {
            S.ok++;
            if (deadMap[it.key]) await clearDead(it.key);
          } else {
            S.unknown++;
            console.log('UNKNOWN |', label(it), '|', r.reason, '|', it.u);
          }
        }
        // post me link badal diya gaya ho to purana dead record hatao
        if (P.id) for (const k of Object.keys(deadMap)) if (deadMap[k].a === P.id && !cur.has(k)) await clearDead(k, true);
        S.posts++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // workers posts ko order me uthate hain; stopAt se pehle wali sab poori ho chuki
    cursor += Math.min(stopAt, posts.length);
    if (stopAt >= posts.length && page.entries.length < FEED_PAGE_SIZE) { wrapped = true; break; }
    if (stopAt < posts.length) break;      // waqt khatam
  }
  S.fixed += fixedList.length;

  // ---- notifications ----
  if (newlyDead.length) {
    await notify(`${newlyDead.length} video link dead mila`,
      newlyDead.map((d) => `• ${label(d)}\n  ${d.reason}`).join('\n') +
      `\n\nStudio > Link Health me "Fix link" dabayein.`,
      { tags: 'rotating_light', priority: 'high', click: newlyDead[0].post });
  }
  if (fixedList.length) {
    await notify(`${fixedList.length} link dobara chal pade`, fixedList.map((d) => `• ${label(d)}`).join('\n'), { tags: 'white_check_mark', priority: 'low' });
  }

  const deadNow = Object.values(deadMap);
  if (wrapped) {
    const mins = Math.max(1, Math.round((Date.now() - st.cycleStart) / 60000));
    const head = `${S.posts} anime/movies · ${S.links} links · ${mins} min`;
    if (!deadNow.length) {
      await notify('Daily report: sab videos theek hain',
        `${head}\nOK: ${S.ok} · Check nahi ho sake: ${S.unknown}\nKoi dead link nahi.`, { tags: 'white_check_mark' });
    } else {
      await notify(`Daily report: ${deadNow.length} dead link abhi baqi`,
        `${head}\nOK: ${S.ok} · Dead: ${deadNow.length} · Check nahi ho sake: ${S.unknown}\n\n` +
        deadNow.slice(0, 40).map((d) => `• ${label(d)}`).join('\n'), { tags: 'warning', priority: 'high' });
    }
    st.lastDoneDate = today; st.cursor = 1;
  } else {
    st.cursor = cursor;
    // bohot bara site: cycle 1 din se lamba chal raha ho to roz progress bhejo
    if (Date.now() - st.cycleStart > 20 * 3600e3 && st.lastProgress !== today && pkHour() >= START_HOUR) {
      await notify('Daily report: check abhi jari hai',
        `${S.posts} of ~${total} posts check ho chuki · ${S.links} links\nDead: ${deadNow.length} · Check nahi ho sake: ${S.unknown}`, { tags: 'hourglass' });
      st.lastProgress = today;
    }
  }
  if (S.links >= 20 && S.unknown / S.links > 0.5 && !st.warnedUnknown) {
    await notify('Checker ko masla', `${S.unknown} of ${S.links} links check nahi ho sake (host block / slow). GitHub log dekhein.`, { tags: 'warning' });
    st.warnedUnknown = 1;
  }
  st.stats = S;
  await LC.child('state').set(st);
  await LC.child('lastRun').set({ at: Date.now(), cursor: st.cursor, totalPosts: total, deadNow: deadNow.length, stats: S });
  console.log(`Posts: ${S.posts} | Links: ${S.links} | OK: ${S.ok} | DEAD: ${deadNow.length} | UNKNOWN: ${S.unknown} | cycle complete: ${wrapped}`);
}

if (require.main === module) main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Link checker FAIL hua', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});

module.exports = { msJson, linksFromPost, hash36, kSafe, sClean, slug };
