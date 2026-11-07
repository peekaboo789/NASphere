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
  // 排列那一栏能攒下的模块数：分组上限 + 五个固定部件，留点余量，超出的直接丢
  layoutModules: 200,
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

/* ---------- 主页排列：整页一张画布，每块模块各带自己的坐标尺寸 ----------
   模块的键只有这几类：clock / search / weather / notes / todos / group:<分组 id>。
   容器组件与读数卡不住这一栏——它们本来就各带 x/y/w/h，住在 docker.items 里，
   跟这些模块共用同一张画布、同一套叠放序（z）。

   「摆过」与「没摆过」的区别就在这四个数上：一个都没给 = 没摆过，这一项不写进配置，
   前端让这块留在文档流里按自动排版画。所以出厂配置的 modules 是个空对象——
   谁都没拖过时，页面就是默认那套自动排版，一个坐标都不用写死。

   给了的数按轴各存各的：只给宽就给宽，高没给就还是自动高（内容撑多高就多高）。
   x / y 没给按 0 算。 */
const LAY = {
  gridMin: 8,
  gridMax: 64,
  gridDef: 16,
  posMin: 0,
  posMax: 4000,
  zMin: 1,
  zMax: 4000,
};

// 每块模块的宽高上下限。下限不是审美值，是「再小就装不下它自己的内容」那条线。
// 每一块能给的尺寸上下限。上限一律比「画布最宽能有多大」（1440 内容宽减内边距 ≈ 1380）留余量：
// 首次固定写的是当场量到的实际宽，钳一下就等于把用户摆好的画面挪了一格。
const LAY_MODS = {
  clock: { w: [180, 1600], h: [60, 900] },
  search: { w: [240, 1600], h: [40, 200] },
  weather: { w: [60, 480], h: [32, 160] },
  notes: { w: [240, 1600], h: [140, 900] },
  todos: { w: [240, 1600], h: [140, 900] },
  group: { w: [260, 1600], h: [120, 2400] },
};
const LAY_FIXED = new Set(['clock', 'search', 'weather', 'notes', 'todos']);
const LAY_GROUP_RE = /^group:[A-Za-z0-9_-]{1,40}$/;
// 关掉的部件不该把坐标留在配置里积灰：撤下天气就顺手清掉 weather 那一格
const LAY_WIDGET_KEY = { clock: 'clock', weather: 'weather', notes: 'notes', todos: 'todos' };

function layBox(key) {
  if (key.startsWith('group:')) return LAY_MODS.group;
  return LAY_MODS[key] || null;
}

// 一块模块的四个数 + 叠放序：只钳制确实给了的那些，一个都没给返回 null（= 没摆过）
function normLayoutBox(key, raw, groupIds) {
  const spec = layBox(key);
  if (!spec) return null;
  // 分组删了、部件关了，坐标就跟着走：认不出的键一律不落地
  if (key.startsWith('group:') && !groupIds.has(key.slice(6))) return null;
  const o = raw && typeof raw === 'object' ? raw : {};
  const x = num(o.x, LAY.posMin, LAY.posMax, NaN);
  const y = num(o.y, LAY.posMin, LAY.posMax, NaN);
  const w = num(pick(o, ['w', 'width']), spec.w[0], spec.w[1], NaN);
  const h = num(pick(o, ['h', 'height']), spec.h[0], spec.h[1], NaN);
  if (!Number.isFinite(x) && !Number.isFinite(y) && !Number.isFinite(w) && !Number.isFinite(h)) return null;
  const out = { x: Math.round(Number.isFinite(x) ? x : 0), y: Math.round(Number.isFinite(y) ? y : 0) };
  if (Number.isFinite(w)) out.w = Math.round(w);
  if (Number.isFinite(h)) out.h = Math.round(h);
  const z = num(o.z, LAY.zMin, LAY.zMax, NaN);
  if (Number.isFinite(z)) out.z = Math.round(z);
  return out;
}

function normLayout(raw, groupIds, widgets) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const boxes = src.modules && typeof src.modules === 'object' && !Array.isArray(src.modules) ? src.modules : {};
  const modules = {};
  for (const key of Object.keys(boxes).slice(0, LIM.layoutModules)) {
    if (LAY_FIXED.has(key)) {
      const on = LAY_WIDGET_KEY[key] ? widgets[LAY_WIDGET_KEY[key]] : true;
      if (!on) continue;
    } else if (!LAY_GROUP_RE.test(key)) {
      continue;
    }
    const box = normLayoutBox(key, boxes[key], groupIds);
    if (box) modules[key] = box;
  }
  return { grid: Math.round(num(src.grid, LAY.gridMin, LAY.gridMax, LAY.gridDef)), modules };
}

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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
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

/* 百分号转义解不开就当它不存在：这三处 decodeURIComponent 都坐在每个请求的同步路径上，
   抛出去的是 URIError，Node 直接把这个连接断掉、进程跟着没——`Cookie: x=%zz` 一条匿名包就能打死服务。
   解不开时返回空串，三条路各自退成「没登录」「404」，都是本来就该给的答案。 */
function decodeOr(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return '';
  }
}

/* 解完码还留着 NUL 的路径不能喂给 fs：fs.stat 拿到带 NUL 的名字是当场同步抛（不是走回调报错），
   抛在请求回调里就是进程没了——一条匿名 `GET /%00` 就能让服务下线。
   这种请求本来就该吃 404，所以解出 NUL 直接当空路径处理。 */
function decodePath(v) {
  const s = decodeOr(v);
  return s.includes('\0') ? '' : s;
}

function cleanId(v, fallback) {
  const s = txt(v, 40);
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : fallback;
}

/* 少打协议头是这里最常见的写法：`localhost:3000`、`nas.lan:8080` 都指望这一句补上 http。
   补的时候只认「主机名 + 冒号 + 纯数字端口」这一种形状（`javascript:` / `data:` / `chrome:` 冒号后面不是数字，走不到这条），
   其余看不懂的协议一律丢掉。`//host/x` 是协议相对写法，原样留着，浏览器会跟着本页面自己补 http 还是 https。 */
