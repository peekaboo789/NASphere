'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));

const uid = (p = 'x') =>
  p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const normalizeUrl = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^(https?|magnet|ftp|file):\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  return 'http://' + s;
};

const looksLikeUrl = (s) => {
  const t = String(s || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^(https?|magnet|ftp|file):\/\//i.test(t)) return true;
  return /^[^\s/]+\.[^\s/]{2,}(:\d+)?([/?#].*)?$/.test(t);
};

const domainOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// 两条都填了就按当前模式各取一边；只填了一条时两种模式都用这一条，卡片不再点不动
const linkHref = (link, mode) => {
  const lan = String((link && link.urlLan) || '');
  const wan = String((link && link.url) || '');
  return mode === 'lan' ? lan || wan : wan || lan;
};

// 带 container（Docker 容器名）的卡片是容器磁贴，不是普通网址卡片
const isContainer = (link) => Boolean(link && link.container);

// 带 res 的是 NAS 资源组件（内存 / 单个卷 / 总览），跟容器组件同住 docker.items
const isResource = (link) => Boolean(link && link.res);

const fmtPct = (v) => (v === null || v === undefined ? '—' : v >= 10 ? v.toFixed(0) + '%' : v.toFixed(1) + '%');

const fmtBytes = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const scaled = v / 1024 ** i;
  return (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)).replace(/\.0$/, '') + ' ' + units[i];
};

// 网络速率：字节/秒 → 「1.5 MB/s」，采不到样本时给一个横杠
const fmtRate = (n) => (Number.isFinite(n) && n >= 0 ? fmtBytes(n) + '/s' : '—');

// 分组可以固定走内网 / 外网，固定了的分组不受右上角全局开关影响
const groupMode = (group, globalMode) =>
  group && (group.netMode === 'lan' || group.netMode === 'wan') ? group.netMode : globalMode;

// Safari 和部分安卓浏览器把 .ico 报成空 type，只看 file.type 会漏掉合法的图标文件
const imageMimeOf = (file) => {
  const type = String((file && file.type) || '');
  if (type.startsWith('image/')) return type;
  return /\.ico$/i.test(String((file && file.name) || '')) ? 'image/x-icon' : type;
};

const isImageFile = (file) => imageMimeOf(file).startsWith('image/');

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const mime = imageMimeOf(file);
      const result = String(r.result);
      resolve(mime ? result.replace(/^data:[^;]*;/, `data:${mime};`) : result);
    };
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });

// 内网常用 http://192.168.x.x 这种非安全上下文，navigator.clipboard 不存在，得回落 execCommand
const copyText = async (text) => {
  const s = String(text || '');
  if (!s) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
};

const Api = {
  async call(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    if (opts.raw) return { data, headers: res.headers };
    return data;
  },
  session: () => Api.call('/api/session'),
  login: (account, password) => Api.call('/api/login', { method: 'POST', body: { account, password } }),
  logout: () => Api.call('/api/logout', { method: 'POST', body: {} }),
  config: (raw) => Api.call('/api/config', { raw }),
  configRev: () => Api.call('/api/config/rev'),
  saveConfig: (cfg) => Api.call('/api/config', { method: 'PUT', body: cfg, raw: true }),
  credentials: (account, current, next) => Api.call('/api/credentials', { method: 'POST', body: { account, current, new: next } }),
  bingWallpaper: () => Api.call('/api/wallpaper/bing'),
  // 登录前就能取到的登录页自有内容：页面标题 + 已解析成图片地址的壁纸
  loginPage: () => Api.call('/api/login-page'),
  // Docker 三个口子都由服务端决定能看哪些容器，前端不传容器名去查
  dockerState: () => Api.call('/api/docker/state'),
  dockerContainers: () => Api.call('/api/docker/containers'),
  dockerAction: (name, action) => Api.call('/api/docker/action', { method: 'POST', body: { name, action } }),
  // NAS 资源读数：内存、每个卷的容量与用量、物理盘型号，服务端只给数字，不给文件
  systemState: () => Api.call('/api/system/state'),
  uploadImage: async (dataUrl) => {
    const r = await Api.call('/api/media', { method: 'POST', body: { image: dataUrl } });
    return r.urls[0];
  },
};

