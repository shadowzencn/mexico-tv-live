import { CATEGORIES, CHANNELS } from './channels.js';

const DEFAULT_CHANNEL = 'imagen-tv';
const LOAD_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 9000;
// 由 serve.py 提供；静态托管时不存在，页面会退回到按频道嵌入 YouTube 直播
const YT_API = 'api/youtube-live';
const YT_CACHE_MS = 5 * 60 * 1000;
const STORE = { favorites: 'mxtv:favorites', last: 'mxtv:last-channel', theater: 'mxtv:theater' };

const STATUS_TEXT = {
  ok: '可播放',
  yt: 'YouTube',
  geo: '仅限墨西哥',
  down: '暂不可用',
  blocked: 'YouTube 不可达',
  ext: '官方平台',
  checking: '检测中',
};

const STATUS_HINT = {
  ok: '已检测到官方直播信号，可以直接播放',
  yt: '通过电视台官方 YouTube 频道播放，需要当前网络能访问 YouTube',
  geo: '电视台限制了播放地区，通常只能在墨西哥境内观看',
  down: '暂未检测到可用信号，频道可能临时停播',
  blocked: '当前网络无法访问 YouTube',
  ext: '没有可嵌入的公开信号，可前往官方平台观看',
  checking: '正在检测信号…',
};

// 选择信号源时的优先级：可直连的 HLS > 检测中的 HLS > YouTube > 其余
const SOURCE_RANK = ['ok', 'checking', 'yt', 'geo', 'down', 'blocked'];

const svg = (body, filled = false) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" ${
    filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

const STAR_PATH = '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>';

const ICON = {
  prev: svg('<path d="M15 18l-6-6 6-6"/>'),
  next: svg('<path d="M9 18l6-6-6-6"/>'),
  star: svg(STAR_PATH, true),
  starLine: svg(STAR_PATH),
  share: svg('<path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/>'),
  theater: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
  alert: svg('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>'),
  youtube: svg(
    '<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.6 2.6 0 0 0-1.8 1.8A27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8zM10 15V9l5.2 3z"/>',
    true,
  ),
};

const $ = (sel) => document.querySelector(sel);
const els = {
  layout: $('#layout'),
  shell: $('#player-shell'),
  player: $('#player'),
  media: $('#media'),
  ytHost: $('#yt-host'),
  overlay: $('#overlay'),
  unmute: $('#unmute'),
  ctxMenu: $('#ctx-menu'),
  stats: $('#stats'),
  statsBody: $('#stats-body'),
  now: $('#now'),
  chips: $('#chips'),
  list: $('#channel-list'),
  count: $('#count'),
  search: $('#search'),
  toast: $('#toast'),
  recheck: $('#btn-recheck'),
  clockMx: $('#clock-mx'),
  clockCn: $('#clock-cn'),
};

const state = {
  category: 'all',
  query: '',
  current: null,
  sourceIndex: -1,
  tried: new Set(),
  favorites: new Set(readJSON(STORE.favorites, [])),
  srcStatus: new Map(),
  ytReachable: null,
  interacted: false,
  loadTimer: 0,
  playToken: 0,
  fragsLoaded: 0,
  loadExtended: false,
  failed: false,
  lastHttpCode: 0,
  playerReady: false,
  engine: null,
  ytInfo: new Map(),
  ytApi: null,
  statsOn: false,
};

const probeCache = new Map();
const ytCache = new Map();
const isHls = (s) => s.type === 'hls';
const isYt = (s) => s.type === 'youtube';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channelById = (id) => CHANNELS.find((ch) => ch.id === id);
const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? '';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/* ---------- 信号状态 ---------- */

function sourceStatus(src) {
  if (isYt(src)) {
    if (state.ytReachable === false) return 'blocked';
    if (state.ytInfo.get(src.channelId)?.live === false) return 'down';
    return state.ytReachable === null ? 'checking' : 'yt';
  }
  return state.srcStatus.get(src.url) ?? 'checking';
}

function channelStatus(ch) {
  if (!ch.sources.length) return 'ext';
  const list = ch.sources.map(sourceStatus);
  for (const s of ['ok', 'checking', 'yt', 'geo']) if (list.includes(s)) return s;
  return list.includes('blocked') && !list.includes('down') ? 'blocked' : 'down';
}