function urlish(v) {
  const s = txt(v, LIM.url).trim();
  if (!s) return '';
  if (s.startsWith('/')) return s;
  if (/^(https?|file|magnet|ftp):\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9.-]*:\d{1,5}([/?#]|$)/i.test(s)) return 'http://' + s;
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

/* === icon-order begin ===
   这一整块在 server/index.js 与 public/js/store.js 里各有一份，逐字相同（有脚本按字节比对），
   所以里面只允许用 new URL / String 这类两边都有的东西，不许调 urlish、hostOf、domainOf。
   取图标的默认顺序写死在这里，不加开关：
     1. 手动填的或上传到 NAS 的那张（image 档，只有前端用得上，见 store.js 的 iconSrcs）
     2. 站点自己的 /favicon.ico —— 内网网址在前、外网网址在后，ico 优先
     3. appearance.iconTemplate（默认 icon.horse），这是整条顺序里唯一能在设置里改的一档
   拿不到就往后走，全都落空才回退首字母。emoji / letter 两档是用户明确选定的，不参与级联。 */
const faviconOf = (url) => {
  const s = String(url || '').trim();
  // 只认绝对的 http(s) 地址：相对路径、//host/x、magnet、data 这些拼不出 favicon
  if (!/^https?:\/\//i.test(s)) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  // 协议、主机、端口整个照抄，只把路径换成 /favicon.ico：内网 http://192.168.1.100:5000 也照拼
  return u.host ? u.protocol + '//' + u.host + '/favicon.ico' : '';
};

const iconDomainOf = (url) => {
  try {
    return new URL(String(url || '').trim()).hostname;
  } catch {
    return '';
  }
};

const iconSourceList = (link, template) => {
  const out = [];
  const push = (url, label) => {
    if (url && !out.some((s) => s.url === url)) out.push({ url, label });
  };
  push(faviconOf(link.urlLan), '内网站点 ico');
  push(faviconOf(link.url), '外网站点 ico');
  // 模板档优先用外网网址的域名：公共 favicon 服务够不着内网 IP
  const host = iconDomainOf(link.url) || iconDomainOf(link.urlLan);
  const tpl = String(template || '').trim();
  if (host && tpl) push(tpl.replace('{domain}', host), 'favicon 模板');
  return out;
};
/* === icon-order end === */

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
  // 叠放序：整页一张画布之后，组件要和分组面板、时钟那些块比同一个 z，光靠数组先后不够用。
  // 没写过 z 的老配置不补这个键——前端按数组先后画，行为跟从前一模一样，谁被拖过谁才有 z。
  const z = num(pick(s, ['z', 'layer']), LAY.zMin, LAY.zMax, NaN);
  if (Number.isFinite(z)) out.z = Math.round(z);
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
    // 行的小名：读数卡上每一行的名字默认取自读数（型号、卷名、指标名），这里只存「这一行改叫别的」
    // 键必须还是上面那套行键，画不到的键留着也无害；盘换过型号、卷改过池名都不挡着重命名
    const want2 = o.rowNames && typeof o.rowNames === 'object' && !Array.isArray(o.rowNames) ? o.rowNames : null;
    if (want2) {
      const names = {};
      for (const key of Object.keys(want2).slice(0, LIM.resRows)) {
        if (!RES_ROW_RE.test(key)) continue;
        const label = txt(want2[key], LIM.name).trim();
        if (label) names[key] = label;
      }
      if (Object.keys(names).length) out.rowNames = names;
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

/* ---------- 出厂内置的那一组常用站点 ----------
   首启只带名气最大的八个：主页一打开不是空白，但也还是一屏谁都能看懂的公共网址，
   没有个人域名、没有私有站点、没有绑容器的卡片。剩下四十来个在设置「常用站点」那一栏里，
   用户点一下才落盘（见 public/js/app.js 的 SITE_CATALOG，那一份只用于展示与添加，不写进配置）。
   这一份必须写成 sanitize 走完之后的形状：固定 id、icon 空串也照样写出来、可选的空键不写——
   「清空为初始配置」走的是 sanitize({})，两条路要逐字节相同，存一次配置不能让它变样。
   网址一律是各家官方域名，只填外网那一条：内网模式下同一条网址也照样打开。 */
const SEED_SITES = [
  { id: 'l_seed_bili', title: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { id: 'l_seed_zhihu', title: '知乎', url: 'https://www.zhihu.com/' },
  { id: 'l_seed_weibo', title: '微博', url: 'https://weibo.com/' },
  { id: 'l_seed_taobao', title: '淘宝', url: 'https://www.taobao.com/' },
  { id: 'l_seed_jd', title: '京东', url: 'https://www.jd.com/' },
  { id: 'l_seed_baidupan', title: '百度网盘', url: 'https://pan.baidu.com/' },
  { id: 'l_seed_github', title: 'GitHub', url: 'https://github.com/' },
  { id: 'l_seed_youtube', title: 'YouTube', url: 'https://www.youtube.com/' },
];
const seedGroups = () => [
  {
    id: 'g_seed',
    name: '常用',
    collapsed: false,
    links: SEED_SITES.map((s) => ({ id: s.id, title: s.title, url: s.url, icon: '', iconKind: 'auto', desc: '' })),
  },
];

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
    // 首启带的是上面那一个「常用」分组、八个公共网址；容器组件、便签与待办仍然一条都没有
    groups: seedGroups(),
    // Docker 组件：一张卡绑一个容器，长宽与摆放坐标各存各的；一条都没有时主页上一个组件都不出现
    docker: {
      items: [],
    },
    notes: { text: '', todos: [] },
    weather: { enabled: true, city: '上海', lat: 31.2304, lon: 121.4737 },
    // 主页排列：出厂一个坐标都不写，整页走自动排版。谁被拖过，那一块才进 modules
    layout: { grid: LAY.gridDef, modules: {} },
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
            // 引擎图标也固定到 NAS：页面第一次显示成功后回调 /api/icon/save 写进来
            icon: urlish(pick(o, ['icon'])),
          };
        })
        .filter((e) => e.url)
    : [];

  const groupIds = new Set();
  const linkIds = new Set();
  // 没写 groups 这一项 = 拿初始那一份（首启和「清空为初始配置」都走这条，两条路要逐字节相同）；
  // 显式写 groups: [] 是用户把分组删空之后存下来的，那是他的页面，不能给他补回内置那八个站
  const rawGroups = Array.isArray(src.groups) ? src.groups : base.groups;
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
  // 部件开关先算出来：排列那一栏要拿它清掉「已经关掉的部件」留下的坐标
  const widgets = {
    clock: ap.widgets?.clock !== false,
    notes: ap.widgets?.notes === true,
    todos: ap.widgets?.todos === true,
    weather: ap.widgets?.weather !== false,
  };
  const weatherOn = src.weather ? Boolean(src.weather.enabled) : true;

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
      widgets,
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
      enabled: weatherOn,
      // 城市名只能从搜索结果里来，不存在「故意留空」：没写就跟着下面那对默认经纬度走
      city: txt(src.weather?.city, LIM.name) || base.weather.city,
      lat: num(src.weather?.lat, -90, 90, 31.2304),
      lon: num(src.weather?.lon, -180, 180, 121.4737),
    },
    // 整页排列：网格密度 + 各模块的坐标尺寸。没拖过 = 这一栏空着，页面走自动排版
    layout: normLayout(src.layout, groupIds, { ...widgets, weather: widgets.weather && weatherOn }),
  };
}

/* 本机那三份私密文件（config / auth / .secret）都得原子落地：writeFileSync 写到一半被断电、被 OOM 掉，
   留下的就是半个 JSON。auth.json 坏了 loadAuth 直接退回默认口令 admin123 —— 主人改的密码凭空失效，
   门反倒对默认口令开着。先写同目录的 .tmp 再改名：同一文件系统里改名是原子的，外界只看到旧的或新的。 */