const Store = {
  cfg: null,
  session: { authed: false, defaultPasswordInUse: false, defaultAccountInUse: false, account: '' },
  editMode: false,
  saving: false,
  lastError: null,
  onChange: () => {},
  _timer: 0,
  rev: '',
  _dirty: false,

  async boot() {
    this.session = await Api.session();
    if (!this.session.authed) return false;
    try {
      await this.reloadConfig();
    } catch (e) {
      if (e.status !== 401) throw e;
      this.session = { authed: false };
      return false;
    }
    return true;
  },

  async reloadConfig() {
    const r = await Api.config(true);
    this.cfg = r.data;
    this.rev = r.headers.get('x-config-rev') || '';
    this._dirty = false;
    return this.cfg;
  },

  // 磁盘上的 config.json 被手改过（或在别处保存过）时拉回最新配置；本地有未保存改动则跳过
  async refreshIfChanged() {
    if (!this.cfg || this.saving || this._dirty) return null;
    const remote = await Api.configRev().then((r) => r.rev).catch(() => '');
    if (!remote || remote === this.rev) return null;
    const r = await Api.config(true);
    this.rev = r.headers.get('x-config-rev') || remote;
    if (JSON.stringify(r.data) === JSON.stringify(this.cfg)) return null;
    this.cfg = r.data;
    this._dirty = false;
    return this.cfg;
  },

  mutate(fn) {
    fn(this.cfg);
    this.touch();
    this.onChange();
  },

  touch() {
    clearTimeout(this._timer);
    this._dirty = true;
    if (this.saving) this._dirtyAfterSave = true;
    this._timer = setTimeout(() => this.persist(), 700);
  },

  async persist() {
    if (!this.cfg) return;
    if (this.saving) {
      this._dirtyAfterSave = true;
      return;
    }
    clearTimeout(this._timer);
    this.saving = true;
    document.dispatchEvent(new CustomEvent('nav:saving'));
    try {
      const r = await Api.saveConfig(this.cfg);
      this.rev = (r.headers && r.headers.get('x-config-rev')) || this.rev;
      this._dirty = false;
      this.lastError = null;
      document.dispatchEvent(new CustomEvent('nav:saved', { detail: { at: Date.now() } }));
    } catch (e) {
      this.lastError = e.message;
      document.dispatchEvent(new CustomEvent('nav:error', { detail: { message: e.message } }));
      if (e.status === 401) document.dispatchEvent(new CustomEvent('nav:unauthorized'));
    } finally {
      this.saving = false;
      if (this._dirtyAfterSave) {
        this._dirtyAfterSave = false;
        this.persist();
      }
    }
  },

  async replaceConfig(cfg) {
    this.cfg = cfg;
    this._dirty = true;
    await this.persist();
    this.onChange();
  },

  clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  get groupCount() {
    return this.cfg ? this.cfg.groups.length : 0;
  },
};

const Prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('nav.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('nav.' + key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem('nav.' + key);
    } catch {}
  },
};

const Gradients = {
  midnight: 'radial-gradient(130% 110% at 50% -14%, #1a2340 0%, #0d1220 46%, #080a10 100%)',
  graphite: 'linear-gradient(160deg, #0c0e12 0%, #191d24 55%, #2b323d 100%)',
  dusk: 'linear-gradient(140deg, #0c1224 0%, #241a3c 52%, #4a3a63 100%)',
  aurora: 'linear-gradient(160deg, #062b2b 0%, #0f6f6c 40%, #6ec6a0 75%, #f4e9c9 100%)',
  ocean: 'linear-gradient(160deg, #041e42 0%, #0b4d7a 50%, #38a3c4 100%)',
  forest: 'linear-gradient(160deg, #0d1f14 0%, #24502f 50%, #6f9a5c 100%)',
  sunset: 'linear-gradient(160deg, #21103a 0%, #a03a5c 55%, #f0a05a 100%)',
  grape: 'linear-gradient(160deg, #16112e 0%, #4b2d82 55%, #a86cd9 100%)',
  slate: 'linear-gradient(160deg, #14161a 0%, #2c313a 60%, #5b6472 100%)',
  paper: 'linear-gradient(160deg, #e9e4d8 0%, #cfd7e0 55%, #a9bcd0 100%)',
};
