// ================================================================
//  Watchanidubs — AniList Alerts (har ghante)
//  - Site ki har anime ko AniList se match karta hai
//  - Sub episode se ~1 din pehle aur release par ntfy alert
//  - Site ki anime ka naya season / sequel / movie announce ho,
//    ya release date aaye / badle, to alert
//  - Roz sham: AniList ki mashhoor aane wali anime mein naye naam
//  Ghalat match theek karne ke liye: anilist-fix.json
// ================================================================
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { msJson, slug, kSafe } = require('./checker.js');

const ENV = process.env;
const BLOG_URL = (ENV.BLOG_URL || '').trim().replace(/\/+$/, '');
const NTFY_TOPIC = (ENV.NTFY_TOPIC || '').trim();
const DIGEST = (ENV.DIGEST || 'true') === 'true';
const MAX_SEARCH_PER_RUN = 20;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOUR = 3600e3, DAY = 86400e3, TZ = 5 * HOUR;   // Pakistan UTC+5
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'];
const FMT = { TV: 'TV series', TV_SHORT: 'TV short', MOVIE: 'Movie', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'Special' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const pkHour = () => new Date(Date.now() + TZ).getUTCHours();
const nameOf = (m) => ((m.title && (m.title.english || m.title.romaji)) || ('#' + m.id)).slice(0, 120);
const fmtOf = (f) => FMT[f] || f || '';
function dateStr(sd) {
  if (!sd || !sd.year) return '';
  return `${sd.day ? sd.day + ' ' : ''}${sd.month ? MON[sd.month - 1] + ' ' : ''}${sd.year}`;
}
function pkTime(ms) {
  const d = new Date(ms + TZ);
  const h = d.getUTCHours();
  const part = h < 4 ? 'raat' : h < 12 ? 'subah' : h < 16 ? 'dopehar' : h < 19 ? 'sham' : 'raat';
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${part} ${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

async function notify(title, body, opts = {}) {
  if (!NTFY_TOPIC) { console.log('[ntfy off]', title, '\n' + body); return; }
  const msg = body.length > 3500 ? body.slice(0, 3450) + '\n... aur bhi hain' : body;
  const q = '?title=' + encodeURIComponent(title) + '&tags=' + encodeURIComponent(opts.tags || 'bell') +
            '&priority=' + (opts.priority || 'default') + (opts.click ? '&click=' + encodeURIComponent(opts.click) : '');
  try { const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC + q, { method: 'POST', body: msg }); console.log('ntfy', r.status, title); }
  catch (e) { console.log('ntfy error:', e.message); }
}

// ---------------- AniList API (rate limit ka khayal) ----------------
let lastCall = 0;
async function anilist(query, variables = {}) {
  for (let t = 1; t <= 4; t++) {
    const wait = lastCall + 2200 - Date.now();       // ~27 requests / minute
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      if (r.status === 429) {
        const ra = parseInt(r.headers.get('retry-after') || '60', 10);
        console.log('AniList rate limit, intezar', ra, 'sec');
        await sleep((ra + 1) * 1000);
        continue;
      }
      const j = await r.json();
      if (!r.ok || j.errors) throw new Error('AniList: ' + (j.errors ? j.errors.map((e) => e.message).join('; ') : 'HTTP ' + r.status));
      return j.data;
    } catch (e) {
      if (t === 4) throw e;
      await sleep(5000 * t);
    }
  }
}

const SEARCH_Q = `query($s:String){Page(perPage:8){media(search:$s,type:ANIME,sort:SEARCH_MATCH){
  id format seasonYear startDate{year} title{romaji english}}}}`;
const FETCH_Q = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){
  id status format title{romaji english} startDate{year month day}
  nextAiringEpisode{episode airingAt}
  relations{edges{relationType node{id type status format title{romaji english} startDate{year month day}}}}}}}`;
const UPCOMING_Q = `query{Page(perPage:50){media(type:ANIME,status:NOT_YET_RELEASED,sort:POPULARITY_DESC){
  id format title{romaji english} startDate{year month day}}}}`;

// site ke title se "Hindi Dubbed", "Season 2" wagaira hatao taa ke AniList par mile
function cleanTitle(t) {
  return String(t || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(hindi|urdu|tamil|telugu|bangla|english|eng|japanese|dubbed|dub|dual audio|multi audio|sub|subbed|official|all episodes?|episodes?|full|download|watch|online|free|hd|in)\b/gi, ' ')
    .replace(/\bseason\s*\d+\b|\bs\d+\b|\bpart\s*\d+\b/gi, ' ')
    .replace(/[|:–—\-]+\s*$/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function findAniList(p) {
  const tries = [cleanTitle(p.title), cleanTitle(p.alt)].filter((x, i, a) => x && x.length >= 2 && a.indexOf(x) === i);
  for (const s of tries) {
    const d = await anilist(SEARCH_Q, { s });
    let list = ((d.Page && d.Page.media) || []).filter((m) => FORMATS.includes(m.format));
    if (p.movie) { const mv = list.filter((m) => m.format === 'MOVIE'); if (mv.length) list = mv; }
    else { const tv = list.filter((m) => m.format !== 'MOVIE'); if (tv.length) list = tv; }
    if (p.yr) { const y = list.find((m) => (m.seasonYear || (m.startDate || {}).year) === p.yr); if (y) return y; }
    if (list.length) return list[0];
  }
  return null;
}

// ---------------- site ki anime list ----------------
async function sitePosts() {
  const out = {};
  let start = 1;
  for (let pg = 0; pg < 200; pg++) {
    const url = `${BLOG_URL}/feeds/posts/default?alt=json&orderby=published&max-results=150&start-index=${start}&_=${Date.now()}`;
    let feed = null;
    for (let t = 1; t <= 3; t++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('Blogger feed HTTP ' + r.status);
        feed = (await r.json()).feed || {};
        break;
      } catch (e) { if (t === 3) throw e; await sleep(5000); }
    }
    const ents = feed.entry || [];
    for (const e of ents) {
      const title = (e.title && e.title.$t) || '';
      const j = msJson((e.content && e.content.$t) || '');
      if (!j || j.k || !title) continue;
      out[kSafe(j.id || slug(title))] = {
        title: title.slice(0, 150), alt: String(j.at || '').slice(0, 120),
        yr: (+j.yr >= 1950 && +j.yr <= 2100) ? Math.round(+j.yr) : 0, movie: j.t === 'Movie' ? 1 : 0
      };
    }
    if (ents.length < 150) break;
    start += 150;
  }
  return out;
}

function loadFixes() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'anilist-fix.json'), 'utf8'));
    const o = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) o[k.toLowerCase().trim()] = parseInt(v, 10) || 0;
    return o;
  } catch (e) { return {}; }
}

async function main() {
  if (!BLOG_URL) throw new Error('BLOG_URL secret missing');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(ENV.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: ENV.FIREBASE_DB_URL
  });
  const A = admin.database().ref('anilist');
  const st = (await A.child('state').get()).val() || {};
  const map = (await A.child('map').get()).val() || {};         // siteKey -> {title, al, ...}
  const tracked = (await A.child('tracked').get()).val() || {}; // anilistId -> {src, site, status, date, pend}
  const sent = (await A.child('sent').get()).val() || {};
  const firstRun = !st.baseline;
  const now = Date.now();
  const fixes = loadFixes();

  const dropSite = (k) => { for (const id of Object.keys(tracked)) if (tracked[id].src === k) delete tracked[id]; };
  const addRoot = (k, id, m) => { if (!tracked[id]) tracked[id] = { src: k, root: 1, site: m.title }; };

  // ---- 1. site list (har 6 ghante) ----
  if (!st.lastScan || now - st.lastScan > 6 * HOUR || !Object.keys(map).length) {
    try {
      const posts = await sitePosts();
      if (Object.keys(posts).length) {
        for (const k of Object.keys(map)) if (!posts[k]) { dropSite(k); delete map[k]; }
        for (const [k, p] of Object.entries(posts)) {
          if (!map[k]) map[k] = Object.assign({ al: -1 }, p);
          else Object.assign(map[k], { title: p.title, alt: p.alt, yr: p.yr, movie: p.movie });
        }
        st.lastScan = now;
        console.log('Site anime:', Object.keys(posts).length);
      }
    } catch (e) { console.log('Site feed error:', e.message); }
  }

  // ---- 2. fixes + naye matches ----
  const newSrc = new Set();
  const matchLines = [];
  let searches = 0;
  for (const [k, m] of Object.entries(map)) {
    const fx = fixes[k.toLowerCase()] !== undefined ? fixes[k.toLowerCase()] : fixes[String(m.title).toLowerCase().trim()];
    if (fx !== undefined) {
      if (m.al !== fx) {
        dropSite(k); m.al = fx; m.fixed = 1;
        if (fx > 0) { addRoot(k, fx, m); newSrc.add(k); }
        matchLines.push(`• ${m.title}\n  → fix se ${fx > 0 ? 'anilist.co/anime/' + fx : 'ignore'}`);
      }
      continue;
    }
    if (m.al === -1 && searches < MAX_SEARCH_PER_RUN) {
      searches++;
      try {
        const r = await findAniList(m);
        if (r) {
          m.al = r.id; addRoot(k, r.id, m); newSrc.add(k);
          matchLines.push(`• ${m.title}\n  → ${nameOf(r)} (${r.seasonYear || (r.startDate || {}).year || '?'}) anilist.co/anime/${r.id}`);
        } else {
          m.al = 0;
          matchLines.push(`• ${m.title}\n  → AniList par nahi mili`);
        }
      } catch (e) { console.log('Search error:', e.message); break; }
    }
  }
  const pendingSearch = Object.values(map).filter((m) => m.al === -1).length;

  // ---- 3. tracked anime ki detail ----
  const ids = Object.keys(tracked).map(Number).filter((n) => n > 0);
  const media = {};
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const d = await anilist(FETCH_Q, { ids: ids.slice(i, i + 50) });
      for (const m of (d.Page && d.Page.media) || []) media[m.id] = m;
    }
  } catch (e) { console.log('Fetch error:', e.message); }

  // ---- 4. announcements + episodes ----
  const announces = [], quietUpcoming = [];
  for (const m of Object.values(media)) {
    const tr = tracked[m.id];
    if (!tr) continue;
    const nm = nameOf(m), ds = dateStr(m.startDate);
    const quiet = firstRun || newSrc.has(tr.src);

    if (tr.status && !quiet) {
      if (tr.status === 'NOT_YET_RELEASED' && m.status === 'NOT_YET_RELEASED' && ds && ds !== tr.date)
        announces.push(`📅 ${nm}: release date ${tr.date ? 'badal gayi (pehle ' + tr.date + ')' : 'aa gayi'}: ${ds}\n   anilist.co/anime/${m.id}`);
      if (tr.status === 'NOT_YET_RELEASED' && m.status === 'RELEASING')
        announces.push(`▶️ ${nm} shuru ho gaya hai!\n   anilist.co/anime/${m.id}`);
    }
    tr.status = m.status; tr.date = ds; tr.name = nm;

    // naye season / sequel / movie
    for (const e of (m.relations && m.relations.edges) || []) {
      const n = e.node;
      if (!n || n.type !== 'ANIME' || !FORMATS.includes(n.format) || tracked[n.id]) continue;
      if (e.relationType !== 'SEQUEL' && n.status !== 'NOT_YET_RELEASED') continue;
      tracked[n.id] = { src: tr.src, site: tr.site, status: n.status, date: dateStr(n.startDate), name: nameOf(n) };
      if (n.status === 'NOT_YET_RELEASED') {
        const line = `🆕 ${nameOf(n)} (${fmtOf(n.format)})\n   ${tr.site} se juda · Release: ${dateStr(n.startDate) || 'date abhi nahi'}\n   anilist.co/anime/${n.id}`;
        if (quiet) quietUpcoming.push(line); else announces.push(line);
      }
    }

    // episode release alert (pichla episode air ho gaya?)
    if (tr.pend && tr.pend.at <= now) {
      const k2 = `r_${m.id}_${tr.pend.ep}`;
      if (!sent[k2] && now - tr.pend.at < 12 * HOUR)
        await notify(`Release: ${nm} EP ${tr.pend.ep}`, `Japan mein air ho gaya, sub ab aa jana chahiye.\nSite: ${tr.site}\nanilist.co/anime/${m.id}`, { tags: 'tv', priority: 'high' });
      sent[k2] = now;
      delete tr.pend;
    }
    // 1 din pehle alert
    const nx = m.nextAiringEpisode;
    if (nx && nx.airingAt) {
      const at = nx.airingAt * 1000, diff = at - now;
      const k1 = `d_${m.id}_${nx.episode}`;
      if (diff > 0 && diff <= 24.5 * HOUR && !sent[k1]) {
        const when = pkDay(at) === pkDay(now) ? 'Aaj' : 'Kal';
        await notify(`${when}: ${nm} EP ${nx.episode}`, `${pkTime(at)} (PK) par sub release hoga.\nSite: ${tr.site}\nanilist.co/anime/${m.id}`, { tags: 'calendar' });
        sent[k1] = now;
      }
      tr.pend = { ep: nx.episode, at };
    }
  }

  if (announces.length)
    await notify(`${announces.length} nayi anime khabar`, announces.join('\n\n'), { tags: 'loudspeaker', priority: 'high' });

  if (matchLines.length) {
    let body = matchLines.join('\n');
    if (quietUpcoming.length) body += '\n\nIn ki aane wali (pehle se announced):\n' + quietUpcoming.join('\n');
    if (pendingSearch) body += `\n\nAbhi ${pendingSearch} anime match hona baqi, agli runs mein hongi.`;
    body += '\n\nGhalat match ho to repo ki anilist-fix.json mein theek karo.';
    await notify(`AniList match: ${matchLines.length} anime`, body, { tags: 'mag', priority: 'low' });
  }

  // ---- 5. roz sham digest ----
  if (DIGEST && st.digestDay !== pkDay(now) && pkHour() >= 18) {
    try {
      const d = await anilist(UPCOMING_Q);
      const list = ((d.Page && d.Page.media) || []).filter((m) => FORMATS.includes(m.format));
      const seen = (await A.child('seenUpcoming').get()).val() || {};
      const fresh = list.filter((m) => !seen[m.id]);
      if (fresh.length && st.digestBaseline)
        await notify(`${fresh.length} nayi mashhoor anime aane wali`,
          fresh.slice(0, 15).map((m) => `• ${nameOf(m)} (${fmtOf(m.format)}) · ${dateStr(m.startDate) || 'date abhi nahi'}\n  anilist.co/anime/${m.id}`).join('\n'),
          { tags: 'sparkles' });
      for (const m of list) seen[m.id] = 1;
      await A.child('seenUpcoming').set(seen);
      st.digestDay = pkDay(now); st.digestBaseline = 1;
    } catch (e) { console.log('Digest error:', e.message); }
  }

  if (firstRun) {
    const up = Object.values(tracked).filter((t) => t.status === 'NOT_YET_RELEASED').length;
    await notify('AniList alerts chalu ho gaye',
      `Site par ${Object.keys(map).length} anime\nIs run mein match: ${searches}, baqi: ${pendingSearch}\nAane wali track: ${up}\n\nAb har ghante check hoga.`, { tags: 'white_check_mark' });
    st.baseline = now;
  }

  // purane "sent" records saaf karo
  for (const k of Object.keys(sent)) if (now - sent[k] > 40 * DAY) delete sent[k];
  st.lastRun = now;
  await A.update({ state: st, map, tracked, sent });
  console.log(`Map: ${Object.keys(map).length} | Tracked: ${Object.keys(tracked).length} | Searches: ${searches} | Announces: ${announces.length}`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error(e);
  await notify('AniList alerts FAIL hue', String(e.message || e), { tags: 'x', priority: 'high' });
  process.exit(1);
});
