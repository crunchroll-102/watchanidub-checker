// ================================================================
//  Watchanidubs - English Dub Alerts v3 (DUB, har 15 minute)
//
//  AnimeSchedule.net (token chahiye):
//   1. 7 din pehle  : agle hafte shuru hone wale naye dubs
//   2. 1 din pehle  : naya dub kal shuru + roz raat kal ki poori list
//   3. 1 ghanta pehle: ntfy par exact time ke liye scheduled alert
//   4. Release par  : "release ho gaya" alert
//
//  v3: Hindi dub ab alag file (hindi.js) mein hai.
//      Apna alag ntfy topic (NTFY_TOPIC_DUB), har alert par [DUB] likha
// ================================================================
const admin = require('firebase-admin');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const ENV = process.env;
const NTFY_SERVER = (ENV.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC_DUB || 'watchanidubs-Dub').trim();
const NTFY_TOKEN = (ENV.NTFY_TOKEN || '').trim();
const LABEL = '[DUB] ';
const AS_TOKEN = (ENV.ANIMESCHEDULE_TOKEN || '').trim();
const PRE_MIN = int(ENV.PRE_MIN, 60);                      // kitne minute pehle alert
const DIGEST_HOUR = int(ENV.DIGEST_HOUR, 20);              // roz raat list (PK time)
const RELEASE_WINDOW_H = int(ENV.RELEASE_WINDOW_H, 3);     // release alert kitni der tak valid
const SCHEDULE_AHEAD_H = int(ENV.SCHEDULE_AHEAD_H, 3);     // 1-ghanta alert kitna pehle schedule ho

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

// ------------------------- ntfy -------------------------
// opts.delay = ms timestamp -> ntfy us waqt message deliver karega
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

// ------------------------- AnimeSchedule -------------------------
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
  const topicH = hash36(NTFY_TOPIC);
  const topicChanged = st.topicH !== topicH;

  await weekAhead(list, sent, now);
  await dayAhead(list, sent, now);
  await hourAhead(list, sent, now);
  await released(list, sent, now, firstRun || firstV2);
  await dailyDigest(list, st, now);

  if (firstRun || firstV2 || topicChanged) {
    const next24 = list.filter((s) => s.at > now && s.at - now <= DAY).length;
    const ok = await notify('English dub alerts is topic par chalu',
      `Agle 24 ghante mein ${next24} dub episode.\n• 7 din pehle: naye dubs\n• 1 din pehle: naya dub + raat ${DIGEST_HOUR > 12 ? DIGEST_HOUR - 12 : DIGEST_HOUR} baje kal ki list\n• ${PRE_MIN} min pehle: har episode\n• Release par: alert`,
      { tags: 'white_check_mark' });
    st.dubStarted = st.dubStarted || now;
    st.v2Started = st.v2Started || now;
    if (ok) st.topicH = topicH;
  }
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
