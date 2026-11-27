// ================================================================
//  Watchanidubs - Dub Alerts v2 (har 15 minute)
//
//  ENGLISH DUB (AnimeSchedule.net, token chahiye):
//   1. 7 din pehle  : agle hafte shuru hone wale naye dubs
//   2. 1 din pehle  : naya dub kal shuru + roz raat kal ki poori list
//   3. 1 ghanta pehle: ntfy par exact time ke liye scheduled alert
//   4. Release par  : "release ho gaya" alert
//
//  HINDI DUB (Google News + AniList titles, koi token nahi):
//   - Sirf asli anime ki Hindi dub khabrein
//   - Indian movies / serials filter ho jate hain
// ================================================================
const admin = require('firebase-admin');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const ENV = process.env;
const NTFY_SERVER = (ENV.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const NTFY_TOKEN = (ENV.NTFY_TOKEN || '').trim();          // optional (private topic ke liye)
const AS_TOKEN = (ENV.ANIMESCHEDULE_TOKEN || '').trim();
const PRE_MIN = int(ENV.PRE_MIN, 60);                      // kitne minute pehle alert
const DIGEST_HOUR = int(ENV.DIGEST_HOUR, 20);              // roz raat list (PK time)
const RELEASE_WINDOW_H = int(ENV.RELEASE_WINDOW_H, 3);     // release alert kitni der tak valid
const SCHEDULE_AHEAD_H = int(ENV.SCHEDULE_AHEAD_H, 3);     // 1-ghanta alert kitna pehle schedule ho
const HINDI_NEWS = (ENV.HINDI_NEWS || 'true') === 'true';
const HINDI_PRIORITY = (ENV.HINDI_PRIORITY || 'default').trim();
const HINDI_QUERIES = (ENV.HINDI_QUERIES ||
  '"anime" "Hindi dub"|"anime" "Hindi dubbed"|Crunchyroll "Hindi dub"|"Sony YAY" anime Hindi|Netflix anime "Hindi dub"|एनीमे हिंदी डब|एनीमे हिंदी')
  .split('|').map((q) => q.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, TZ = 5 * HOUR;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Itwar', 'Peer', 'Mangal', 'Budh', 'Jumeraat', 'Juma', 'Hafta'];

// ------------------------- helpers -------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const pkHour = () => new Date(Date.now() + TZ).getUTCHours();
const pkDate = (ms) => { const d = new Date(ms + TZ); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
function pkClock(ms) {
  const d = new Date(ms + TZ), h = d.getUTCHours();
  const part = h < 4 ? 'raat' : h < 12 ? 'subah' : h < 16 ? 'dopehar' : h < 19 ? 'sham' : 'raat';
  return `${part} ${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const whenWord = (at, now) => pkDay(at) === pkDay(now) ? 'Aaj' : pkDay(at) === pkDay(now + DAY) ? 'Kal' : pkDate(at);
const hash36 = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ------------------------- ntfy -------------------------
// opts.delay = ms timestamp -> ntfy us waqt message deliver karega
async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, '\n' + body); return true; }
  const msg = body.length > 3800 ? body.slice(0, 3750) + '\n... aur bhi hain' : body;
  let q = '?title=' + encodeURIComponent(title) +
          '&tags=' + encodeURIComponent(opts.tags || 'bell') +
          '&priority=' + encodeURIComponent(opts.priority || 'default');
  if (opts.click) q += '&click=' + encodeURIComponent(opts.click);
  if (opts.delay && opts.delay - Date.now() > 15e3) q += '&delay=' + Math.floor(opts.delay / 1000);
  const headers = NTFY_TOKEN ? { Authorization: 'Bearer ' + NTFY_TOKEN } : {};
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}${q}`, { method: 'POST', body: msg, headers });
      console.log('ntfy', r.status, title, opts.delay ? '(scheduled ' + new Date(opts.delay).toISOString() + ')' : '');
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

// ======================= ENGLISH DUB =======================
function isoWeek(ms) {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - y0) / DAY + 1) / 7) };
}

