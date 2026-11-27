// ================================================================
//  Watchanidubs — Anime Release Alerts (har ghante, AniList se)
//  Site se koi talluq nahi: poore AniList airing schedule par chalta hai
//  - Roz sham: "Kal ke episodes" ki list (PK time ke saath)
//  - Nayi anime (Episode 1) shuru hone se ~1 din pehle alert
//  - Har anime ka har episode + nayi anime: ~1 ghanta pehle alert
//  - (Optional) episode air hote hi "Abhi aaya" alert (ALERT_POP)
//  - watchlist.json wali anime ka har episode: 1 din pehle + release par
//  - Roz sham: nayi mashhoor aane wali anime (announcements)
// ================================================================
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const ENV = process.env;
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const MIN_POP = parseInt(ENV.MIN_POP || '10000', 10);       // roz ki list + nayi anime
const ALERT_POP = parseInt(ENV.ALERT_POP || '-1', 10);      // "abhi aaya" alert (-1 = band)
const DIGEST_HOUR = parseInt(ENV.DIGEST_HOUR || '20', 10);  // roz ki list kitne baje (PK)
const NEWS = (ENV.NEWS || 'true') === 'true';               // nayi announcements
const PRE_MIN = parseInt(ENV.PRE_MIN || '70', 10);         // episode se kitne minute pehle alert
const PRE_POP = parseInt(ENV.PRE_POP || '0', 10);          // pehle wala alert: 0 = sab anime
const HOUR = 3600e3, DAY = 86400e3, TZ = 5 * HOUR;          // Pakistan UTC+5
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'];
const FMT = { TV: 'TV', TV_SHORT: 'TV short', MOVIE: 'Movie', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'Special' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const pkHour = () => new Date(Date.now() + TZ).getUTCHours();
const nameOf = (m) => ((m.title && (m.title.english || m.title.romaji)) || ('#' + m.id)).slice(0, 90);
const fmtOf = (f) => FMT[f] || f || '';
function dateStr(sd) {
  if (!sd || !sd.year) return '';
  return `${sd.day ? sd.day + ' ' : ''}${sd.month ? MON[sd.month - 1] + ' ' : ''}${sd.year}`;
}
function pkClock(ms) {
  const d = new Date(ms + TZ), h = d.getUTCHours();
  const part = h < 4 ? 'raat' : h < 12 ? 'subah' : h < 16 ? 'dopehar' : h < 19 ? 'sham' : 'raat';
  return `${part} ${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const pkDate = (ms) => { const d = new Date(ms + TZ); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const whenWord = (at, now) => pkDay(at) === pkDay(now) ? 'Aaj' : pkDay(at) === pkDay(now + DAY) ? 'Kal' : pkDate(at);

async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, '\n' + body); return; }
  const msg = body.length > 3800 ? body.slice(0, 3750) + '\n... aur bhi hain' : body;
  const q = '?title=' + encodeURIComponent(title) + '&tags=' + encodeURIComponent(opts.tags || 'bell') +
            '&priority=' + (opts.priority || 'default') + (opts.click ? '&click=' + encodeURIComponent(opts.click) : '');
  try { const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC + q, { method: 'POST', body: msg }); console.log('ntfy', r.status, title); }
  catch (e) { console.log('ntfy error:', e.message); }
}

// lambi list ko kai messages mein todo (ntfy ki 4 KB limit)
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

// ---------------- AniList API ----------------
let lastCall = 0;
async function anilist(query, variables = {}) {
  for (let t = 1; t <= 4; t++) {
    const wait = lastCall + 2200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      if (r.status === 429) {
        const ra = parseInt(r.headers.get('retry-after') || '60', 10);
        console.log('AniList rate limit, intezar', ra, 'sec'); await sleep((ra + 1) * 1000); continue;
      }
      const j = await r.json();
      if (!r.ok || j.errors) throw new Error('AniList: ' + (j.errors ? j.errors.map((e) => e.message).join('; ') : 'HTTP ' + r.status));
      return j.data;
    } catch (e) { if (t === 4) throw e; await sleep(5000 * t); }
  }
}

const SCHED_Q = `query($from:Int,$to:Int,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
  airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){
    episode airingAt media{id isAdult popularity format episodes title{romaji english} externalLinks{site type}}}}}`;
const UPCOMING_Q = `query{Page(perPage:50){media(type:ANIME,status:NOT_YET_RELEASED,sort:POPULARITY_DESC,isAdult:false){
  id format title{romaji english} startDate{year month day}}}}`;

async function schedule(fromMs, toMs) {
  const out = [];
  for (let p = 1; p <= 15; p++) {
    const d = await anilist(SCHED_Q, { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000), p });
    const pg = d.Page || {};
    for (const s of pg.airingSchedules || []) {
      const m = s.media;
      if (!m || m.isAdult || !FORMATS.includes(m.format)) continue;
      const plat = [...new Set((m.externalLinks || []).filter((l) => l && l.type === 'STREAMING' && l.site).map((l) => l.site))].slice(0, 2).join(', ');
      out.push({ id: m.id, ep: s.episode, at: s.airingAt * 1000, pop: m.popularity || 0, total: m.episodes || 0, fmt: m.format, name: nameOf(m), plat });
    }
    if (!pg.pageInfo || !pg.pageInfo.hasNextPage) break;
  }
  return out;
}

function loadWatch() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
    return new Set((raw.ids || []).map((x) => parseInt(x, 10)).filter((n) => n > 0));
  } catch (e) { return new Set(); }
}

const epLine = (s, now, withDay) =>
  `• ${withDay ? whenWord(s.at, now) + ' ' : ''}${pkClock(s.at)} — ${s.name} EP ${s.ep}${s.plat ? ' (' + s.plat + ')' : ''}${s.total && s.ep === s.total ? ' (aakhri)' : ''}${s.ep === 1 ? ' 🆕' : ''}`;

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

  const list = await schedule(now - 3 * HOUR, now + 30 * HOUR);
  console.log('Schedule entries:', list.length, '| watchlist:', watch.size);
  const big = (s, min) => s.pop >= min || watch.has(s.id);

  // ---- 1. abhi air hue episodes ----
  const since = Math.max(st.lastCheck || now, now - 3 * HOUR);
  const aired = ALERT_POP < 0 ? [] : list.filter((s) => s.at > since && s.at <= now && big(s, ALERT_POP) && !sent[`r_${s.id}_${s.ep}`]);
  if (aired.length && !firstRun) {
    if (aired.length === 1) {
      const s = aired[0];
      await notify(`Abhi aaya: ${s.name} EP ${s.ep}`, `Japan mein air ho gaya (${pkClock(s.at)} PK). Sub ab aa jana chahiye.${watch.has(s.id) ? '\n⭐ Aapki watchlist mein hai.' : ''}\nanilist.co/anime/${s.id}`, { tags: 'tv', priority: 'high' });
    } else {
      await notify(`Abhi aaye: ${aired.length} episode`, aired.map((s) => epLine(s, now, false) + (watch.has(s.id) ? ' ⭐' : '')).join('\n') + '\n\nSub ab aa jane chahiye.', { tags: 'tv', priority: 'high' });
    }
  }
  for (const s of aired) sent[`r_${s.id}_${s.ep}`] = now;

  // ---- 1b. ~1 ghanta pehle: nayi anime + har naya episode ----
  const soon = list.filter((s) => s.at > now && s.at - now <= PRE_MIN * 60e3 && big(s, PRE_POP) && !sent[`a_${s.id}_${s.ep}`]).sort((a, b) => a.at - b.at);
  if (soon.length) {
    const naye = soon.filter((s) => s.ep === 1), baqi = soon.filter((s) => s.ep !== 1);
    const lines = [];
    if (naye.length) {
      lines.push('🆕 NAYI ANIME:');
      for (const s of naye) lines.push(`• ${pkClock(s.at)} — ${s.name} EP 1 (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' ep' : ''})${s.plat ? ' · ' + s.plat : ''}`);
      if (baqi.length) lines.push('');
    }
    if (baqi.length) {
      lines.push('📺 EPISODES:');
      for (const s of baqi) lines.push(epLine(s, now, false) + (watch.has(s.id) ? ' ⭐' : ''));
    }
    const mins = Math.max(1, Math.round((soon[0].at - now) / 60000));
    const title = soon.length === 1
      ? `${mins} min mein: ${soon[0].name} EP ${soon[0].ep}${soon[0].ep === 1 ? ' (NAYI)' : ''}`
      : `Agle 1 ghante mein: ${soon.length} episode${naye.length ? ', ' + naye.length + ' nayi anime' : ''}`;
    await notifyList(title, lines, 'Time Pakistan ka hai. Ready ho jao!', { tags: naye.length ? 'sparkles' : 'alarm_clock', priority: 'high' });
    for (const s of soon) sent[`a_${s.id}_${s.ep}`] = now;
  }

  // ---- 2. nayi anime (EP 1) ~1 din pehle ----
  const prem = list.filter((s) => s.ep === 1 && s.at > now && s.at - now <= 24.5 * HOUR && big(s, MIN_POP) && !sent[`p_${s.id}`]);
  if (prem.length) {
    await notify(prem.length === 1 ? `Nayi anime shuru: ${prem[0].name}` : `${prem.length} nayi anime shuru hone wali`,
      prem.map((s) => `• ${whenWord(s.at, now)} ${pkClock(s.at)} — ${s.name} (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' episodes' : ''})${s.plat ? ' · ' + s.plat : ''}\n  anilist.co/anime/${s.id}`).join('\n'),
      { tags: 'sparkles', priority: 'high' });
    for (const s of prem) sent[`p_${s.id}`] = now;
  }

  // ---- 3. watchlist: har episode se ~1 din pehle ----
  const wl = list.filter((s) => watch.has(s.id) && s.ep !== 1 && s.at > now && s.at - now <= 24.5 * HOUR && !sent[`d_${s.id}_${s.ep}`]);
  if (wl.length) {
    await notify(`Watchlist: ${wl.length} episode aane wale`, wl.map((s) => epLine(s, now, true)).join('\n'), { tags: 'calendar' });
    for (const s of wl) sent[`d_${s.id}_${s.ep}`] = now;
  }

  // ---- 4. roz sham: kal ki list + nayi announcements ----
  if (pkHour() >= DIGEST_HOUR && st.digestDay !== pkDay(now)) {
    const tmr = pkDay(now + DAY);
    const kal = list.filter((s) => pkDay(s.at) === tmr && big(s, MIN_POP)).sort((a, b) => a.at - b.at);
    const naye = kal.filter((s) => s.ep === 1);
    const lines = [];
    if (naye.length) {
      lines.push(`🆕 NAYI ANIME (${naye.length}):`);
      for (const s of naye) lines.push(`• ${pkClock(s.at)} — ${s.name} (${fmtOf(s.fmt)}${s.total ? ', ' + s.total + ' ep' : ''})${s.plat ? ' · ' + s.plat : ''}`);
      lines.push('');
    }
    if (kal.length) {
      lines.push(`📺 SAARE EPISODES (${kal.length}):`);
      for (const s of kal) lines.push(epLine(s, now, false) + (watch.has(s.id) ? ' ⭐' : ''));
    }
    if (kal.length)
      await notifyList(`Kal (${pkDate(now + DAY)}): ${kal.length} episode, ${naye.length} nayi anime`, lines, 'Time Pakistan ka hai (Japan airing).', { tags: 'date' });
    else
      await notify(`Kal (${pkDate(now + DAY)}) koi episode nahi`, 'AniList par kal ka koi episode nahi mila.', { tags: 'date' });

    if (NEWS) {
      try {
        const d = await anilist(UPCOMING_Q);
        const up = ((d.Page && d.Page.media) || []).filter((m) => FORMATS.includes(m.format));
        const seen = (await R.child('seenUpcoming').get()).val() || {};
        const fresh = up.filter((m) => !seen[m.id]);
        if (fresh.length && st.newsBaseline)
          await notify(`${fresh.length} nayi mashhoor anime announce / aane wali`,
            fresh.slice(0, 15).map((m) => `• ${nameOf(m)} (${fmtOf(m.format)}) · ${dateStr(m.startDate) || 'date abhi nahi'}\n  anilist.co/anime/${m.id}`).join('\n'),
            { tags: 'loudspeaker' });
        for (const m of up) seen[m.id] = 1;
        await R.child('seenUpcoming').set(seen);
        st.newsBaseline = 1;
      } catch (e) { console.log('News error:', e.message); }
    }
    st.digestDay = pkDay(now);
  }

  if (firstRun) {
    const next24 = list.filter((s) => s.at > now && s.at - now <= DAY && big(s, MIN_POP)).length;
    await notify('Anime release alerts chalu ho gaye',
      `Agle 24 ghante mein ${next24} episode (popularity ${MIN_POP}+).\nRoz ${DIGEST_HOUR > 12 ? DIGEST_HOUR - 12 : DIGEST_HOUR} baje kal ki list aaye gi.\nNayi anime: 1 din pehle alert.\nHar episode aur nayi anime: ${PRE_MIN} minute pehle alert.`, { tags: 'white_check_mark' });
    st.started = now;
  }

  for (const k of Object.keys(sent)) if (now - sent[k] > 40 * DAY) delete sent[k];
  st.lastCheck = now;
  await R.update({ state: st, sent });
  console.log(`Soon: ${soon.length} | Aired: ${aired.length} | Premieres: ${prem.length} | Watchlist: ${wl.length}`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('Anime alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