function pickSourceIndex(ch) {
  let best = 0;
  let bestRank = Infinity;
  ch.sources.forEach((src, i) => {
    const rank = SOURCE_RANK.indexOf(sourceStatus(src));
    if (rank < bestRank) {
      best = i;
      bestRank = rank;
    }
  });
  return best;
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (res.status === 403 || res.status === 451) return 'geo';
    if (!res.ok) return 'down';
    const body = await res.text();
    return body.includes('#EXTM3U') ? 'ok' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

function probeSource(url, force = false) {
  if (!force && probeCache.has(url)) return probeCache.get(url);
  state.srcStatus.set(url, 'checking');
  const task = probe(url).then((status) => {
    state.srcStatus.set(url, status);
    scheduleRefresh();
    return status;
  });
  probeCache.set(url, task);
  return task;
}

function probeAll(force = false) {
  return Promise.allSettled(CHANNELS.flatMap((ch) => ch.sources.filter(isHls).map((s) => probeSource(s.url, force))));
}

// 用图片请求判断能否访问 YouTube（无需 CORS），国内网络环境下通常会失败。
function checkYouTube() {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 6000);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.referrerPolicy = 'no-referrer';
    img.src = `https://www.youtube.com/favicon.ico?_=${Date.now()}`;
  });
}