async function asGet(url) {
  for (let t = 1; t <= 3; t++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + AS_TOKEN, Accept: 'application/json', 'User-Agent': 'watchanidubs-alerts' } });
    if (r.status === 401 || r.status === 403) throw new Error(`AnimeSchedule token ghalat ya band hai (HTTP ${r.status})`);
    if (r.status === 429) { await sleep(30000); continue; }
    if (!r.ok) { if (t === 3) throw new Error('AnimeSchedule HTTP ' + r.status); await sleep(5000); continue; }
    return r.json();
  }
  throw new Error('AnimeSchedule rate limit (429)');
}

const listOf = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);

// Pichle 3 ghante se agle 8 din tak ka dub schedule
async function dubSchedule(now) {
  const weeks = [];
  for (let t = now - 3 * HOUR; t <= now + 8 * DAY; t += DAY) {
    const w = isoWeek(t);
    if (!weeks.some((x) => x.year === w.year && x.week === w.week)) weeks.push(w);
  }
  const out = new Map();
  for (const w of weeks) {
    const data = await asGet(`https://animeschedule.net/api/v3/timetables/dub?year=${w.year}&week=${w.week}&tz=UTC`);
    for (const a of listOf(data)) {
      if (!a || !a.episodeDate || a.airingStatus === 'delayed-air') continue;
      const at = Date.parse(a.episodeDate);
      if (isNaN(at)) continue;
      const ep = a.episodeNumber || 0, from = a.subtractedEpisodeNumber || 0;
      const plat = [...new Set(listOf(a.streams)
        .map((x) => typeof x === 'string' ? x : (x && (x.name || x.platform)))
        .filter(Boolean))].slice(0, 2).join(', ');
      const key = `${a.route}_${ep}`;
      out.set(key, {
        key, route: a.route, ep, from, at, plat, total: a.episodes || 0,
        name: String(a.english || a.title || a.romaji || a.route).slice(0, 90)
      });
    }
    await sleep(1000);
  }
  return [...out.values()].sort((x, y) => x.at - y.at);
}

const isPremiere = (s) => s.ep === 1 || s.from === 1;
const epTxt = (s) => (s.from && s.from < s.ep) ? `EP ${s.from}-${s.ep}` : `EP ${s.ep}`;
const platTxt = (s) => s.plat ? ` (${s.plat})` : '';
const tagTxt = (s) => (s.total && s.ep === s.total ? ' (aakhri)' : '') + (isPremiere(s) ? ' 🆕' : '');
const dubLine = (s, now, withDay) =>
  `• ${withDay ? whenWord(s.at, now) + ' ' : ''}${pkClock(s.at)} | ${s.name} ${epTxt(s)}${platTxt(s)}${tagTxt(s)}`;
const uniqBy = (arr, fn) => { const m = new Map(); for (const x of arr) if (!m.has(fn(x))) m.set(fn(x), x); return [...m.values()]; };
const groupByTime = (arr) => { const m = new Map(); for (const s of arr) { if (!m.has(s.at)) m.set(s.at, []); m.get(s.at).push(s); } return [...m.entries()]; };

// 1) 7 din pehle: naye dubs jo agle hafte shuru honge
async function weekAhead(list, sent, now) {
  const wk = uniqBy(list.filter((s) => isPremiere(s) && s.at - now > 25 * HOUR && s.at - now <= 7.5 * DAY && !sent[`w_${s.route}`]), (s) => s.route);
  if (!wk.length) return;
  const ok = await notifyList(
    wk.length === 1 ? `Agle hafte naya English dub: ${wk[0].name}` : `Agle hafte ${wk.length} naye English dubs`,
    wk.map((s) => `• ${pkDate(s.at)}, ${pkClock(s.at)} | ${s.name} ${epTxt(s)}${platTxt(s)}`),
    'Time Pakistan ka hai. 1 din pehle aur 1 ghanta pehle dobara yaad dilaya jayega.',
    { tags: 'calendar', priority: 'default' });
  if (ok) for (const s of wk) sent[`w_${s.route}`] = now;
}

