'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 18086);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
const SECRET_PATH = path.join(DATA_DIR, '.secret');

const SESSION_DAYS = Math.min(Math.max(Number(process.env.SESSION_DAYS || 30), 1), 365);
const MAX_BODY = Number(process.env.MAX_BODY || 8 * 1024 * 1024);
const MAX_CONFIG = 1024 * 1024;
const COOKIE_NAME = 'nav_session';
// 容器名既是查看也是启停的凭据，字符集收紧到 Docker 自己允许的那套
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_ACCOUNT = 'admin';
// 首次启动（auth.json 还不存在，或升级前那份没有账号）时用的账号名
const INITIAL_ACCOUNT = String(process.env.NAV_USER || DEFAULT_ACCOUNT).trim() || DEFAULT_ACCOUNT;

const LIM = {
  text: 200,
  url: 2000,
  name: 60,
  note: 20000,
  groups: 120,
  linksPerGroup: 300,
  dockerItems: 60,
  resRows: 40,
  engines: 40,
  todos: 300,
};

// 容器组件各自摆在主页上，长宽和坐标都按 px 存：这里给单张组件的范围，前端的滑块照这一套给刻度。
// canvasW / gap 只在做兼容时用一次——早期配置里没有坐标，摘出来时按这一档宽度从左到右排一排。
const DK = {
  tileMinW: 120,
  tileMaxW: 900,
  tileDefW: 250,
  tileMinH: 64,
  tileMaxH: 600,
  tileDefH: 118,
  posMin: 0,
  posMax: 4000,
  canvasW: 1440,
  gap: 16,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`无法写入数据目录 ${DATA_DIR}：${e.code || e.message}`);
  console.error('请检查挂载目录权限，例如在 NAS 上执行：chmod 700 ./data（非 root 运行时还需 chown 对应 uid）');
  process.exit(1);
}

function txt(v, max = LIM.text) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function cleanId(v, fallback) {
  const s = txt(v, 40);
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : fallback;
}

function urlish(v) {
  const s = txt(v, LIM.url).trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^(https?|file|magnet|ftp):\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  return 'http://' + s;
}