// 返回 { live, videoId }；接口不可用或解析失败时返回 null
function resolveYouTube(channelId) {
  if (state.ytApi === false) return Promise.resolve(null);
  const hit = ytCache.get(channelId);
  if (hit && performance.now() - hit.at < YT_CACHE_MS) return hit.task;
  const task = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${YT_API}?channel=${encodeURIComponent(channelId)}`, { cache: 'no-store', signal: ctrl.signal });
      if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
        state.ytApi = false;
        return null;
      }
      state.ytApi = true;
      if (!res.ok) return null;
      const info = await res.json();
      state.ytInfo.set(channelId, info);
      scheduleRefresh();
      return info;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  ytCache.set(channelId, { at: performance.now(), task });
  return task;
}

async function prefetchYouTube() {
  const ids = [...new Set(CHANNELS.flatMap((ch) => ch.sources.filter(isYt).map((s) => s.channelId)))];
  if (!ids.length || !(await resolveYouTube(ids[0])) || state.ytApi === false) return;
  await Promise.allSettled(ids.slice(1).map(resolveYouTube));
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    renderList();
    renderSources();
  });
}

/* ---------- 渲染 ---------- */

function tileHTML(ch, size = '') {
  const text = ch.logo.text;
  return `<span class="tile ${size}" data-len="${Math.min(text.length, 4)}" style="--from:${ch.logo.from};--to:${ch.logo.to}" aria-hidden="true">${esc(text)}</span>`;
}

function visibleChannels() {
  const q = normalize(state.query.trim());
  return CHANNELS.filter((ch) => {
    if (state.category === 'fav' && !state.favorites.has(ch.id)) return false;
    if (state.category !== 'all' && state.category !== 'fav' && ch.category !== state.category) return false;
    if (!q) return true;
    const category = CATEGORIES.find((c) => c.id === ch.category);
    const haystack = [ch.name, ch.zh, ch.network, ch.reach, ch.number ? `canal ${ch.number} 频道${ch.number}` : '', category?.label, category?.keywords, ...ch.tags].join(' ');
    return normalize(haystack).includes(q);
  });
}

function renderChips() {
  els.chips.innerHTML = CATEGORIES.map((c) => {
    const n =
      c.id === 'all' ? CHANNELS.length : c.id === 'fav' ? state.favorites.size : CHANNELS.filter((ch) => ch.category === c.id).length;
    return `<button class="chip" type="button" role="tab" data-cat="${c.id}" aria-selected="${state.category === c.id}">${
      c.id === 'fav' ? ICON.star : ''
    }${esc(c.label)}<b>${n}</b></button>`;
  }).join('');
}

function itemHTML(ch) {
  const status = channelStatus(ch);
  const active = state.current?.id === ch.id;
  const fav = state.favorites.has(ch.id);
  return `<li class="ch" role="option" tabindex="0" data-id="${ch.id}" aria-selected="${active}">
    ${tileHTML(ch)}
    <span class="ch-main">
      <span class="ch-name">${esc(ch.name)}<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></span>
      <span class="ch-sub">${esc(ch.zh)} · ${esc(ch.network)}</span>
    </span>
    <span class="ch-side">
      <span class="status" data-status="${status}" title="${esc(STATUS_HINT[status])}"><i></i><em>${STATUS_TEXT[status]}</em></span>
      <button class="fav" type="button" data-fav="${ch.id}" aria-pressed="${fav}" aria-label="${fav ? '取消收藏' : '收藏'} ${esc(ch.name)}">${
        fav ? ICON.star : ICON.starLine
      }</button>
    </span>
  </li>`;
}

function renderList() {
  const focusedId = document.activeElement?.closest?.('.ch')?.dataset.id;
  const items = visibleChannels();
  const playable = CHANNELS.filter((ch) => ['ok', 'yt'].includes(channelStatus(ch))).length;
  els.count.textContent = `${CHANNELS.length} 个 · ${playable} 个可播放`;

  if (!items.length) {
    els.list.innerHTML = `<li class="empty">${
      state.category === 'fav' && !state.query ? '还没有收藏的频道。<br />点击频道右侧的星标即可收藏。' : '没有找到匹配的频道，换个关键词试试。'
    }</li>`;
    return;
  }

  const grouped = state.category === 'all' && !state.query.trim();
  let html = '';
  let lastCategory = '';
  for (const ch of items) {
    if (grouped && ch.category !== lastCategory) {
      html += `<li class="group-title" role="presentation">${esc(categoryLabel(ch.category))}</li>`;
      lastCategory = ch.category;
    }
    html += itemHTML(ch);
  }
  els.list.innerHTML = html;
  if (focusedId) els.list.querySelector(`.ch[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
}

function renderNow() {
  const ch = state.current;
  if (!ch) return;
  const fav = state.favorites.has(ch.id);
  const meta = [ch.network, ch.number ? `频道 ${ch.number}` : '', ch.reach, '西班牙语'].filter(Boolean).join(' · ');
  els.now.innerHTML = `
    <div class="now-head">
      ${tileHTML(ch, 'tile-lg')}
      <div class="now-title">
        <div class="now-kicker">
          ${ch.sources.length ? '<span class="live-pill"><i></i>LIVE 直播</span>' : '<span class="ext-pill">官方平台观看</span>'}
          <span>${esc(categoryLabel(ch.category))}</span>
        </div>
        <h1>${esc(ch.name)}<span class="zh">${esc(ch.zh)}</span></h1>
        <p class="now-sub">${esc(meta)}</p>
      </div>
      <div class="now-actions">
        <button class="btn icon" type="button" data-action="prev" title="上一个频道（[）" aria-label="上一个频道">${ICON.prev}</button>
        <button class="btn icon" type="button" data-action="next" title="下一个频道（]）" aria-label="下一个频道">${ICON.next}</button>
        <button class="btn" type="button" data-action="fav" aria-pressed="${fav}">${fav ? ICON.star : ICON.starLine}<span class="lbl">${
          fav ? '已收藏' : '收藏'
        }</span></button>
        <button class="btn" type="button" data-action="theater" aria-pressed="${isTheater()}" title="剧场模式（T）">${ICON.theater}<span class="lbl">剧场模式</span></button>
        <button class="btn" type="button" data-action="share">${ICON.share}<span class="lbl">分享</span></button>
        <a class="btn" href="${esc(ch.website)}" target="_blank" rel="noopener noreferrer">${ICON.external}<span class="lbl">官网</span></a>
      </div>
    </div>
    <p class="now-intro">${esc(ch.intro)}</p>
    <div class="now-tags">${ch.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="now-sources" id="now-sources"></div>`;
  renderSources();
}

function sourceNote(src) {
  if (isYt(src) && state.ytInfo.get(src.channelId)?.live === false) return '电视台的 YouTube 频道此刻没有直播，可以稍后再试，或切换到其他信号源。';
  if (src.note) return src.note;
  if (isYt(src)) return '通过电视台官方 YouTube 频道播放。如果画面无法加载，可能是当前网络无法访问 YouTube，或频道此刻没有直播。';
  return '官方 HLS 直播信号，支持画质切换、画中画和全屏，按 [ 或 ] 可以快速换台。';
}

function renderSources() {
  const box = document.getElementById('now-sources');
  const ch = state.current;
  if (!box || !ch) return;
  if (!ch.sources.length) {
    box.innerHTML = `<span class="label">信号源</span>
      <p class="source-note">这个频道没有可以公开嵌入的直播信号，请前往 <a href="${esc(ch.watch.url)}" target="_blank" rel="noopener noreferrer">${esc(
        ch.watch.label,
      )}</a> 观看（通常需要在墨西哥境内或登录账号）。</p>`;
    return;
  }
  const current = ch.sources[state.sourceIndex] ?? ch.sources[0];
  box.innerHTML = `<span class="label">信号源</span>
    <div class="seg" role="radiogroup" aria-label="选择信号源">
      ${ch.sources
        .map((src, i) => {
          const status = sourceStatus(src);
          return `<button class="seg-btn" type="button" role="radio" data-source="${i}" aria-checked="${i === state.sourceIndex}" title="${esc(
            STATUS_HINT[status],
          )}">
            <span class="dot" data-status="${status}"></span>
            ${isYt(src) ? `<span class="yt-mark">${ICON.youtube}</span>` : ''}
            <span>信号 ${i + 1} · ${esc(src.label)}</span>
            ${src.quality ? `<small>${esc(src.quality)}</small>` : ''}
          </button>`;
        })
        .join('')}
    </div>
    <div class="src-foot">
      <p class="source-note">${esc(sourceNote(current))}</p>
      ${isHls(current) ? `<button class="btn small" type="button" data-action="copy-src">${ICON.copy}复制播放地址</button>` : ''}
    </div>`;
}