function writePrivate(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function ensureSecret() {
  try {
    const s = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  writePrivate(SECRET_PATH, s);
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
        writePrivate(AUTH_PATH, JSON.stringify(rec));
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
  writePrivate(AUTH_PATH, JSON.stringify(rec));
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeOr(part.slice(i + 1).trim());
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
  // http: 是主页级联图标要的：内网站点大多只有 http://192.168.x.x:port，站点自己的 /favicon.ico 直接进 img
  "img-src 'self' data: http: https:",
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
  writePrivate(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
    // 抓图留档里那张也算「在用」：页面刚抓完、配置还没写回去的这几百毫秒里别把它当垃圾清了
    for (const rec of Object.values(readIconCache())) {
      if (rec && typeof rec.file === 'string') refs.add(rec.file);
    }
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
    /* 只等 res 的 'end' 是不够的：应答写了一半就断链（dockerd 被重启、被 OOM 掉）时 'end' 永远不来，
       超时也救不了——套接字已经没了，空闲计时器不再响。实测这样两次请求全挂死，
       而 ttlCache 里那份 pending 也就永远清不掉，容器面板从这以后再也刷不动。
       'close' 是这条连接彻底没了的兜底信号，一定落地，所以拿它配合一个「只落地一次」的闸收尾。 */
    let done = false;
    const once = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    const req = http.request(
      { ...dockerTarget, method, path: `/${DOCKER_API}${api}`, headers: { Accept: 'application/json' }, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (e) => once(reject, new Error('Docker 应答读坏了：' + (e.code || e.message))));
        res.on('aborted', () => once(reject, new Error('Docker 应答中途断开了连接')));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return once(reject, dockerErr(raw, res.statusCode));
          // /_ping 这类接口回的是纯文本 OK，别当成解析失败
          if (!raw) return once(resolve, null);
          try {
            once(resolve, JSON.parse(raw));
          } catch {
            once(resolve, raw);
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('连 Docker 超时')));
    req.on('error', (e) =>
      once(
        reject,
        new Error(e.code === 'ENOENT' || e.code === 'ENOTFOUND' ? '找不到 Docker 套接字' : e.code === 'ECONNREFUSED' ? 'Docker 端口没人监听' : e.message)
      )
    );
    req.on('close', () => once(reject, new Error('与 Docker 的连接中途断开了')));
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
  /* dockerList 失败时给的是 null（缓存层把出错折成 null），空列表才是真的一个容器都没有。
     两者不能混：把故障画成「可用、0 个容器」，面板上就是一片空白加一句假的可用的 */
  const listed = await dockerList();
  if (!listed) return { available: false, error: 'Docker 没能给出容器列表', containers: {} };
  const byName = new Map(listed.map((c) => [c.name, c]));
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
     · 网络取 /proc/net/dev 的收发字节，同样作差成速率；回环和 Docker 自己的网桥不算，
       被 bond / bridge 收编的从属网卡也不算（上层那一个已经把它的量数进去了）。容器默认只看得见自己
       那块虚拟网卡，这一档数字是真的但数的不是这台机器，所以带 localOnly 让行上说明白
     · 核显在 /sys/class/drm 每张 card 的子树里认那几个文件名（gpu_busy_percent / busy_percent / 频率三档），
       驱动只写频率时按 RPn→RP0 折算成百分比，并在行上写明这一格是折算的
     · 物理盘取 /sys/block 的目录名、size 与 device/model，那里只有型号和大小，从来不是路径
     · 盘上「用了多少」是拿 /proc/self/mountinfo 第三栏的设备号对上 /sys/block/<盘>/<分区>/dev 归过去的，
       全程只比数字串；对上之后出口的是 sysfs 里那个节点名（sda、sda2、md0），不是 /dev/ 打头的那串路径——
       容器里的 /dev 根本没有宿主机的设备节点，写了等于编一个
     · 每个卷只对目录本身调一次 statfs：那是整个文件系统的账，返回里不会出现一个文件名
     · 卷卡片上的挂载点写的是宿主机那一条路径，而那一条只有生成 compose 的 deploy.sh 知道（容器里的挂载表
       只看得到 /host/<id>），由它写进 HOST_VOLUME_MAP 交进来；没给就空着，页面那段跟着省掉
   候选卷 = 数据目录 + 挂进来的 /host 第一层目录。宿主机没挂进来的目录在容器里本来就不存在，
   所以 deploy.sh 每探到一卷就往 compose 里写一行只读挂载，页面自己就多出一张卷卡片，这里不需要配开关。 */

// 自测用的前缀：把一份假的 proc / sys / host 目录树指过来，在没有 Linux 的开发机上也能跑通这套解析
const SYS_ROOT = path.resolve(process.env.NAV_SYS_ROOT || '/');
const SYS_TTL = 5000;
// 认不出来就不是物理盘：loop / ram / zram 是内存兜出来的块设备，sr 是光驱，md 与 dm- 是 RAID / LVM 叠出来的，
// nbd / fd / live 一类是网络与引导用的。用黑名单是因为各家的盘名实在不统一（sdX、nvmeXnY、mmcblkX，
// 群晖那种 sata1 / sataA 也确有存在），照白名单猜会把真盘滤掉。
const DISK_SKIP = /^(?:loop|ram|zram|sr|md|dm-|nbd|fd|live|dat|bgvt|ubi|mtd)/;
// /sys/block/*/size 自己写着单位是 512 字节，跟机器扇区无关
const SECTOR = 512;

const sysPath = (...parts) => path.join(SYS_ROOT, ...parts);

/* 卷在宿主机上真实挂在哪条路径：容器里的挂载表只有 /host/<挂点名>，宿主那一条从来看不见，
   所以由写 compose 的那一方（deploy.sh 自动探卷，手写 compose 的人自己填）交进来。
   格式是 `<挂点名>=<宿主机绝对路径>`，几卷之间用分号隔开。挂点名先过 VOL_ID_RE，路径要求绝对、
   不带控制字符、最长 200，认不出的那一条整条丢掉——这一串是要出现在页面上的，不能照单全收。 */
const HOST_MOUNT_RE = /^\/[^\u0000-\u001f\u007f]{0,199}$/;
const HOST_MAP_MAX = 64;

function hostMountMap() {
  const out = new Map();
  for (const part of String(process.env.HOST_VOLUME_MAP || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const id = part.slice(0, eq);
    if (!VOL_ID_RE.test(id)) continue;
    // 只把结尾和中间重复的斜杠收一下：宿主机路径里没有八进制转义那一套，别拿挂载表的读法套它
    const p = part.slice(eq + 1).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    if (!HOST_MOUNT_RE.test(p)) continue;
    out.set(id, p);
    if (out.size >= HOST_MAP_MAX) break;
  }
  return out;
}

const HOST_MOUNTS = hostMountMap();

function readSysText(rel) {
  try {
    return String(fs.readFileSync(sysPath(rel), 'utf8')).trim();
  } catch {
    return '';
  }
}

const devFile = (rel) => {
  const t = readSysText(rel);
  return /^\d+:\d+$/.test(t) ? t : '';
};

// 只认名字，不看类型：/sys/block 下面每一项都是符号链接，用 withFileTypes + isDirectory 会一块盘都不剩
// （开发机上那棵仿真树全是真目录，恰好看不出来这个坑——真机 v1.0.4 就栽在这儿）
function readSysDir(rel) {
  try {
    return fs.readdirSync(sysPath(rel));
  } catch {
    return [];
  }
}

/* 盘对到用量上靠的是设备号：/proc/self/mountinfo 第三栏写的「主:次」，和 /sys/block/<盘>/<分区>/dev
   写的是同一个字符串（两边都由内核自己格式化，没有编码口径的问题）。拿它当线索，卷那一行才知道自己落在
   哪块盘、哪个分区上。这张表只认「设备号 + 容器里的路径 + 文件系统类型」三项，那一行写的来源（/dev/…）
   与子路径都不出口；页面上的挂载点是宿主机那一条路径，来自上面那份 HOST_VOLUME_MAP。 */
const CI_PATH = process.platform === 'win32';

function normPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const t = s || '/';
  return CI_PATH ? t.toLowerCase() : t;
}

// mountinfo 里的挂载点把空格和制表符写成 \040 这样的八进制，所以按空白切字段是安全的，读进来再还原
function unescapeMount(p) {
  return normPath(p.replace(/\\(040|011|012|134)/g, (_, o) => ({ '040': ' ', '011': '\t', '012': '\n', '134': '\\' }[o])));
}

function mountTable() {
  let raw;
  try {
    raw = fs.readFileSync(sysPath('proc', 'self', 'mountinfo'), 'utf8');
  } catch {
    return null;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^\d+:\d+$/.test(f[2])) continue;
    // 挂载点后面那串可选字段以单个 '-' 收口，'- ' 之后第一位就是文件系统类型。
    // bind mount 抄的是宿主超级块，所以 /host/vol1 这一行写的类型就是宿主机那一卷自己的。
    let sep = -1;
    for (let i = 5; i < f.length; i++) {
      if (f[i] === '-') {
        sep = i;
        break;
      }
    }
    out.push({ dev: f[2], mount: unescapeMount(f[4]), fs: sep >= 0 ? f[sep + 1] || '' : '' });
  }
  return out;
}

/* 虚拟文件系统没有「容量」这回事：proc / sysfs 那些是内核自己的账，tmpfs 是内存，overlay 是容器这层
   的地盘，squashfs 是 snap 那种只读镜像。探到的卷落在这类上面就当它不是一卷，免得主页多出一行数字
   对不上现实的条。fuse.sshfs、nfs、cifs 这些是真远端，容量报得出来，不在这一列里。 */
const VIRTUAL_FS = /^(?:proc|procfs|sysfs|devtmpfs|devfs|tmpfs|ramfs|rootfs|runfs|hugetlbfs|cgroup2?|cgroupfs|pstore|bpf|securityfs|selinuxfs|debugfs|tracefs|configfs|fusectl|mqueue|binfmt_misc|devpts|autofs(?:4)?|nsfs|overlay(?:fs)?|squashfs|efivarfs|rpc_pipefs|sunrpc|udev|bdev|pipefs|sockfs|virtiofs)$/;

// 这个目录坐在哪个设备上、是什么文件系统：取最长的那个挂载点前缀，跟 df 一个认法
function mountOfDir(mounts, dir) {
  if (!mounts) return { dev: '', fs: '' };
  const p = normPath(dir);
  let hit = null;
  for (const m of mounts) {
    if (!(p === m.mount || p.startsWith(m.mount === '/' ? '/' : m.mount + '/'))) continue;
    if (!hit || m.mount.length > hit.mount.length) hit = m;
  }
  return hit ? { dev: hit.dev, fs: hit.fs } : { dev: '', fs: '' };
}

/* 设备号 → 这个文件系统落在哪几块物理盘上、sysfs 里那个节点叫什么。
   sysfs 的规矩是分区目录坐在它那块盘的目录底下（sda/sda1、nvme0n1/nvme0n1p1、md127/md127p1），
   所以「哪块盘的分区」按目录归属认，不拿名字猜前缀——群晖那种 sata1 和 sata12 摆在一起时前缀会认错。
   md / dm- 这类叠出来的设备自己不存数据，往下翻成员（RAID1 会翻出两块盘，那份用量是整组的）。
   卷和硬盘两处共用这一份索引：一次采样只扫一遍 /sys/block。 */
function blockIndex() {
  const names = readSysDir(path.join('sys', 'block'));
  if (!names.length) return null;
  const isDisk = new Set(names.filter((n) => !DISK_SKIP.test(n)));
  const childOf = new Map();
  const byDev = new Map();
  // node 是带着这个文件系统的那个 sysfs 名字（整盘就是盘名自己），device 只在成员归到唯一一块盘时才有
  const put = (dev, list, node) => {
    if (byDev.has(dev) || !dev || !list || !list.length) return;
    byDev.set(dev, { owners: list, node, device: list.length === 1 ? list[0] : '' });
  };
  for (const n of names) {
    const here = path.join('sys', 'block', n);
    if (isDisk.has(n)) put(devFile(path.join(here, 'dev')), [n], n);
    for (const k of readSysDir(here)) {
      if (!k.startsWith(n) || !/^p?\d+$/.test(k.slice(n.length))) continue;
      childOf.set(k, n);
      if (isDisk.has(n)) put(devFile(path.join(here, k, 'dev')), [n], k);
    }
  }
  const ownersOf = (node, depth, seen) => {
    const out = new Set();
    if (depth > 4 || seen.has(node)) return out;
    seen.add(node);
    if (isDisk.has(node)) return out.add(node);
    const parent = childOf.get(node);
    if (parent) return ownersOf(parent, depth + 1, seen);
    for (const k of readSysDir(path.join('sys', 'block', node, 'slaves'))) {
      for (const x of ownersOf(k, depth + 1, seen)) out.add(x);
    }
    if (out.size) return out;
    // md 那类老结构没有 slaves，成员写在 md/dev-xxx/block/dev 里，记的还是设备号
    for (const d of readSysDir(path.join('sys', 'block', node, 'md'))) {
      const hit = byDev.get(devFile(path.join('sys', 'block', node, 'md', d, 'block', 'dev')));
      if (hit) for (const x of hit.owners) out.add(x);
    }
    return out;
  };
  for (const n of names) {
    if (isDisk.has(n)) continue;
    put(devFile(path.join('sys', 'block', n, 'dev')), [...ownersOf(n, 0, new Set())], n);
  }
  // 叠出来的设备自己也可能分了区（md127p1），成员跟它的父节点一样
  for (const [child, parent] of childOf) {
    if (isDisk.has(parent)) continue;
    put(devFile(path.join('sys', 'block', parent, child, 'dev')), [...ownersOf(child, 0, new Set())], child);
  }
  return byDev;
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

/* 这块网卡是不是这台机器自己的物理进出：
   · 被 bond / bridge 收编的从属网卡（/sys/class/net/<name>/master 存在）要跳过——
     上层那一个已经把它成员的量数进去了，两边一起加就是把同一份流量数两遍
   · 带 device（真网卡）或带 lower_*（bond / bridge 这一层）的才算这台的流量
   · 一处都对不上就只剩容器自己那块虚拟网卡：数字是真的，可它是这个容器的进出，不是这台 NAS 的，
     所以另带一份 localOnly 让行上说明白，别拿它冒充实测
   /sys/class/net 读不到时不猜：不写 localOnly。 */
function classifyNic(name) {
  const kids = readSysDir(path.join('sys', 'class', 'net', name));
  if (!kids.length) return null;
  if (kids.some((k) => k.startsWith('lower_'))) return true;
  return kids.includes('device');
}

function nicIsEnslaved(name) {
  try {
    fs.statSync(sysPath('sys', 'class', 'net', name, 'master'));
    return true;
  } catch {
    return false;
  }
}

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
  let phys = null;
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || NET_SKIP.test(name)) continue;
    if (nicIsEnslaved(name)) continue;
    // 收发字节分别是第 1 列和第 9 列，两份表头之外每行的列数固定
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 16 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    rx += f[0];
    tx += f[8];
    seen = true;
    const kind = classifyNic(name);
    if (kind === true) phys = true;
    else if (phys === null && kind === false) phys = false;
  }
  return seen ? { at: Date.now(), rx, tx, phys } : null;
}

let netPrevSys = null;

function readNet() {
  const cur = netSample();
  const out = { down: null, up: null, warming: false };
  if (cur) {
    const prev = netPrevSys;
    netPrevSys = cur;
    out.warming = !prev;
    if (prev && cur.at > prev.at) {
      const secs = (cur.at - prev.at) / 1000;
      const dRx = cur.rx - prev.rx;
      const dTx = cur.tx - prev.tx;
      // 计数回绕（重启或换网卡）时那一路给 null，别把负的塞进格式化函数
      if (dRx >= 0) out.down = dRx / secs;
      if (dTx >= 0) out.up = dTx / secs;
    }
    // phys 是这一轮「这块网卡算不算这机器自己的」的判断，作差不成立时也要照说
    if (cur.phys === false) out.localOnly = true;
  }
  return out;
}

/* 各家驱动把占用率写在不一样的地方，而且这套布局跟着内核版本换名字（i915 是 gt/gt0/rcs0，xe 是 render0/copy0，
   amdgpu 直接写在 device 下），所以这里不写死路径：在这一张卡的 sysfs 子树里认文件名。
   ① gpu_busy_percent —— 写在这一项的驱动（amdgpu、部分 nouveau）读到就用
   ② busy_percent     —— 每个引擎一份，取最大的：一块显卡只要有一个引擎在忙就是忙，求平均会把正在转码的机器报成闲着
   ③ 两处都没有（飞牛那种 Debian + i915 就是这一档）：只剩频率可看。RPn 是停车频率、RP0 是峰值，
      当前频率落在这两点之间哪儿就是这块核显有多忙，折算出来的数在行上写明是折算的
   ④ 连频率都配不齐：把驱动名与能读到的频率写进 note，让卡片说得出卡在哪一步，而不是甩一句读不到 */
const GPU_DIRECT = 'gpu_busy_percent';
const GPU_ENGINE = 'busy_percent';
const GPU_ACT_NAMES = ['gt_act_freq_mhz', 'rps_act_freq_mhz', 'gt_cur_freq_mhz', 'rps_cur_freq_mhz'];
const GPU_FLOOR_NAMES = ['gt_RPn_freq_mhz', 'rps_RPn_freq_mhz', 'gt_min_freq_mhz', 'rps_min_freq_mhz'];
const GPU_TOP_NAMES = ['gt_RP0_freq_mhz', 'rps_RP0_freq_mhz', 'gt_max_freq_mhz', 'rps_max_freq_mhz'];
const GPU_NAME_ROLE = new Map();
for (const n of GPU_ACT_NAMES) GPU_NAME_ROLE.set(n, 'act');
for (const n of GPU_FLOOR_NAMES) GPU_NAME_ROLE.set(n, 'floor');
for (const n of GPU_TOP_NAMES) GPU_NAME_ROLE.set(n, 'top');
GPU_NAME_ROLE.set(GPU_DIRECT, 'direct');
GPU_NAME_ROLE.set(GPU_ENGINE, 'engine');
/* sysfs 里这几个名字会把路径指回别处：subsystem 指向整个 drm 类、driver 指向模块、drm 指回 card 本身。
   跟着走会把别的显卡写的数当成这一块卡的，所以走到这一层就停。 */
const GPU_WALK_STOP = new Set(['subsystem', 'driver', 'drm', 'power', 'firmware_node', 'physical_node', 'msi_bus']);
const GPU_WALK_DEPTH = 4;
const GPU_WALK_DIRS = 160;

function readDriverName(card) {
  try {
    return path.basename(fs.readlinkSync(sysPath('sys', 'class', 'drm', card, 'device', 'driver')));
  } catch {
    return '';
  }
}

/* 一张卡的子树扫一遍，只碰 GPU_NAME_ROLE 里那几个名字，其余文件一个字节都不读。
   目录判定必须 isDirectory() || isSymbolicLink()：sysfs 里 card 到 device 这一路整个是符号链接，
   只看 isDirectory() 会把整棵子树滤成空（跟 /sys/block 那次是同一个坑）。 */
function scanGpuCard(cardRel) {
  const hit = { direct: null, engines: [], freq: {} };
  const queue = [[cardRel, 0]];
  let dirs = 0;
  while (queue.length && dirs < GPU_WALK_DIRS) {
    const [rel, depth] = queue.shift();
    dirs += 1;
    let ents;
    try {
      ents = fs.readdirSync(sysPath(rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const role = GPU_NAME_ROLE.get(e.name);
      if (role) {
        // 空串先拦下：Number('') 是 0，没写这一项的驱动会被报成「占用 0%」，比报读不到更糟
        const raw = readSysText(path.join(rel, e.name));
        const v = raw === '' ? NaN : Number(raw);
        if (Number.isFinite(v)) {
          if (role === 'direct') hit.direct = hit.direct === null ? v : Math.max(hit.direct, v);
          else if (role === 'engine') hit.engines.push(v);
          else if (hit.freq[role] === undefined) hit.freq[role] = v;
        }
      }
      if (depth >= GPU_WALK_DEPTH) continue;
      if (GPU_WALK_STOP.has(e.name)) continue;
      if (e.isDirectory() || e.isSymbolicLink()) queue.push([path.join(rel, e.name), depth + 1]);
    }
  }
  return hit;
}

// RPn 是停车频率、RP0 是峰值：两端齐了才折得出百分比，缺任何一端就老实说没有占用率
function gpuFromFreq(freq, driver) {
  const act = freq.act;
  const floor = freq.floor;
  const top = freq.top;
  if (!Number.isFinite(act) || !Number.isFinite(floor) || !Number.isFinite(top) || top <= floor) return null;
  const used = Math.min(100, Math.max(0, Math.round(((act - floor) / (top - floor)) * 100)));
  return { used, note: (driver ? driver + ' 不写占用率，' : '') + `按核心频率折算（${floor}→${top} MHz）` };
}

function readGpu() {
  let cards;
  try {
    cards = fs
      .readdirSync(sysPath('sys', 'class', 'drm'))
      .filter((n) => /^card\d+$/.test(n))
      .sort();
  } catch {
    return { used: null, note: '这台机器上没有 /sys/class/drm' };
  }
  if (!cards.length) return { used: null, note: '这台机器的 drm 里没有显卡设备' };
  let driver = '';
  let est = null;
  let freq = null;
  for (const n of cards) {
    const hit = scanGpuCard(path.join('sys', 'class', 'drm', n));
    if (hit.direct !== null) return { used: Math.min(100, Math.max(0, Math.round(hit.direct))), note: '' };
    if (hit.engines.length) return { used: Math.min(100, Math.max(0, Math.round(Math.max(...hit.engines)))), note: '' };
    if (!driver) driver = readDriverName(n);
    const f = hit.freq;
    if (!est) est = gpuFromFreq(f, readDriverName(n));
    if (!freq && Number.isFinite(f.act) && Number.isFinite(f.top) && f.top > 0) freq = { cur: f.act, max: f.top };
  }
  if (est) return est;
  const bits = [];
  if (driver) bits.push('驱动 ' + driver + ' 不写占用率');
  if (freq) bits.push(`当前 ${freq.cur} / 峰值 ${freq.max} MHz`);
  return { used: null, note: bits.join(' · ') || '没有驱动写占用率' };
}

function readDisks(vols, noMountinfo, index) {
  const names = readSysDir(path.join('sys', 'block'));
  if (!names.length) return { disks: [], note: '这台机器上没有 /sys/block' };
  // 每卷的账按设备号归到盘上：一块文件系统摊在几块盘上（镜像、阵列），这几块盘各记一次整组的账
  const byDev = index;
  const tally = new Map();
  for (const v of vols) {
    const hit = v.dev && byDev ? byDev.get(v.dev) : null;
    const owners = hit ? hit.owners : null;
    if (!owners) continue;
    for (const d of owners) {
      const t = tally.get(d) || { used: 0, total: 0, avail: 0, shared: false };
      t.used += v.used;
      t.total += v.total;
      t.avail += v.avail;
      if (owners.length > 1) t.shared = true;
      tally.set(d, t);
    }
  }
  const why = noMountinfo
    ? '这台机器上没有 /proc/self/mountinfo'
    : !vols.length
      ? '这一层里没挂进来的卷'
      : !vols.some((v) => v.dev)
        ? '挂载表里对不上这些卷的路径'
        : '没找到挂在这块盘上的文件系统';
  const out = [];
  for (const name of names.filter((n) => !DISK_SKIP.test(n)).sort()) {
    const blocks = Number(readSysText(path.join('sys', 'block', name, 'size')));
    // 0 块是空读卡器和光驱残留，列出来只会碍眼
    if (!(blocks > 0)) continue;
    const rel = ['sys', 'block', name, 'device'];
    // 型号：SATA / NVMe 写 model，eMMC 那类写 name，两个都空就退回设备名
    const model = readSysText(path.join(...rel, 'model')) || readSysText(path.join(...rel, 'name'));
    const row = { name, model: model.slice(0, 40), size: blocks * SECTOR };
    const t = tally.get(name);
    if (t && t.total > 0) {
      // 这里的 total 是这块盘上文件系统加起来的容量，不是 /sys/block 那个裸盘容量：
      // 分区表、没分出去的空格都算不进「还能写多少」，文件系统满才是真满
      row.total = t.total;
      row.used = t.used;
      row.avail = t.avail;
      row.pct = Math.round(Math.min(100, Math.max(0, (t.used / t.total) * 100)) * 10) / 10;
      if (t.shared) row.shared = true;
    } else {
      row.used = null;
      row.why = why;
    }
    out.push(row);
  }
  return { disks: out, note: out.length ? '' : '/sys/block 里没有可用的盘' };
}

// 目录 → 整个文件系统的容量账；statfs 只看目录本身，不碰里面的内容
function readVolume(id, name, dir, mounts, fromHost, index) {
  let st;
  let dev;
  try {
    // 用 statSync 而不是目录项的类型：挂点常是 bind mount / 链接，只看类型会漏
    const s = fs.statSync(dir);
    if (!s.isDirectory()) return null;
    dev = s.dev;
  } catch {
    return null;
  }
  const at = mountOfDir(mounts, dir);
  // 数据目录那一卷永远留着：它至少是这台机器上一份真实的账，宁可它写着 overlay 也别让卡片空着
  if (fromHost && VIRTUAL_FS.test(at.fs)) return null;
  try {
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
  // 这一卷的文件系统落在哪个节点上：整盘就是盘名自己（没有分区表那种摆法），叠出来的设备只有成员不止一块盘时
  // 才说不清该归谁，两种情况都把 device 留空——宁可行上少一段字，也别编一个对不上的盘名出来
  const at2 = at.dev && index ? index.get(at.dev) : null;
  const vol = {
    id,
    name,
    fs: at.fs,
    // 宿主机那一条路径，没交给容器就是空串，页面那段跟着省掉；不拿 /host/xxx 冒充宿主路径
    mount: HOST_MOUNTS.get(id) || '',
    device: at2 ? at2.device : '',
    partition: at2 && at2.node !== at2.device ? at2.node : '',
    total,
    used,
    avail: st.bavail * unit,
    pct: Math.round(pct * 10) / 10,
  };
  return { dev, devId: at.dev, vol };
}

function readVolumes() {
  const mounts = mountTable();
  const index = blockIndex();
  // 挂进来的存储池排在前面：数据目录十有八九就躺在某一卷里面，同一块文件系统该留池子的名字，
  // 而不是留「数据盘」这个只对这台容器有意义的叫法
  const candidates = [];
  try {
    for (const name of fs
      .readdirSync(sysPath('host'))
      // 认不出这个名字的目录就当没看见：卡片按 id 认卷，隐藏目录和带怪字符的名字进不了配置
      .filter((n) => VOL_ID_RE.test(n))
      .sort()) {
      candidates.push({ id: name, name, dir: sysPath('host', name), host: true });
    }
  } catch {
    // 没挂 /host 就只剩数据目录，这本来的默认样子
  }
  candidates.push({ id: 'data', name: '数据盘', dir: DATA_DIR });
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const hit = readVolume(c.id, c.name, c.dir, mounts, c.host, index);
    if (!hit) continue;
    // 同一个文件系统只报一次：数据目录常常就摆在某一卷里面
    if (hit.dev) {
      if (seen.has(hit.dev)) continue;
      seen.add(hit.dev);
    }
    out.push(hit);
  }
  return { hits: out, noMountinfo: !mounts, index };
}

const sysCache = ttlCache(SYS_TTL, SYS_TTL);

function systemState() {
  return sysCache.load(() => {
    // 卷要先读：硬盘那一行的已用与百分比是从每卷的文件系统账按设备号归过去的，两边共用同一份 sysfs 索引
    const vols = readVolumes();
    const disks = readDisks(
      vols.hits.map((h) => ({ dev: h.devId, ...h.vol })),
      vols.noMountinfo,
      vols.index
    );
    return {
      ok: true,
      error: '',
      at: Date.now(),
      memory: readMemory(),
      cpu: readCpu(),
      net: readNet(),
      gpu: readGpu(),
      volumes: vols.hits.map((h) => h.vol),
      disks: disks.disks,
      // 硬盘那一项为什么空着：页面把这句原样写在行上，省得只看到「读不到」
      diskNote: disks.note,
    };
  });
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

/* 动态壁纸：视频不走 data URL（体积大、base64 还要再涨三分之一），直接按原始字节流收。
   只认 MP4 / WebM / Ogg 三种浏览器能直接播的容器，按文件头认，不信 Content-Type。 */
const VIDEO_MAX_BYTES = 80 * 1024 * 1024;

function sniffVideoExt(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return '.ogv';
  return '';
}

function handleVideoUpload(req, res) {
  const len = Number(req.headers['content-length'] || 0);
  if (len && len > VIDEO_MAX_BYTES) return send(res, 413, { error: '视频最大 80MB' });
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > VIDEO_MAX_BYTES) {
      over = true;
      // 先把 413 发出去，响应写完再掐连接，别让超传的文件继续占带宽
      res.on('finish', () => req.destroy());
      send(res, 413, { error: '视频最大 80MB' });
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    const buf = Buffer.concat(chunks);
    const ext = sniffVideoExt(buf);
    if (!ext) return send(res, 400, { error: '只支持 MP4 / WebM / Ogg 视频' });
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    send(res, 200, { url: '/media/' + name, bytes: buf.length });
  });
  req.on('error', () => {});
}

/* ---------- 抓取站点图标：页面在 https 下打不开内网 http 图标时，由服务端替它出网 ----------
   抓回来的图和上传的图走同一套存法（sha1 内容寻址 + UPLOAD_DIR + /media/），
   所以抓完只是草稿，点保存才进配置；没保存就被 GC 清掉也不丢什么。 */
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const ICON_TIMEOUT = 5000;
const ICON_MAX_REDIRECTS = 3;
// 用普通浏览器的 UA：不少 CDN / 门户对陌生 UA 直接 403，浏览器看得见、服务端却抓不到
const ICON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 读页面 HTML 只为找 <link rel="icon">，别把整站页面拖下来
const ICON_PAGE_TIMEOUT = 4000;
const ICON_PAGE_MAX_BYTES = 512 * 1024;

/* ---------- 抓过的图标在 NAS 上留档（data/icons.json）----------
   「固定过一次就一直是那一张」：某个图标地址只要成功抓到过，就把这次落在 uploads 里的那张记下来，
   以后同一个地址不再出网，直接把已经存着的回给页面；同一站的两张卡、换设备、换浏览器都拿到同一张。
   全都落空也记一笔，六小时内不再对同一个地址重试，免得每次开页面都对死站发一轮请求。
   记下的那张被 GC 或手工删掉了就算没记过，下一次重新抓。
   这份只是抓图留档，不是用户数据：跟着 data/ 一起备份，但「清空为初始配置」不动它。 */
const ICON_CACHE_PATH = path.join(DATA_DIR, 'icons.json');
const ICON_FAIL_TTL = 6 * 60 * 60 * 1000;
const ICON_CACHE_MAX = 400;
let iconCache = null;
// 同一地址的并发抓取合成一次：首启那八个站、目录里一次加一整类，都只出网一次
const iconInflight = new Map();

function readIconCache() {
  if (iconCache) return iconCache;
  try {
    const raw = JSON.parse(fs.readFileSync(ICON_CACHE_PATH, 'utf8'));
    iconCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    iconCache = {};
  }
  return iconCache;
}

function writeIconCache(key, entry) {
  const c = readIconCache();
  c[key] = entry;
  const keys = Object.keys(c);
  if (keys.length > ICON_CACHE_MAX) {
    // 超出上限按最久没成功的先丢：留档条目本来就少，不做额外结构
    keys.sort((a, b) => (Number(c[a] && c[a].at) || 0) - (Number(c[b] && c[b].at) || 0));
    for (const k of keys.slice(0, keys.length - ICON_CACHE_MAX)) delete c[k];
  }
  try {
    writePrivate(ICON_CACHE_PATH, JSON.stringify(c, null, 2));
  } catch (e) {
    console.warn('icons.json 写入失败：' + e.message);
  }
}

// 留档里的文件还在不在：不在就报「没记过」，让调用方重新抓
function iconCachedFile(rec) {
  if (!rec || typeof rec.file !== 'string') return '';
  const name = path.basename(rec.file);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) return '';
  try {
    return fs.statSync(path.join(UPLOAD_DIR, name)).isFile() ? '/media/' + name : '';
  } catch {
    return '';
  }
}

function fetchIconShared(target) {
  const p = iconInflight.get(target);
  if (p) return p;
  const run = fetchIconAt(target, ICON_MAX_REDIRECTS).finally(() => iconInflight.delete(target));
  iconInflight.set(target, run);
  return run;
}

/* 站点把图标声明在 <link rel="icon" href="/static/xxx.png"> 这种猜不到的路径上时，
   浏览器自己找得到、我们只看 /favicon.ico 就永远落空。猜的那几档全失败后读一遍页面，
   把这些地址补进候选——图标是浏览器正常显示过的那一张，才有「固定到 NAS」的机会。 */
function fetchPageHtml(target, depth = 2) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(String(target));
    } catch {
      return resolve('');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve('');
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = lib.get(
      u,
      { headers: { 'User-Agent': ICON_UA, Accept: 'text/html,application/xhtml+xml' }, timeout: ICON_PAGE_TIMEOUT },
      (up) => {
        const loc = up.headers && up.headers.location;
        if (up.statusCode >= 300 && up.statusCode < 400 && loc) {
          up.resume();
          if (depth <= 0) return finish('');
          let next = '';
          try {
            next = new URL(loc, u).href;
          } catch {
            return finish('');
          }
          return fetchPageHtml(next, depth - 1).then(finish);
        }
        if (up.statusCode !== 200) {
          up.resume();
          return finish('');
        }
        const type = String(up.headers['content-type'] || '');
        if (type && !/html/i.test(type)) {
          up.resume();
          return finish('');
        }
        const chunks = [];
        let size = 0;
        up.on('data', (c) => {
          size += c.length;
          if (size > ICON_PAGE_MAX_BYTES) {
            req.destroy();
            return finish('');
          }
          chunks.push(c);
        });
        up.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        up.on('error', () => finish(''));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish('');
    });
    req.on('error', () => finish(''));
  });
}

