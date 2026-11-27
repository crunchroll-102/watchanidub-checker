// ================================================================
//  Watchanidubs — Dub Alerts (har 15 minute)
//  ENGLISH DUB (AnimeSchedule.net, token chahiye):
//   - Har dub episode se ~1 ghanta pehle alert (platform ke saath)
//   - Nayi anime ka dub shuru hone se ~1 din pehle alert
//   - Roz raat: "Kal ke English dub episodes" ki list
//  HINDI DUB (Google News, koi token nahi):
//   - Har ghante Hindi dub anime ki nayi khabrein dhoondta hai
// ================================================================
const admin = require('firebase-admin');

const ENV = process.env;
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const AS_TOKEN = (ENV.ANIMESCHEDULE_TOKEN || '').trim();
const PRE_MIN = parseInt(ENV.PRE_MIN || '70', 10);
const DIGEST_HOUR = parseInt(ENV.DIGEST_HOUR || '20', 10);
const HINDI_NEWS = (ENV.HINDI_NEWS || 'true') === 'true';
const HINDI_QUERIES = (ENV.HINDI_QUERIES || 'anime "Hindi dub"|anime Hindi dubbed|Crunchyroll Hindi|एनीमे हिंदी डब')
  .split('|').map((q) => q.trim()).filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOUR = 3600e3, DAY = 86400e3, TZ = 5 * HOUR;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const pkHour = () => new Date(Date.now() + TZ).getUTCHours();
const pkDate = (ms) => { const d = new Date(ms + TZ); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
function pkClock(ms) {
  const d = new Date(ms + TZ), h = d.getUTCHours();
  const part = h < 4 ? 'raat' : h < 12 ? 'subah' : h < 16 ? 'dopehar' : h < 19 ? 'sham' : 'raat';
  return `${part} ${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const whenWord = (at, now) => pkDay(at) === pkDay(now) ? 'Aaj' : pkDay(at) === pkDay(now + DAY) ? 'Kal' : pkDate(at);
const hash36 = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };

async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, '\n' + body); return; }
  const msg = body.length > 3800 ? body.slice(0, 3750) + '\n... aur bhi hain' : body;
  const q = '?title=' + encodeURIComponent(title) + '&tags=' + encodeURIComponent(opts.tags || 'bell') +
            '&priority=' + (opts.priority || 'default') + (opts.click ? '&click=' + encodeURIComponent(opts.click) : '');
  try { const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC + q, { method: 'POST', body: msg }); console.log('ntfy', r.status, title); }
  catch (e) { console.log('ntfy error:', e.message); }
}
async function notifyList(title, lines, footer, opts) {
  const chunks = []; let cur = [], len = 0;
  for (const l of lines) {
    if (cur.length && len + l.length + 1 > 3300) { chunks.push(cur); cur = []; len = 0; }
    cur.push(l); len += l.length + 1;
  }
  if (cur.length) chunks.push(cur);
  for (let i = 0; i < chunks.length; i++)
    await notify(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
      chunks[i].join('\n') + (i === chunks.length - 1 && footer ? '\n\n' + footer : ''), opts);
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
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + AS_TOKEN, 'Accept': 'application/json', 'User-Agent': 'watchanidubs-alerts' } });
    if (r.status === 401 || r.status === 403) throw new Error(`AnimeSchedule token ghalat ya band hai (HTTP ${r.status})`);
    if (r.status === 429) { await sleep(30000); continue; }
    if (!r.ok) { if (t === 3) throw new Error('AnimeSchedule HTTP ' + r.status); await sleep(5000); continue; }
    return r.json();
  }
}

const listOf = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);

async function dubSchedule(now) {
  const weeks = [isoWeek(now - 3 * HOUR), isoWeek(now + 30 * HOUR)]
    .filter((w, i, a) => a.findIndex((x) => x.year === w.year && x.week === w.week) === i);
  const out = new Map();
  for (const w of weeks) {
    const data = await asGet(`https://animeschedule.net/api/v3/timetables/dub?year=${w.year}&week=${w.week}&tz=UTC`);
    for (const a of listOf(data)) {
      if (!a || !a.episodeDate || a.airingStatus === 'delayed-air') continue;
      const at = Date.parse(a.episodeDate);
      if (isNaN(at)) continue;
      const ep = a.episodeNumber || 0, from = a.subtractedEpisodeNumber || 0;
      const plat = [...new Set(listOf(a.streams).map((x) => typeof x === 'string' ? x : (x && (x.name || x.platform))).filter(Boolean))].slice(0, 2).join(', ');
      const key = `${a.route}_${ep}`;
      out.set(key, {
        key, route: a.route, ep, from, at, plat, total: a.episodes || 0,
        name: String(a.english || a.title || a.romaji || a.route).slice(0, 90)
      });
    }
  }
  return [...out.values()].sort((x, y) => x.at - y.at);
}