function num(v, min, max, fallback) {
  // 空串/空缺都按「没填」走回落：Number('') 是 0，不先挡一道会把空字段悄悄钳成下限
  const s = typeof v === 'string' ? v.trim() : v;
  if (s === '' || s === null || s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function colorOr(v, fallback) {
  const s = txt(v, 32);
  return /^(#[0-9a-f]{3,8}|hsla?\([^)]{1,24}\)|[a-z]{3,20})$/i.test(s) ? s : fallback;
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function sha1Short(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

/* 手写 config.json 时允许 id 缺省：用内容派生一个稳定 id，避免每次读取都变 */
function takeId(prefix, raw, seed, used) {
  const s = txt(raw, 40);
  let id = /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : prefix + '_' + sha1Short(seed);
  let i = 0;
  while (used.has(id)) id = prefix + '_' + sha1Short(seed + '#' + ++i);
  used.add(id);
  return id;
}

const pick = (o, keys) => {
  for (const k of keys) {
    const v = o ? o[k] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const guessIconKind = (icon) => {
  const s = String(icon).trim();
  if (/^(data:|\/|https?:\/\/|www\.)/i.test(s)) return 'image';
  if (/\.[a-z0-9]{2,5}$/i.test(s.split('?')[0])) return 'image';
  return [...s].length <= 4 ? 'emoji' : '';
};

// 图标可以是上传/相对路径/外链，也允许手写的 data:image
const iconSrc = (v) => {
  const s = String(v).trim();
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{1,40000}$/i.test(s) ? s : urlish(s);
};

// 图标字段：分组没有网址可猜，所以兜底档由调用方给
const normIcon = (o, defaultKind) => {
  const iconRaw = String(pick(o, ['icon', 'emoji', 'img', 'image', 'logo', 'src'])).trim();
  const kindExplicit = pick(o, ['iconKind', 'icon_kind']);
  const kind = ['emoji', 'image', 'auto', 'letter'].includes(kindExplicit)
    ? kindExplicit
    : iconRaw
      ? guessIconKind(iconRaw) || 'emoji'
      : defaultKind;
  const icon = kind === 'emoji' ? txt(iconRaw, 16) : kind === 'image' ? iconSrc(iconRaw) : '';
  return { icon, iconKind: kind };
};

const normLink = (l, used) => {
  const o = typeof l === 'string' ? { url: l } : l && typeof l === 'object' ? l : {};
  const title = txt(pick(o, ['title', 'name', 'label', 'text']), LIM.text);
  const url = urlish(pick(o, ['url', 'href', 'link', 'to']));
  const urlLan = urlish(pick(o, ['urlLan', 'url_lan', 'lanUrl', 'lan_url']));
  const rawContainer = txt(pick(o, ['container', 'containerName', 'container_name', 'docker']), 64);
  // 容器名同时是查询和启停的凭据，字符集收紧到 Docker 自己允许的那套
  const container = CONTAINER_NAME_RE.test(rawContainer) ? rawContainer : '';
  const { icon, iconKind } = normIcon(o, url || urlLan ? 'auto' : 'emoji');
  const out = {
    id: takeId('l', o.id !== undefined ? o.id : o.key, (container ? '容器:' + container : url) + '|' + title, used),
    title: title || hostOf(url || urlLan) || url || urlLan || container || '未命名',
    url,
    icon,
    iconKind,
    desc: txt(pick(o, ['desc', 'note', 'subtitle', 'description', 'remark']), LIM.text),
  };
  // 内网网址为空时整个字段不写回，免得规范化把手写的 config.json 塞满空键
  if (urlLan) out.urlLan = urlLan;
  if (container) out.container = container;
  return out;
};

const normGroup = (g, used, linkIds) => {
  const o = typeof g === 'string' ? { name: g } : g && typeof g === 'object' ? g : {};
  const rawLinks = Array.isArray(o.links) ? o.links : Array.isArray(o.items) ? o.items : Array.isArray(o.tiles) ? o.tiles : [];
  const name = txt(pick(o, ['name', 'title', 'label']), LIM.name) || '未命名分组';
  const { icon, iconKind } = normIcon(o, 'letter');
  const netRaw = pick(o, ['netMode', 'net_mode', 'mode']);
  const netMode = netRaw === 'lan' || netRaw === 'wan' ? netRaw : '';
  const out = {
    id: takeId('g', o.id !== undefined ? o.id : o.key, name, used),
    name,
  };
  // 没图/跟随全局时不写空键，手改的 config.json 保持清爽
  if (icon) {
    out.icon = icon;
    out.iconKind = iconKind;
  }
  if (netMode) out.netMode = netMode;
  out.collapsed = Boolean(pick(o, ['collapsed', 'folded']));
  out.links = rawLinks.slice(0, LIM.linksPerGroup).map((l) => normLink(l, linkIds));
  return out;
};

// Docker 组件的一张卡：字段沿用链接那套（标题 / 图标 / 顺带的网址 / 绑的容器），
// 末尾再挂自己的宽高与坐标——组件不住在窗口里了，各摆各的，所以手改 config.json 时
// 一眼看得出这张卡多大、摆在页面哪个位置。
// 这四个数要从没规范化过的那一份读：normLink 只认链接那几个字段，w / x 会被它先丢掉。
// 老配置只有窗口宽高、每张卡没有坐标：一律按画布宽度从左到右补一排，不然所有组件会叠在页面左上角。
// 补出来只剩一次（写回以后每张卡都自带坐标了），所以幂等。
const withDkBox = (out, from, cur) => {
  const s = from && typeof from === 'object' ? from : out;
  out.w = Math.round(num(pick(s, ['w', 'width']), DK.tileMinW, DK.tileMaxW, DK.tileDefW));
  out.h = Math.round(num(pick(s, ['h', 'height']), DK.tileMinH, DK.tileMaxH, DK.tileDefH));
  const x = num(pick(s, ['x']), DK.posMin, DK.posMax, NaN);
  const y = num(pick(s, ['y']), DK.posMin, DK.posMax, NaN);
  if (Number.isFinite(x) || Number.isFinite(y)) {
    out.x = Math.round(num(x, DK.posMin, DK.posMax, 0));
    out.y = Math.round(num(y, DK.posMin, DK.posMax, 0));
    return out;
  }
  if (cur.x > 0 && cur.x + out.w > DK.canvasW) {
    cur.y += cur.rowH + DK.gap;
    cur.x = 0;
    cur.rowH = 0;
  }
  out.x = cur.x;
  out.y = cur.y;
  cur.x += out.w + DK.gap;
  cur.rowH = Math.max(cur.rowH, out.h);
  return out;
};

// 资源组件的四种：内存 / 单个卷 / 整台 NAS 总览是三种固定卡，custom 那一张画哪几行由 rows 说了算。
// 跟容器组件同住 docker.items，靠 res 区分。
const DK_RES = new Set(['mem', 'vol', 'overview', 'custom']);
const RES_TITLE = { mem: '内存', overview: 'NAS 总览', custom: '自定义读数' };
// 卷 id 和盘名共用这一份字符集：只跟服务端读数里的名字精确比对，从不拼成路径；斜杠和打头的点照样挡在门外，读代码的人不用去找第二道保险
const ID_SRC = '[A-Za-z0-9][A-Za-z0-9_.-]{0,59}';
const VOL_ID_RE = new RegExp(`^${ID_SRC}$`);
// 勾选行的词汇表：四个整机指标、每卷一行 / 每盘一行两档，再加上点名的某一卷、某一块盘。
// 拼进分支里的片段必须不带锚：^…$ 落在 alternation 中间就等于永远匹配不上
const RES_ROW_RE = new RegExp(`^(?:mem|cpu|net|gpu|vols|disks|vol:${ID_SRC}|disk:${ID_SRC})$`);

// 只写一个容器名的简写也算一条：{ items: ['nginx'] }
const normDockerItem = (l, used, cur) => {
  const o = typeof l === 'string' ? { container: l } : l && typeof l === 'object' ? l : {};
  const out = normLink(o, used);
  const res = DK_RES.has(String(o.res)) ? String(o.res) : '';
  if (res) {
    out.res = res;
    const want = txt(pick(o, ['vol', 'volume', 'volId']), LIM.name);
    // 只有卷卡需要知道是哪一卷
    if (res === 'vol' && VOL_ID_RE.test(want)) out.vol = want;
    if (res === 'custom') {
      const seen = new Set();
      const rows = [];
      for (const raw of Array.isArray(o.rows) ? o.rows.slice(0, LIM.resRows) : []) {
        const key = String(raw);
        if (!RES_ROW_RE.test(key) || seen.has(key)) continue;
        seen.add(key);
        rows.push(key);
      }
      // 一行都没勾就干脆不写这个键：前端画一句提示，配置里少一个空数组
      if (rows.length) out.rows = rows;
    }
    if (!txt(pick(o, ['title', 'name', 'label', 'text']), LIM.text)) out.title = RES_TITLE[res] || out.vol || '未命名';
  }
  return withDkBox(out, o, cur);
};

// 改名之前出厂就写着这两个标题的配置，读到时换成现品牌名；用户自己敲过的标题原样保留
const LEGACY_TITLES = ['我的 NAS 导航', 'NAS 导航'];
const normTitle = (v) => {
  const t = txt(v, 40);
  return LEGACY_TITLES.includes(t) ? '' : t;
};

function defaultConfig() {
  return {
    version: 1,
    appearance: {
      title: 'NASphere',
      theme: 'dark',
      accent: '#7c8cff',
      iconSize: 'medium',
      tileLayout: 'top',
      // 字号与行距都是 px，直接写进 CSS 变量，手改配置时也一眼能看懂
      fontSize: 12.5,
      rowGap: 12,
      clock24: true,
      showSeconds: false,
      iconTemplate: 'https://icon.horse/icon/{domain}',
      widgets: { clock: true, notes: false, todos: false, weather: true },
      wallpaper: { kind: 'gradient', value: 'midnight', fit: 'cover', blur: 0, dim: 0.42 },
    },
    search: {
      default: 'baidu',
      engines: [
        { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}' },
        { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}' },
        { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
        { id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
        { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query={query}' },
      ],
    },
    // 干净版：首启不带任何分组、链接、便签与待办，主页从空页面开始，用户自己加。
    groups: [],
    // Docker 组件：一张卡绑一个容器，长宽与摆放坐标各存各的；一条都没有时主页上一个组件都不出现
    docker: {
      items: [],
    },
    notes: { text: '', todos: [] },
    weather: { enabled: true, city: '上海', lat: 31.2304, lon: 121.4737 },
  };
}

function sanitize(raw) {
  const base = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const ap = src.appearance && typeof src.appearance === 'object' ? src.appearance : {};
  const wp = ap.wallpaper && typeof ap.wallpaper === 'object' ? ap.wallpaper : {};
  const wpKind = ['none', 'url', 'upload', 'gradient', 'bing'].includes(wp.kind) ? wp.kind : base.appearance.wallpaper.kind;

  const engIds = new Set();
  const engines = Array.isArray(src.search?.engines)
    ? src.search.engines
        .slice(0, LIM.engines)
        .map((e) => {
          const o = typeof e === 'string' ? { url: e } : e && typeof e === 'object' ? e : {};
          const u = urlish(pick(o, ['url', 'href', 'link', 'to']));
          const name = txt(pick(o, ['name', 'title', 'label']), LIM.name);
          return {
            id: takeId('e', o.id !== undefined ? o.id : o.key, name + '|' + u, engIds),
            name: name || hostOf(u) || '未命名引擎',
            url: u.includes('{query}') ? u.slice(0, LIM.url) : '',
          };
        })
        .filter((e) => e.url)
    : [];

  const groupIds = new Set();
  const linkIds = new Set();
  // 没写 groups 与显式写 groups: [] 都是空页面（干净版首启就是这样）
  const rawGroups = Array.isArray(src.groups) ? src.groups : [];
  const groups = rawGroups.slice(0, LIM.groups).map((g) => normGroup(g, groupIds, linkIds));

  // 早期配置把容器卡片写在分组里：一律摘出来当独立组件，分组网格从此只放网址应用。
  const carried = [];
  for (const g of groups) {
    const moved = g.links.filter((l) => l.container);
    if (!moved.length) continue;
    g.links = g.links.filter((l) => !l.container);
    carried.push(...moved);
  }
  const dk = src.docker && typeof src.docker === 'object' ? src.docker : {};
  const rawDkItems = Array.isArray(dk.items) ? dk.items.slice(0, LIM.dockerItems) : [];
  // 补坐标的光标跨两拨条目共用：先摆配置里点名的，再接上从分组摘出来的，顺序与页面上读到的一致
  const cur = { x: 0, y: 0, rowH: 0 };
  // 摘出来的老卡片已经取过号了（id 就在 linkIds 里），只补框，别再走一遍取号，否则每次迁移都换 id
  const dkItems = rawDkItems.map((i) => normDockerItem(i, linkIds, cur)).concat(carried.map((i) => withDkBox(i, i, cur)));
  // 既没绑容器又没标资源类型的条目不成其为组件，直接丢掉（绑过的容器名就是启停接口的白名单）
  const items = dkItems.filter((i) => i.container || i.res);

  const todoIds = new Set();
  const todos = Array.isArray(src.notes?.todos)
    ? src.notes.todos.slice(0, LIM.todos).map((t) => {
        const o = typeof t === 'string' ? { text: t } : t && typeof t === 'object' ? t : {};
        const text = txt(pick(o, ['text', 'title', 'label', 'name']), LIM.text);
        return {
          id: takeId('t', o.id !== undefined ? o.id : o.key, text, todoIds),
          text,
          done: Boolean(pick(o, ['done', 'checked', 'completed'])),
        };
      })
    : base.notes.todos;

  const defId = cleanId(src.search?.default, '');
  const list = engines.length ? engines : base.search.engines.map((e) => ({ ...e }));

  return {
    version: 1,
    appearance: {
      title: normTitle(ap.title) || base.appearance.title,
      theme: ['auto', 'light', 'dark'].includes(ap.theme) ? ap.theme : base.appearance.theme,
      accent: colorOr(ap.accent, base.appearance.accent),
      iconSize: ['small', 'medium', 'large'].includes(ap.iconSize) ? ap.iconSize : base.appearance.iconSize,
      tileLayout: ['top', 'left'].includes(ap.tileLayout) ? ap.tileLayout : base.appearance.tileLayout,
      fontSize: num(ap.fontSize, 10, 20, base.appearance.fontSize),
      rowGap: num(ap.rowGap, 2, 40, base.appearance.rowGap),
      clock24: ap.clock24 !== false,
      showSeconds: Boolean(ap.showSeconds),
      iconTemplate: urlish(ap.iconTemplate) || base.appearance.iconTemplate,
      widgets: {
        clock: ap.widgets?.clock !== false,
        notes: ap.widgets?.notes === true,
        todos: ap.widgets?.todos === true,
        weather: ap.widgets?.weather !== false,
      },
      wallpaper: {
        kind: wpKind,
        value:
          wpKind === 'url' || wpKind === 'upload'
            ? urlish(wp.value)
            : wpKind === 'gradient'
              ? /^[a-z0-9_-]{1,20}$/i.test(txt(wp.value, 20))
                ? txt(wp.value, 20)
                : 'midnight'
              : '',
        fit: ['cover', 'contain', 'stretch'].includes(wp.fit) ? wp.fit : base.appearance.wallpaper.fit,
        blur: num(wp.blur, 0, 30, 0),
        dim: num(wp.dim, 0, 0.9, base.appearance.wallpaper.dim),
      },
    },
    search: {
      default: list.some((e) => e.id === defId) ? defId : list[0].id,
      engines: list,
    },
    groups,
    docker: {
      items,
    },
    notes: {
      text: txt(src.notes?.text, LIM.note),
      todos,
    },
    weather: {
      enabled: src.weather ? Boolean(src.weather.enabled) : true,
      // 城市名只能从搜索结果里来，不存在「故意留空」：没写就跟着下面那对默认经纬度走
      city: txt(src.weather?.city, LIM.name) || base.weather.city,
      lat: num(src.weather?.lat, -90, 90, 31.2304),
      lon: num(src.weather?.lon, -180, 180, 121.4737),
    },
  };
}

function ensureSecret() {
  try {
    const s = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  return s;
}

const SECRET = ensureSecret();

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash: h };
}

function verifyPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 64);
  const ref = Buffer.from(rec.hash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}

function loadAuth() {
  try {
    const rec = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (rec?.salt && rec?.hash) {
      // 只设过密码的老 auth.json：补上账号名再写回，别把升级的人锁在门外
      if (!normalizeAccount(rec.user)) {
        rec.user = initialAccount();
        fs.writeFileSync(AUTH_PATH, JSON.stringify(rec), { mode: 0o600 });
      }
      return rec;
    }
  } catch {}
  const initial = process.env.NAV_PASSWORD || 'admin123';
  const rec = {
    ...hashPassword(initial),
    user: initialAccount(),
    source: process.env.NAV_PASSWORD ? 'env' : 'default',
  };
  fs.writeFileSync(AUTH_PATH, JSON.stringify(rec), { mode: 0o600 });
  return rec;
}

let auth = loadAuth();

// /api/session 与改完账号密码后的回包共用这一份视图：账号信息只给已登录的人
function sessionView(authed) {
  return {
    authed,
    defaultPasswordInUse: auth.source === 'default',
    ...(authed
      ? { account: auth.user, defaultAccountInUse: accountKey(auth.user) === accountKey(DEFAULT_ACCOUNT) }
      : {}),
  };
}

// 账号名：去首尾空格后 1–32 位，允许字母 / 数字 / 中文 / _ . -
function normalizeAccount(raw) {
  const s = String(raw ?? '').trim();
  return /^[\p{L}\p{N}._-]{1,32}$/u.test(s) ? s : '';
}

function initialAccount() {
  return normalizeAccount(process.env.NAV_USER) || DEFAULT_ACCOUNT;
}

// 账号比对不区分大小写，也不管中间多余空格
function accountMatches(got) {
  return accountKey(got) === accountKey(auth.user);
}

function accountKey(s) {
  return String(s || '').trim().toLowerCase();
}

function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('base64url');
  return exp + '.' + sig;
}

function checkToken(token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', SECRET).update(exp).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, data, headers) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) && typeof data !== 'string' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
].join('; ');

function readConfig() {
  let raw = null;
  let broken = false;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      broken = true;
      console.warn('config.json unreadable, using defaults:', e.message);
    }
  }
  const clean = sanitize(broken ? defaultConfig() : raw || defaultConfig());
  // 手改的 config.json 在这里补齐 id / 别名 / 字符串链接，并写回磁盘，之后 id 才稳定
  if (!broken && JSON.stringify(raw) !== JSON.stringify(clean)) {
    try {
      writeConfig(clean);
    } catch (e) {
      console.warn('配置规范化写回失败:', e.message);
    }
  }
  return clean;
}

// 登录页背景：登录前拿不到 config.json，所以单独开一份只含壁纸的公开视图。
// 字段全部按白名单收过，必应也只回服务端已缓存的那条 URL，不替匿名请求对外发请求。
function loginWallpaperPath() {
  const wp = readConfig().appearance.wallpaper;
  if (wp.kind !== 'upload') return '';
  const name = path.basename(String(wp.value || ''));
  return /^[A-Za-z0-9._-]{1,80}$/.test(name) ? '/media/' + name : '';
}

function loginWallpaper() {
  const wp = readConfig().appearance.wallpaper;
  const out = { kind: 'none', value: '', fit: wp.fit, blur: 0, dim: 0.32 };
  if (wp.kind === 'upload' && wp.value === loginWallpaperPath()) out.value = wp.value;
  else if (wp.kind === 'url' || wp.kind === 'gradient') out.value = wp.value;
  else if (wp.kind === 'bing') out.value = bingCache.url;
  if (out.value) {
    out.kind = wp.kind === 'bing' ? 'url' : wp.kind;
    out.blur = wp.blur;
    out.dim = wp.dim;
  }
  return out;
}

// 登录页要显示的自有内容：页面标题（当 logo 用）+ 主页那张壁纸，别的配置一概不给
function loginPage() {
  const cfg = readConfig();
  return { title: String(cfg.appearance.title || ''), wallpaper: loginWallpaper() };
}

function configRev() {
  try {
    return sha1Short(fs.readFileSync(CONFIG_PATH));
  } catch {
    return 'none';
  }
}

function writeConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

function collectStrings(node, out) {
  if (typeof node === 'string') out.add(node);
  else if (Array.isArray(node)) for (const v of node) collectStrings(v, out);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) collectStrings(v, out);
  return out;
}

function gcUploads(cfg) {
  try {
    const refs = collectStrings(cfg, new Set());
    const blob = [...refs].join('\n');
    let removed = 0;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) continue;
      if (!blob.includes('/media/' + name)) {
        fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
        removed++;
      }
    }
    if (removed) console.log(`gc: removed ${removed} unused upload(s)`);
  } catch (e) {
    console.warn('gc skipped:', e.message);
  }
}

const extByMime = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico' };

/* ---------- Docker：容器实时状态 + 启停，零依赖直接说 HTTP ---------- */

// DOCKER_HOST 认 unix:// / npipe:// / tcp://；容器一律用名字引用（重建容器名字不变，手写也看得懂）
const DOCKER_HOST = String(process.env.DOCKER_HOST || 'unix:///var/run/docker.sock').trim();
const DOCKER_API = 'v1.41';
const DOCKER_TIMEOUT = 4000;
// 停止要等容器自己退出，超时给得宽
const DOCKER_ACTION_TIMEOUT = 20000;
const STATS_TTL = 2000;
const LIST_TTL = 5000;
const PING_TTL = 20000;
const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart']);

const dockerTarget = (() => {
  const m = /^(unix|npipe|tcp):\/\/(.*)$/i.exec(DOCKER_HOST);
  if (!m) return { socketPath: DOCKER_HOST };
  if (m[1].toLowerCase() === 'tcp') {
    const i = m[2].lastIndexOf(':');
    const host = i < 0 ? m[2] : m[2].slice(0, i);
    return { host: host || '127.0.0.1', port: Number(i < 0 ? '' : m[2].slice(i + 1)) || 2375 };
  }
  if (m[1].toLowerCase() === 'npipe') {
    // npipe:////./pipe/docker_engine → \\.\pipe\docker_engine
    return { socketPath: '\\\\.\\' + m[2].replace(/^\/+\.?\/+/, '').replace(/\//g, '\\') };
  }
  return { socketPath: m[2] };
})();

function dockerErr(raw, status) {
  let msg = '';
  try {
    msg = String(JSON.parse(raw).message || '');
  } catch {
    msg = String(raw).slice(0, 160);
  }
  const e = new Error(msg || `Docker 返回了 ${status}`);
  e.status = status;
  return e;
}

function dockerRequest(method, api, body, timeout = DOCKER_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { ...dockerTarget, method, path: `/${DOCKER_API}${api}`, headers: { Accept: 'application/json' }, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(dockerErr(raw, res.statusCode));
          // /_ping 这类接口回的是纯文本 OK，别当成解析失败
          if (!raw) return resolve(null);
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('连 Docker 超时')));
    req.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' || e.code === 'ENOTFOUND' ? '找不到 Docker 套接字' : e.code === 'ECONNREFUSED' ? 'Docker 端口没人监听' : e.message))
    );
    if (payload) req.write(payload);
    req.end();
  });
}