function declaredIconUrls(html, base) {
  const out = [];
  if (!html) return out;
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const relM = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!relM) continue;
    const rel = (relM[2] || relM[3] || relM[4] || '').toLowerCase();
    if (!/(^|\s)(shortcut\s+icon|icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(rel)) continue;
    const hrefM = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = hrefM && (hrefM[2] || hrefM[3] || hrefM[4] || '');
    if (!href) continue;
    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    if (!out.includes(abs)) out.push(abs);
    if (out.length >= 4) break;
  }
  return out;
}

/* 只按文件头认格式，不信 Content-Type：favicon.ico 被报成别 MIME 是常态，
   反过来把登录页 HTML 报成 image/png 的更多（反代、门户、302 到登录页）。 */
const iconSniffers = [
  ['.ico', (b) => b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] === 1 || b[4] === 2)],
  ['.png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a],
  ['.jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.gif', (b) => b.length > 6 && b.slice(0, 4).toString('latin1') === 'GIF8'],
  ['.webp', (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'],
  ['.avif', (b) => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp' && /^av[isio]/i.test(b.slice(8, 12).toString('latin1'))],
  // SVG 是文本，只能松认：开头得是 <svg / <?xml，并且不带脚本、外部实体
  ['.svg', (b) => {
    const s = b.slice(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    return (s.startsWith('<svg') || s.startsWith('<?xml')) && !/<script|<!ENTITY|<!DOCTYPE/i.test(b.slice(0, 2048).toString('utf8'));
  }],
];

function sniffIcon(buf) {
  for (const [ext, test] of iconSniffers) if (test(buf)) return { buf, ext };
  return null;
}

function fetchIconAt(target, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(String(target));
    } catch {
      return reject(new Error('地址不合法'));
    }
    // 这一条是本机自己去连，协议收紧到 http/https：file:// 之类绝不允许从这里出去
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只走 http / https'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      u,
      { headers: { 'User-Agent': ICON_UA, Accept: 'image/*,*/*;q=0.8' }, timeout: ICON_TIMEOUT },
      (up) => {
        const loc = up.headers && up.headers.location;
        if (up.statusCode >= 300 && up.statusCode < 400 && loc) {
          up.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向太多'));
          let next = '';
          try {
            next = new URL(loc, u).href;
          } catch {
            return reject(new Error('重定向地址不合法'));
          }
          return resolve(fetchIconAt(next, redirectsLeft - 1));
        }
        if (up.statusCode !== 200) {
          up.resume();
          return reject(new Error('HTTP ' + up.statusCode));
        }
        const chunks = [];
        let size = 0;
        up.on('data', (c) => {
          size += c.length;
          if (size > ICON_MAX_BYTES) return req.destroy(new Error('图标超过 2MB'));
          chunks.push(c);
        });
        up.on('end', () => {
          const got = sniffIcon(Buffer.concat(chunks));
          if (got) resolve(got);
          else reject(new Error('返回的不是可识别的图标'));
        });
        up.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', (e) => reject(e));
  });
}

async function resolveIcon(link, template) {
  const sources = iconSourceList(link, template);
  if (!sources.length) {
    const e = new Error('内网 / 外网网址至少填一条 http(s) 地址，才有站点图标可抓');
    e.status = 400;
    throw e;
  }
  const tried = [];
  const cache = readIconCache();
  const seen = new Set();
  const trySource = async (src) => {
    if (!src.url || seen.has(src.url)) return null;
    seen.add(src.url);
    const rec = cache[src.url];
    // 1) 这个地址以前抓到过：直接把 NAS 上存着的那一张回出去，一次网都不出
    if (rec && !rec.failAt) {
      const keep = iconCachedFile(rec);
      if (keep) {
        tried.push({ label: src.label, url: src.url, cached: true });
        return { url: keep, label: src.label, source: src.url, tried, cached: true };
      }
    }
    // 2) 六小时内刚试过没拿到：这一档跳过，别每次开页面都对着死站发请求
    if (rec && rec.failAt && Date.now() - Number(rec.failAt) < ICON_FAIL_TTL) {
      tried.push({ label: src.label, url: src.url, error: (rec.error || '最近刚试过') + '（暂缓重试）' });
      return null;
    }
    try {
      const got = await fetchIconShared(src.url);
      const name = crypto.createHash('sha1').update(got.buf).digest('hex').slice(0, 20) + got.ext;
      const file = path.join(UPLOAD_DIR, name);
      // 内容寻址：同一个图标反复抓只占一份文件，写之前看一眼，省一次落盘
      if (!fs.existsSync(file)) fs.writeFileSync(file, got.buf);
      writeIconCache(src.url, { file: '/media/' + name, label: src.label, at: Date.now() });
      return { url: '/media/' + name, label: src.label, source: src.url, tried };
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 120);
      tried.push({ label: src.label, url: src.url, error: why });
      writeIconCache(src.url, { failAt: Date.now(), error: why });
      return null;
    }
  };

  // 猜的几档先试（内网 ico → 外网 ico）；模板放最后：站点自己声明的图标比公共 favicon 服务可信
  const templateSources = sources.filter((s) => s.label === 'favicon 模板');
  for (const src of sources) {
    if (templateSources.includes(src)) continue;
    const r = await trySource(src);
    if (r) return r;
  }

  // 猜不到不代表站点没有：读一遍页面，把它自己声明的 <link rel="icon"> 补进候选
  for (const page of [link.urlLan, link.url].filter(Boolean)) {
    const html = await fetchPageHtml(page);
    for (const url of declaredIconUrls(html, page)) {
      const r = await trySource({ url, label: '站点声明的图标' });
      if (r) return r;
    }
  }

  for (const src of templateSources) {
    const r = await trySource(src);
    if (r) return r;
  }

  // 全都落空时不装作成功：把每一档试到什么、为什么不算，原样带回给调用方
  const e = new Error('按顺序试过了，都没拿到图标：' + tried.map((t) => `${t.label}（${t.error}）`).join('、'));
  e.tried = tried;
  throw e;
}

async function handleIconFetch(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: '请求格式错误' });
  }
  // 网址由调用方给（就是这张卡片自己填的那两条），模板只认配置里那一份：
  // 前端传什么都不看，免得这个接口被人拿来打任意地址。
  const link = {
    url: urlish(pick(body, ['url', 'href', 'link'])),
    urlLan: urlish(pick(body, ['urlLan', 'url_lan', 'lanUrl', 'lan_url'])),
  };
  try {
    return send(res, 200, await resolveIcon(link, readConfig().appearance.iconTemplate));
  } catch (e) {
    return send(res, e.status || 404, { error: e.message, tried: e.tried || [] });
  }
}

