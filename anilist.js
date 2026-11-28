// ================================================================
//  Watchanidubs - Anime Release Alerts v3 (SUB, AniList, har 15 minute)
//
//   1. 7 din pehle   : agle hafte shuru hone wali nayi anime
//   2. 1 din pehle   : nayi anime kal shuru + roz raat kal ki poori list
//   3. 1 ghanta pehle: ntfy par exact time ke liye scheduled alert
//   4. Release par   : "Abhi aaya" alert (ALERT_POP)
//   + watchlist.json (optional): har episode 1 din pehle
//   + roz raat: nayi mashhoor anime announcements
//
//  v3: apna alag ntfy topic (NTFY_TOPIC_SUB), har alert par [SUB] likha
// ================================================================
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const ENV = process.env;
const NTFY_SERVER = (ENV.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC_SUB || 'watchanidubs-Sub').trim();
const NTFY_TOKEN = (ENV.NTFY_TOKEN || '').trim();
const LABEL = '[SUB] ';
const MIN_POP = int(ENV.MIN_POP, 0);                 // raat ki list + 1 din pehle nayi anime
const WEEK_POP = int(ENV.WEEK_POP, 5000);            // 7 din pehle wala alert
const PRE_POP = int(ENV.PRE_POP, 2000);              // 1 ghanta pehle wala alert (0 = sab)
const ALERT_POP = int(ENV.ALERT_POP, 2000);          // release alert (-1 = band, 0 = sab)
const PRE_MIN = int(ENV.PRE_MIN, 60);
const DIGEST_HOUR = int(ENV.DIGEST_HOUR, 20);
const RELEASE_WINDOW_H = int(ENV.RELEASE_WINDOW_H, 3);
const SCHEDULE_AHEAD_H = int(ENV.SCHEDULE_AHEAD_H, 3);
const NEWS = (ENV.NEWS || 'true') === 'true';

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, TZ = 5 * HOUR;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Itwar', 'Peer', 'Mangal', 'Budh', 'Jumeraat', 'Juma', 'Hafta'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'];
const FMT = { TV: 'TV', TV_SHORT: 'TV short', MOVIE: 'Movie', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'Special' };

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
const nameOf = (m) => ((m.title && (m.title.english || m.title.romaji)) || ('#' + m.id)).slice(0, 90);
const fmtOf = (f) => FMT[f] || f || '';
const hash36 = (s) => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
function dateStr(sd) {
  if (!sd || !sd.year) return '';
  return `${sd.day ? sd.day + ' ' : ''}${sd.month ? MON[sd.month - 1] + ' ' : ''}${sd.year}`;
}
const uniqBy = (arr, fn) => { const m = new Map(); for (const x of arr) if (!m.has(fn(x))) m.set(fn(x), x); return [...m.values()]; };
const groupByTime = (arr) => { const m = new Map(); for (const s of arr) { if (!m.has(s.at)) m.set(s.at, []); m.get(s.at).push(s); } return [...m.entries()]; };

// ------------------------- ntfy -------------------------
async function notify(title, body, opts = {}) {
  title = LABEL + title;
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

// ------------------------- AniList -------------------------
let lastCall = 0;
async function anilist(query, variables = {}) {
  for (let t = 1; t <= 4; t++) {
    const wait = lastCall + 2200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      if (r.status === 429) {
        const ra = int(r.headers.get('retry-after'), 60);
        console.log('AniList rate limit, intezar', ra, 'sec'); await sleep((ra + 1) * 1000); continue;
      }
      const j = await r.json();
      if (!r.ok || j.errors) throw new Error('AniList: ' + (j.errors ? j.errors.map((e) => e.message).join('; ') : 'HTTP ' + r.status));
      return j.data;
    } catch (e) { if (t === 4) throw e; await sleep(5000 * t); }
  }
}

const FIELDS = 'episode airingAt media{id isAdult popularity format episodes title{romaji english} externalLinks{site type}}';
const SCHED_Q = `query($from:Int,$to:Int,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
  airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){${FIELDS}}}}`;