/* 同一份数据短时间内只问一次套接字：多台设备同时刷新也不会打爆 dockerd */
function ttlCache(okTtl, badTtl) {
  let slot = null;
  let pending = null;
  return {
    load(read) {
      if (slot && Date.now() - slot.at < (slot.bad ? badTtl : okTtl)) return Promise.resolve(slot.value);
      if (pending) return pending;
      pending = Promise.resolve()
        .then(read)
        .then(
          (value) => {
            slot = { at: Date.now(), value, bad: false };
            return value;
          },
          () => {
            slot = { at: Date.now(), value: null, bad: true };
            return null;
          }
        )
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    drop() {
      slot = null;
      pending = null;
    },
  };
}

const pingCache = ttlCache(PING_TTL, 5000);
const listCache = ttlCache(LIST_TTL, 4000);
// 每个容器一份：名字 → { at, cpu, mem, netUp, netDown }
const statCache = new Map();
// 网络计数是启动以来的累计值，速率要靠上一次的采样作差
const netPrev = new Map();
const statPending = new Map();

function dockerPing() {
  return pingCache.load(() => dockerRequest('GET', '/_ping').then(() => true));
}

async function dockerList() {
  return listCache.load(async () => {
    const rows = await dockerRequest('GET', '/containers/json?all=1');
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const name = String((Array.isArray(r.Names) && r.Names[0]) || '').replace(/^\//, '');
      if (!name) continue;
      out.push({
        name,
        id: String(r.Id || '').slice(0, 12),
        image: String(r.Image || ''),
        state: String(r.State || ''),
        status: String(r.Status || ''),
      });
    }
    out.sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'running' ? -1 : 1));
    return out;
  });
}