/* 页面自己把图标显示出来之后回来落一份：这张图已经在浏览器里验证能拿到了，
   服务端按同一个地址再取一次存进 NAS，之后这张卡改成 /media 固定下来，开页面不再出网。
   地址只认这张卡自己的候选（或这个引擎自己的模板），不做任意 URL 抓取。 */
async function cacheIconSource(src) {
  const rec = readIconCache()[src.url];
  if (rec && !rec.failAt) {
    const keep = iconCachedFile(rec);
    if (keep) return { url: keep, label: src.label, source: src.url, cached: true };
  }
  if (rec && rec.failAt && Date.now() - Number(rec.failAt) < ICON_FAIL_TTL) {
    throw new Error('最近刚试过没拿到（暂缓重试）');
  }
  const got = await fetchIconShared(src.url);
  const name = crypto.createHash('sha1').update(got.buf).digest('hex').slice(0, 20) + got.ext;
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, got.buf);
  writeIconCache(src.url, { file: '/media/' + name, label: src.label, at: Date.now() });
  return { url: '/media/' + name, label: src.label, source: src.url };
}

async function handleIconSave(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: '请求格式错误' });
  }
  const id = String(pick(body, ['id']) || '');
  const url = String(pick(body, ['url']) || '');
  const kind = String(pick(body, ['kind']) || 'link');
  if (!id || !url) return send(res, 400, { error: '缺 id 或 url' });

  const cfg = readConfig();
  let src = null;

  if (kind === 'engine') {
    const eng = (cfg.search && cfg.search.engines ? cfg.search.engines : []).find((e) => e && e.id === id);
    if (!eng) return send(res, 404, { error: '没有这个搜索引擎' });
    const host = iconDomainOf(eng.url);
    const tpl = String(cfg.appearance.iconTemplate || '').trim();
    const expect = host && tpl ? tpl.replace('{domain}', host) : '';
    if (!expect || url !== expect) return send(res, 400, { error: '这个地址不是这个引擎的图标' });
    src = { url, label: '搜索引擎图标' };
  } else {
    const all = [...(cfg.groups || []).flatMap((g) => g.links || []), ...(cfg.docker ? cfg.docker.items || [] : [])];
    const card = all.find((l) => l && l.id === id);
    if (!card) return send(res, 404, { error: '没有这张卡片' });
    src = iconSourceList(card, cfg.appearance.iconTemplate).find((s) => s.url === url) || null;
    if (!src) return send(res, 400, { error: '这个地址不是这张卡的图标候选' });
  }

  try {
    return send(res, 200, await cacheIconSource(src));
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e).slice(0, 200) });
  }
}