const WEEK_Q = `query($from:Int,$to:Int,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
  airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,episode:1,sort:TIME){${FIELDS}}}}`;
const UPCOMING_Q = `query{Page(perPage:50){media(type:ANIME,status:NOT_YET_RELEASED,sort:POPULARITY_DESC,isAdult:false){
  id format title{romaji english} startDate{year month day}}}}`;

async function schedule(query, fromMs, toMs) {
  const out = [];
  for (let p = 1; p <= 15; p++) {
    const d = await anilist(query, { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000), p });
    const pg = d.Page || {};
    for (const s of pg.airingSchedules || []) {
      const m = s.media;
      if (!m || m.isAdult || !FORMATS.includes(m.format)) continue;
      const plat = [...new Set((m.externalLinks || []).filter((l) => l && l.type === 'STREAMING' && l.site).map((l) => l.site))].slice(0, 2).join(', ');
      out.push({ id: m.id, ep: s.episode, at: s.airingAt * 1000, pop: m.popularity || 0, total: m.episodes || 0, fmt: m.format, name: nameOf(m), plat });
    }
    if (!pg.pageInfo || !pg.pageInfo.hasNextPage) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

function loadWatch() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
    return new Set((raw.ids || []).map((x) => parseInt(x, 10)).filter((n) => n > 0));
  } catch (e) { return new Set(); }
}

const platTxt = (s) => s.plat ? ` (${s.plat})` : '';
const epLine = (s, now, withDay) =>
  `• ${withDay ? whenWord(s.at, now) + ' ' : ''}${pkClock(s.at)} | ${s.name} EP ${s.ep}${platTxt(s)}${s.total && s.ep === s.total ? ' (aakhri)' : ''}${s.ep === 1 ? ' 🆕' : ''}`;
const newLine = (s) => `• ${pkClock(s.at)} | ${s.name} EP 1 (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' ep' : ''})${platTxt(s)}`;