function cpuPctOf(stats) {
  const cur = stats.cpu_stats || {};
  const prev = stats.precpu_stats || {};
  const nowTotal = Number(cur.cpu_usage && cur.cpu_usage.total_usage);
  const prevTotal = Number(prev.cpu_usage && prev.cpu_usage.total_usage);
  const nowSys = Number(cur.system_cpu_usage);
  const prevSys = Number(prev.system_cpu_usage);
  if (![nowTotal, prevTotal, nowSys, prevSys].every(Number.isFinite)) return null;
  if (nowTotal <= prevTotal || nowSys <= prevSys) return 0;
  const cores = Number(cur.online_cpus) || os.cpus().length;
  // 和 docker stats 同一算法：容器占用的时钟周期 / 主机总时钟周期 × 核数
  return Math.min(9999, ((nowTotal - prevTotal) / (nowSys - prevSys)) * cores * 100);
}

function netTotalsOf(stats) {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const v of Object.values(stats.networks || {})) {
    if (!v) continue;
    rx += Number(v.rx_bytes) || 0;
    tx += Number(v.tx_bytes) || 0;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

async function readStats(name) {
  const stats = await dockerRequest('GET', `/containers/${encodeURIComponent(name)}/stats?stream=false`);
  if (!stats) return null;
  const mem = Number(stats.memory_stats && stats.memory_stats.usage);
  const at = Date.now();
  const net = netTotalsOf(stats);
  const prev = netPrev.get(name);
  let netDown = null;
  let netUp = null;
  if (net && prev && at > prev.at) {
    const secs = (at - prev.at) / 1000;
    netDown = Math.max(0, (net.rx - prev.rx) / secs);
    netUp = Math.max(0, (net.tx - prev.tx) / secs);
  }
  if (net) {
    netPrev.set(name, { at, ...net });
    if (netPrev.size > 300) netPrev.delete(netPrev.keys().next().value);
  }
  return {
    at,
    cpu: cpuPctOf(stats),
    mem: Number.isFinite(mem) ? mem : null,
    netUp,
    netDown,
  };
}

function dockerStatsOf(name) {
  const hit = statCache.get(name);
  if (hit && Date.now() - hit.at < STATS_TTL) return Promise.resolve(hit);
  const flying = statPending.get(name);
  if (flying) return flying;
  const p = readStats(name).then(
    (v) => {
      if (v) statCache.set(name, v);
      return v;
    },
    (e) => {
      // 容器没了就别再拿旧数据顶着，其余故障用上一次的值，免得抖一下磁贴就空了
      if (e.status === 404) statCache.delete(name);
      else if (hit) return hit;
      return null;
    }
  );
  statPending.set(name, p);
  return p.finally(() => statPending.delete(name));
}

// 配置里挂出来的容器名，就是这套接口允许查看和操作的全集
function containerRefs(cfg) {
  const out = [];
  for (const l of (cfg && cfg.docker && cfg.docker.items) || []) {
    if (l && l.container && !out.includes(l.container)) out.push(l.container);
  }
  return out;
}

async function dockerState(names) {
  if (!(await dockerPing())) return { available: false, error: `连不上 Docker（${DOCKER_HOST}）`, containers: {} };
  const list = (await dockerList()) || [];
  const byName = new Map(list.map((c) => [c.name, c]));
  const containers = {};
  await Promise.all(
    names.slice(0, 80).map(async (name) => {
      const info = byName.get(name);
      // 停着的容器 stats 接口会直接报错，状态从列表拿就够了
      const st = info && info.state === 'running' ? await dockerStatsOf(name) : null;
      containers[name] = {
        found: Boolean(info),
        image: info ? info.image : '',
        state: info ? info.state : 'missing',
        status: info ? info.status : '',
        cpu: st ? st.cpu : null,
        mem: st ? st.mem : null,
        netUp: st ? st.netUp : null,
        netDown: st ? st.netDown : null,
      };
    })
  );
  return { available: true, error: '', containers };
}

function dockerAct(name, action) {
  return dockerRequest('POST', `/containers/${encodeURIComponent(name)}/${action}`, undefined, DOCKER_ACTION_TIMEOUT).then(() => {
    statCache.delete(name);
    netPrev.delete(name);
    // 操作完再清缓存，免得并发的那一次读到的还是操作前的状态
    listCache.drop();
  });
}

/* ---------- NAS 资源读数：内存 / CPU / 网络 / 核显 / 每个卷的用量 / 物理盘型号 ----------
   边界只有一条：只取计数器一样的数字，不读任何文件内容。
     · 内存取 /proc/meminfo 的两个计数，读不到就用 os 模块给的同一份统计
     · CPU / 负载取 /proc/stat 第一行与 /proc/loadavg，都是累计计数，跟上一次采样作差
     · 网络取 /proc/net/dev 的收发字节，同样作差成速率；回环和 Docker 自己的网桥不算
     · 核显只读 /sys/class/drm 下每张 card 的 device/gpu_busy_percent，驱动不写这一项就如实报读不到
     · 物理盘取 /sys/block 的目录名、size 与 device/model，那里只有型号和大小，从来不是路径
     · 每个卷只对目录本身调一次 statfs：那是整个文件系统的账，返回里不会出现一个文件名
   候选卷 = 数据目录 + 挂进来的 /host 第一层目录。宿主机没挂进来的目录在容器里本来就不存在，
   所以 deploy.sh 每探到一卷就往 compose 里写一行只读挂载，页面自己就多出一张卷卡片，这里不需要配开关。 */

// 自测用的前缀：把一份假的 proc / sys / host 目录树指过来，在没有 Linux 的开发机上也能跑通这套解析
const SYS_ROOT = path.resolve(process.env.NAV_SYS_ROOT || '/');
const SYS_TTL = 5000;
// 只认物理盘的命名前缀：loop / ram / zram / sr / md / dm 都是包出来的设备，报成硬盘会误导
const DISK_RE = /^(?:hd[a-z]|sd[a-z]|nvme\d+n\d+|mmcblk\d+|vd[a-z]|xvd[a-z])$/;
// /sys/block/*/size 自己写着单位是 512 字节，跟机器扇区无关
const SECTOR = 512;

const sysPath = (...parts) => path.join(SYS_ROOT, ...parts);

function readSysText(rel) {
  try {
    return String(fs.readFileSync(sysPath(rel), 'utf8')).trim();
  } catch {
    return '';
  }
}

function memFromOs() {
  const total = os.totalmem();
  const avail = os.freemem();
  return { total, used: Math.max(0, total - avail), avail };
}

function readMemory() {
  let raw = '';
  try {
    raw = fs.readFileSync(sysPath('proc', 'meminfo'), 'utf8');
  } catch {
    return memFromOs();
  }
  const lines = raw.split('\n');
  // 'MemTotal:  32800128 kB' → 32800128 * 1024
  const kbOf = (key) => {
    const hit = lines.find((l) => l.startsWith(key + ':'));
    if (!hit) return NaN;
    const n = Number(hit.slice(key.length + 1).trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n * 1024 : NaN;
  };
  const total = kbOf('MemTotal');
  const avail = kbOf('MemAvailable');
  if (!(total > 0) || !(avail >= 0)) return memFromOs();
  return { total, used: Math.max(0, total - avail), avail };
}

/* CPU 占用与网卡速率都是「这一段用了多少」，可 /proc 给的是开机以来的累计值，
   所以各留一份上一次的采样作差。第一轮没有上一次，那一项就是 null，页面画成「—」，
   5 秒后第二轮自然有真数——凑一个假数比留白更糟。 */

// /proc/stat 第一行的字段：user nice system idle iowait irq softirq steal guest guest_nice。
// guest 那两个已经算进 user / nice，再取一次就重复计数了，所以只认前八个。
const CPU_FIELDS = 8;

function cpuSample() {
  try {
    const line = fs.readFileSync(sysPath('proc', 'stat'), 'utf8').split('\n', 1)[0].trim();
    if (/^cpu\s/.test(line)) {
      const f = line.split(/\s+/).slice(1, CPU_FIELDS + 1).map(Number);
      if (f.length === CPU_FIELDS && f.every(Number.isFinite)) {
        return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4] };
      }
    }
  } catch {
    // 没有 /proc 的开发机走下面 os 模块那份，同一套作差逻辑
  }
  const list = os.cpus();
  if (!list.length) return null;
  let total = 0;
  let idle = 0;
  for (const c of list) {
    const t = c && c.times;
    if (!t) return null;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

// 平均负载只有 /proc/loadavg 有；Windows 上 os.loadavg() 恒为 0，那是假数，不如报读不到
function readLoadAvg() {
  const f = readSysText(path.join('proc', 'loadavg')).split(/\s+/).slice(0, 3).map(Number);
  return f.length === 3 && f.every(Number.isFinite) ? f : null;
}

let cpuPrev = null;

function readCpu() {
  const cur = cpuSample();
  let used = null;
  let warming = false;
  if (cur) {
    const prev = cpuPrev;
    cpuPrev = cur;
    warming = !prev;
    const dTotal = prev ? cur.total - prev.total : 0;
    const dIdle = prev ? cur.idle - prev.idle : 0;
    // 重启后计数归零，差值会是负的：这种时候宁可空着
    if (dTotal > 0 && dIdle >= 0) used = Math.min(100, Math.max(0, Math.round((1 - dIdle / dTotal) * 1000) / 10));
  }
  // warming 分两种空：页面刚起来、还没作差完（下一轮就有数），和这台机器真给不出占用
  return { cores: os.cpus().length || 0, used, warming, load: readLoadAvg() };
}

// 回环、Docker 自己的网桥和一对端的 veth 都不算进出机器的流量，算进去数字会翻倍
const NET_SKIP = /^(?:lo|veth|docker|br-|virbr|tap|dummy)/;

function netSample() {
  let raw = '';
  try {
    raw = fs.readFileSync(sysPath('proc', 'net', 'dev'), 'utf8');
  } catch {
    return null;
  }
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || NET_SKIP.test(name)) continue;
    // 收发字节分别是第 1 列和第 9 列，两份表头之外每行的列数固定
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 16 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    rx += f[0];
    tx += f[8];
    seen = true;
  }
  return seen ? { at: Date.now(), rx, tx } : null;
}