/* 存量卡片的图标固定：老版本建的卡片（含首启自带的「常用」8 条）是 auto 档、icon 为空，
   每次打开页面浏览器都要去站点要一次 favicon——图标会「再出来一遍」，内网卡片还可能闪一下。
   服务起来后在后台把这些卡片抓一次、存进 NAS 并改成 image 档，之后页面只读 /media。
   抓不到的保持原样；留档里的六小时暂缓会让下次启动不再对它出网。 */
async function pinLegacyIcons() {
  let cfg;
  try {
    cfg = readConfig();
  } catch {
    return;
  }
  const targets = [];
  for (const g of cfg.groups || []) {
    for (const l of g.links || []) {
      if (l && l.id && l.iconKind === 'auto' && !l.icon && (l.url || l.urlLan)) {
        targets.push({ id: l.id, url: l.url, urlLan: l.urlLan });
      }
    }
  }
  if (!targets.length) return;
  console.log(`图标固定：${targets.length} 张 auto 档卡片开始抓取`);
  const fixed = new Map();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      try {
        const r = await resolveIcon({ url: t.url, urlLan: t.urlLan }, readConfig().appearance.iconTemplate);
        if (r && r.url) fixed.set(t.id, r.url);
      } catch {
        // 失败原因已经记进留档，下一次启动先看六小时暂缓
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!fixed.size) {
    console.log('图标固定：一张都没抓到');
    return;
  }
  // 抓图这段时间里可能有人保存过配置：重新读一遍再写，只动还是 auto 空图标的那几条
  const now = readConfig();
  let hit = 0;
  for (const g of now.groups || []) {
    for (const l of g.links || []) {
      const url = l && fixed.get(l.id);
      if (url && l.iconKind === 'auto' && !l.icon) {
        l.icon = url;
        l.iconKind = 'image';
        hit += 1;
      }
    }
  }
  if (hit) {
    writeConfig(now);
    console.log(`图标固定：${hit} 张已存到 NAS`);
  }
}