/* ---------- 播放控制 ---------- */

function setMode(mode) {
  els.shell.dataset.mode = mode;
  if (mode !== 'hls') els.unmute.hidden = true;
}

function showOverlay(html) {
  els.overlay.innerHTML = html;
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
  els.overlay.innerHTML = '';
}

function loadingHTML(message) {
  return `<div class="overlay-card"><span class="spinner" aria-hidden="true"></span><p>${esc(message)}</p></div>`;
}

function stopHls() {
  clearTimeout(state.loadTimer);
  if (!state.playerReady) return;
  els.media.pause();
  els.media.source = null;
}

function unmountYouTube() {
  els.ytHost.innerHTML = '';
}

// 有具体的直播视频 ID 时直接嵌入该视频，比按频道嵌入（live_stream?channel=）更稳定
function mountYouTube(ch, src, videoId) {
  const params = new URLSearchParams({ autoplay: '1', mute: state.interacted ? '0' : '1', playsinline: '1', rel: '0' });
  let path = `embed/${encodeURIComponent(videoId)}`;
  if (!videoId) {
    path = 'embed/live_stream';
    params.set('channel', src.channelId);
  }
  els.ytHost.innerHTML = `<iframe src="https://www.youtube.com/${path}?${params}" title="${esc(
    ch.name,
  )} 官方 YouTube 直播" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

async function playYouTube(ch, src, force) {
  const token = state.playToken;
  showOverlay(loadingHTML('正在连接官方 YouTube 直播…'));
  const info = await resolveYouTube(src.channelId);
  if (token !== state.playToken) return;
  hideOverlay();
  if (info?.live === false && !force) {
    renderSources();
    showYouTubeOffline(ch);
    return;
  }
  mountYouTube(ch, src, info?.videoId ?? '');
}

function playSource(index, { force = false } = {}) {
  const ch = state.current;
  const src = ch.sources[index];
  state.playToken += 1;
  state.sourceIndex = index;
  state.failed = false;
  state.lastHttpCode = 0;
  state.fragsLoaded = 0;
  state.loadExtended = false;
  clearTimeout(state.loadTimer);
  hideOverlay();
  renderSources();

  if (!src) {
    showExternal(ch);
    return;
  }

  if (isYt(src)) {
    stopHls();
    unmountYouTube();
    setMode('youtube');
    if (state.ytReachable === false && !force) {
      showYouTubeBlocked(ch);
      return;
    }
    playYouTube(ch, src, force);
    return;
  }

  unmountYouTube();
  setMode('hls');
  // 检测已确认不可用的信号直接走失败流程，不必让用户白等加载超时；手动重试时仍会强制尝试
  const known = state.srcStatus.get(src.url);
  if (!force && (known === 'geo' || known === 'down')) {
    fail(known === 'geo' ? 'geo' : 'error');
    return;
  }
  if (!state.playerReady) return;
  els.media.title = `${ch.name} · ${ch.zh}`;
  els.media.source = {
    src: src.url,
    type: 'application/x-mpegurl',
    // 按播放器尺寸限制自动画质，避免小窗口也去下载 1080p
    capRenditionToPlayerSize: true,
    engine: { hlsJs: { backBufferLength: 30 } },
  };
  state.loadTimer = setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
}

function showExternal(ch) {
  stopHls();
  unmountYouTube();
  setMode('external');
  showOverlay(`<div class="overlay-card">
      ${tileHTML(ch, 'tile-xl')}
      <h3>${esc(ch.name)} 暂无可嵌入的公开直播信号</h3>
      <p>该频道的官方直播只在自有平台提供，通常需要在墨西哥境内或登录账号观看。</p>
      <div class="actions">
        <a class="btn primary" href="${esc(ch.watch.url)}" target="_blank" rel="noopener noreferrer">${ICON.external}前往${esc(ch.watch.label)}</a>
        <button class="btn" type="button" data-action="next">${ICON.next}看下一个频道</button>
      </div>
    </div>`);
}

function showYouTubeBlocked(ch) {
  showOverlay(`<div class="overlay-card">
      <span class="overlay-icon">${ICON.youtube}</span>
      <h3>当前网络无法访问 YouTube</h3>
      <p>${esc(ch.name)} 通过电视台官方 YouTube 频道直播，需要当前网络能够访问 YouTube。可以先看看其他频道。</p>
      <div class="actions">
        <button class="btn primary" type="button" data-action="force">${ICON.retry}仍然尝试</button>
        <button class="btn" type="button" data-action="next">${ICON.next}下一个频道</button>
      </div>
    </div>`);
}

function showYouTubeOffline(ch) {
  showOverlay(`<div class="overlay-card">
      <span class="overlay-icon">${ICON.youtube}</span>
      <h3>${esc(ch.name)} 的 YouTube 频道此刻没有直播</h3>
      <p>频道可能处在节目间隙、休会期或临时停播。可以稍后再来，或先看看其他频道。</p>
      <div class="actions">
        <button class="btn primary" type="button" data-action="force">${ICON.youtube}仍然打开</button>
        <a class="btn" href="${esc(ch.website)}" target="_blank" rel="noopener noreferrer">${ICON.external}官网</a>
        <button class="btn" type="button" data-action="next">${ICON.next}下一个频道</button>
      </div>
    </div>`);
}

function showError(ch, reason) {
  const geo = reason === 'geo';
  showOverlay(`<div class="overlay-card">
      <span class="overlay-icon">${geo ? ICON.globe : ICON.alert}</span>
      <h3>${geo ? '这路信号仅限墨西哥境内播放' : '信号暂时无法播放'}</h3>
      <p>${
        geo
          ? `${esc(ch.name)} 对网页直播设置了地区限制，当前网络位置无法观看。可以前往官网，或先看看其他频道。`
          : '可能是频道临时停播、网络不稳定，或当前网络连不上信号服务器。可以稍后重试，或先看看其他频道。'
      }</p>
      <div class="actions">
        <button class="btn primary" type="button" data-action="retry">${ICON.retry}重新连接</button>
        <a class="btn" href="${esc(ch.website)}" target="_blank" rel="noopener noreferrer">${ICON.external}官网</a>
        <button class="btn" type="button" data-action="next">${ICON.next}下一个频道</button>
      </div>
    </div>`);
}

function fail(reason) {
  const ch = state.current;
  const src = ch?.sources[state.sourceIndex];
  if (state.failed || !src || !isHls(src)) return;
  state.failed = true;
  clearTimeout(state.loadTimer);
  state.srcStatus.set(src.url, reason === 'geo' ? 'geo' : 'down');
  state.tried.add(state.sourceIndex);
  scheduleRefresh();

  const next = ch.sources.findIndex((s, i) => !state.tried.has(i) && !['blocked', 'geo'].includes(sourceStatus(s)));
  if (next !== -1) {
    toast(`信号 ${state.sourceIndex + 1} ${reason === 'geo' ? '受地区限制' : '暂时无法播放'}，已切换到信号 ${next + 1}`);
    playSource(next);
    return;
  }
  stopHls();
  showError(ch, reason);
}

function onReady() {
  const src = state.current?.sources[state.sourceIndex];
  if (els.shell.dataset.mode !== 'hls' || !src || !isHls(src) || state.failed) return;
  clearTimeout(state.loadTimer);
  if (state.srcStatus.get(src.url) !== 'ok') {
    state.srcStatus.set(src.url, 'ok');
    scheduleRefresh();
  }
}

function onLoadTimeout() {
  // 高码率信号的首个分片可能要下载很久，只要分片还在陆续到达就再多等一轮
  if (state.fragsLoaded > 0 && !state.loadExtended) {
    state.loadExtended = true;
    toast('信号较慢，正在缓冲…');
    state.loadTimer = setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
    return;
  }
  fail('timeout');
}

function selectChannel(id) {
  const ch = channelById(id);
  if (!ch) return;
  if (state.current?.id === ch.id && state.sourceIndex !== -1 && els.overlay.hidden) return;
  state.current = ch;
  state.tried = new Set();
  writeJSON(STORE.last, ch.id);
  if (location.hash !== `#/${ch.id}`) history.replaceState(null, '', `#/${ch.id}`);
  document.title = `${ch.name} · ${ch.zh} | 墨西哥电视直播`;
  renderNow();
  renderList();
  scrollActiveIntoView();
  playSource(ch.sources.length ? pickSourceIndex(ch) : -1);
}