let netPrevSys = null;

function readNet() {
  const cur = netSample();
  let down = null;
  let up = null;
  let warming = false;
  if (cur) {
    const prev = netPrevSys;
    netPrevSys = cur;
    warming = !prev;
    if (prev && cur.at > prev.at) {
      const secs = (cur.at - prev.at) / 1000;
      const dRx = cur.rx - prev.rx;
      const dTx = cur.tx - prev.tx;
      // 计数回绕（重启或换网卡）时那一路给 null，别把负的塞进格式化函数
      if (dRx >= 0) down = dRx / secs;
      if (dTx >= 0) up = dTx / secs;
    }
  }
  return { down, up, warming };
}

// 核显 / 独显都认这一个文件：只有 intel_gt 与 amdgpu 那几类驱动会写，读不到就是读不到
function readGpu() {
  let cards;
  try {
    cards = fs
      .readdirSync(sysPath('sys', 'class', 'drm'))
      .filter((n) => /^card\d+$/.test(n))
      .sort();
  } catch {
    return { used: null };
  }
  for (const n of cards) {
    const raw = readSysText(path.join('sys', 'class', 'drm', n, 'device', 'gpu_busy_percent'));
    // 空串得先拦下来：Number('') 是 0，那样没写这一项的驱动会被报成「占用 0%」，比报读不到更糟
    if (!raw) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return { used: Math.min(100, v) };
  }
  return { used: null };
}