// 2) 1 din pehle: naya dub kal shuru
async function dayAhead(list, sent, now) {
  const prem = uniqBy(list.filter((s) => isPremiere(s) && s.at > now && s.at - now <= 25 * HOUR && !sent[`p_${s.route}`]), (s) => s.route);
  if (!prem.length) return;
  const ok = await notify(
    prem.length === 1 ? `English dub shuru: ${prem[0].name}` : `${prem.length} anime ka English dub shuru hone wala`,
    prem.map((s) => `• ${whenWord(s.at, now)} ${pkClock(s.at)} | ${s.name} ${epTxt(s)}${platTxt(s)}\n  animeschedule.net/anime/${s.route}`).join('\n'),
    { tags: 'microphone,sparkles', priority: 'high' });
  if (ok) for (const s of prem) sent[`p_${s.route}`] = now;
}

// 3) 1 ghanta pehle: ntfy delay se exact time par
async function hourAhead(list, sent, now) {
  const up = list.filter((s) => s.at > now && s.at - now <= (SCHEDULE_AHEAD_H * HOUR + PRE_MIN * MIN) && !sent[`a_${s.key}`]);
  for (const [at, eps] of groupByTime(up)) {
    const fireAt = at - PRE_MIN * MIN;
    const late = fireAt <= now + 15e3;
    const mins = late ? Math.max(1, Math.round((at - now) / MIN)) : PRE_MIN;
    const title = eps.length === 1
      ? `${mins} min mein English dub: ${eps[0].name} ${epTxt(eps[0])}`
      : `${mins} min mein ${eps.length} English dub episodes`;
    const ok = await notify(title,
      eps.map((s) => dubLine(s, now, false)).join('\n') + `\n\nRelease: ${pkClock(at)} (Pakistan time)`,
      { tags: 'microphone,alarm_clock', priority: 'high', delay: late ? 0 : fireAt });
    if (ok) for (const s of eps) sent[`a_${s.key}`] = now;
  }
}

// 4) Release ho gaya
async function released(list, sent, now, silent) {
  const done = list.filter((s) => s.at <= now && now - s.at <= RELEASE_WINDOW_H * HOUR && !sent[`r_${s.key}`]);
  if (!done.length) return;
  if (silent) { for (const s of done) sent[`r_${s.key}`] = now; return; }   // pehli run par purane skip
  const ok = await notifyList(
    done.length === 1 ? `Release ho gaya: ${done[0].name} ${epTxt(done[0])}` : `${done.length} English dub episodes release ho gaye`,
    done.map((s) => `• ${pkClock(s.at)} | ${s.name} ${epTxt(s)}${platTxt(s)}${tagTxt(s)}`),
    'Platform par aane mein kabhi 5-30 min lag jate hain.',
    { tags: 'white_check_mark,tv', priority: 'high' });
  if (ok) for (const s of done) sent[`r_${s.key}`] = now;
}

// Roz raat: kal ki list (time ke saath)
async function dailyDigest(list, st, now) {
  if (pkHour() < DIGEST_HOUR || st.dubDigestDay === pkDay(now)) return;
  const tmr = pkDay(now + DAY);
  const kal = list.filter((s) => pkDay(s.at) === tmr);
  const ok = kal.length
    ? await notifyList(`Kal (${pkDate(now + DAY)}): ${kal.length} English dub episode`, kal.map((s) => dubLine(s, now, false)), 'Time Pakistan ka hai.', { tags: 'microphone,calendar' })
    : await notify(`Kal (${pkDate(now + DAY)}) koi English dub nahi`, 'AnimeSchedule par kal ka koi dub episode nahi mila.', { tags: 'microphone' });
  if (ok) st.dubDigestDay = pkDay(now);
}