function step(direction) {
  let list = visibleChannels();
  if (!list.some((ch) => ch.id === state.current?.id)) list = CHANNELS;
  const i = list.findIndex((ch) => ch.id === state.current?.id);
  selectChannel(list[(i + direction + list.length) % list.length].id);
}

function scrollActiveIntoView() {
  const box = els.list;
  const item = box.querySelector('.ch[aria-selected="true"]');
  if (!item || box.scrollHeight <= box.clientHeight + 1) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < box.scrollTop + 8) box.scrollTo({ top: top - 40, behavior: 'smooth' });
  else if (bottom > box.scrollTop + box.clientHeight - 8) box.scrollTo({ top: bottom - box.clientHeight + 12, behavior: 'smooth' });
}

/* ---------- 收藏 / 剧场 / 分享 ---------- */

function toggleFavorite(id) {
  const ch = channelById(id);
  if (!ch) return;
  const added = !state.favorites.has(id);
  if (added) state.favorites.add(id);
  else state.favorites.delete(id);
  writeJSON(STORE.favorites, [...state.favorites]);
  renderChips();
  renderList();
  if (state.current?.id === id) {
    const btn = els.now.querySelector('[data-action="fav"]');
    if (btn) {
      btn.setAttribute('aria-pressed', String(added));
      btn.innerHTML = `${added ? ICON.star : ICON.starLine}<span class="lbl">${added ? '已收藏' : '收藏'}</span>`;
    }
  }
  toast(added ? `已收藏 ${ch.name}` : `已取消收藏 ${ch.name}`);
}