function readDisks() {
  let names;
  try {
    names = fs
      .readdirSync(sysPath('sys', 'block'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && DISK_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const blocks = Number(readSysText(path.join('sys', 'block', name, 'size')));
    // 0 块是空读卡器和光驱残留，列出来只会碍眼
    if (!(blocks > 0)) continue;
    out.push({ name, model: readSysText(path.join('sys', 'block', name, 'device', 'model')).slice(0, 40), size: blocks * SECTOR });
  }
  return out;
}

// 目录 → 整个文件系统的容量账；statfs 只看目录本身，不碰里面的内容
function readVolume(id, name, dir) {
  let st;
  let dev;
  try {
    // 用 statSync 而不是目录项的类型：挂点常是 bind mount / 链接，只看类型会漏
    const s = fs.statSync(dir);
    if (!s.isDirectory()) return null;
    dev = s.dev;
    st = fs.statfsSync(dir);
  } catch {
    return null;
  }
  // 块数按 fragment size 折算才是 POSIX 的口径，环境没给 frsize 时才退回 bsize
  const unit = st.frsize > 0 ? st.frsize : st.bsize;
  const total = st.blocks * unit;
  if (!(unit > 0) || !(total > 0)) return null;
  const used = Math.max(0, (st.blocks - st.bfree) * unit);
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  // 挂载点路径不给前端：那一串字符对页面没用，接口里留纯数字和名字边界更干净
  return { dev, vol: { id, name, total, used, avail: st.bavail * unit, pct: Math.round(pct * 10) / 10 } };
}

function readVolumes() {
  // 挂进来的存储池排在前面：数据目录十有八九就躺在某一卷里面，同一块文件系统该留池子的名字，
  // 而不是留「数据盘」这个只对这台容器有意义的叫法
  const candidates = [];
  try {
    for (const name of fs
      .readdirSync(sysPath('host'))
      // 认不出这个名字的目录就当没看见：卡片按 id 认卷，隐藏目录和带怪字符的名字进不了配置
      .filter((n) => VOL_ID_RE.test(n))
      .sort()) {
      candidates.push({ id: name, name, dir: sysPath('host', name) });
    }
  } catch {
    // 没挂 /host 就只剩数据目录，这本来的默认样子
  }
  candidates.push({ id: 'data', name: '数据盘', dir: DATA_DIR });
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const hit = readVolume(c.id, c.name, c.dir);
    if (!hit) continue;
    // 同一个文件系统只报一次：数据目录常常就摆在某一卷里面
    if (hit.dev) {
      if (seen.has(hit.dev)) continue;
      seen.add(hit.dev);
    }
    out.push(hit.vol);
  }
  return out;
}

const sysCache = ttlCache(SYS_TTL, SYS_TTL);

function systemState() {
  return sysCache.load(() => ({
    ok: true,
    error: '',
    at: Date.now(),
    memory: readMemory(),
    cpu: readCpu(),
    net: readNet(),
    gpu: readGpu(),
    volumes: readVolumes(),
    disks: readDisks(),
  }));
}

function handleLogin(req, res, body) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) {
    rec.n = 0;
    rec.t = now;
  }
  if (rec.n >= 8) return send(res, 429, { error: '尝试次数过多，请 1 分钟后再试' });
  rec.n++;
  attempts.set(ip, rec);

  let pw = '';
  let got = '';
  try {
    const o = JSON.parse(body.toString('utf8') || '{}');
    pw = String(o.password ?? '');
    got = String(o.account ?? '');
  } catch {
    return send(res, 400, { error: '请求格式错误' });
  }
  // 账号不符也照样跑一次 scrypt，免得别人拿响应快慢猜账号存不存在
  const okPw = verifyPassword(pw, auth);
  if (!got.trim() || !accountMatches(got) || !okPw) return send(res, 401, { error: '账号或密码不正确' });
  attempts.delete(ip);
  const token = makeToken();
  send(res, 200, { ok: true }, {
    'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

const attempts = new Map();

function dataUrlToBuffer(s) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(s || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!extByMime[mime]) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
  return { buf, ext: extByMime[mime] };
}

function handleMediaUpload(req, res) {
  readBody(req).then((raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, { error: '请求格式错误' });
    }
    const items = Array.isArray(payload.images) ? payload.images.slice(0, 8) : [payload.image];
    const saved = [];
    for (const item of items) {
      const parsed = dataUrlToBuffer(item);
      if (!parsed) continue;
      const name = crypto.createHash('sha1').update(parsed.buf).digest('hex').slice(0, 20) + parsed.ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), parsed.buf);
      saved.push('/media/' + name);
    }
    if (!saved.length) return send(res, 400, { error: '仅支持 png / jpeg / gif / webp / avif / svg / ico，单张不超过 5MB' });
    send(res, 200, { urls: saved });
  }).catch((e) => send(res, e.status || 400, { error: e.message }));
}