/* 清空图标留档：data/icons.json 抹掉，只被留档引用的那几张图跟着被回收。
   配置里正在用的图标一张都不动——所以清完只是「以后要重新抓」，主页上看到的还是原来那张。 */
function handleIconCacheClear(req, res) {
  const before = Object.keys(readIconCache()).length;
  iconCache = {};
  try {
    fs.rmSync(ICON_CACHE_PATH, { force: true });
  } catch (e) {
    return send(res, 500, { error: '留档清不掉：' + e.message });
  }
  // 留档已经空了，这一句只会删掉「配置不认、原先靠留档保命」的那几张
  gcUploads(readConfig());
  send(res, 200, { cleared: before });
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

/* stat 点头之后文件还能消失（改配置触发的清理正和这一枪抢同一个文件），那时读流会抛 'error'；
   没人接这个事件就是未捕获异常，进程跟着走。头已经发出去了，改不了状态码，只能断这条连接。 */
function pipeOrDrop(res, file) {
  const s = fs.createReadStream(file);
  s.on('error', () => res.destroy());
  s.pipe(res);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodePath(pathname);
  if (!rel) return send(res, 404, 'not found');
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
    pipeOrDrop(res, file);
  });
}

function serveMedia(req, res, pathname) {
  const name = path.basename(decodePath(pathname));
  if (!name) return send(res, 404, 'not found');
  const file = path.join(UPLOAD_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const base = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    // 视频要能拖动进度、循环播放：浏览器发 Range 就回 206 那一段，别每次整段重下
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (m) {
      let start;
      let end;
      if (!m[1]) {
        const n = Number(m[2]);
        if (!Number.isFinite(n) || n <= 0) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        start = Math.max(0, st.size - n);
        end = st.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : st.size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    pipeOrDrop(res, file);
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
        const nextAuth = {
          user: nextAccount,
          ...(changingPw ? hashPassword(next) : { salt: auth.salt, hash: auth.hash }),
          source: changingPw ? 'user' : auth.source,
          updatedAt: new Date().toISOString(),
        };
        // 先落盘再换内存里那一份：写坏了（盘满、只读挂载）就维持旧密码，别出现「这一轮会话用新密码、重启又回旧密码」
        writePrivate(AUTH_PATH, JSON.stringify(nextAuth));
        auth = nextAuth;
        console.log(changingPw ? 'credentials changed (account + password)' : 'account renamed');
        send(res, 200, sessionView(true));
      })
      .catch((e) => send(res, e.status || 400, { error: e.message }));
  }

  if (p === '/api/media' && req.method === 'POST') return handleMediaUpload(req, res);

  if (p === '/api/media/video' && req.method === 'POST') return handleVideoUpload(req, res);

  // 按写死的顺序替这张卡片抓一次站点图标，存成上传目录里的固定图标
  if (p === '/api/icon/fetch' && req.method === 'POST') return handleIconFetch(req, res);

  if (p === '/api/icon/save' && req.method === 'POST') return handleIconSave(req, res);

  // 「数据」栏那个清空按钮：只清抓图留档，配置里在用的图标一张不动
  if (p === '/api/icon/cache/clear' && req.method === 'POST') return handleIconCacheClear(req, res);

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
        const list = await dockerList();
        if (!list) return send(res, 200, { available: false, error: 'Docker 没能给出容器列表', containers: [] });
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
  // 存量 auto 卡片在后台固定一次：不挡监听，失败也不影响服务
  setTimeout(() => {
    pinLegacyIcons().catch((e) => console.warn('图标固定失败：' + e.message));
  }, 800);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