const isTheater = () => els.layout.classList.contains('is-theater');

function applyTheater(on) {
  els.layout.classList.toggle('is-theater', on);
  document.querySelectorAll('[data-action="theater"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

function toggleTheater() {
  const on = !isTheater();
  applyTheater(on);
  writeJSON(STORE.theater, on);
  toast(on ? '已开启剧场模式，按 T 退出' : '已退出剧场模式');
}

async function share() {
  const url = location.href;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: document.title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('链接已复制，发给朋友就能直接打开这个频道');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('复制失败，请手动复制地址栏中的链接');
  }
}

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

/* ---------- 播放地址与统计信息 ---------- */

let statsTimer = 0;

function currentHlsUrl() {
  const src = state.current?.sources[state.sourceIndex];
  return src && isHls(src) ? src.url : '';
}

// 局域网 IP 或 http 页面下 navigator.clipboard 不可用，退回到选中文本再执行复制命令
function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

async function copyText(text, okMessage) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    toast(legacyCopy(text) ? okMessage : '复制失败，请手动复制');
  }
}

function copySource() {
  const url = currentHlsUrl();
  if (!url) {
    toast('当前信号没有可复制的播放地址');
    return;
  }
  copyText(url, '播放地址已复制');
}

const fmtBps = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

function bufferedAhead(video) {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) return video.buffered.end(i) - t;
  }
  return 0;
}

function statsRows() {
  const ch = state.current;
  const src = ch?.sources[state.sourceIndex];
  if (!src || !isHls(src)) return [['状态', '当前不是 HLS 直连信号，统计信息不可用']];
  const video = els.media;
  const store = els.player.store;
  const q = store?.activeVideoRendition;
  const hls = video.engine;
  // <hlsjs-video> 把真正的 <video> 放在 Shadow DOM 里，丢帧数需要从它上面读取
  const vq = (video.shadowRoot?.querySelector('video') ?? video).getVideoPlaybackQuality?.();
  return [
    ['频道', `${ch.name} · ${ch.zh}`],
    ['信号源', `${src.label}${src.quality ? ` · ${src.quality}` : ''}`],
    ['播放地址', src.url],
    ['播放器', 'Video.js 10 + hls.js'],
    ['状态', store?.waiting ? '缓冲中' : video.paused ? '已暂停' : '播放中'],
    ['分辨率', video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : '—'],
    ['当前画质', q?.height ? `${q.height}p${q.bitrate ? ` · ${fmtBps(q.bitrate)}` : ''}` : '自动'],
    ['带宽估计', hls?.bandwidthEstimate ? fmtBps(hls.bandwidthEstimate) : '—'],
    ['缓冲余量', `${bufferedAhead(video).toFixed(1)} 秒`],
    ['已加载分片', String(state.fragsLoaded)],
    ['丢帧', vq ? `${vq.droppedVideoFrames} / ${vq.totalVideoFrames}` : '—'],
    ['音量', video.muted ? '静音' : `${Math.round(video.volume * 100)}%`],
  ];
}

function renderStats() {
  if (!state.statsOn) return;
  els.statsBody.innerHTML = statsRows()
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
}

function setStats(on) {
  state.statsOn = on;
  els.stats.hidden = !on;
  clearInterval(statsTimer);
  if (on) {
    renderStats();
    statsTimer = setInterval(renderStats, 1000);
  }
}

function hideMenu() {
  els.ctxMenu.hidden = true;
}