async function englishDub(st, sent, now) {
  if (!AS_TOKEN) {
    if (!st.noTokenWarned) {
      await notify('English dub alerts band hain', 'GitHub secret ANIMESCHEDULE_TOKEN nahi mila. AnimeSchedule.net ka API token daal do, phir English dub alerts shuru ho jayenge.', { tags: 'information_source', priority: 'low' });
      st.noTokenWarned = 1;
    }
    return;
  }
  const list = await dubSchedule(now);
  console.log('Dub entries:', list.length);
  const firstRun = !st.dubStarted;
  const firstV2 = !st.v2Started;   // purane version se upgrade: purani release spam na ho

  await weekAhead(list, sent, now);
  await dayAhead(list, sent, now);
  await hourAhead(list, sent, now);
  await released(list, sent, now, firstRun || firstV2);
  await dailyDigest(list, st, now);

  if (firstRun || firstV2) {
    const next24 = list.filter((s) => s.at > now && s.at - now <= DAY).length;
    await notify('English dub alerts v2 chalu',
      `Agle 24 ghante mein ${next24} dub episode.\n• 7 din pehle: naye dubs\n• 1 din pehle: naya dub + raat ${DIGEST_HOUR > 12 ? DIGEST_HOUR - 12 : DIGEST_HOUR} baje kal ki list\n• ${PRE_MIN} min pehle: har episode\n• Release par: alert`,
      { tags: 'white_check_mark' });
    st.dubStarted = st.dubStarted || now;
    st.v2Started = now;
  }
}

// ======================= HINDI DUB NEWS =======================
const HINDI_RX = /hindi|हिंदी|हिन्दी/i;
const ANIME_RX = /\banime\b|एनीमे|एनिमे|crunchyroll|animax|sony yay|\bmanga\b/i;
const BLOCK_RX = /bollywood|tollywood|kollywood|mollywood|sandalwood|box office|south (indian )?(movie|film)|bhojpuri|web ?series|\bserial\b|पुष्पा|बॉलीवुड|साउथ/i;
// Aam English words jo anime ke naam bhi hain (galat match se bachne ke liye)
const STOP = new Set(['another', 'monster', 'given', 'orange', 'erased', 'nana', 'gate', 'rewrite', 'akira', 'kingdom',
  'pluto', 'blood', 'angel', 'charlotte', 'overlord', 'trigun', 'chaos', 'beyond', 'hunter', 'world', 'anime']);

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

const AL_QUERY = 'query($page:Int,$sort:[MediaSort]){Page(page:$page,perPage:50){media(type:ANIME,sort:$sort,isAdult:false){title{romaji english}}}}';
async function anilistPage(page, sort) {
  for (let t = 1; t <= 3; t++) {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: AL_QUERY, variables: { page, sort: [sort] } })
    });
    if (r.status === 429) { await sleep(60000); continue; }
    if (!r.ok) { if (t === 3) throw new Error('AniList HTTP ' + r.status); await sleep(5000); continue; }
    const j = await r.json();
    return (j && j.data && j.data.Page && j.data.Page.media) || [];
  }
  return [];
}

// Din mein ek dafa AniList se ~500 popular + trending anime ke naam (Firebase mein cache)
async function loadTitles(R, now) {
  const c = (await R.child('titles').get()).val();
  if (c && c.day === pkDay(now) && Array.isArray(c.list) && c.list.length) return c.list;
  try {
    const set = new Set();
    const jobs = [];
    for (let p = 1; p <= 10; p++) jobs.push([p, 'POPULARITY_DESC']);
    for (let p = 1; p <= 2; p++) jobs.push([p, 'TRENDING_DESC']);
    for (const [p, s] of jobs) {
      for (const m of await anilistPage(p, s)) for (const v of titleVariants(m.title)) set.add(v);
      await sleep(2100);   // AniList rate limit
    }
    const list = [...set];
    if (list.length < 100) throw new Error('bohat kam titles mile: ' + list.length);
    await R.child('titles').set({ day: pkDay(now), list });
    console.log('AniList titles:', list.length);
    return list;
  } catch (e) {
    console.log('AniList titles error:', e.message);
    return (c && Array.isArray(c.list)) ? c.list : [];
  }
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

function decode(s) {
  return String(s || '').replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '').trim();
}
function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const g = (tag) => { const x = m[1].match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return x ? decode(x[1]) : ''; };
    return { title: g('title'), link: g('link'), date: Date.parse(g('pubDate')) || 0, src: g('source') };
  });
}
async function googleNews(q) {
  const hi = /[\u0900-\u097F]/.test(q);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=${hi ? 'hi' : 'en-IN'}&gl=IN&ceid=IN:${hi ? 'hi' : 'en'}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('Google News HTTP ' + r.status);
  return parseRss(await r.text());
}