const epTxt = (s) => (s.from && s.from < s.ep) ? `EP ${s.from}-${s.ep}` : `EP ${s.ep}`;
const dubLine = (s, now, withDay) =>
  `• ${withDay ? whenWord(s.at, now) + ' ' : ''}${pkClock(s.at)} — ${s.name} ${epTxt(s)}${s.plat ? ' (' + s.plat + ')' : ''}${s.total && s.ep === s.total ? ' (aakhri)' : ''}${(s.ep === 1 || s.from === 1) ? ' 🆕' : ''}`;

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

  // 1 ghanta pehle
  const soon = list.filter((s) => s.at > now && s.at - now <= PRE_MIN * 60e3 && !sent[`a_${s.key}`]);
  if (soon.length) {
    const title = soon.length === 1
      ? `${Math.max(1, Math.round((soon[0].at - now) / 60000))} min mein English dub: ${soon[0].name} ${epTxt(soon[0])}`
      : `Agle 1 ghante mein: ${soon.length} English dub episode`;
    await notifyList(title, soon.map((s) => dubLine(s, now, false)), 'Time Pakistan ka hai.', { tags: 'microphone', priority: 'high' });
    for (const s of soon) sent[`a_${s.key}`] = now;
  }

  // nayi anime ka dub ~1 din pehle
  const prem = list.filter((s) => (s.ep === 1 || s.from === 1) && s.at > now && s.at - now <= 24.5 * HOUR && !sent[`p_${s.route}`]);
  if (prem.length) {
    await notify(prem.length === 1 ? `English dub shuru: ${prem[0].name}` : `${prem.length} anime ka English dub shuru hone wala`,
      prem.map((s) => `• ${whenWord(s.at, now)} ${pkClock(s.at)} — ${s.name} ${epTxt(s)}${s.plat ? ' (' + s.plat + ')' : ''}\n  animeschedule.net/anime/${s.route}`).join('\n'),
      { tags: 'microphone,sparkles', priority: 'high' });
    for (const s of prem) sent[`p_${s.route}`] = now;
  }

  // roz raat: kal ki list
  if (pkHour() >= DIGEST_HOUR && st.dubDigestDay !== pkDay(now)) {
    const tmr = pkDay(now + DAY);
    const kal = list.filter((s) => pkDay(s.at) === tmr);
    if (kal.length)
      await notifyList(`Kal (${pkDate(now + DAY)}): ${kal.length} English dub episode`, kal.map((s) => dubLine(s, now, false)), 'Time Pakistan ka hai.', { tags: 'microphone' });
    else
      await notify(`Kal (${pkDate(now + DAY)}) koi English dub nahi`, 'AnimeSchedule par kal ka koi dub episode nahi mila.', { tags: 'microphone' });
    st.dubDigestDay = pkDay(now);
  }

  if (firstRun) {
    const next24 = list.filter((s) => s.at > now && s.at - now <= DAY).length;
    await notify('English dub alerts chalu ho gaye', `Agle 24 ghante mein ${next24} dub episode.\nHar dub episode: ${PRE_MIN} minute pehle alert.\nRoz raat kal ki dub list.`, { tags: 'white_check_mark' });
    st.dubStarted = now;
  }
}

// ======================= HINDI DUB NEWS =======================
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
  if (st.newsAt && now - st.newsAt < 55 * 60e3) return;          // har ghante ek dafa
  const seen = (await R.child('newsSeen').get()).val() || {};
  const firstRun = !st.newsStarted;
  const fresh = [], titles = new Set();
  for (const q of HINDI_QUERIES) {
    try {
      for (const it of await googleNews(q)) {
        if (!it.title || !it.link) continue;
        if (!/hindi|हिंदी|हिन्दी/i.test(it.title)) continue;     // sirf Hindi wali khabar
        const h = hash36(it.link), th = hash36(it.title.toLowerCase().replace(/\s+-\s+[^-]+$/, ''));
        if (seen[h] || seen[th] || titles.has(th)) continue;
        seen[h] = now; seen[th] = now; titles.add(th);
        if (!firstRun && it.date && now - it.date < 3 * DAY) fresh.push(it);
      }
    } catch (e) { console.log('News error:', q, e.message); }
    await sleep(1500);
  }
  if (fresh.length) {
    fresh.sort((a, b) => b.date - a.date);
    await notifyList(fresh.length === 1 ? 'Hindi dub khabar' : `Hindi dub: ${fresh.length} nayi khabrein`,
      fresh.slice(0, 15).map((it) => `• ${it.title}${it.src && !it.title.includes(it.src) ? ' (' + it.src + ')' : ''}\n  ${it.link}`),
      '', { tags: 'flag-in,loudspeaker', priority: 'high', click: fresh[0].link });
  }
  for (const k of Object.keys(seen)) if (now - seen[k] > 30 * DAY) delete seen[k];
  await R.child('newsSeen').set(seen);
  if (firstRun) {
    await notify('Hindi dub news alerts chalu ho gaye', 'Ab har ghante Google News par Hindi dub anime ki nayi khabrein dekhi jayengi. Purani khabrein skip kar di gayi hain.', { tags: 'white_check_mark' });
    st.newsStarted = now;
  }
  st.newsAt = now;
}

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
  await R.update({ state: st, sent });

  if (err) {   // token / API masla: din mein ek dafa batao
    if (!st.errDay || st.errDay !== pkDay(now)) {
      await notify('English dub alerts mein masla', String(err.message || err), { tags: 'warning' });
      await R.child('state/errDay').set(pkDay(now));
    }
  }
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Dub alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