function showMenu(x, y) {
  const menu = els.ctxMenu;
  menu.querySelector('[data-ctx="copy"]').disabled = !currentHlsUrl();
  menu.querySelector('[data-ctx="stats"]').textContent = state.statsOn ? '关闭统计信息' : '统计信息';
  menu.hidden = false;
  const box = els.shell.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, box.width - menu.offsetWidth - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, box.height - menu.offsetHeight - 6))}px`;
}

function bindPlayerMenu() {
  // 只在 HLS 直连时接管右键菜单；YouTube 和报错页保留浏览器原生行为
  els.shell.addEventListener('contextmenu', (e) => {
    if (els.shell.dataset.mode !== 'hls' || !els.overlay.hidden) return;
    e.preventDefault();
    const box = els.shell.getBoundingClientRect();
    showMenu(e.clientX - box.left, e.clientY - box.top);
  });

  els.ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ctx]');
    if (!item || item.disabled) return;
    hideMenu();
    if (item.dataset.ctx === 'copy') copySource();
    if (item.dataset.ctx === 'stats') setStats(!state.statsOn);
  });

  els.stats.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn) return;
    if (btn.dataset.ctx === 'copy') copySource();
    if (btn.dataset.ctx === 'stats-close') setStats(false);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!els.ctxMenu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, { passive: true });
}

/* ---------- 时钟 ---------- */

function startClock() {
  const make = (timeZone) => new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const mx = make('America/Mexico_City');
  const cn = make('Asia/Shanghai');
  const tick = () => {
    const now = new Date();
    els.clockMx.textContent = mx.format(now);
    els.clockCn.textContent = cn.format(now);
  };
  tick();
  setInterval(tick, 10000);
}

/* ---------- 事件绑定 ---------- */

function idFromHash() {
  try {
    return decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  } catch {
    return '';
  }
}

function handleAction(action, target) {
  switch (action) {
    case 'prev':
      step(-1);
      break;
    case 'next':
      step(1);
      break;
    case 'fav':
      toggleFavorite(state.current.id);
      break;
    case 'theater':
      toggleTheater();
      break;
    case 'share':
      share();
      break;
    case 'copy-src':
      copySource();
      break;
    case 'retry':
      state.tried = new Set();
      state.current.sources.filter(isHls).forEach((s) => probeSource(s.url, true));
      playSource(state.sourceIndex >= 0 ? state.sourceIndex : pickSourceIndex(state.current), { force: true });
      break;
    case 'force':
      playSource(state.sourceIndex, { force: true });
      break;
    case 'source': {
      const i = Number(target.dataset.source);
      state.tried = new Set();
      if (i !== state.sourceIndex || !els.overlay.hidden) playSource(i, { force: true });
      break;
    }
  }
}

// 全页面可用的 空格 / M / F / I；焦点在播放器内时皮肤已处理并阻止默认行为，这里不会再次触发
function playerKey(e) {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (!['m', 'f', 'i', ' '].includes(key)) return;
  if (key === ' ' && e.target instanceof HTMLElement && e.target.closest('button, a, input, select, textarea, [role="option"], [role="radio"]')) return;
  const media = els.media;
  const store = els.player.store;
  const run = (promise) => promise?.catch?.(() => {});
  e.preventDefault();
  if (key === ' ') {
    if (media.paused) tryPlay();
    else media.pause();
  } else if (key === 'm') {
    media.muted = !media.muted;
  } else if (key === 'f') {
    run(store?.isFullscreen ? store.exitFullscreen() : store?.requestFullscreen());
  } else if (key === 'i') {
    run(store?.isPictureInPicture ? store.exitPictureInPicture() : store?.requestPictureInPicture());
  }
}

function bindUI() {
  bindPlayerMenu();
  const markInteracted = () => {
    state.interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  window.addEventListener('keydown', markInteracted, { once: true, capture: true });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.dataset.cat;
    renderChips();
    renderList();
  });

  els.list.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
    const item = e.target.closest('.ch');
    if (item) selectChannel(item.dataset.id);
  });

  // 拦截列表内的按键，防止播放器的全局快捷键（空格、方向键）被同时触发
  els.list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.ch');
    if (!item || e.target.closest('[data-fav]')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      selectChannel(item.dataset.id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const items = [...els.list.querySelectorAll('.ch')];
      const i = items.indexOf(item);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderList();
  });
  els.search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      els.search.value = '';
      state.query = '';
      renderList();
      els.search.blur();
    } else if (e.key === 'Enter') {
      const first = visibleChannels()[0];
      if (first) selectChannel(first.id);
      els.search.blur();
    }
  });

  els.now.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-source]');
    if (!el) return;
    handleAction(el.dataset.action ?? 'source', el);
  });

  els.overlay.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) handleAction(el.dataset.action, el);
  });

  els.unmute.addEventListener('click', () => {
    els.media.muted = false;
    if (els.media.volume < 0.2) els.media.volume = 0.8;
    els.unmute.hidden = true;
  });

  els.recheck.addEventListener('click', async () => {
    if (els.recheck.classList.contains('spinning')) return;
    els.recheck.classList.add('spinning');
    toast('正在重新检测所有频道的信号…');
    state.ytReachable = null;
    ytCache.clear();
    state.ytInfo.clear();
    const yt = checkYouTube().then((ok) => {
      state.ytReachable = ok;
      return ok && prefetchYouTube();
    });
    const all = probeAll(true);
    scheduleRefresh();
    await Promise.allSettled([all, yt]);
    scheduleRefresh();
    els.recheck.classList.remove('spinning');
    const ok = CHANNELS.filter((ch) => channelStatus(ch) === 'ok').length;
    toast(`检测完成：${ok} 个频道可直连播放${state.ytReachable ? '，YouTube 可正常访问' : '，当前网络无法访问 YouTube'}`);
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === '/') {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    } else if (e.key === ']' || e.key === 'PageDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === '[' || e.key === 'PageUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 't' || e.key === 'T') {
      toggleTheater();
    } else if (els.shell.dataset.mode === 'hls') {
      playerKey(e);
    }
  });

  window.addEventListener('hashchange', () => {
    const id = idFromHash();
    if (id && id !== state.current?.id) selectChannel(id);
  });
}

// hls.js 实例在每次加载新源时重建，所以每次 loadstart 都重新绑定统计和错误事件
function bindEngine() {
  const hls = els.media.engine;
  if (!hls || hls === state.engine) return;
  state.engine = hls;
  hls.on('hlsFragLoaded', () => {
    state.fragsLoaded += 1;
  });
  hls.on('hlsError', (_event, data) => {
    if (!data?.fatal) return;
    state.lastHttpCode = data.response?.code ?? 0;
    const src = state.current?.sources[state.sourceIndex];
    if (els.shell.dataset.mode !== 'hls' || !src || !isHls(src)) return;
    fail(state.lastHttpCode === 403 || state.lastHttpCode === 451 ? 'geo' : 'error');
  });
}

// 先尝试带声音播放；被浏览器拦截时静音再播，并显示“点击开启声音”
async function tryPlay() {
  const media = els.media;
  try {
    await media.play();
  } catch {
    if (media.muted) return;
    media.muted = true;
    try {
      await media.play();
    } catch {
      /* 静音后仍无法自动播放时，保留播放按钮让用户手动点击 */
    }
  }
}

function setupPlayer() {
  const media = els.media;

  media.addEventListener('loadstart', bindEngine);

  // 首帧到达即视为信号可用，并尝试开始播放
  media.addEventListener('loadeddata', () => {
    onReady();
    if (els.shell.dataset.mode === 'hls') tryPlay();
  });
  media.addEventListener('playing', () => {
    onReady();
    if (media.muted && els.shell.dataset.mode === 'hls') els.unmute.hidden = false;
  });

  media.addEventListener('error', () => {
    const src = state.current?.sources[state.sourceIndex];
    if (els.shell.dataset.mode !== 'hls' || !src || !isHls(src)) return;
    const active = media.src;
    if (active && active !== src.url) return;
    fail(state.lastHttpCode === 403 || state.lastHttpCode === 451 ? 'geo' : 'error');
  });

  media.addEventListener('volumechange', () => {
    if (!media.muted) els.unmute.hidden = true;
  });

  state.playerReady = true;
}

async function init() {
  applyTheater(readJSON(STORE.theater, false) === true);
  renderChips();
  bindUI();
  startClock();

  const initial = channelById(idFromHash()) ?? channelById(readJSON(STORE.last, '')) ?? channelById(DEFAULT_CHANNEL) ?? CHANNELS[0];
  state.current = initial;
  renderNow();
  renderList();
  showOverlay(loadingHTML('正在检测直播信号…'));

  const ytCheck = checkYouTube().then((ok) => {
    state.ytReachable = ok;
    scheduleRefresh();
    if (ok) prefetchYouTube();
    else toast('当前网络无法访问 YouTube，已优先使用官方直连信号');
  });
  probeAll();

  await Promise.all(['video-player', 'video-skin', 'hlsjs-video'].map((tag) => customElements.whenDefined(tag)));
  setupPlayer();

  // 稍等首个频道的检测结果，这样开播就能选中最合适的信号源
  const initialChecks = initial.sources.map((s) => (isHls(s) ? probeSource(s.url) : ytCheck));
  await Promise.race([Promise.allSettled(initialChecks), sleep(4000)]);
  state.current = null;
  selectChannel(initial.id);
}

init();