async function hindiNews(R, st, now) {
  if (!HINDI_NEWS) return;
  if (st.newsAt && now - st.newsAt < 55 * MIN) return;   // har ghante ek dafa
  const titles = await loadTitles(R, now);
  const seen = (await R.child('newsSeen').get()).val() || {};
  const firstRun = !st.newsStarted;
  const fresh = [], batch = new Set();
  let skipped = 0, okQueries = 0;

  for (const q of HINDI_QUERIES) {
    try {
      for (const it of await googleNews(q)) {
        if (!it.title || !it.link) continue;
        const h = hash36(it.link), th = hash36(it.title.toLowerCase().replace(/\s+-\s+[^-]+$/, ''));
        if (seen[h] || seen[th] || batch.has(th)) continue;
        const c = classify(it.title, titles);
        if (!c) { skipped++; continue; }
        seen[h] = now; seen[th] = now; batch.add(th);
        if (!firstRun && it.date && now - it.date < 3 * DAY) fresh.push({ ...it, anime: c.anime });
      }
      okQueries++;
    } catch (e) { console.log('News error:', q, e.message); }
    await sleep(1500);
  }
  console.log(`Hindi news: ${fresh.length} nayi, ${skipped} filter hui, ${okQueries}/${HINDI_QUERIES.length} queries ok`);

  if (fresh.length) {
    fresh.sort((a, b) => b.date - a.date);
    const ok = await notifyList(
      fresh.length === 1 ? `Hindi dub${fresh[0].anime ? ': ' + fresh[0].anime : ' khabar'}` : `Hindi dub: ${fresh.length} nayi khabrein`,
      fresh.slice(0, 15).map((it) => `• ${it.anime ? '[' + it.anime + '] ' : ''}${it.title}${it.src && !it.title.includes(it.src) ? ' (' + it.src + ')' : ''}\n  ${it.link}`),
      '', { tags: 'flag-in,loudspeaker', priority: HINDI_PRIORITY, click: fresh[0].link });
    if (!ok) for (const it of fresh) { delete seen[hash36(it.link)]; }   // fail hua to agli dafa dobara try
  }

  if (okQueries === 0) {   // Google News poora fail: din mein ek dafa batao
    if (st.newsErrDay !== pkDay(now)) {
      await notify('Hindi dub news mein masla', 'Google News se koi result nahi aa raha. Logs check karein.', { tags: 'warning' });
      st.newsErrDay = pkDay(now);
    }
  }

  for (const k of Object.keys(seen)) if (now - seen[k] > 30 * DAY) delete seen[k];
  await R.child('newsSeen').set(seen);
  if (firstRun) {
    await notify('Hindi dub news alerts chalu', 'Har ghante Google News par sirf anime ki Hindi dub khabrein dekhi jayengi. Indian movies filter hoti hain.', { tags: 'white_check_mark' });
    st.newsStarted = now;
  }
  st.newsAt = now;
}

// ======================= MAIN =======================
async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const R = admin.database().ref('dub');
  const st = (await R.child('state').get()).val() || {};
  const sent = (await R.child('sent').get()).val() || {};
  const now = Date.now();
  let err = null;

  try { await englishDub(st, sent, now); } catch (e) { console.log('English dub error:', e.message); err = e; }
  try { await hindiNews(R, st, now); } catch (e) { console.log('Hindi news error:', e.message); }

  for (const k of Object.keys(sent)) if (now - sent[k] > 40 * DAY) delete sent[k];

  if (err && st.errDay !== pkDay(now)) {   // token / API masla: din mein ek dafa
    await notify('English dub alerts mein masla', String(err.message || err), { tags: 'warning' });
    st.errDay = pkDay(now);
  }
  await R.update({ state: st, sent });
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Dub alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