// ======================= MAIN =======================
async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const R = admin.database().ref('airing');
  const st = (await R.child('state').get()).val() || {};
  const sent = (await R.child('sent').get()).val() || {};
  const watch = loadWatch();
  const now = Date.now();
  const firstRun = !st.started;
  const quiet = firstRun || !st.v2Started;   // pehli run / upgrade: purane alerts ka spam nahi
  const topicH = hash36(NTFY_TOPIC);
  const topicChanged = st.topicH !== topicH;  // naya topic laga: wahan "chalu" message bhejo
  const big = (s, min) => s.pop >= min || watch.has(s.id);
  const star = (s) => watch.has(s.id) ? ' ⭐' : '';
  const count = { week: 0, prem: 0, soon: 0, aired: 0, wl: 0 };

  const list = await schedule(SCHED_Q, now - RELEASE_WINDOW_H * HOUR, now + 30 * HOUR);
  console.log('Schedule entries:', list.length, '| watchlist:', watch.size);

  // ---- 1. 7 din pehle: agle hafte ki nayi anime (har 6 ghante check) ----
  if (!st.weekAt || now - st.weekAt > 6 * HOUR) {
    try {
      const wlist = await schedule(WEEK_Q, now + 25 * HOUR, now + 7.5 * DAY);
      const wk = uniqBy(wlist.filter((s) => big(s, WEEK_POP) && !sent[`w_${s.id}`]), (s) => s.id);
      if (wk.length) {
        const ok = await notifyList(
          wk.length === 1 ? `Agle hafte nayi anime: ${wk[0].name}` : `Agle hafte ${wk.length} nayi anime`,
          wk.map((s) => `• ${pkDate(s.at)}, ${pkClock(s.at)} | ${s.name} (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' ep' : ''})${platTxt(s)}${star(s)}`),
          'Time Pakistan ka hai (Japan airing). 1 din pehle aur 1 ghanta pehle dobara yaad dilaya jayega.',
          { tags: 'calendar,sparkles' });
        if (ok) { for (const s of wk) sent[`w_${s.id}`] = now; count.week = wk.length; }
      }
      st.weekAt = now;
    } catch (e) { console.log('Week check error:', e.message); }
  }

  // ---- 2. 1 din pehle: nayi anime (EP 1) ----
  const prem = uniqBy(list.filter((s) => s.ep === 1 && s.at > now && s.at - now <= 25 * HOUR && big(s, MIN_POP) && !sent[`p_${s.id}`]), (s) => s.id);
  if (prem.length) {
    const ok = await notifyList(
      prem.length === 1 ? `Nayi anime shuru: ${prem[0].name}` : `${prem.length} nayi anime shuru hone wali`,
      prem.map((s) => `• ${whenWord(s.at, now)} ${pkClock(s.at)} | ${s.name} (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' episodes' : ''})${platTxt(s)}${star(s)}\n  anilist.co/anime/${s.id}`),
      '', { tags: 'sparkles', priority: 'high' });
    if (ok) { for (const s of prem) sent[`p_${s.id}`] = now; count.prem = prem.length; }
  }

  // ---- 3. 1 ghanta pehle: exact time par scheduled alert ----
  const up = list.filter((s) => s.at > now && s.at - now <= SCHEDULE_AHEAD_H * HOUR + PRE_MIN * MIN && big(s, PRE_POP) && !sent[`a_${s.id}_${s.ep}`]);
  for (const [at, eps] of groupByTime(up)) {
    const fireAt = at - PRE_MIN * MIN;
    const late = fireAt <= now + 15e3;
    const mins = late ? Math.max(1, Math.round((at - now) / MIN)) : PRE_MIN;
    const naye = eps.filter((s) => s.ep === 1), baqi = eps.filter((s) => s.ep !== 1);
    const lines = [];
    if (naye.length) { lines.push('🆕 NAYI ANIME:'); for (const s of naye) lines.push(newLine(s) + star(s)); if (baqi.length) lines.push(''); }
    if (baqi.length) { lines.push('📺 EPISODES:'); for (const s of baqi) lines.push(epLine(s, now, false) + star(s)); }
    const title = eps.length === 1
      ? `${mins} min mein: ${eps[0].name} EP ${eps[0].ep}${eps[0].ep === 1 ? ' (NAYI)' : ''}`
      : `${mins} min mein: ${eps.length} episode${naye.length ? ', ' + naye.length + ' nayi anime' : ''}`;
    const ok = await notifyList(title, lines, `Release: ${pkClock(at)} (Pakistan time)`,
      { tags: naye.length ? 'sparkles,alarm_clock' : 'alarm_clock', priority: 'high', delay: late ? 0 : fireAt });
    if (ok) { for (const s of eps) sent[`a_${s.id}_${s.ep}`] = now; count.soon += eps.length; }
  }

  // ---- 4. Release par: "Abhi aaya" ----
  if (ALERT_POP >= 0) {
    const aired = list.filter((s) => s.at <= now && now - s.at <= RELEASE_WINDOW_H * HOUR && big(s, ALERT_POP) && !sent[`r_${s.id}_${s.ep}`]);
    if (aired.length && quiet) {
      for (const s of aired) sent[`r_${s.id}_${s.ep}`] = now;
    } else if (aired.length) {
      const ok = aired.length === 1
        ? await notify(`Abhi aaya: ${aired[0].name} EP ${aired[0].ep}`,
            `Japan mein air ho gaya (${pkClock(aired[0].at)} PK). Sub thodi der mein aa jana chahiye.${star(aired[0]) ? '\n⭐ Aapki watchlist mein hai.' : ''}\nanilist.co/anime/${aired[0].id}`,
            { tags: 'tv', priority: 'high' })
        : await notifyList(`Abhi aaye: ${aired.length} episode`, aired.map((s) => epLine(s, now, false) + star(s)),
            'Sub thodi der mein aa jane chahiye.', { tags: 'tv', priority: 'high' });
      if (ok) { for (const s of aired) sent[`r_${s.id}_${s.ep}`] = now; count.aired = aired.length; }
    }
  }

  // ---- 5. Watchlist: har episode 1 din pehle ----
  const wl = list.filter((s) => watch.has(s.id) && s.ep !== 1 && s.at > now && s.at - now <= 25 * HOUR && !sent[`d_${s.id}_${s.ep}`]);
  if (wl.length) {
    const ok = await notify(`Watchlist: ${wl.length} episode aane wale`, wl.map((s) => epLine(s, now, true)).join('\n'), { tags: 'calendar' });
    if (ok) { for (const s of wl) sent[`d_${s.id}_${s.ep}`] = now; count.wl = wl.length; }
  }

  // ---- 6. Roz raat: kal ki list + nayi announcements ----
  if (pkHour() >= DIGEST_HOUR && st.digestDay !== pkDay(now)) {
    const tmr = pkDay(now + DAY);
    const kal = list.filter((s) => pkDay(s.at) === tmr && big(s, MIN_POP));
    const naye = kal.filter((s) => s.ep === 1);
    const lines = [];
    if (naye.length) { lines.push(`🆕 NAYI ANIME (${naye.length}):`); for (const s of naye) lines.push(newLine(s) + star(s)); lines.push(''); }
    if (kal.length) { lines.push(`📺 SAARE EPISODES (${kal.length}):`); for (const s of kal) lines.push(epLine(s, now, false) + star(s)); }
    const ok = kal.length
      ? await notifyList(`Kal (${pkDate(now + DAY)}): ${kal.length} episode, ${naye.length} nayi anime`, lines, 'Time Pakistan ka hai (Japan airing).', { tags: 'date' })
      : await notify(`Kal (${pkDate(now + DAY)}) koi episode nahi`, 'AniList par kal ka koi episode nahi mila.', { tags: 'date' });

    if (NEWS) {
      try {
        const d = await anilist(UPCOMING_Q);
        const upc = ((d.Page && d.Page.media) || []).filter((m) => FORMATS.includes(m.format));
        const seen = (await R.child('seenUpcoming').get()).val() || {};
        const fresh = upc.filter((m) => !seen[m.id]);
        let newsOk = true;
        if (fresh.length && st.newsBaseline)
          newsOk = await notifyList(`${fresh.length} nayi mashhoor anime announce / aane wali`,
            fresh.slice(0, 15).map((m) => `• ${nameOf(m)} (${fmtOf(m.format)}) | ${dateStr(m.startDate) || 'date abhi nahi'}\n  anilist.co/anime/${m.id}`),
            '', { tags: 'loudspeaker' });
        if (newsOk) { for (const m of upc) seen[m.id] = 1; await R.child('seenUpcoming').set(seen); st.newsBaseline = 1; }
      } catch (e) { console.log('News error:', e.message); }
    }
    if (ok) st.digestDay = pkDay(now);
  }

  if (quiet || topicChanged) {
    const next24 = list.filter((s) => s.at > now && s.at - now <= DAY && big(s, MIN_POP)).length;
    const ok = await notify('Anime release (SUB) alerts is topic par chalu',
      `Agle 24 ghante mein ${next24} episode.\n• 7 din pehle: nayi anime\n• 1 din pehle: nayi anime + raat ${DIGEST_HOUR > 12 ? DIGEST_HOUR - 12 : DIGEST_HOUR} baje kal ki list\n• ${PRE_MIN} min pehle: har episode\n• Release par: ${ALERT_POP < 0 ? 'band' : 'alert'}`,
      { tags: 'white_check_mark' });
    st.started = st.started || now;
    st.v2Started = st.v2Started || now;
    if (ok) st.topicH = topicH;
  }

  for (const k of Object.keys(sent)) if (now - sent[k] > 40 * DAY) delete sent[k];
  st.lastCheck = now;
  await R.update({ state: st, sent });
  console.log(`Week: ${count.week} | Premieres: ${count.prem} | Soon: ${count.soon} | Aired: ${count.aired} | Watchlist: ${count.wl}`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Anime alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