const bingCache = { at: 0, url: '' };

function handleBing(res) {
  if (bingCache.url && Date.now() - bingCache.at < 600000) {
    return send(res, 200, { url: bingCache.url });
  }
  const req = https.get(
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN',
    { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 6000 },
    (up) => {
      let body = '';
      up.setEncoding('utf8');
      up.on('data', (c) => (body += c));
      up.on('end', () => {
        try {
          const path0 = JSON.parse(body).images[0].url;
          bingCache.url = 'https://www.bing.com' + String(path0).split('&ohr=')[0] + '&ohr=2';
          bingCache.at = Date.now();
          send(res, 200, { url: bingCache.url });
        } catch {
          send(res, 502, { error: '必应壁纸接口解析失败' });
        }
      });
    }
  );
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => {
    console.warn('bing wallpaper failed:', e.message);
    send(res, bingCache.url ? 200 : 502, bingCache.url ? { url: bingCache.url } : { error: '必应壁纸获取失败：' + e.message });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return send(res, 404, 'not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveMedia(req, res, pathname) {
  const name = path.basename(decodeURIComponent(pathname));
  const file = path.join(UPLOAD_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'bad url');
  }
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, ip: HOST, port: PORT });

  if (!/^(GET|POST|PUT|HEAD)$/.test(req.method)) return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST, PUT, HEAD' });

  const authed = checkToken(parseCookies(req)[COOKIE_NAME]);

  if (p === '/api/session') return send(res, 200, sessionView(authed));

  if (p === '/api/login' && req.method === 'POST') {
    return readBody(req)
      .then((raw) => handleLogin(req, res, raw))
      .catch((e) => send(res, e.status || 400, { error: e.message }));
  }

  // 登录页要在鉴权之前就知道标题和壁纸，所以这个端点在门禁之前应答
  if (p === '/api/login-page' && req.method === 'GET') {
    return send(res, 200, loginPage(), { 'Cache-Control': 'no-store' });
  }

  if (!authed) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
    if (p.startsWith('/media/')) {
      // 只放行正被登录页当壁纸用的那一张，其余上传图片依然要登录
      if (p === loginWallpaperPath()) return serveMedia(req, res, p);
      return send(res, 401, { error: 'unauthorized' });
    }
    return serveStatic(req, res, p);
  }

  if (p === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }

  if (p === '/api/config' && req.method === 'GET') {
    const cfg = readConfig();
    return send(res, 200, cfg, {
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
      'X-Config-Rev': configRev(),
    });
  }

  if (p === '/api/config/rev' && req.method === 'GET') {
    return send(res, 200, { rev: configRev() }, { 'Cache-Control': 'no-store' });
  }

  if (p === '/api/config' && req.method === 'PUT') {
    return readBody(req)
      .then((raw) => {
        if (raw.length > MAX_CONFIG) return send(res, 413, { error: '配置过大（上限 1MB）' });
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, { error: 'JSON 解析失败' });
        }
        const cfg = sanitize(parsed);
        writeConfig(cfg);
        gcUploads(cfg);
        const rev = configRev();
        send(res, 200, { ok: true, savedAt: Date.now(), rev }, { 'X-Config-Rev': rev });
      })
      .catch((e) => send(res, e.status || 400, { error: e.message }));
  }

  // 改账号名和改密码走同一个口子：两者都要求填对当前密码
  if (p === '/api/credentials' && req.method === 'POST') {
    return readBody(req)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          return send(res, 400, { error: '请求格式错误' });
        }
        if (!verifyPassword(body.current, auth)) return send(res, 403, { error: '当前密码不正确' });
        const keepAccount = body.account === undefined || body.account === null;
        const nextAccount = keepAccount ? auth.user : normalizeAccount(body.account);
        if (!nextAccount) return send(res, 400, { error: '账号名需 1–32 位，只能用字母、数字、中文或 _ . -' });
        const next = String(body.new ?? '');
        const changingPw = next !== '';
        if (changingPw && next.length < 6) return send(res, 400, { error: '新密码至少 6 位' });
        auth = {
          user: nextAccount,
          ...(changingPw ? hashPassword(next) : { salt: auth.salt, hash: auth.hash }),
          source: changingPw ? 'user' : auth.source,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(AUTH_PATH, JSON.stringify(auth), { mode: 0o600 });
        console.log(changingPw ? 'credentials changed (account + password)' : 'account renamed');
        send(res, 200, sessionView(true));
      })
      .catch((e) => send(res, e.status || 400, { error: e.message }));
  }

  if (p === '/api/media' && req.method === 'POST') return handleMediaUpload(req, res);

  // 磁贴要的数据：只看配置里挂出来的那几个容器，客户端不能自己点名要别人机器上的容器
  if (p === '/api/docker/state' && req.method === 'GET') {
    return dockerState(containerRefs(readConfig()))
      .then((r) => send(res, 200, r, { 'Cache-Control': 'no-store' }))
      .catch((e) => send(res, 200, { available: false, error: e.message, containers: {} }, { 'Cache-Control': 'no-store' }));
  }

  // 挑容器用的列表，带镜像名和状态，不含实时数据
  if (p === '/api/docker/containers' && req.method === 'GET') {
    return dockerPing()
      .then(async (ok) => {
        if (!ok) return send(res, 200, { available: false, error: `连不上 Docker（${DOCKER_HOST}）`, containers: [] });
        const list = (await dockerList()) || [];
        send(res, 200, { available: true, error: '', containers: list });
      })
      .catch((e) => send(res, 200, { available: false, error: e.message, containers: [] }));
  }

  if (p === '/api/docker/action' && req.method === 'POST') {
    return readBody(req)
      .then(async (raw) => {
        let body;
        try {
          body = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          return send(res, 400, { error: '请求格式错误' });
        }
        const action = String(body.action || '');
        const name = String(body.name || '');
        if (!DOCKER_ACTIONS.has(action)) return send(res, 400, { error: '只允许启动 / 停止 / 重启' });
        if (!CONTAINER_NAME_RE.test(name)) return send(res, 400, { error: '容器名不合法' });
        if (!containerRefs(readConfig()).includes(name)) return send(res, 403, { error: '这个容器不在主页配置里，不能从这里操作' });
        await dockerAct(name, action);
        console.log(`docker ${action} ${name}`);
        send(res, 200, { ok: true });
      })
      .catch((e) => send(res, e.status === 404 ? 404 : 502, { error: 'Docker 操作失败：' + e.message }));
  }

  // NAS 资源读数：内存、各卷用量、物理盘型号。全是容量数字，没有一个文件内容
  if (p === '/api/system/state' && req.method === 'GET') {
    return systemState().then((r) => send(res, 200, r, { 'Cache-Control': 'no-store' }));
  }

  if (p === '/api/wallpaper/bing') return handleBing(res);
  if (p.startsWith('/media/')) return serveMedia(req, res, p);

  return serveStatic(req, res, p);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请改用其它端口（环境变量 PORT）`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`nav page listening on http://${HOST}:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`登录账号：${auth.user}`);
  if (auth.source === 'default') {
    console.warn('!! 正在使用默认密码 admin123，请尽快在「设置 → 安全」中修改，或用环境变量 NAV_PASSWORD 首次启动');
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
