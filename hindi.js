// ================================================================
//  Watchanidubs - Hindi Dub News Alerts v4 (HINDI, har ghante)
//
//  - 2 jagah se khabrein: Google News + Bing News
//    (ek block ho jaye to doosri se kaam chalta rahe)
//  - Sirf anime ki Hindi dub khabrein, Indian movies / serials filter
//  - Pehli run par pichle 3 din ki khabrein bhi bhejta hai (test ke liye)
//  - Manual "Run workflow" par hamesha ek status message aata hai
//  - Roz raat report: khabar na mile tab bhi pata chale system chal raha hai
//  - Sirf apna topic: watchanidubs-Hindi, har alert par [HINDI]
// ================================================================
const admin = require('firebase-admin');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const ENV = process.env;
const NTFY_SERVER = (ENV.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC_HINDI || 'watchanidubs-Hindi').trim();
const NTFY_TOKEN = (ENV.NTFY_TOKEN || '').trim();
const LABEL = '[HINDI] ';
const PRIORITY = (ENV.HINDI_PRIORITY || 'default').trim();
const EVERY_MIN = int(ENV.HINDI_EVERY_MIN, 55);     // kitne minute baad dobara check
const REPORT_HOUR = int(ENV.REPORT_HOUR, 21);       // roz raat report (PK time)
const FRESH_DAYS = int(ENV.FRESH_DAYS, 3);          // sirf itne din purani khabar tak
const FORCE = (ENV.FORCE || '') === 'true';         // manual run: abhi check + status message
const QUERIES = (ENV.HINDI_QUERIES || [
  '"Hindi dub" anime',
  '"Hindi dubbed" anime',
  'anime "in Hindi"',
  'anime Hindi release',
  'Crunchyroll Hindi',
  'Netflix anime Hindi',
  '"Sony YAY" anime',
  'Animax Hindi',
  'एनीमे हिंदी डब',
  'एनीमे हिंदी',
  'हिंदी डब'
].join('|')).split('|').map((q) => q.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIN = 60e3, DAY = 86400e3, TZ = 5 * 3600e3;

// ------------------------- helpers -------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const pkHour = () => new Date(Date.now() + TZ).getUTCHours();
const hash36 = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
// Google title ke aakhir mein " - Source" hota hai, Bing mein nahi: dono ko ek jaisa karo
function cleanTitle(t, src) {
  let x = String(t || '').trim();
  if (src && x.toLowerCase().endsWith(' - ' + src.toLowerCase())) x = x.slice(0, -(src.length + 3));
  return x.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ------------------------- ntfy -------------------------
async function notify(title, body, opts = {}) {
  title = LABEL + title;
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, '\n' + body); return true; }
  const msg = body.length > 3800 ? body.slice(0, 3750) + '\n... aur bhi hain' : body;
  let q = '?title=' + encodeURIComponent(title) +
          '&tags=' + encodeURIComponent(opts.tags || 'flag-in') +
          '&priority=' + encodeURIComponent(opts.priority || 'default');
  if (opts.click) q += '&click=' + encodeURIComponent(opts.click);
  const headers = NTFY_TOKEN ? { Authorization: 'Bearer ' + NTFY_TOKEN } : {};
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}${q}`, { method: 'POST', body: msg, headers });
      console.log('ntfy', r.status, NTFY_TOPIC, '|', title);
      if (r.ok) return true;
      if (r.status === 429) { await sleep(10000); continue; }
      return false;
    } catch (e) { console.log('ntfy error:', e.message); await sleep(3000); }
  }
  return false;
}

async function notifyList(title, lines, footer, opts) {
  const chunks = []; let cur = [], len = 0;
  for (const l of lines) {
    if (cur.length && len + l.length + 1 > 3300) { chunks.push(cur); cur = []; len = 0; }
    cur.push(l); len += l.length + 1;
  }
  if (cur.length) chunks.push(cur);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const t = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
    const b = chunks[i].join('\n') + (i === chunks.length - 1 && footer ? '\n\n' + footer : '');
    ok = (await notify(t, b, opts)) && ok;
  }
  return ok;
}

// ------------------------- filter -------------------------
const HINDI_RX = /hindi|हिंदी|हिन्दी/i;
const ANIME_RX = /\banime\b|एनीमे|एनिमे|crunchyroll|animax|sony yay|\bmanga\b/i;
const BLOCK_RX = /bollywood|tollywood|kollywood|mollywood|sandalwood|box office|south (indian )?(movie|film)|bhojpuri|web ?series|\bserial\b|पुष्पा|बॉलीवुड|साउथ/i;
// Aam English words jo anime ke naam bhi hain (galat match se bachne ke liye)
const STOP = new Set(['another', 'monster', 'given', 'orange', 'erased', 'nana', 'gate', 'rewrite', 'akira', 'kingdom',
  'pluto', 'blood', 'angel', 'charlotte', 'overlord', 'trigun', 'chaos', 'beyond', 'hunter', 'world', 'anime']);
// India mein Hindi mein chalne wali mashhoor anime (AniList list na mile tab bhi kaam kare)
const EXTRA = ['doraemon', 'shinchan', 'shin chan', 'crayon shin chan', 'ninja hattori', 'kiteretsu', 'perman',
  'pokemon', 'beyblade', 'dragon ball', 'naruto', 'boruto', 'one piece', 'demon slayer', 'jujutsu kaisen', 'solo leveling',
  'attack on titan', 'death note', 'chainsaw man', 'spy x family', 'black clover', 'my hero academia', 'bleach',
  'haikyuu', 'blue lock', 'dandadan', 'kaiju no 8', 'frieren', 'tokyo revengers', 'hunter x hunter', 'dr stone',
  'mashle', 'wind breaker', 'sakamoto days', 'oshi no ko', 'kuroko'];

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();

function titleVariants(t) {
  const out = new Set();
  for (const raw of [t && t.english, t && t.romaji]) {
    if (!raw) continue;
    const parts = [raw, raw.split(/[:：]/)[0],
      raw.replace(/\b(season|part|cour)\s*\d+\b|\b\d+(st|nd|rd|th)\s+season\b|\bfinal season\b/gi, '')];
    for (const p of parts) {
      const n = norm(p);
      if (n.length >= 5 && !STOP.has(n) && !/^\d+$/.test(n)) out.add(n);
    }
  }
  return out;
}

// Khabar asli anime Hindi dub ki hai ya nahi
function classify(title, titles) {
  if (!HINDI_RX.test(title) || BLOCK_RX.test(title)) return null;
  const n = ' ' + norm(title) + ' ';
  let best = '';
  for (const t of titles) if (t.length > best.length && n.includes(' ' + t + ' ')) best = t;
  if (best) return { anime: titleCase(best) };
  if (ANIME_RX.test(title)) return { anime: '' };
  return null;
}

// ------------------------- AniList titles -------------------------
const AL_QUERY = 'query($page:Int,$sort:[MediaSort]){Page(page:$page,perPage:50){media(type:ANIME,sort:$sort,isAdult:false){title{romaji english}}}}';
async function anilistPage(page, sort) {
  for (let t = 1; t <= 2; t++) {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: AL_QUERY, variables: { page, sort: [sort] } })
    });
    if (r.status === 429) throw new Error('AniList rate limit (429)');   // intezar nahi, purani list se kaam
    if (!r.ok) { if (t === 2) throw new Error('AniList HTTP ' + r.status); await sleep(3000); continue; }
    const j = await r.json();
    return (j && j.data && j.data.Page && j.data.Page.media) || [];
  }
  return [];
}

// Din mein ek dafa AniList se ~600 anime ke naam (Firebase mein cache). Max 90 sec.
async function loadTitles(R, now) {
  const c = (await R.child('titles').get()).val();
  let list = (c && Array.isArray(c.list)) ? c.list : [];
  if (!(c && c.day === pkDay(now) && list.length)) {
    try {
      const set = new Set();
      const stopAt = Date.now() + 90e3;
      const jobs = [];
      for (let p = 1; p <= 10; p++) jobs.push([p, 'POPULARITY_DESC']);
      for (let p = 1; p <= 2; p++) jobs.push([p, 'TRENDING_DESC']);
      for (const [p, s] of jobs) {
        if (Date.now() > stopAt) throw new Error('AniList bohat slow hai');
        for (const m of await anilistPage(p, s)) for (const v of titleVariants(m.title)) set.add(v);
        await sleep(2100);
      }
      if (set.size < 100) throw new Error('bohat kam titles mile: ' + set.size);
      list = [...set];
      await R.child('titles').set({ day: pkDay(now), list });
      console.log('AniList titles:', list.length);
    } catch (e) { console.log('AniList titles error (purani/built-in list use hogi):', e.message); }
  }
  return [...new Set([...list, ...EXTRA])];
}

// ------------------------- News sources -------------------------
function decode(s) {
  return String(s || '').replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '').trim();
}
function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const g = (tag) => { const x = m[1].match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i')); return x ? decode(x[1]) : ''; };
    let link = g('link');
    // Bing ka redirect link: asli article ka link nikalo
    const u = link.match(/[?&]url=([^&]+)/);
    if (/bing\.com/i.test(link) && u) { try { link = decodeURIComponent(u[1]); } catch (e) {} }
    return { title: g('title'), link, date: Date.parse(g('pubDate')) || 0, src: g('source') || g('News:Source') };
  });
}

async function getRss(url, hi) {
  let last = null;
  for (let t = 1; t <= 2; t++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': hi ? 'hi-IN,hi;q=0.9,en;q=0.8' : 'en-IN,en;q=0.9' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const xml = await r.text();
      if (!/<rss|<channel/i.test(xml)) throw new Error('RSS nahi mila (block page)');
      return parseRss(xml);
    } catch (e) {
      last = e.name === 'AbortError' ? new Error('timeout') : e;
      if (t < 2) await sleep(4000);
    } finally { clearTimeout(timer); }
  }
  throw last;
}

const SOURCES = [
  { name: 'Google', url: (q, hi) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=${hi ? 'hi' : 'en-IN'}&gl=IN&ceid=IN:${hi ? 'hi' : 'en'}` },
  { name: 'Bing', url: (q, hi) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&cc=IN&setlang=${hi ? 'hi' : 'en-IN'}` }
];

// ------------------------- news check -------------------------
async function checkNews(R, st, now, firstRun) {
  const titles = await loadTitles(R, now);
  const seen = (await R.child('seen').get()).val() || {};
  const fresh = [], recent = [], batch = new Set();
  const src = {};
  for (const S of SOURCES) src[S.name] = { ok: 0, fail: 0, items: 0 };
  let total = 0, matched = 0;
  const stopAt = Date.now() + 8 * MIN;   // max 8 min, taake job time out na ho

  for (const q of QUERIES) {
    if (Date.now() > stopAt) { console.log('Waqt khatam, baqi queries agli dafa'); break; }
    const hi = /[\u0900-\u097F]/.test(q);
    for (const S of SOURCES) {
      if (src[S.name].fail >= 3 && !src[S.name].ok) continue;   // yeh site lagatar fail: is run mein chhor do
      try {
        const items = await getRss(S.url(q, hi), hi);
        src[S.name].ok++; src[S.name].items += items.length; total += items.length;
        let m = 0;
        for (const it of items) {
          if (!it.title || !it.link) continue;
          const ct = cleanTitle(it.title, it.src);
          const h = hash36(it.link), th = hash36(ct);
          if (batch.has(th)) continue;
          const c = classify(ct, titles);
          if (!c) continue;
          batch.add(th); matched++; m++;
          const isNew = !seen[h] && !seen[th];
          if (isNew) { seen[h] = now; seen[th] = now; }
          if (!it.date || now - it.date > FRESH_DAYS * DAY) continue;
          const item = { ...it, title: it.title.replace(new RegExp('\\s+-\\s+' + (it.src || '#').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ''), anime: c.anime, h, th };
          if (firstRun) recent.push(item);
          else if (isNew) fresh.push(item);
        }
        console.log(`${S.name} | ${q} -> ${items.length} results, ${m} anime Hindi`);
      } catch (e) { src[S.name].fail++; console.log(`${S.name} FAIL | ${q} -> ${e.message}`); }
      await sleep(1200);
    }
  }
  const srcTxt = SOURCES.map((S) => `${S.name}: ${src[S.name].ok}/${QUERIES.length} ok, ${src[S.name].items} khabrein`).join(' | ');
  console.log(`Hindi news: ${total} dekhi, ${matched} anime Hindi wali, ${fresh.length} nayi | ${srcTxt}`);

  const line = (it) => `• ${it.anime ? '[' + it.anime + '] ' : ''}${it.title}${it.src ? ' (' + it.src + ')' : ''}\n  ${it.link}`;

  if (fresh.length) {
    fresh.sort((a, b) => b.date - a.date);
    const ok = await notifyList(
      fresh.length === 1 ? `Hindi dub${fresh[0].anime ? ': ' + fresh[0].anime : ' khabar'}` : `${fresh.length} nayi Hindi dub khabrein`,
      fresh.slice(0, 15).map(line), '', { tags: 'flag-in,loudspeaker', priority: PRIORITY, click: fresh[0].link });
    if (!ok) for (const it of fresh) { delete seen[it.h]; delete seen[it.th]; }   // fail hua to agli dafa dobara
  }

  const anyOk = SOURCES.some((S) => src[S.name].ok > 0);

  if (firstRun) {
    recent.sort((a, b) => b.date - a.date);
    const body = `Har ghante Google News + Bing News par anime ki Hindi dub khabrein dekhi jayengi. Roz raat ${REPORT_HOUR > 12 ? REPORT_HOUR - 12 : REPORT_HOUR} baje report aayegi.\n\n` +
      (!anyOk ? 'MASLA: abhi dono news sites se kuch nahi aaya. GitHub Actions > HINDI job ka log check karo.'
        : recent.length ? `Pichle ${FRESH_DAYS} din ki khabrein (test ke liye):\n` + recent.slice(0, 5).map(line).join('\n')
        : `Pichle ${FRESH_DAYS} din mein koi anime Hindi dub khabar nahi mili. Nayi aate hi alert aayega.`) +
      `\n\n${srcTxt}`;
    await notify('Hindi dub news alerts is topic par chalu', body, { tags: anyOk ? 'white_check_mark' : 'warning' });
  } else if (FORCE) {
    await notify('Manual check ho gaya',
      `${total} khabrein dekhi, ${matched} anime Hindi wali mili, ${fresh.length} nayi bheji.\n${srcTxt}` +
      (!anyOk ? '\n\nMASLA: dono news sites fail. Log check karo.' : fresh.length ? '' : '\n\nSab theek chal raha hai, bas abhi koi nayi khabar nahi.'),
      { tags: anyOk ? 'mag' : 'warning', priority: 'low' });
  }

  for (const k of Object.keys(seen)) if (now - seen[k] > 30 * DAY) delete seen[k];
  await R.child('seen').set(seen);

  // raat ki report ke liye ginti
  st.cRuns = (st.cRuns || 0) + 1;
  st.cTotal = (st.cTotal || 0) + total;
  st.cMatched = (st.cMatched || 0) + matched;
  st.cSent = (st.cSent || 0) + fresh.length;
  if (!anyOk) {
    st.cFail = (st.cFail || 0) + 1;
    if (!firstRun && !FORCE && st.errDay !== pkDay(now)) {   // din mein ek dafa
      await notify('News sites se khabrein nahi aa rahi', 'Google aur Bing dono fail. GitHub Actions > HINDI job ka log check karo.', { tags: 'warning' });
      st.errDay = pkDay(now);
    }
  }
}

// Roz raat: report (khabar na bhi ho to)
async function dailyReport(st, now) {
  if (pkHour() < REPORT_HOUR || st.reportDay === pkDay(now)) return;
  const runs = st.cRuns || 0, fail = st.cFail || 0;
  let body = `Pichli report se ab tak:\n• ${runs} dafa check hua\n• ${st.cTotal || 0} khabrein dekhi\n• ${st.cMatched || 0} anime Hindi wali mili\n• ${st.cSent || 0} nayi khabar bheji`;
  if (fail) body += `\n• ${fail} dafa news sites fail hui`;
  if (!runs) body += '\n\nKoi check nahi chala. GitHub Actions check karo.';
  else if (fail === runs) body += '\n\nHar dafa news sites fail hui. GitHub Actions log check karo.';
  else if (!st.cSent) body += '\n\nSystem chal raha hai, bas aaj koi nayi anime Hindi dub khabar nahi aayi.';
  const ok = await notify(st.cSent ? `Aaj ki report: ${st.cSent} khabar` : 'Aaj ki report: koi nayi khabar nahi', body, { tags: 'bar_chart', priority: 'low' });
  if (ok) { st.reportDay = pkDay(now); st.cRuns = 0; st.cTotal = 0; st.cMatched = 0; st.cSent = 0; st.cFail = 0; }
}

// ======================= MAIN =======================
async function main() {
  console.log('Hindi alerts start | topic:', NTFY_TOPIC, '| manual:', FORCE);
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const R = admin.database().ref('hindi');
  const st = (await R.child('state').get()).val() || {};
  const now = Date.now();
  const topicH = hash36(NTFY_TOPIC);
  const firstRun = st.topicH !== topicH;   // pehli run ya naya topic

  if (FORCE || firstRun || !st.newsAt || now - st.newsAt >= EVERY_MIN * MIN) {
    await checkNews(R, st, now, firstRun);
    st.newsAt = now;
    st.topicH = topicH;
  } else {
    console.log('Abhi check ka waqt nahi hua (har', EVERY_MIN, 'min), agle run par.');
  }
  await dailyReport(st, now);
  await R.child('state').set(st);
}

if (require.main === module) main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Hindi dub alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});

module.exports = { classify, parseRss, cleanTitle, EXTRA };
