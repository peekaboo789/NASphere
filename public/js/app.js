'use strict';

/* 右上角内外网图标：描边走 currentColor，跟白色文字令牌一起变 */
const NET_ICON_LAN = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.6 10.6 12 4.2l8.4 6.4V20h-6.2v-5.3H9.8V20H3.6z"></path></svg>';
const NET_ICON_WAN = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.2"></circle><path d="M3.8 12h16.4M12 3.8c2.5 2.4 2.5 14 0 16.4M12 3.8c-2.5 2.4-2.5 14 0 16.4"></path></svg>';

/* ---------- 容器实时数据：3 秒一轮，只在页面上真的有容器组件时才跑 ---------- */

// 每张组件的长宽：刻度与服务端 sanitize 里的钳制范围一一对应，默认值也与 DK 常量一致
const DK_TILE = { minW: 120, maxW: 900, minH: 64, maxH: 600, defW: 250, defH: 118 };
// 新组件落在最下面那张的下方，别一上来就盖住已有的（间距与服务端补位那档一致）
const DK_GAP = 16;

const Docker = {
  byName: new Map(),
  timer: 0,
  busy: false,
  available: null,
  bound: false,

  refs() {
    const out = [];
    for (const l of (Store.cfg && Store.cfg.docker && Store.cfg.docker.items) || []) {
      if (isContainer(l) && !out.includes(l.container)) out.push(l.container);
    }
    return out;
  },

  get(name) {
    return this.byName.get(name) || null;
  },

  // 每次重画分组之后调用：清掉已删除的容器、按需要起停轮询
  sync() {
    const names = this.refs();
    for (const key of [...this.byName.keys()]) if (!names.includes(key)) this.byName.delete(key);
    clearInterval(this.timer);
    this.timer = 0;
    if (!names.length) return;
    if (!this.bound) {
      this.bound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.timer) this.fetch();
      });
    }
    this.paintAll();
    this.fetch();
    this.timer = setInterval(() => {
      if (!document.hidden) this.fetch();
    }, 3000);
  },

  async fetch() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await Api.dockerState();
      this.available = Boolean(r.available);
      for (const [name, info] of Object.entries(r.containers || {})) this.byName.set(name, info);
    } catch {
      // 取不到数据就维持上一轮的数字，别让一次网络抖动把卡片刷成空
      this.available = null;
    } finally {
      this.busy = false;
    }
    this.paintAll();
  },

  // 启停之后立刻补一轮，别等下一个 3 秒
  refresh() {
    clearInterval(this.timer);
    this.timer = 0;
    if (!this.refs().length) return;
    this.fetch().then(() => {
      this.timer = setInterval(() => {
        if (!document.hidden) this.fetch();
      }, 3000);
    });
  },

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  },

  paintAll() {
    // 页面上的组件与设置那一栏的行用的是同一套 data-* 钩子，一轮刷两处
    for (const node of $$('#dkLayer [data-container], #dkTileList [data-container]')) this.paint(node);
    this.paintCabinet();
  },

  // 「容器一览」里已绑定的那些行跟着轮询走；没绑的只能停在读取列表那一刻的状态（实时数据只查配置点名的容器）
  paintCabinet() {
    for (const row of $$('#dkCabinet [data-name]')) {
      const info = this.get(row.dataset.name);
      if (!info || !info.found) continue;
      row.dataset.state = info.state;
      const label = row.querySelector('.docker-state');
      if (label) label.textContent = this.stateText(info);
    }
  },

  stateText(info) {
    if (!info) return this.available === false ? 'Docker 不可用' : '查询中';
    if (!info.found) return '容器不存在';
    return { running: '运行中', paused: '已暂停', restarting: '重启中', exited: '已停止', created: '未启动', dead: '已失效' }[info.state] || info.state;
  },

  value(info, key) {
    if (!info || !info.found) return '—';
    if (key === 'net') {
      // 首轮采样没有上一次计数可作差，两次都缺就只给一个横杠，别写成「↓ — ↑ —」
      if (!Number.isFinite(info.netDown) && !Number.isFinite(info.netUp)) return '—';
      return `↓ ${fmtRate(info.netDown)} ↑ ${fmtRate(info.netUp)}`;
    }
    const v = info[key];
    if (v === null || v === undefined) return '—';
    return key === 'cpu' ? fmtPct(v) : fmtBytes(v);
  },

  summary(name) {
    const info = this.get(name);
    return `${name}：${this.stateText(info)} · CPU ${this.value(info, 'cpu')} · 内存 ${this.value(info, 'mem')}`;
  },

  paint(node) {
    const name = node.dataset.container;
    const info = this.get(name);
    // 配置里点名了但 Docker 上找不到 = 容器被删了；整套 Docker 连不上 = unreachable。两件事别混成一个状态
    node.dataset.dstate = info ? (info.found ? info.state : 'missing') : this.available === false ? 'unreachable' : 'unknown';
    const cpu = node.querySelector('[data-cpu]');
    const mem = node.querySelector('[data-mem]');
    const net = node.querySelector('[data-net]');
    // 标签（CPU / 内存）写在版式里，这里只填数字
    if (cpu) cpu.textContent = this.value(info, 'cpu');
    if (mem) mem.textContent = this.value(info, 'mem');
    if (net) net.textContent = this.value(info, 'net');
    const label = node.querySelector('[data-state-text]');
    if (label) label.textContent = this.stateText(info);
    const img = node.querySelector('[data-image]');
    // 镜像名只有真查到的容器才有；查不到就把这一格收掉，别留个空竖线
    if (img) {
      img.hidden = !(info && info.image);
      if (info && info.image) img.textContent = info.image;
    }
  },
};

const App = {
  bound: false,
  bingToken: 0,
  // 当前这台设备走内网还是外网，只记在浏览器本地：同一账号在家/在外的设备互不影响
  netMode: Prefs.get('netMode', 'lan') === 'wan' ? 'wan' : 'lan',

  async init() {
    // 登录页不记账号：把老版本存在本机的账号名清掉
    Prefs.remove('account');
    this.bindLogin();
    this.bindKeys();
    let ready = false;
    try {
      ready = await Store.boot();
    } catch (e) {
      this.fatal(e);
      return;
    }
    if (!ready) {
      $('#bootScreen').hidden = true;
      this.showLogin();
      return;
    }
    await this.startSession();
  },

  fatal(e) {
    const box = $('#bootScreen');
    box.hidden = false;
    box.classList.add('error');
    box.textContent = '无法加载导航数据：' + (e.message || e) + '。请确认已登录或 NAS 服务正常。';
  },

  async startSession() {
    $('#bootScreen').hidden = true;
    $('#app').hidden = false;
    if (!this.bound) {
      this.bound = true;
      this.bindTopbar();
      this.bindSearch();
      this.bindSaveStateHandlers();
      this.bindSettings();
      this.bindLinkModal();
      this.bindGroupModal();
      this.bindFileDropGuard();
      this.bindNavRails();
      this.bindCtxMenu();
      this.bindSwapPick();
      Widgets.bindPanels();
    }
    Widgets.startClock();
    this.renderAll();
    Widgets.refreshWeather();
    clearInterval(this.weatherTimer);
    this.weatherTimer = setInterval(() => Widgets.refreshWeather(), 15 * 60000);
    this.startConfigWatch();
    if (Store.session.defaultPasswordInUse) {
      this.toast('正在使用默认密码 admin123，请到「设置 → 安全」修改', 6000);
    }
  },

  /* ---------- 外部修改 config.json 的自动同步 ---------- */

  startConfigWatch() {
    clearInterval(this.configTimer);
    this.configTimer = setInterval(() => this.checkExternalConfig(), 20000);
    if (this.configWatchBound) return;
    this.configWatchBound = true;
    window.addEventListener('focus', () => this.checkExternalConfig());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.checkExternalConfig();
    });
  },

  editingInModal() {
    return ['#linkModal', '#groupModal', '#settingsModal'].some((s) => {
      const m = $(s);
      return m && !m.hidden;
    });
  },

  async checkExternalConfig() {
    if (document.hidden || this.editingInModal()) return;
    try {
      const cfg = await Store.refreshIfChanged();
      if (!cfg) return;
      this.renderAll();
      this.syncSettings();
      this.toast('配置已更新（来自 config.json）');
    } catch (e) {
      if (e.status === 401) document.dispatchEvent(new CustomEvent('nav:unauthorized'));
    }
  },

  /* ---------- render ---------- */

  renderAll() {
    if (!Store.editMode) this.swapPick = null;
    this.applyAppearance();
    this.renderSearch();
    this.syncNetMode();
    this.renderGroups();
    this.renderDockerTiles();
    Widgets.renderPanels();
    $('#editModeToggle').checked = Store.editMode;
    document.documentElement.dataset.edit = Store.editMode ? 'on' : 'off';
    $('#editBar').hidden = !Store.editMode;
  },

  applyAppearance() {
    const ap = Store.cfg.appearance;
    const dark = ap.theme === 'dark' || (ap.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.dataset.resolved = dark ? 'dark' : 'light';
    root.dataset.iconsize = ap.iconSize;
    root.dataset.layout = ap.tileLayout === 'left' ? 'left' : 'top';
    root.style.setProperty('--accent', ap.accent);
    // 字号与行距跟图标档位分开：档位只管图标框，文字大小和行间距由设置里的滑块给
    root.style.setProperty('--title-fs', ap.fontSize + 'px');
    root.style.setProperty('--row-gap', ap.rowGap + 'px');
    document.title = ap.title || 'NASphere';
    $('#clockBox').hidden = !ap.widgets.clock;
    $('#weatherChip').hidden = !ap.widgets.weather;
    // 顶栏只有天气那一枚芯片，所以「芯片平时会不会出现」要由设置说了算（CSS 靠这个属性收掉整行）
    root.dataset.weather = ap.widgets.weather ? 'on' : 'off';
    this.applyWallpaper(ap.wallpaper);
  },

  applyWallpaper(wp) {
    // 主页壁纸或标题一变，登录页那份缓存就作废（登录页只跟随，不单独设置）
    this.loginPageCache = null;
    this.paintWallpaper($('#bgLayer'), $('#bgVeil'), wp);
  },

  // 壁纸绘制主页与登录页共用；登录页拿的是 /api/login-page 里已经解析成图片地址的那一份
  paintWallpaper(bg, veil, wp) {
    const fits = { cover: 'cover', contain: 'contain', stretch: '100% 100%' };
    veil.style.opacity = String(wp.dim);
    bg.style.filter = wp.blur ? `blur(${wp.blur}px)` : '';
    // 只在 .bg 上写长写属性，填充方式才能被 CSS 变量带过去
    bg.style.setProperty('--wp-size', fits[wp.fit] || 'cover');
    const cssUrl = (u) => `url("${String(u).replace(/["\\]/g, '')}")`;

    if (wp.kind === 'none') {
      bg.style.backgroundImage = 'none';
      bg.style.backgroundColor = 'transparent';
      veil.style.opacity = '0';
      return;
    }
    if (wp.kind === 'gradient') {
      bg.style.backgroundImage = Gradients[wp.value] || Gradients.midnight;
      bg.style.backgroundColor = '';
      return;
    }
    if (wp.kind === 'bing') {
      bg.style.backgroundImage = Gradients.slate;
      bg.style.backgroundColor = '';
      const token = ++this.bingToken;
      Api.bingWallpaper()
        .then((r) => {
          if (token !== this.bingToken) return;
          bg.style.backgroundImage = cssUrl(r.url);
          bg.style.backgroundColor = '#0a0d13';
        })
        .catch(() => {});
      return;
    }
    if (wp.value) {
      bg.style.backgroundColor = '#0a0d13';
      bg.style.backgroundImage = cssUrl(wp.value);
    }
  },

  renderGroups() {
    const host = $('#groups');
    const prev = this.captureTiles();
    this.flatIds = [];
    for (const g of Store.cfg.groups) for (const l of g.links) this.flatIds.push(l.id);
    host.innerHTML = '';
    for (const g of Store.cfg.groups) host.appendChild(this.groupNode(g));
    this.playFlip(prev);
    this.renderSideNav();
    this.updateScrollRail();
  },

  /* ---------- 容器组件：每张各自带坐标摆在主页上（应用矩阵那个窗口已经撤了），长宽和位置各存各的 ---------- */

  renderDockerTiles() {
    const layer = $('#dkLayer');
    const items = (Store.cfg.docker && Store.cfg.docker.items) || [];
    if (!items.length) {
      layer.hidden = true;
      layer.innerHTML = '';
      layer.style.height = '0px';
      Docker.sync();
      return;
    }
    layer.hidden = false;
    layer.innerHTML = '';
    for (const item of items) layer.appendChild(this.dockerTileNode(item));
    this.fitDockerLayer();
    Docker.sync();
  },

  /* 绝对定位不撑页面高度：这条摆放区的高度得按最下面那张组件自己拉出来，
     不然把组件拖到区外就永远滚不到、看不见。 */
  fitDockerLayer() {
    const layer = $('#dkLayer');
    let bottom = 0;
    for (const it of (Store.cfg.docker && Store.cfg.docker.items) || []) {
      bottom = Math.max(bottom, (it.y || 0) + (it.h || 0));
    }
    layer.style.height = bottom + 'px';
  },

  // 新组件的落点：最下面那张的再下面，别一盖上去就挡住已有的
  nextDockerPos() {
    let bottom = 0;
    for (const it of (Store.cfg.docker && Store.cfg.docker.items) || []) {
      bottom = Math.max(bottom, (it.y || 0) + (it.h || 0));
    }
    return { x: 0, y: bottom ? bottom + DK_GAP : 0 };
  },

  dockerTileNode(item) {
    const a = document.createElement('a');
    const href = linkHref(item, this.netMode);
    a.className = 'dk-tile' + (href ? '' : ' dk-no-href');
    a.href = href || '#';
    // 和分组卡片一样：点组件是另开一页，不把主页带走
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.link = item.id;
    a.dataset.container = item.container;
    // 位置与尺寸都走 CSS 变量：窄屏要在「配置的 px」和「屏幕可用宽」之间取小的，写死 style.left 就夹不住
    a.style.setProperty('--dk-x', (item.x || 0) + 'px');
    a.style.setProperty('--dk-y', (item.y || 0) + 'px');
    a.style.setProperty('--dk-tile-w', item.w + 'px');
    a.style.setProperty('--dk-tile-h', item.h + 'px');
    a.title = item.desc ? `${item.title}\n${item.desc}` : item.title;

    const title = document.createElement('span');
    title.className = 'tile-title';
    title.textContent = item.title;
    a.appendChild(this.iconNode(item));
    a.appendChild(title);
    a.appendChild(this.dockerMetaNode(item));
    a.appendChild(this.dockerStatNode());

    if (Store.editMode) {
      const x = document.createElement('button');
      x.className = 'tile-x';
      x.type = 'button';
      x.title = '移除这张组件（只从主页摘掉，不动 NAS 上的容器）';
      x.textContent = '✕';
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.removeDockerItem(item);
      });
      a.appendChild(x);
      // 编辑模式只用来排列：点组件别把标签页弹出去，改内容去「设置」里
      a.addEventListener('click', (e) => e.preventDefault());
    }

    this.bindDockerDrag(a, item);
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.holdDrag || Date.now() < this.ctxBlockedBy) return;
      this.openDockerCtxMenu(item, e.clientX, e.clientY);
    });
    if (!href) {
      a.addEventListener('click', (e) => {
        if (Store.editMode) return;
        e.preventDefault();
        // 容器组件本来就可以不填网址，点击给一句当前状态
        this.toast(Docker.summary(item.container), 2600);
      });
    }
    return a;
  },

  /* ---------- 长按拖动组件：和分组卡片同一档长按（420ms），只是落点是自由坐标而不是插入位 ---------- */

  bindDockerDrag(el, item) {
    // 组件不支持系统那套拖拽，指针长按才是唯一的挪位置方式
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('button')) return;
      this.clearClickKiller();
      if (this.holdDrag) this.cancelHoldDrag(this.holdDrag);
      const r = el.getBoundingClientRect();
      const st = {
        el,
        item,
        // 窄屏那一档 CSS 把组件改成静态竖排（配置里的坐标夹不进屏宽，见 styles.css 那条）：
        // 这时候没有坐标落点可写，长按只当手机上的「右键」，拖了也不动配置
        free: getComputedStyle(el).position === 'absolute',
        // 记住手指落在卡片内部的哪一处：拖动中保持这点不动，卡片不会跳一下
        grabX: e.clientX - r.left,
        grabY: e.clientY - r.top,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        moved: false,
        touch: e.pointerType === 'touch',
      };
      st.onMove = (ev) => this.onDockerDragMove(st, ev);
      st.onEnd = () => this.endDockerDrag(st);
      st.timer = setTimeout(() => this.beginDockerDrag(st), this.HOLD_MS);
      window.addEventListener('pointermove', st.onMove);
      window.addEventListener('pointerup', st.onEnd);
      window.addEventListener('pointercancel', st.onEnd);
      this.holdDrag = st;
    });
  },

  beginDockerDrag(st) {
    st.active = true;
    if (!st.free) return;
    st.el.classList.add('dragging');
    document.body.classList.add('holding-drag');
    if (!st.touch) return;
    // 手指按满半秒就算起拖：接下来的页面滚动要让位给拖动（两者走的是同一根手指）
    st.blocker = (ev) => ev.preventDefault();
    window.addEventListener('touchmove', st.blocker, { passive: false });
  },

  onDockerDragMove(st, e) {
    if (!st.active) {
      // 半秒内先动了 = 只是想点击或滚动页面，不算长按
      if (this.holdMoved(st, e)) this.cancelHoldDrag(st);
      return;
    }
    st.moved = st.moved || this.holdMoved(st, e);
    st.x = e.clientX;
    st.y = e.clientY;
    if (!st.free || !st.moved) return;
    // 拖的时候只改这一张的 CSS 变量：整页重画会把指针底下这张换掉，拖动就断了。
    // 每次重新量一遍摆放区，中途滚了页面也跟得上。
    const lr = $('#dkLayer').getBoundingClientRect();
    st.el.style.setProperty('--dk-x', Math.max(0, e.clientX - lr.left - st.grabX) + 'px');
    st.el.style.setProperty('--dk-y', Math.max(0, e.clientY - lr.top - st.grabY) + 'px');
  },

  endDockerDrag(st) {
    const dragged = st.active;
    this.cancelHoldDrag(st);
    if (!dragged) return;
    st.el.classList.remove('dragging');
    document.body.classList.remove('holding-drag');
    // 两种情况都开这张组件的菜单：窄屏上拖不动（长按＝右键），手指按住不动再松开也算右键、位置算原地没挪
    if (!st.free || (st.touch && !st.moved)) {
      this.ctxBlockedBy = Date.now() + 600;
      this.openDockerCtxMenu(st.item, st.x, st.y);
      this.swallowNextClick();
      return;
    }
    this.commitDockerPos(st.el, st.item);
    this.swallowNextClick();
  },

  /* 落笔：写回的是渲染之后的位置（窄屏上已经被 CSS 夹进屏宽），存的数就永远是不溢出的那一份。
     顺带把这张挪到数组末尾——数组顺序就是叠放顺序，刚拖过的得在顶上，跟松手时看到的画面一致。 */
  commitDockerPos(el, item) {
    const lr = $('#dkLayer').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.round(r.left - lr.left));
    const y = Math.max(0, Math.round(r.top - lr.top));
    const list = Store.cfg.docker.items || [];
    const cur = list.find((l) => l.id === item.id);
    if (!cur) return;
    // 原地长按松手（没挪、本来就在最上层）什么都不用改，别白写一次配置
    if (cur.x === x && cur.y === y && list[list.length - 1].id === item.id) return;
    Store.mutate((c) => {
      const i = c.docker.items.findIndex((l) => l.id === item.id);
      if (i < 0) return;
      const [it] = c.docker.items.splice(i, 1);
      it.x = x;
      it.y = y;
      c.docker.items.push(it);
    });
    this.renderDockerTiles();
    this.renderDockerPane();
  },

  removeDockerItem(item) {
    if (!confirm(`把「${item.title}」从主页摘掉？\n（只是撤下组件，NAS 上的容器 ${item.container} 不会被动到）`)) return;
    Store.mutate((c) => {
      c.docker.items = c.docker.items.filter((l) => l.id !== item.id);
    });
    this.renderDockerTiles();
    this.renderDockerPane();
  },

  // 右键给全：打开 / 复制链接 / 启动 / 停止 / 重启 / 移除。挪位置是长按直接拖，改内容在「设置 → 应用矩阵」
  openDockerCtxMenu(item, x, y) {
    const menu = $('#ctxMenu');
    menu.innerHTML = '';
    const href = linkHref(item, this.netMode);
    if (href) {
      menu.appendChild(this.ctxItem('↗ 打开 ' + (domainOf(href) || item.container), false, () => window.open(href, '_blank', 'noopener')));
      menu.appendChild(this.ctxItem('⧉ 复制链接', false, async () => this.toast((await copyText(href)) ? '链接已复制' : '复制失败', 2200, true)));
    }
    // 只有查到的那一刻是运行中才给停止 / 重启，反过来才给启动；数据还没回来就全部按着
    const info = Docker.get(item.container);
    const running = Boolean(info && info.state === 'running');
    menu.appendChild(this.ctxItem('▶ 启动容器', false, () => this.actContainer(item.container, 'start'), running || !info));
    menu.appendChild(this.ctxItem('■ 停止容器', true, () => this.actContainer(item.container, 'stop'), !running));
    menu.appendChild(this.ctxItem('⟳ 重启容器', false, () => this.actContainer(item.container, 'restart'), !running));
    menu.appendChild(this.ctxItem('✕ 移除组件', true, () => this.removeDockerItem(item)));
    menu.hidden = false;
    this.ctxTarget = item.id;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  },

  /* 换序 / 跨分组移动时用 FLIP 补间，别瞬间跳位 */
  flipped: [],
  flipTimer: 0,
  flatIds: [],
  navLockId: '',
  navLockTimer: 0,

  captureTiles() {
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const map = new Map();
    for (const t of $$('#groups .tile')) {
      if (t.getClientRects().length) map.set(t.dataset.link, t.getBoundingClientRect());
    }
    return map.size ? map : null;
  },

  playFlip(prev) {
    if (!prev) return;
    const moved = [];
    for (const t of $$('#groups .tile')) {
      const was = prev.get(t.dataset.link);
      if (!was) continue;
      const now = t.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      t.style.transition = 'none';
      t.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(t);
    }
    if (!moved.length) return;
    this.flipped.forEach((n) => this.clearFlip(n));
    this.flipped = moved;
    // 起跑要用 rAF 等浏览器把「旧位置」画出来；标签页被切走时 rAF 不跑，所以另设一个兜底清理
    clearTimeout(this.flipTimer);
    this.flipTimer = setTimeout(() => {
      for (const t of this.flipped) this.clearFlip(t);
      this.flipped = [];
    }, 500);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const t of this.flipped) {
          t.style.transition = 'transform 0.34s var(--ease-out)';
          t.style.transform = '';
        }
      })
    );
  },

  clearFlip(node) {
    node.style.removeProperty('transition');
    node.style.removeProperty('transform');
  },

  /* ---------- 左侧分组导航 + 右侧滚动条 ---------- */

  renderSideNav() {
    const nav = $('#sideNav');
    nav.innerHTML = '';
    const groups = Store.cfg.groups;
    if (groups.length < 2) {
      nav.hidden = true;
      return;
    }
    nav.hidden = false;
    for (const g of groups) {
      const b = this.groupBadge(g, 'side-dot');
      if (g.collapsed) b.classList.add('folded');
      b.setAttribute('aria-label', '跳转到分组 ' + g.name);
      b.addEventListener('click', () => this.scrollToGroup(g.id));
      nav.appendChild(b);
    }
    this.scrollSpy();
  },

  scrollToGroup(id) {
    const sec = $$('#groups .group').find((s) => s.dataset.group === id);
    if (!sec) return;
    this.navLockId = id;
    clearTimeout(this.navLockTimer);
    // 平滑滚动途中还会来一串 scroll 事件，短暂锁住高亮，免得跳回上一个分组
    this.navLockTimer = setTimeout(() => {
      this.navLockId = '';
      this.scrollSpy();
    }, 800);
    sec.scrollIntoView({ behavior: this.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    this.scrollSpy(id);
  },

  // 高亮视口里当前那个分组；传入 id 可立刻指定（点击导航点后不用等滚动结束）
  scrollSpy(forceId) {
    const dots = $$('#sideNav .side-dot');
    if (!dots.length) return;
    const secs = $$('#groups .group');
    let cur = forceId || this.navLockId;
    if (!cur) {
      const line = window.innerHeight * 0.4;
      for (const s of secs) {
        if (s.getBoundingClientRect().top <= line) cur = s.dataset.group;
      }
      // 还没滚到第一个分组时先亮第一个；滚到底就亮最后一个（短页面也能跳到位）
      if (!cur && secs.length) cur = secs[0].dataset.group;
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 && secs.length) {
        cur = secs[secs.length - 1].dataset.group;
      }
    }
    for (const d of dots) {
      const on = d.dataset.group === cur;
      d.classList.toggle('active', on);
      d.setAttribute('aria-current', String(on));
    }
  },

  reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  },

  railParts() {
    const zone = $('#scrollZone');
    return { zone, rail: zone.querySelector('.scroll-rail'), thumb: $('#scrollThumb') };
  },

  // 页面没超出屏幕时不显示轨道；返回 null 表示当前不可滚动
  railMetrics() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max <= 4) return null;
    const { rail, thumb } = this.railParts();
    const box = rail.getBoundingClientRect();
    const h = thumb.getBoundingClientRect().height;
    if (box.height <= h + 2) return null;
    return { top: box.top, height: box.height, thumbH: h, max };
  },

  updateScrollRail() {
    const { zone, rail, thumb } = this.railParts();
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max <= 4) {
      zone.hidden = true;
      return;
    }
    zone.hidden = false;
    const trackH = rail.getBoundingClientRect().height;
    const h = Math.max(30, Math.round(trackH * Math.min(1, window.innerHeight / doc.scrollHeight)));
    thumb.style.height = h + 'px';
    const t = Math.max(0, Math.min(1, window.scrollY / max)) * (trackH - h);
    thumb.style.transform = `translateY(${Math.round(t)}px)`;
  },

  railScrollTo(clientY, offset) {
    const m = this.railMetrics();
    if (!m) return;
    const t = Math.max(0, Math.min(m.height - m.thumbH, clientY - m.top - offset));
    window.scrollTo(0, Math.round((t / (m.height - m.thumbH)) * m.max));
  },

  bindNavRails() {
    let queued = false;
    const onMove = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.scrollSpy();
        this.updateScrollRail();
      });
    };
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    // 便签/待办面板显隐、壁纸等都会改变页面高度
    if (window.ResizeObserver) new ResizeObserver(() => this.updateScrollRail()).observe($('#app'));

    const { zone, thumb } = this.railParts();
    zone.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.railMetrics()) return;
      e.preventDefault();
      const box = thumb.getBoundingClientRect();
      const offset = e.target === thumb ? e.clientY - box.top : box.height / 2;
      zone.classList.add('dragging');
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {}
      const end = () => {
        zone.classList.remove('dragging');
        zone.removeEventListener('pointermove', move);
        zone.removeEventListener('pointerup', end);
        zone.removeEventListener('pointercancel', end);
      };
      const move = (ev) => this.railScrollTo(ev.clientY, offset);
      zone.addEventListener('pointermove', move);
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
      this.railScrollTo(e.clientY, offset);
    });
  },

  /* ---------- 单个图标前后挪位置 ---------- */

  /* 卡片上的 ◀ ▶：组内前后换位；走到分组边界时并入相邻分组，这样任意图标都能换到任意位置 */
  moveLinkStep(linkId, dir) {
    Store.mutate((c) => {
      const gi = c.groups.findIndex((g) => g.links.some((l) => l.id === linkId));
      if (gi < 0) return;
      const g = c.groups[gi];
      const i = g.links.findIndex((l) => l.id === linkId);
      let dest = g;
      if (dir > 0) {
        if (i < g.links.length - 1) {
          [g.links[i], g.links[i + 1]] = [g.links[i + 1], g.links[i]];
          return;
        }
        dest = c.groups[gi + 1];
        if (!dest) return;
        dest.links.unshift(g.links[i]);
      } else {
        if (i > 0) {
          [g.links[i - 1], g.links[i]] = [g.links[i], g.links[i - 1]];
          return;
        }
        dest = c.groups[gi - 1];
        if (!dest) return;
        dest.links.push(g.links[i]);
      }
      g.links.splice(i, 1);
      dest.collapsed = false;
    });
    this.renderGroups();
    const tile = $$('#groups .tile').find((t) => t.dataset.link === linkId);
    if (tile) tile.scrollIntoView({ behavior: this.reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  },

  /* ---------- 编辑模式：两张卡片互换位置 ---------- */

  /* ◀ ▶ 只能一格一格挪，隔着几个分组要把一个站点挪到显眼位置得点十几次；
     按 ⇄ 选中第一张，再点任意一张卡片就就地互换（跨分组也行，各自占住对方的坑）。 */
  swapPick: null,

  armSwap(linkId) {
    if (this.swapPick === linkId) return this.cancelSwap();
    this.swapPick = linkId;
    this.paintSwap();
    this.toast('已选中，再点另一张卡片即可互换位置（按 Esc 取消）', 4000);
  },

  cancelSwap() {
    if (!this.swapPick) return;
    this.swapPick = null;
    this.paintSwap();
  },

  // 配对状态用 class 标记，重绘后由 tileNode 重新贴上一个
  paintSwap() {
    for (const t of $$('#groups .tile')) t.classList.toggle('swap-pick', t.dataset.link === this.swapPick);
    document.documentElement.dataset.swap = this.swapPick ? 'on' : 'off';
  },

  swapLinks(aId, bId) {
    const find = (id) => {
      for (const g of Store.cfg.groups) {
        const i = g.links.findIndex((l) => l.id === id);
        if (i >= 0) return { g, i };
      }
      return null;
    };
    const a = find(aId);
    const b = find(bId);
    if (!a || !b) return this.cancelSwap();
    const ta = a.g.links[a.i].title;
    const tb = b.g.links[b.i].title;
    const sameGroup = a.g === b.g;
    Store.mutate(() => {
      [a.g.links[a.i], b.g.links[b.i]] = [b.g.links[b.i], a.g.links[a.i]];
    });
    this.swapPick = null;
    this.renderGroups();
    this.paintSwap();
    this.toast(`已互换「${ta}」与「${tb}」${sameGroup ? '' : `（${a.g.name} ↔ ${b.g.name}）`}`, 3200);
  },

  bindSwapPick() {
    // 捕获阶段先拦一道：配对时点卡片是要互换，不是打开编辑弹层
    $('#groups').addEventListener(
      'click',
      (e) => {
        const pick = this.swapPick;
        if (!pick) return;
        const tile = e.target instanceof Element ? e.target.closest('.tile[data-link]') : null;
        const btn = e.target instanceof Element ? e.target.closest('button') : null;
        if (!tile) return this.cancelSwap();
        if (tile.dataset.link === pick) {
          // 还按在 ⇄ 上：交给按钮自己取消
          if (btn?.dataset.swap) return;
          e.preventDefault();
          e.stopPropagation();
          return this.cancelSwap();
        }
        // 别的编辑按钮（◀ ▶ ✕）不算配对，放行让原本的动作生效
        if (btn && !btn.dataset.swap) return this.cancelSwap();
        e.preventDefault();
        e.stopPropagation();
        this.swapLinks(pick, tile.dataset.link);
      },
      true
    );
  },

  tileBtn(text, title, disabled, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.disabled = !!disabled;
    b.draggable = false;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) onClick();
    });
    return b;
  },

  /* ---------- 卡片右键菜单：打开 / 复制链接 / 移到组首组尾 / 移除（编辑应用在「设置」里） ---------- */

  ctxTarget: null,

  ctxItem(label, danger, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('role', 'menuitem');
    if (danger) b.className = 'danger';
    if (disabled) {
      b.disabled = true;
      return b;
    }
    b.addEventListener('click', () => {
      this.closeCtxMenu();
      onClick();
    });
    return b;
  },

  openCtxMenu(link, groupId, x, y) {
    const menu = $('#ctxMenu');
    const mode = this.modeFor(groupId);
    const href = linkHref(link, mode);
    const netLabel = mode === 'lan' ? '内网' : '外网';
    menu.innerHTML = '';
    menu.appendChild(
      this.ctxItem(`↗ 打开${netLabel}链接`, false, () => {
        if (!href) return this.toast(`这条链接没填${netLabel}网址`, 2600, true);
        window.open(href, '_blank', 'noopener');
      })
    );
    menu.appendChild(
      this.ctxItem(`⧉ 复制${netLabel}链接`, false, async () => {
        if (!href) return this.toast(`这条链接没填${netLabel}网址`, 2600, true);
        const ok = await copyText(href);
        this.toast(ok ? `已复制${netLabel}链接` : '复制失败，请手动选择复制', 2600, !ok);
      })
    );
    const g = (Store.cfg.groups || []).find((x) => x.id === groupId);
    const links = g ? g.links : [];
    const pos = links.findIndex((l) => l.id === link.id);
    const goTo = (index) => this.moveLink({ kind: 'link', linkId: link.id, groupId }, groupId, index);
    // 组尾要报成「挪之前那一栏的条数」，moveLink 会自己扣掉卡片本身那一格
    menu.appendChild(this.ctxItem('⤒ 移到本组最前', false, () => goTo(0), pos <= 0));
    menu.appendChild(this.ctxItem('⤓ 移到本组最后', false, () => goTo(links.length), pos >= links.length - 1));
    menu.appendChild(this.ctxItem('✕ 移除', true, () => this.removeLink(link, groupId)));
    menu.hidden = false;
    this.ctxTarget = link.id;
    // 先量出菜单尺寸再夹进视口，贴近边缘时往反方向收
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  },

  closeCtxMenu() {
    if (!this.ctxTarget) return;
    this.ctxTarget = null;
    $('#ctxMenu').hidden = true;
  },

  removeLink(link, groupId) {
    if (!confirm(`删除「${link.title}」？`)) return;
    Store.mutate((c) => {
      const g = c.groups.find((x) => x.id === groupId);
      if (g) g.links = g.links.filter((l) => l.id !== link.id);
    });
    this.renderGroups();
  },

  bindCtxMenu() {
    // 右键按下时先关掉旧菜单，再由随后的 contextmenu 重新打开
    window.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Element && e.target.closest('#ctxMenu')) return;
      this.closeCtxMenu();
    });
    window.addEventListener('scroll', () => this.closeCtxMenu(), { passive: true });
    window.addEventListener('resize', () => this.closeCtxMenu());
    window.addEventListener('blur', () => this.closeCtxMenu());
  },

  groupNode(g) {
    const sec = document.createElement('section');
    sec.className = 'group';
    if (g.collapsed) sec.classList.add('folded');
    sec.dataset.group = g.id;
    sec.dataset.size = Store.cfg.appearance.iconSize;

    const head = document.createElement('div');
    head.className = 'group-head';

    // 头上不放折叠三角：点分组名称本身就在折叠/展开（改名称与图标去「设置 → 数据 → 分组概览」）
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'group-name';
    name.textContent = g.name;
    name.title = g.collapsed ? '展开分组' : '折叠分组';
    name.setAttribute('aria-expanded', String(!g.collapsed));
    name.addEventListener('click', () => {
      Store.mutate((c) => {
        const t = c.groups.find((x) => x.id === g.id);
        if (t) t.collapsed = !t.collapsed;
      });
      this.renderGroups();
    });

    head.append(name, Object.assign(document.createElement('span'), { className: 'grow' }));

    if (Store.editMode) {
      const actions = document.createElement('div');
      actions.className = 'group-actions';
      actions.append(
        this.miniBtn('↑', '上移分组', () => this.moveGroup(g.id, -1)),
        this.miniBtn('↓', '下移分组', () => this.moveGroup(g.id, 1)),
        this.miniBtn('✕', '删除分组', () => {
          if (!confirm(`删除分组「${g.name}」及其 ${g.links.length} 个链接？`)) return;
          Store.mutate((c) => {
            c.groups = c.groups.filter((x) => x.id !== g.id);
          });
          this.renderGroups();
        }, true)
      );
      head.appendChild(actions);
    }

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    if (!g.collapsed) {
      for (const link of g.links) tiles.appendChild(this.tileNode(link, g.id));
    }

    sec.append(head, tiles);
    if (Store.editMode) this.makeGroupDroppable(sec, tiles, g.id);
    return sec;
  },

  miniBtn(text, title, onClick, danger, disabled) {
    const b = document.createElement('button');
    b.className = 'icon-btn mini';
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    if (danger && !disabled) b.style.color = '#ff6b6b';
    if (disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    return b;
  },

  tileNode(link, groupId) {
    const a = document.createElement('a');
    const href = linkHref(link, this.modeFor(groupId));
    a.className = 'tile' + (href ? '' : ' no-href');
    a.href = href || '#';
    // 主页不该被一次点击带走：链接固定新窗口打开
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.link = link.id;
    a.dataset.group = groupId;
    a.draggable = Store.editMode;
    a.title = link.desc ? `${link.title}\n${link.desc}` : link.title;

    const icon = this.iconNode(link);
    const title = document.createElement('span');
    title.className = 'tile-title';
    title.textContent = link.title;
    a.appendChild(icon);
    a.appendChild(title);

    if (Store.editMode) {
      const pos = this.flatIds.indexOf(link.id);
      const last = this.flatIds.length - 1;
      const move = document.createElement('span');
      move.className = 'tile-move';
      const swap = this.tileBtn('⇄', this.swapPick === link.id ? '取消互换' : '与另一张卡片互换位置', false, () => this.armSwap(link.id));
      swap.dataset.swap = '1';
      move.append(
        this.tileBtn('◀', pos > 0 ? '往前挪一格（在分组开头时并入上一分组末尾）' : '已经排在最前面', pos <= 0, () => this.moveLinkStep(link.id, -1)),
        this.tileBtn('▶', pos < last ? '往后挪一格（在分组末尾时进入下一分组开头）' : '已经排在最后面', pos >= last, () => this.moveLinkStep(link.id, 1)),
        swap
      );
      if (this.swapPick === link.id) a.classList.add('swap-pick');
      a.appendChild(move);

      const x = document.createElement('button');
      x.className = 'tile-x';
      x.type = 'button';
      x.title = '删除';
      x.textContent = '✕';
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.removeLink(link, groupId);
      });
      a.appendChild(x);
      // 编辑模式只用来排列：点卡片别把标签页弹出去，改内容去「设置」里
      a.addEventListener('click', (e) => e.preventDefault());
      a.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'link', linkId: link.id, groupId }));
        e.dataTransfer.effectAllowed = 'move';
        a.classList.add('dragging');
      });
      a.addEventListener('dragend', () => a.classList.remove('dragging'));
      a.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (!isImageFile(file)) return;
        e.preventDefault();
        e.stopPropagation();
        this.setIconFromUpload(file, link, groupId);
      });
    }
    this.bindHoldDrag(a, link, groupId);
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 手指长按归长按拖拽那套管（松手时该开菜单它会自己开），别让浏览器补发的那次 contextmenu 抢着开
      if (this.holdDrag || Date.now() < this.ctxBlockedBy) return;
      this.openCtxMenu(link, groupId, e.clientX, e.clientY);
    });
    if (!href) {
      a.addEventListener('click', (e) => {
        if (Store.editMode) return;
        e.preventDefault();
        this.toast(`「${link.title}」没填${this.modeFor(groupId) === 'lan' ? '内网' : '外网'}网址`, 2800, true);
      });
    }
    return a;
  },

  /* ---------- Docker 组件共用的小件：状态那一行 + 实时数字（启停在右键菜单里，卡片上不占位置） ---------- */

  dockerMetaNode(item) {
    const box = document.createElement('span');
    box.className = 'dk-meta';
    const dot = document.createElement('i');
    dot.className = 'stat-dot';
    const st = document.createElement('b');
    st.className = 'dk-state';
    st.dataset.stateText = '';
    st.textContent = Docker.stateText(Docker.get(item.container));
    const img = document.createElement('span');
    img.className = 'dk-image';
    img.dataset.image = '';
    img.hidden = true;
    box.append(dot, st, img);
    return box;
  },

  dockerStatNode() {
    const box = document.createElement('span');
    box.className = 'tile-stat';
    box.innerHTML =
      '<span class="stat-line"><span class="k">CPU</span><b data-cpu>—</b><span class="k sep">内存</span><b data-mem>—</b></span>' +
      '<span class="stat-line" data-net>↓ — · ↑ —</span>';
    return box;
  },

  // 停止和重启会把服务打断，所以要点两下；启动没有副作用，直接执行
  async actContainer(name, action) {
    const label = { start: '启动', stop: '停止', restart: '重启' }[action];
    if (action !== 'start' && !confirm(`${label}容器「${name}」？\n（停止后主页上的这张卡片会显示为已停止）`)) return;
    this.toast(`正在${label} ${name}…`, 2000);
    try {
      await Api.dockerAction(name, action);
      Docker.refresh(name);
      this.toast(`${name} 已${label}`, 2600);
    } catch (e) {
      this.toast(e.message, 4000, true);
    }
  },

  iconNode(link, cls = 'tile-icon') {
    const box = document.createElement('span');
    const letter = (link.title || link.url || link.urlLan || '?').trim().charAt(0).toUpperCase() || '?';
    const fallback = () => {
      box.replaceChildren(document.createTextNode(letter));
      box.className = cls + ' letter';
    };
    if (link.iconKind === 'emoji' && link.icon) {
      box.className = cls;
      box.textContent = link.icon;
      return box;
    }
    let src = '';
    if (link.iconKind === 'auto') {
      // favicon 服务取不到内网 IP，优先用外网网址的域名
      const domain = domainOf(link.url || link.urlLan || '');
      src = domain ? String(Store.cfg.appearance.iconTemplate || '').replace('{domain}', domain) : '';
    } else if (link.iconKind === 'image') {
      src = link.icon || '';
    }
    if (!src) {
      fallback();
      return box;
    }
    box.className = cls;
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', fallback);
    img.src = src;
    box.appendChild(img);
    return box;
  },

  // 分组图标：分组没有网址可猜，所以只有 Emoji / 图片 / 首字母三档
  groupIconNode(g, cls) {
    return this.iconNode(
      {
        title: g.name,
        icon: g.icon || '',
        iconKind: g.icon ? (g.iconKind === 'image' ? 'image' : 'emoji') : 'letter',
      },
      cls
    );
  },

  /* ---------- 左侧导航的分组按钮：图标 + 悬停浮出名称 ---------- */

  groupBadge(g, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.dataset.group = g.id;
    b.appendChild(this.groupIconNode(g, cls + '-icon'));
    const pop = document.createElement('span');
    pop.className = 'icon-pop';
    pop.textContent = g.netMode ? `${g.name}（固定走${g.netMode === 'lan' ? '内网' : '外网'}网址）` : g.name;
    b.appendChild(pop);
    b.setAttribute('aria-label', '分组 ' + g.name);
    return b;
  },

  /* ---------- drag & drop between groups ---------- */

  makeGroupDroppable(sec, tiles, groupId) {
    sec.addEventListener('dragover', (e) => {
      const data = this.dragPayload(e);
      if (!data) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (data.kind === 'link') this.markInsertion(tiles, e);
    });
    sec.addEventListener('dragleave', (e) => {
      if (!sec.contains(e.relatedTarget)) this.clearMarkers(tiles);
    });
    sec.addEventListener('drop', (e) => {
      const data = this.dragPayload(e);
      if (!data) return;
      e.preventDefault();
      const index = this.insertIndex(tiles, e);
      this.clearMarkers(tiles);
      if (data.kind === 'link') this.moveLink(data, groupId, index);
      else if (data.kind === 'group') this.moveGroupTo(data.groupId, this.groupIndexOf(groupId) + (index > 0 ? 1 : 0));
    });

    const head = sec.querySelector('.group-head');
    if (head) {
      head.setAttribute('draggable', 'true');
      head.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'group', groupId }));
        e.dataTransfer.effectAllowed = 'move';
      });
    }
  },

  dragPayload(e) {
    try {
      const raw = e.dataTransfer.getData('text/plain');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  tileAt(tiles, e) {
    return [...tiles.querySelectorAll('.tile:not(.dragging)')].find((t) => {
      const r = t.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
  },

  markInsertion(tiles, e) {
    this.clearMarkers(tiles);
    const target = this.tileAt(tiles, e);
    if (!target) {
      tiles.classList.add('drop-empty');
      return;
    }
    const r = target.getBoundingClientRect();
    target.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
  },

  insertIndex(tiles, e) {
    const nodes = [...tiles.querySelectorAll('.tile')];
    const target = this.tileAt(tiles, e);
    if (!target) return nodes.length;
    let i = nodes.indexOf(target);
    const r = target.getBoundingClientRect();
    if (e.clientX > r.left + r.width / 2) i++;
    return i;
  },

  clearMarkers(tiles) {
    tiles.classList.remove('drop-empty');
    for (const t of tiles.querySelectorAll('.drop-before, .drop-after')) t.classList.remove('drop-before', 'drop-after');
  },

  /* ---------- 左键长按拖拽：不用进编辑模式，按住卡片半秒就能就地换位、也能拖到别的分组（手指长按同样有效） ---------- */

  holdDrag: null,
  clickKiller: null,
  ctxBlockedBy: 0,
  HOLD_MS: 420,
  HOLD_SLOP: 9,

  bindHoldDrag(a, link, groupId) {
    a.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('button')) return;
      this.clearClickKiller();
      if (this.holdDrag) this.cancelHoldDrag(this.holdDrag);
      const st = {
        el: a,
        link,
        groupId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        fromIndex: [...a.parentElement.children].indexOf(a),
        active: false,
        moved: false,
        touch: e.pointerType === 'touch',
      };
      st.onMove = (ev) => this.onHoldMove(st, ev);
      st.onEnd = () => this.endHoldDrag(st);
      st.timer = setTimeout(() => this.beginHoldDrag(st), this.HOLD_MS);
      window.addEventListener('pointermove', st.onMove);
      window.addEventListener('pointerup', st.onEnd);
      window.addEventListener('pointercancel', st.onEnd);
      this.holdDrag = st;
    });
  },

  cancelHoldDrag(st) {
    clearTimeout(st.timer);
    clearInterval(st.tick);
    for (const [type, fn] of [['pointermove', st.onMove], ['pointerup', st.onEnd], ['pointercancel', st.onEnd]]) {
      window.removeEventListener(type, fn);
    }
    if (st.blocker) window.removeEventListener('touchmove', st.blocker);
    if (this.holdDrag === st) this.holdDrag = null;
  },

  beginHoldDrag(st) {
    st.active = true;
    st.el.classList.add('dragging');
    document.body.classList.add('holding-drag');
    // 原生拖拽会和手动的指针拖拽抢同一次按下，长按期间先关掉，松手按编辑模式还原
    st.el.draggable = false;
    if (!st.touch) return;
    // 手指按满半秒就已经算起拖了：接下来的滚动条要让位给拖拽（两者走的是同一根手指）
    st.blocker = (ev) => ev.preventDefault();
    window.addEventListener('touchmove', st.blocker, { passive: false });
    // 停在边缘不动时不会再有 move 事件，得按时钟自己往下滚并重排（页面动了，手指底下那栏也换了）
    st.tick = setInterval(() => {
      if (!st.active || !this.holdEdge(st)) return;
      this.holdPlace(st);
    }, 90);
  },

  onHoldMove(st, e) {
    if (!st.active) {
      // 半秒内先动了 = 只是想点击或拖动页面，不算长按
      if (this.holdMoved(st, e)) this.cancelHoldDrag(st);
      return;
    }
    st.moved = st.moved || this.holdMoved(st, e);
    st.x = e.clientX;
    st.y = e.clientY;
    this.holdPlace(st);
    this.holdEdge(st);
  },

  holdMoved(st, e) {
    // 手指按住不动也会抖十几像素，触屏上这点位移不算「其实是想滚页面」；鼠标 9px 就够
    const slop = st.touch ? 15 : this.HOLD_SLOP;
    return Math.abs(e.clientX - st.startX) > slop || Math.abs(e.clientY - st.startY) > slop;
  },

  // 把按住那张卡片摆到指针当前该插入的位置
  holdPlace(st) {
    const tiles = this.tilesAt(st.y);
    if (!tiles) return;
    const others = [...tiles.querySelectorAll('.tile')].filter((n) => n !== st.el);
    const ref = this.holdInsertRef(others, { clientX: st.x, clientY: st.y });
    if (st.el.parentElement !== tiles) tiles.appendChild(st.el);
    if (ref && ref !== st.el) tiles.insertBefore(st.el, ref);
    else if (!ref && st.el !== tiles.lastElementChild) tiles.appendChild(st.el);
  },

  // 指针贴到上下边缘就顺着滚，返回是否还在边缘区里
  holdEdge(st) {
    if (st.y > window.innerHeight - 40) window.scrollBy(0, 18);
    else if (st.y < 40) window.scrollBy(0, -18);
    else return false;
    return true;
  },

  // 取离指针最近的那张卡片，按指针落在它左半边还是右半边决定插到它前面还是后面
  holdInsertRef(nodes, e) {
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const d = (r.left + r.width / 2 - e.clientX) ** 2 + (r.top + r.height / 2 - e.clientY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    const after = e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.left + r.width / 2);
    return after ? best.nextElementSibling : best;
  },

  // 只按纵轴判分组：从上往下扫，留下顶部还没越过指针的那一栏（折叠的分组没有高度，自然跳过）
  tilesAt(y) {
    let hit = null;
    for (const sec of $$('#groups .group')) {
      const tiles = sec.querySelector('.tiles');
      if (!tiles) continue;
      const r = tiles.getBoundingClientRect();
      if (!r.height || r.top > y) continue;
      hit = tiles;
    }
    return hit;
  },

  endHoldDrag(st) {
    const dragged = st.active;
    // 手指按住不动再松开 = 手机上的「右键」：开那张卡片的菜单，位置算原地没挪
    const longPressMenu = dragged && st.touch && !st.moved;
    this.cancelHoldDrag(st);
    if (!dragged) return;
    st.el.classList.remove('dragging');
    document.body.classList.remove('holding-drag');
    st.el.draggable = Store.editMode;
    if (longPressMenu) {
      this.ctxBlockedBy = Date.now() + 600;
      this.openCtxMenu(st.link, st.groupId, st.x, st.y);
      this.swallowNextClick();
      return;
    }
    const tiles = st.el.parentElement;
    const sec = tiles && tiles.closest('.group');
    const toGroup = sec && sec.dataset.group;
    const at = [...tiles.children].indexOf(st.el);
    // moveLink 要的是「拖之前那一栏里的插入位」：同组右移时卡片本身还算在里面，得补回一格
    const index = toGroup === st.groupId && at > st.fromIndex ? at + 1 : at;
    if (toGroup && (toGroup !== st.groupId || at !== st.fromIndex)) {
      this.moveLink({ kind: 'link', linkId: st.link.id, groupId: st.groupId }, toGroup, index);
    }
    this.swallowNextClick();
  },

  // 长按松手那一下也会被浏览器当成点击，吃掉紧随其后的一次 click，别把标签页弹出去
  swallowNextClick() {
    this.clearClickKiller();
    this.clickKiller = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.clearClickKiller();
    };
    window.addEventListener('click', this.clickKiller, { capture: true });
  },

  clearClickKiller() {
    if (this.clickKiller) window.removeEventListener('click', this.clickKiller, { capture: true });
    this.clickKiller = null;
  },

  groupIndexOf(id) {
    return Store.cfg.groups.findIndex((g) => g.id === id);
  },

  moveLink(data, toGroupId, index) {
    if (!data.linkId || data.groupId === toGroupId) {
      if (data.groupId === toGroupId) {
        Store.mutate((c) => {
          const g = c.groups.find((x) => x.id === toGroupId);
          const from = g.links.findIndex((l) => l.id === data.linkId);
          if (from < 0) return;
          const [item] = g.links.splice(from, 1);
          g.links.splice(Math.min(index > from ? index - 1 : index, g.links.length), 0, item);
        });
        this.renderGroups();
      }
      return;
    }
    Store.mutate((c) => {
      const from = c.groups.find((g) => g.id === data.groupId);
      const to = c.groups.find((g) => g.id === toGroupId);
      if (!from || !to) return;
      const i = from.links.findIndex((l) => l.id === data.linkId);
      if (i < 0) return;
      const [item] = from.links.splice(i, 1);
      to.links.splice(Math.min(index, to.links.length), 0, item);
      if (to.collapsed) to.collapsed = false;
    });
    this.renderGroups();
  },

  moveGroup(id, dir) {
    Store.mutate((c) => {
      const i = c.groups.findIndex((g) => g.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.groups.length) return;
      const [g] = c.groups.splice(i, 1);
      c.groups.splice(j, 0, g);
    });
    this.renderGroups();
  },

  moveGroupTo(id, targetIndex) {
    Store.mutate((c) => {
      const i = c.groups.findIndex((g) => g.id === id);
      if (i < 0) return;
      const [g] = c.groups.splice(i, 1);
      c.groups.splice(Math.max(0, Math.min(targetIndex, c.groups.length)), 0, g);
    });
    this.renderGroups();
  },

  /* ---------- search ---------- */

  currentEngine() {
    const s = Store.cfg.search;
    const saved = Prefs.get('engine', '');
    const id = Prefs.get('rememberEngine', true) && s.engines.some((e) => e.id === saved) ? saved : s.default;
    return s.engines.find((e) => e.id === id) || s.engines[0];
  },

  // 引擎一律用站点官方图标（走 appearance.iconTemplate），拿不到时用名称首字母兜底
  engineIcon(eng) {
    const box = document.createElement('span');
    box.className = 'eng-ico';
    const fallback = () => {
      box.classList.add('letter');
      box.textContent = (eng.name || domainOf(eng.url || '') || '?').trim().charAt(0).toUpperCase();
    };
    const domain = domainOf(eng.url || '');
    const src = domain ? String(Store.cfg.appearance.iconTemplate || '').replace('{domain}', domain) : '';
    if (!src) {
      fallback();
      return box;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', fallback);
    img.src = src;
    box.appendChild(img);
    return box;
  },

  renderSearch() {
    const eng = this.currentEngine();
    $('#engineName').textContent = eng.name;
    $('#engineIcon').replaceChildren(this.engineIcon(eng));
    $('#engineBtn').title = `当前引擎：${eng.name}，点击切换`;
    const menu = $('#engineMenu');
    menu.innerHTML = '';
    for (const e of Store.cfg.search.engines) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-checked', String(e.id === eng.id));
      b.append(this.engineIcon(e), document.createTextNode(e.name));
      b.addEventListener('click', () => {
        this.pickEngine(e.id);
        this.engineMenu(false);
      });
      li.appendChild(b);
      menu.appendChild(li);
    }
  },

  engineMenu(open) {
    const menu = $('#engineMenu');
    const show = open === undefined ? menu.hidden : open;
    menu.hidden = !show;
    $('#enginePicker').classList.toggle('open', show);
    $('#engineBtn').setAttribute('aria-expanded', String(show));
  },

  pickEngine(id) {
    Prefs.set('engine', id);
    if (!Prefs.get('rememberEngine', true)) {
      Store.mutate((c) => {
        c.search.default = id;
      });
    }
    this.renderSearch();
  },

  bindSearch() {
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#searchInput');
      const q = input.value.trim();
      if (!q) return;
      if (looksLikeUrl(q)) {
        const url = /^https?:\/\//i.test(q) ? q : 'http://' + q;
        window.open(url, '_blank', 'noopener');
      } else {
        window.open(this.currentEngine().url.replace('{query}', encodeURIComponent(q)), '_blank', 'noopener');
      }
      input.value = '';
    });

    $('#engineBtn').addEventListener('click', () => this.engineMenu());
    document.addEventListener('click', (e) => {
      if (e.target instanceof Element && !e.target.closest('#enginePicker')) this.engineMenu(false);
    });
  },

  /* ---------- link modal ---------- */

  linkDraft: null,

  // dockerMode 由入口决定：「编辑应用」开出来的是网址应用，「应用矩阵」栏开出来的是容器组件
  openLinkModal(link, groupId, dockerMode = false) {
    const kind = link ? link.iconKind : Prefs.get('defaultIconKind', 'emoji');
    const group = groupId || (Store.cfg.groups[0] && Store.cfg.groups[0].id);
    // 容器组件不住在分组里，没有归属可挑，也就不能因为「还没有分组」被拦住
    if (!dockerMode && !group) return this.toast('还没有分组，先到「数据」栏新建一个', 3000, true);
    this.linkDraft = {
      id: link ? link.id : uid('l'),
      groupId: dockerMode ? '' : group,
      isNew: !link,
      dockerMode,
      title: link ? link.title : '',
      url: link ? link.url : '',
      urlLan: link ? link.urlLan || '' : '',
      desc: link ? link.desc : '',
      icon: link ? link.icon : kind === 'emoji' ? '🔗' : '',
      iconKind: kind,
      container: dockerMode && link ? link.container || '' : '',
      w: link && dockerMode ? link.w : DK_TILE.defW,
      h: link && dockerMode ? link.h : DK_TILE.defH,
      // 编辑已有组件时坐标原样带回去；新建那张（走「容器一览」那条路）落在最下面一张的下方
      x: link && dockerMode ? link.x : this.nextDockerPos().x,
      y: link && dockerMode ? link.y : this.nextDockerPos().y,
    };
    $('#linkModalTitle').textContent = dockerMode ? (link ? '编辑容器组件' : '新建容器组件') : link ? '编辑应用' : '新建应用';
    $('#lkTitle').value = this.linkDraft.title;
    $('#lkUrl').value = this.linkDraft.url;
    $('#lkUrlLan').value = this.linkDraft.urlLan;
    $('#lkDesc').value = this.linkDraft.desc;
    $('#lkEmoji').value = this.linkDraft.iconKind === 'emoji' ? this.linkDraft.icon : '';
    $('#lkImage').value = this.linkDraft.iconKind === 'image' ? this.linkDraft.icon : '';
    $('#lkDelete').hidden = !link;
    const sel = $('#lkGroup');
    sel.innerHTML = '';
    for (const g of Store.cfg.groups) sel.append(new Option(g.name, g.id, false, g.id === group));
    // 每次打开都重新读一遍容器列表：清掉上一次那列，paintLinkDocker 才会去取新的
    $('#lkDockerList').innerHTML = '';
    this.paintLinkDocker();
    this.setLinkIconKind(this.linkDraft.iconKind);
    this.paintLinkPreview();
    $('#linkModal').hidden = false;
    $('#lkTitle').focus();
  },

  // 容器只写进草稿，点保存才落到配置：中途取消不该在主页上凭空多出一张卡
  paintLinkDocker() {
    const docker = this.linkDraft.dockerMode;
    // 容器组件不属于任何分组，那行归属下拉留着只会让人以为它还在分组网格里面
    $('#lkGroupRow').hidden = docker;
    $('#lkDockerRow').hidden = !docker;
    $('#lkDockerHint').hidden = !docker;
    if (!docker) return;
    const name = this.linkDraft.container;
    $('#lkDockerName').textContent = name || '未选择';
    $('#lkDockerName').classList.toggle('unset', !name);
    const list = $('#lkDockerList');
    if (list.childElementCount) this.repaintCabinet(list, 'draft');
    else this.fillDockerCabinet(list, 'draft', $('#lkDockerCabinetHint'));
  },

  setLinkIconKind(kind) {
    this.linkDraft.iconKind = kind;
    for (const b of $$('#iconKindSeg button')) b.classList.toggle('active', b.dataset.v === kind);
    $('#ipEmoji').hidden = kind !== 'emoji';
    $('#ipImage').hidden = kind !== 'image';
    $('#ipAuto').hidden = kind !== 'auto';
  },

  paintLinkPreview() {
    const host = $('#lkPreview');
    const url = $('#lkUrl').value.trim() || $('#lkUrlLan').value.trim() || this.linkDraft.url || this.linkDraft.urlLan;
    host.innerHTML = '';
    const node = this.iconNode({ ...this.linkDraft, url, title: this.linkDraft.title || '示例' });
    host.className = node.className;
    const kids = Array.from(node.childNodes);
    host.append(...kids);
    if (!kids.length) host.textContent = node.textContent;
  },

  bindLinkModal() {
    $('#linkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const d = this.linkDraft;
      const targetGroup = $('#lkGroup').value;
      d.title = $('#lkTitle').value.trim().slice(0, 200);
      d.url = normalizeUrl($('#lkUrl').value);
      d.urlLan = normalizeUrl($('#lkUrlLan').value);
      d.desc = $('#lkDesc').value.trim().slice(0, 200);
      if (d.iconKind === 'emoji') d.icon = ($('#lkEmoji').value.trim() || '🔗').slice(0, 4);
      if (d.iconKind === 'image') d.icon = normalizeUrl($('#lkImage').value);
      if (!d.title && (d.url || d.urlLan)) d.title = domainOf(d.url || d.urlLan) || d.url || d.urlLan;
      if (!d.title) return this.toast('请填写名称', 2500, true);
      if ($('#lkUrl').value.trim() && !d.url) return this.toast('外网网址协议不安全或格式不对', 3000, true);
      if ($('#lkUrlLan').value.trim() && !d.urlLan) return this.toast('内网网址协议不安全或格式不对', 3000, true);
      if (d.dockerMode && !d.container) return this.toast('请先选择一个容器', 3000, true);
      if (!d.dockerMode && !d.url && !d.urlLan) return this.toast('请填写网址', 3000, true);
      if (!d.dockerMode && !Store.cfg.groups.some((g) => g.id === targetGroup)) return this.toast('目标分组已不存在', 2500, true);
      Store.mutate((c) => {
        const payload = { id: d.id, title: d.title, url: d.url, icon: d.icon, iconKind: d.iconKind, desc: d.desc };
        // 空的可选字段不写进配置，字段顺序要和服务端规范化保持一致
        if (d.urlLan) payload.urlLan = d.urlLan;
        if (d.container) payload.container = d.container;
        if (d.dockerMode) {
          // 长宽与坐标不在这个表单里改（长宽在「应用矩阵」那行的滑块上、位置在主页长按拖），保存时原样带回去
          payload.w = d.w;
          payload.h = d.h;
          payload.x = d.x;
          payload.y = d.y;
          const i = c.docker.items.findIndex((l) => l.id === d.id);
          if (i >= 0) c.docker.items[i] = payload;
          else c.docker.items.push(payload);
          return;
        }
        let placed = false;
        for (const g of c.groups) {
          const i = g.links.findIndex((l) => l.id === d.id);
          if (i < 0) continue;
          // 原地编辑保持排序不动；改了归属就从原分组摘掉，追加到目标分组末尾
          if (g.id === targetGroup) {
            g.links[i] = payload;
            placed = true;
          } else g.links.splice(i, 1);
        }
        if (!placed) {
          const dst = c.groups.find((g) => g.id === targetGroup);
          if (dst) dst.links.push(payload);
        }
      });
      $('#linkModal').hidden = true;
      this.renderGroups();
      this.renderDockerTiles();
      this.renderAppList();
      this.renderDockerPane();
    });

    for (const b of $$('#iconKindSeg button')) {
      b.addEventListener('click', () => {
        this.setLinkIconKind(b.dataset.v);
        this.paintLinkPreview();
      });
    }
    for (const sel of ['#lkUrl', '#lkUrlLan', '#lkEmoji', '#lkImage', '#lkTitle']) {
      $(sel).addEventListener('input', () => this.paintLinkPreview());
    }
    $('#lkFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await this.setIconFromUpload(file, this.linkDraft, this.linkDraft.groupId, true);
    });
    $('#iconDrop').addEventListener('dragover', (e) => e.preventDefault());
    $('#iconDrop').addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) await this.setIconFromUpload(file, this.linkDraft, this.linkDraft.groupId, true);
    });
    $('#lkDelete').addEventListener('click', () => {
      const d = this.linkDraft;
      if (!confirm(`删除「${d.title}」？`)) return;
      Store.mutate((c) => {
        if (d.dockerMode) {
          c.docker.items = c.docker.items.filter((l) => l.id !== d.id);
          return;
        }
        const g = c.groups.find((x) => x.id === d.groupId);
        if (g) g.links = g.links.filter((l) => l.id !== d.id);
      });
      $('#linkModal').hidden = true;
      this.renderGroups();
      this.renderDockerTiles();
      this.renderAppList();
      this.renderDockerPane();
    });
  },

  /* ---------- 容器一览：NAS 上的容器整列摊开，点一个就在主页上加一张组件（不再有弹层和下拉） ---------- */

  dockerCabinetData: null,

  // 读一次列表再画；换绑那种「点了要立刻重画选中态」的地方直接用缓存，不重复请求
  fillDockerCabinet(host, mode, hint) {
    Api.dockerContainers()
      .then((r) => this.paintDockerCabinet(host, mode, hint, r))
      .catch((e) => this.paintDockerCabinet(host, mode, hint, { available: false, error: e.message, containers: [] }));
  },

  // 一个容器只能有一张组件：这一列算出某行该标成什么，画和重画都走它，别两处各写一套
  cabinetRowState(name, mode) {
    const items = (Store.cfg && Store.cfg.docker && Store.cfg.docker.items) || [];
    const mine = mode === 'draft' && this.linkDraft ? this.linkDraft.id : '';
    const bound = items.some((l) => l.container === name);
    const blocked = mode === 'draft' && items.some((l) => l.container === name && l.id !== mine);
    const picked = mode === 'draft' && name === (this.linkDraft && this.linkDraft.container);
    return {
      bound,
      blocked,
      picked,
      cls: 'docker-row' + (bound ? ' bound' : '') + (picked ? ' picked' : ''),
      mark: picked ? '当前绑定' : blocked ? '别的组件在用' : bound ? '已在页面上' : mode === 'draft' ? '换绑到这张组件' : '＋ 加到主页',
    };
  },

  paintDockerCabinet(host, mode, hint, r) {
    if (!host) return;
    this.dockerCabinetData = r;
    host.innerHTML = '';
    const list = r.containers || [];
    if (hint) {
      hint.textContent = !r.available
        ? r.error || '连不上 Docker 守护进程'
        : list.length
          ? `这台 NAS 上共 ${list.length} 个容器，点一个${mode === 'draft' ? '绑到当前组件' : '加进主页的应用矩阵'}`
          : '这台 NAS 上一个容器都没有';
    }
    if (!r.available) return;
    for (const c of list) {
      // 已经挂过组件的照样列出来：在这一栏点它是去编辑那张组件，在表单里点它就是别的组件在用，直接按着
      const s = this.cabinetRowState(c.name, mode);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = s.cls;
      b.disabled = s.blocked;
      b.dataset.name = c.name;
      b.dataset.state = c.state;
      const live = Docker.get(c.name);
      b.append(
        Object.assign(document.createElement('i'), { className: 'stat-dot' }),
        Object.assign(document.createElement('span'), { className: 'docker-name', textContent: c.name }),
        Object.assign(document.createElement('span'), { className: 'docker-state', textContent: Docker.stateText(live && live.found ? live : { found: true, state: c.state }) }),
        Object.assign(document.createElement('span'), { className: 'docker-image', textContent: c.image }),
        Object.assign(document.createElement('span'), { className: 'docker-mark', textContent: s.mark })
      );
      b.addEventListener('click', () => this.useCabinetRow(c, mode));
      host.appendChild(b);
    }
  },

  // 点下去该做什么按「此刻」的配置判断：同一行刚加过组件以后就该变成编辑那张组件
  useCabinetRow(c, mode) {
    const s = this.cabinetRowState(c.name, mode);
    if (mode === 'draft') {
      if (s.blocked) return this.toast(`容器 ${c.name} 已经被另一张组件用着了`, 2800, true);
      // 换绑只写草稿，点保存才落配置；卡片上自己改过的名称备注保持原样
      const d = this.linkDraft;
      d.container = c.name;
      if (!d.title && !$('#lkTitle').value.trim()) {
        d.title = c.name;
        $('#lkTitle').value = c.name;
      }
      this.paintLinkDocker();
      this.paintLinkPreview();
      this.toast(`已绑定容器 ${c.name}，点保存生效`, 2600);
      return;
    }
    if (s.bound) {
      const item = (Store.cfg.docker.items || []).find((l) => l.container === c.name);
      if (item) this.openLinkModal(item, '', true);
      return;
    }
    Store.mutate((cfg) => {
      // 字段顺序照服务端规范化的那一套：可选的空键干脆不写，手改 config.json 才看得清
      const pos = this.nextDockerPos();
      cfg.docker.items.push({ id: uid('l'), title: c.name, url: '', icon: '', iconKind: 'letter', desc: '', container: c.name, w: DK_TILE.defW, h: DK_TILE.defH, x: pos.x, y: pos.y });
    });
    this.renderDockerTiles();
    this.renderDockerPane();
    this.toast(`已添加容器组件 ${c.name}`, 2600);
  },

  // 换绑以后只重画选中态，别再发一次请求
  repaintCabinet(host, mode) {
    const list = (this.dockerCabinetData && this.dockerCabinetData.containers) || [];
    for (const row of Array.from(host.children)) {
      const c = list.find((x) => x.name === row.dataset.name);
      if (!c) continue;
      const s = this.cabinetRowState(c.name, mode);
      row.className = s.cls;
      row.disabled = s.blocked;
      const mark = row.querySelector('.docker-mark');
      if (mark) mark.textContent = s.mark;
    }
  },

  async setIconFromUpload(file, link, groupId, intoDraft) {
    if (!isImageFile(file)) return this.toast('只能上传图片文件', 2500, true);
    try {
      const url = await Api.uploadImage(await fileToDataUrl(file));
      if (intoDraft) {
        this.linkDraft.icon = url;
        this.linkDraft.iconKind = 'image';
        this.setLinkIconKind('image');
        $('#lkImage').value = url;
        this.paintLinkPreview();
      } else {
        Store.mutate((c) => {
          const g = c.groups.find((x) => x.id === groupId);
          const l = g?.links.find((x) => x.id === link.id);
          if (l) {
            l.icon = url;
            l.iconKind = 'image';
          }
        });
        this.renderGroups();
      }
      this.toast('图标已上传到 NAS');
    } catch (e) {
      this.toast('上传失败：' + e.message, 4000, true);
    }
  },

  /* ---------- group modal：名称 / 图标 / 固定走内网还是外网 ---------- */

  groupDraft: null,

  groupDraftPayload(d) {
    // 键序跟服务端规范化保持一致：id → name → icon/iconKind → netMode → collapsed → links
    const out = { id: d.id, name: d.name };
    if (d.icon) {
      out.icon = d.icon;
      out.iconKind = d.iconKind === 'image' ? 'image' : 'emoji';
    }
    if (d.netMode) out.netMode = d.netMode;
    return out;
  },

  openGroupModal(group) {
    const icon = group && group.icon ? group.icon : '';
    const kind = !icon ? 'letter' : group.iconKind === 'image' ? 'image' : 'emoji';
    this.groupDraft = {
      id: group ? group.id : uid('g'),
      name: group ? group.name : '',
      icon,
      iconKind: group ? kind : 'letter',
      netMode: group && (group.netMode === 'lan' || group.netMode === 'wan') ? group.netMode : '',
    };
    $('#groupModalTitle').textContent = group ? '分组设置' : '新建分组';
    $('#gpName').value = this.groupDraft.name;
    $('#gpEmoji').value = this.groupDraft.iconKind === 'emoji' ? this.groupDraft.icon : '';
    $('#gpImage').value = this.groupDraft.iconKind === 'image' ? this.groupDraft.icon : '';
    $('#gpDelete').hidden = !group;
    this.setGroupIconKind(this.groupDraft.iconKind);
    this.setGroupNetMode(this.groupDraft.netMode);
    this.paintGroupPreview();
    $('#groupModal').hidden = false;
    $('#gpName').focus();
  },

  setGroupIconKind(kind) {
    this.groupDraft.iconKind = kind;
    for (const b of $$('#gpIconSeg button')) b.classList.toggle('active', b.dataset.v === kind);
    $('#gpipEmoji').hidden = kind !== 'emoji';
    $('#gpipImage').hidden = kind !== 'image';
  },

  setGroupNetMode(mode) {
    this.groupDraft.netMode = mode;
    for (const b of $$('#gpNetSeg button')) b.classList.toggle('active', b.dataset.v === mode);
    $('#gpNetHint').textContent = mode
      ? `本分组的链接固定用${mode === 'lan' ? '内网' : '外网'}网址打开，右上角的全局开关对它们无效。`
      : '跟随右上角的内网 / 外网开关。';
  },

  paintGroupPreview() {
    const host = $('#gpPreview');
    const d = this.groupDraft;
    host.innerHTML = '';
    // 预览读输入框的实时值：改了名称或图标就该立刻看到
    const icon = d.iconKind === 'emoji' ? $('#gpEmoji').value.trim().slice(0, 4) : d.iconKind === 'image' ? $('#gpImage').value.trim() : '';
    const node = this.groupIconNode({ name: $('#gpName').value.trim() || '示例分组', icon, iconKind: d.iconKind }, 'tile-icon');
    host.className = node.className;
    const kids = Array.from(node.childNodes);
    host.append(...kids);
    if (!kids.length) host.textContent = node.textContent;
  },

  saveGroupDraft() {
    const d = this.groupDraft;
    d.name = $('#gpName').value.trim().slice(0, 60);
    if (d.iconKind === 'emoji') d.icon = ($('#gpEmoji').value.trim() || '📁').slice(0, 4);
    if (d.iconKind === 'image') d.icon = normalizeUrl($('#gpImage').value);
    if (d.iconKind === 'letter') d.icon = '';
    if (!d.name) return this.toast('请填写分组名称', 2500, true);
    if (d.iconKind === 'image' && $('#gpImage').value.trim() && !d.icon) return this.toast('图标地址格式不对', 3000, true);
    const payload = this.groupDraftPayload(d);
    Store.mutate((c) => {
      const i = c.groups.findIndex((x) => x.id === d.id);
      if (i < 0) {
        payload.collapsed = false;
        payload.links = [];
        c.groups.push(payload);
        return;
      }
      const old = c.groups[i];
      Object.assign(payload, { collapsed: old.collapsed, links: old.links });
      c.groups[i] = payload;
    });
    $('#groupModal').hidden = true;
    this.renderGroups();
    if (!$('#settingsModal').hidden) this.syncSettings();
  },

  async setGroupIconFromUpload(file) {
    if (!isImageFile(file)) return this.toast('只能上传图片文件', 2500, true);
    try {
      const url = await Api.uploadImage(await fileToDataUrl(file));
      this.groupDraft.icon = url;
      this.setGroupIconKind('image');
      $('#gpImage').value = url;
      this.paintGroupPreview();
      this.toast('图标已上传到 NAS');
    } catch (e) {
      this.toast('上传失败：' + e.message, 4000, true);
    }
  },

  bindGroupModal() {
    $('#groupForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveGroupDraft();
    });
    for (const b of $$('#gpIconSeg button')) {
      b.addEventListener('click', () => {
        this.setGroupIconKind(b.dataset.v);
        this.paintGroupPreview();
      });
    }
    for (const b of $$('#gpNetSeg button')) b.addEventListener('click', () => this.setGroupNetMode(b.dataset.v));
    for (const sel of ['#gpName', '#gpEmoji', '#gpImage']) {
      $(sel).addEventListener('input', () => this.paintGroupPreview());
    }
    $('#gpFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await this.setGroupIconFromUpload(file);
    });
    $('#gpIconDrop').addEventListener('dragover', (e) => e.preventDefault());
    $('#gpIconDrop').addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) await this.setGroupIconFromUpload(file);
    });
    $('#gpDelete').addEventListener('click', () => {
      const d = this.groupDraft;
      const g = Store.cfg.groups.find((x) => x.id === d.id);
      if (!g) return;
      if (!confirm(`删除分组「${g.name}」及其 ${g.links.length} 个链接？`)) return;
      Store.mutate((c) => {
        c.groups = c.groups.filter((x) => x.id !== g.id);
      });
      $('#groupModal').hidden = true;
      this.renderGroups();
      if (!$('#settingsModal').hidden) this.syncSettings();
    });
  },

  /* ---------- topbar / edit mode ---------- */

  bindTopbar() {
    $('#settingsBtn').addEventListener('click', () => this.openSettings('look'));
    $('#netBtn').addEventListener('click', () => this.setNetMode(this.netMode === 'lan' ? 'wan' : 'lan'));
    $('#editModeToggle').addEventListener('change', (e) => {
      Store.editMode = e.target.checked;
      this.renderAll();
      this.toast(Store.editMode ? '编辑模式已开启' : '编辑模式已关闭');
    });
    $('#weatherChip').addEventListener('click', () => this.openSettings('widget'));
    $('#addGroupBtn').addEventListener('click', () => this.openGroupModal(null));
  },

  syncNetMode() {
    const b = $('#netBtn');
    const lan = this.netMode === 'lan';
    const label = lan ? '内网' : '外网';
    b.innerHTML = lan ? NET_ICON_LAN : NET_ICON_WAN;
    b.title = `当前用${label}网址打开 · 点击切到${lan ? '外网' : '内网'}`;
    b.setAttribute('aria-label', b.title);
    b.dataset.mode = this.netMode;
  },

  setNetMode(mode) {
    const next = mode === 'wan' ? 'wan' : 'lan';
    if (next === this.netMode) return;
    this.netMode = next;
    Prefs.set('netMode', next);
    this.syncNetMode();
    this.renderGroups();
    this.renderDockerTiles();
    this.toast(next === 'lan' ? '现在用内网网址打开' : '现在用外网网址打开');
  },

  // 这条链接该用哪套网址：分组固定了就听分组的，否则跟右上角全局开关
  modeFor(groupId) {
    return groupMode(Store.cfg.groups.find((g) => g.id === groupId), this.netMode);
  },

  toggleEdit() {
    Store.editMode = !Store.editMode;
    this.renderAll();
    this.toast(Store.editMode ? '编辑模式已开启' : '编辑模式已关闭');
  },

  async logout() {
    try {
      await Api.logout();
    } catch {}
    location.reload();
  },

  bindSaveStateHandlers() {
    document.addEventListener('nav:error', (e) => {
      this.setSaveState('保存失败：' + e.detail.message);
      this.toast('保存失败：' + e.detail.message, 4000, true);
    });
    document.addEventListener('nav:unauthorized', () => this.showLogin());
  },

  setSaveState(text) {
    $('#saveState').textContent = text;
  },

  /* ---------- login ---------- */

  // 登录页登录前能拿到的自有内容只有两样：主页那张壁纸 + 自定义页面标题（当 logo 用）
  loginPageCache: null,

  renderLoginPage() {
    const bg = $('#loginBg');
    const veil = $('#loginVeil');
    if (!bg || !veil) return;
    if (this.loginPageCache) this.paintLoginPage(this.loginPageCache);
    Api.loginPage()
      .then((page) => {
        this.loginPageCache = page;
        if (!$('#loginModal').hidden) this.paintLoginPage(page);
      })
      .catch(() => {});
  },

  paintLoginPage(page) {
    const title = String(page.title || '').slice(0, 40);
    if (title) $('#loginTitle').textContent = title;
    if (page.wallpaper) this.paintWallpaper($('#loginBg'), $('#loginVeil'), page.wallpaper);
  },

  showLogin(msg) {
    Docker.stop();
    this.closeCtxMenu();
    $('#bootScreen').hidden = true;
    $('#sideNav').hidden = true;
    $('#scrollZone').hidden = true;
    $('#loginModal').hidden = false;
    this.renderLoginPage();
    $('#loginError').hidden = !msg;
    $('#loginError').textContent = msg || '';
    if (msg) {
      const card = $('#loginForm');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
    setTimeout(() => $('#loginAccount').focus(), 30);
  },

  bindLogin() {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#loginSubmit');
      btn.disabled = true;
      try {
        await Api.login($('#loginAccount').value.trim(), $('#loginPassword').value);
        $('#loginModal').hidden = true;
        $('#loginAccount').value = '';
        $('#loginPassword').value = '';
        await Store.boot();
        await this.startSession();
      } catch (err) {
        this.showLogin(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  },

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if (e.key === 'Escape') {
        // 弹层可以叠着开（设置 → 应用表单），从最上面那层往下关
        const open = $$('.modal:not([hidden])');
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i].id === 'loginModal') continue;
          open[i].hidden = true;
          break;
        }
        this.engineMenu(false);
        this.closeCtxMenu();
        this.cancelSwap();
        $('#cityResults').hidden = true;
        return;
      }
      if (typing || $$('.modal:not([hidden])').length) return;
      if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        $('#searchInput').focus();
      } else if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.toggleEdit();
      } else if (e.key === ',') {
        e.preventDefault();
        this.openSettings('look');
      }
    });
  },

  /* ---------- 拖到主页空白处什么都不做 ---------- */

  // 拖图片换壁纸已经撤掉了，但浏览器对落在空白处的文件有自己的默认处理：直接把整页换成那张图。这里只把这个默认吞掉
  bindFileDropGuard() {
    const swallow = (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
  },

  /* ---------- settings ---------- */

  openSettings(tab = 'look') {
    this.syncSettings();
    this.switchTab(tab);
    $('#settingsModal').hidden = false;
  },

  switchTab(tab) {
    for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const body of $$('.tab-body')) body.hidden = body.dataset.body !== tab;
    // 应用与容器一览只在打开那一栏时重建：主页有上百个应用，别的栏里没必要跟着重排
    if (tab === 'apps') this.renderAppList();
    if (tab === 'docker') this.renderDockerPane();
  },

  /* ---------- 编辑应用：全站网址应用一览，新建 / 改归属 / 删除都从这里进同一个表单 ---------- */

  renderAppList() {
    const ul = $('#appList');
    if (!ul) return;
    ul.innerHTML = '';
    if (!Store.cfg.groups.length) {
      const empty = document.createElement('li');
      empty.className = 'app-head';
      empty.textContent = '还没有分组，也还没有网址应用：先到「数据」栏「＋ 新建分组」建一组，再点上面「＋ 新建应用」加链接。';
      ul.appendChild(empty);
      return;
    }
    // 空的分组也列出来：首启是「先建组、再加应用」，看不到刚建的那组会以为没生效
    for (const g of Store.cfg.groups) {
      const links = g.links || [];
      const head = document.createElement('li');
      head.className = 'app-head';
      const pin = g.netMode === 'lan' ? '固定内网' : g.netMode === 'wan' ? '固定外网' : '';
      head.textContent = `${g.name}｜${links.length} 个${pin ? ' · ' + pin : ''}`;
      ul.appendChild(head);
      for (const link of links) {
        const li = document.createElement('li');
        li.className = 'app-row';
        const name = document.createElement('strong');
        name.textContent = link.title;
        const meta = document.createElement('span');
        meta.className = 'grow';
        meta.textContent = link.url || link.urlLan || '没有网址';
        const acts = document.createElement('div');
        acts.className = 'btn-row';
        acts.append(
          this.miniBtn('✎', '编辑：名称 / 网址 / 图标 / 所属分组', () => this.openLinkModal(link, g.id)),
          this.miniBtn('✕', '删除', () => {
            this.removeLink(link, g.id);
            this.renderAppList();
          })
        );
        li.append(name, meta, acts);
        ul.appendChild(li);
      }
    }
  },

  /* ---------- 「应用矩阵」那一栏：容器一览 + 每张组件的长宽（摆放位置在主页上长按拖） ---------- */

  renderDockerPane() {
    const ul = $('#dkTileList');
    if (!ul) return;
    ul.innerHTML = '';
    // 「加组件」的入口就是这列容器一览，一张组件都还没有时也得画出来
    this.fillDockerCabinet($('#dkCabinet'), 'create', $('#dkCabinetHint'));
    const items = Store.cfg.docker.items || [];
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'app-head';
      li.textContent = '还没有容器组件，点上面「容器一览」里的任意一个容器就往主页上加一张。';
      ul.appendChild(li);
      Docker.paintAll();
      return;
    }
    const tag = (attr, text) => {
      const el = document.createElement('span');
      if (attr) el.setAttribute(attr, '');
      el.textContent = text;
      return el;
    };
    items.forEach((link) => {
      const li = document.createElement('li');
      li.className = 'app-row dk-row';
      // 挂上 data-container / data-cpu / data-mem / data-net，Docker 的轮询就会顺手把这一行也刷了
      li.dataset.container = link.container;
      const info = Docker.get(link.container);
      const dot = document.createElement('i');
      dot.className = 'stat-dot';
      const name = document.createElement('strong');
      name.textContent = link.title;
      const meta = document.createElement('span');
      meta.className = 'grow';
      meta.append(
        tag(null, `容器 ${link.container}｜`),
        tag('data-state-text', Docker.stateText(info)),
        tag(null, ' · CPU '),
        tag('data-cpu', Docker.value(info, 'cpu')),
        tag(null, ' · 内存 '),
        tag('data-mem', Docker.value(info, 'mem')),
        tag(null, ' · '),
        tag('data-net', Docker.value(info, 'net'))
      );
      const acts = document.createElement('div');
      acts.className = 'btn-row';
      acts.append(
        this.miniBtn('✎', '编辑：名称 / 图标 / 附带网址 / 绑定的容器', () => this.openLinkModal(link, '', true)),
        this.miniBtn('✕', '移除这张组件（只删主页上的卡片，不动 NAS 上的容器）', () => this.removeDockerItem(link))
      );
      li.append(dot, name, meta, acts, this.dkSizeRow(link));
      ul.appendChild(li);
    });
    Docker.paintAll();
  },

  // 一张组件的长宽：滑块一边拖一边重画那张卡，改完就地存配置。位置不在这里调，去主页长按拖
  dkSizeRow(link) {
    const box = document.createElement('span');
    box.className = 'size-set';
    const mk = (label, key, min, max) => {
      const wrap = document.createElement('label');
      const t = document.createElement('span');
      t.textContent = label;
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.step = '1';
      r.value = String(link[key]);
      r.title = `这张组件的${label}`;
      const v = document.createElement('b');
      v.textContent = link[key] + 'px';
      r.addEventListener('input', () => {
        const px = Number(r.value);
        v.textContent = px + 'px';
        Store.mutate((c) => {
          const it = c.docker.items.find((x) => x.id === link.id);
          if (it) it[key] = px;
        });
        this.resizeDockerTile(link.id);
      });
      wrap.append(t, r, v);
      return wrap;
    };
    box.append(mk('宽', 'w', DK_TILE.minW, DK_TILE.maxW), mk('高', 'h', DK_TILE.minH, DK_TILE.maxH));
    return box;
  },

  // 拖滑块时只改那一张组件的尺寸，别把上百个应用的分组网格重排一遍
  resizeDockerTile(itemId) {
    const it = (Store.cfg.docker.items || []).find((x) => x.id === itemId);
    const node = $('#dkLayer .dk-tile[data-link="' + CSS.escape(itemId) + '"]');
    if (!it || !node) return;
    node.style.setProperty('--dk-tile-w', it.w + 'px');
    node.style.setProperty('--dk-tile-h', it.h + 'px');
    // 摆放下缘可能跟着变了：这条摆放区的高度是自己算的，不重算会把下面那截留空或截掉
    this.fitDockerLayer();
  },

  syncSettings() {
    const cfg = Store.cfg;
    const ap = cfg.appearance;

    $('#setTitle').value = ap.title;
    for (const b of $$('#themeSeg button')) b.classList.toggle('active', b.dataset.v === ap.theme);
    for (const b of $$('#iconSizeSeg button')) b.classList.toggle('active', b.dataset.v === ap.iconSize);
    for (const b of $$('#tileLayoutSeg button')) b.classList.toggle('active', b.dataset.v === ap.tileLayout);
    $('#accentInput').value = /^#[0-9a-f]{6}$/i.test(ap.accent) ? ap.accent : '#7c8cff';

    for (const b of $$('#wpSeg button')) b.classList.toggle('active', b.dataset.v === ap.wallpaper.kind);
    for (const b of $$('#wpFitSeg button')) b.classList.toggle('active', b.dataset.v === (ap.wallpaper.fit || 'cover'));
    $('#wpGradient').hidden = ap.wallpaper.kind !== 'gradient';
    $('#wpUrl').hidden = ap.wallpaper.kind !== 'url';
    $('#wpUpload').hidden = ap.wallpaper.kind !== 'upload';
    $('#wpBing').hidden = ap.wallpaper.kind !== 'bing';
    $('#wpUrlInput').value = ap.wallpaper.kind === 'url' ? ap.wallpaper.value : '';
    $('#wpUploadState').textContent = ap.wallpaper.kind === 'upload' ? `当前：${ap.wallpaper.value}` : '';
    $('#blurRange').value = ap.wallpaper.blur;
    $('#dimRange').value = Math.round(ap.wallpaper.dim * 100);
    $('#blurVal').textContent = ap.wallpaper.blur;
    $('#dimVal').textContent = Math.round(ap.wallpaper.dim * 100);
    $('#fontRange').value = ap.fontSize;
    $('#fontVal').textContent = ap.fontSize;
    $('#gapRange').value = ap.rowGap;
    $('#gapVal').textContent = ap.rowGap;

    const sw = $('#gradientSwatches');
    sw.innerHTML = '';
    for (const [key, css] of Object.entries(Gradients)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (ap.wallpaper.kind === 'gradient' && ap.wallpaper.value === key ? ' active' : '');
      b.style.background = css;
      b.title = key;
      b.addEventListener('click', () => {
        Store.mutate((c) => {
          c.appearance.wallpaper.kind = 'gradient';
          c.appearance.wallpaper.value = key;
        });
        this.applyAppearance();
        this.syncSettings();
      });
      sw.appendChild(b);
    }

    this.renderEngineList();
    const defSel = $('#defaultEngine');
    defSel.innerHTML = '';
    for (const e of cfg.search.engines) defSel.append(new Option(e.name, e.id, false, e.id === cfg.search.default));
    $('#rememberEngine').checked = Prefs.get('rememberEngine', true);

    $('#showClock').checked = ap.widgets.clock;
    $('#showNotes').checked = ap.widgets.notes;
    $('#showTodos').checked = ap.widgets.todos;
    $('#showWeather').checked = ap.widgets.weather;
    $('#showSeconds').checked = ap.showSeconds;
    $('#clock24').checked = ap.clock24;
    $('#iconDefault').value = ['emoji', 'auto', 'letter'].includes(Prefs.get('defaultIconKind', 'emoji')) ? Prefs.get('defaultIconKind', 'emoji') : 'emoji';
    $('#iconTemplate').value = ap.iconTemplate;
    $('#cityInput').value = cfg.weather.city || '';

    const gl = $('#groupList');
    gl.innerHTML = '';
    cfg.groups.forEach((g, i) => {
      const li = document.createElement('li');
      li.className = 'row';
      const label = document.createElement('span');
      const pinned = g.netMode === 'lan' ? '固定内网' : g.netMode === 'wan' ? '固定外网' : '';
      label.textContent = `${i + 1}. ${g.name}（${g.links.length}${pinned ? ' · ' + pinned : ''}）`;
      const acts = document.createElement('div');
      acts.className = 'btn-row';
      acts.append(
        this.miniBtn('✎', '图标 / 名称 / 取址方式', () => this.openGroupModal(g)),
        this.miniBtn('↑', '上移', () => {
          this.moveGroup(g.id, -1);
          this.syncSettings();
        }),
        this.miniBtn('↓', '下移', () => {
          this.moveGroup(g.id, 1);
          this.syncSettings();
        }),
        this.miniBtn('✕', '删除分组', () => {
          if (!confirm(`删除分组「${g.name}」及其 ${g.links.length} 个链接？`)) return;
          Store.mutate((c) => {
            c.groups = c.groups.filter((x) => x.id !== g.id);
          });
          this.renderGroups();
          this.syncSettings();
        })
      );
      li.append(label, acts);
      gl.appendChild(li);
    });

    $('#accountInput').value = Store.session.account || '';
    const warn = [];
    if (Store.session.defaultPasswordInUse) warn.push('当前仍是默认密码 admin123');
    if (Store.session.defaultAccountInUse) warn.push('当前仍是默认账号 admin');
    $('#safeNotice').textContent = warn.length
      ? `⚠️ ${warn.join('、')}，请立刻修改。`
      : '账号名明文存在 NAS 的 data/auth.json，密码只存 scrypt 哈希，不会通过网络下发。';
  },

  renderEngineList() {
    const ul = $('#engineList');
    ul.innerHTML = '';
    for (const e of Store.cfg.search.engines) {
      const li = document.createElement('li');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'defeng';
      radio.checked = e.id === Store.cfg.search.default;
      radio.title = '设为默认';
      radio.addEventListener('change', () => {
        Store.mutate((c) => {
          c.search.default = e.id;
        });
        this.renderSearch();
      });
      const name = document.createElement('strong');
      name.textContent = e.name;
      const url = document.createElement('span');
      url.className = 'grow';
      url.textContent = e.url;
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        if (Store.cfg.search.engines.length <= 1) return this.toast('至少保留一个搜索引擎', 2500, true);
        Store.mutate((c) => {
          c.search.engines = c.search.engines.filter((x) => x.id !== e.id);
          if (c.search.default === e.id) c.search.default = c.search.engines[0]?.id || '';
        });
        Prefs.set('engine', Store.cfg.search.default);
        this.renderSearch();
        this.syncSettings();
      });
      li.append(radio, this.engineIcon(e), name, url, del);
      ul.appendChild(li);
    }
  },

  bindSettings() {
    for (const m of [$('#settingsModal'), $('#linkModal'), $('#groupModal')]) {
      m.addEventListener('click', (e) => {
        if (e.target === m || (e.target instanceof Element && e.target.closest('[data-close]'))) m.hidden = true;
      });
    }
    for (const b of $$('.tabs .tab')) b.addEventListener('click', () => this.switchTab(b.dataset.tab));
    $('#appNewBtn').addEventListener('click', () => this.openLinkModal(null));
    // 建组不必先开编辑模式：这一栏和主页编辑条开的是同一个弹层
    $('#groupNewBtn').addEventListener('click', () => this.openGroupModal(null));

    $('#setTitle').addEventListener('input', (e) => {
      Store.mutate((c) => {
        c.appearance.title = e.target.value.slice(0, 40) || 'NASphere';
      });
      document.title = Store.cfg.appearance.title;
    });
    for (const b of $$('#themeSeg button')) {
      b.addEventListener('click', () => {
        Store.mutate((c) => {
          c.appearance.theme = b.dataset.v;
        });
        this.applyAppearance();
        this.syncSettings();
      });
    }
    for (const b of $$('#iconSizeSeg button')) {
      b.addEventListener('click', () => {
        Store.mutate((c) => {
          c.appearance.iconSize = b.dataset.v;
        });
        this.applyAppearance();
        this.renderGroups();
        this.syncSettings();
      });
    }
    for (const b of $$('#tileLayoutSeg button')) {
      b.addEventListener('click', () => {
        Store.mutate((c) => {
          c.appearance.tileLayout = b.dataset.v;
        });
        this.applyAppearance();
        this.syncSettings();
      });
    }
    $('#accentInput').addEventListener('input', (e) => {
      Store.mutate((c) => {
        c.appearance.accent = e.target.value;
      });
      document.documentElement.style.setProperty('--accent', e.target.value);
    });

    for (const b of $$('#wpSeg button')) {
      b.addEventListener('click', () => {
        const kind = b.dataset.v;
        Store.mutate((c) => {
          const wp = c.appearance.wallpaper;
          if (wp.kind !== kind) {
            wp.value = kind === 'gradient' ? 'midnight' : '';
          }
          wp.kind = kind;
        });
        this.applyAppearance();
        this.syncSettings();
        if (kind === 'url') $('#wpUrlInput').focus();
      });
    }
    for (const b of $$('#wpFitSeg button')) {
      b.addEventListener('click', () => {
        Store.mutate((c) => {
          c.appearance.wallpaper.fit = b.dataset.v;
        });
        this.applyAppearance();
        this.syncSettings();
      });
    }
    $('#wpUrlInput').addEventListener('change', (e) => {
      const v = normalizeUrl(e.target.value);
      e.target.value = v;
      Store.mutate((c) => {
        c.appearance.wallpaper.kind = 'url';
        c.appearance.wallpaper.value = v;
      });
      this.applyAppearance();
    });
    $('#wpFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await Api.uploadImage(await fileToDataUrl(file));
        Store.mutate((c) => {
          c.appearance.wallpaper.kind = 'upload';
          c.appearance.wallpaper.value = url;
        });
        this.applyAppearance();
        this.syncSettings();
        this.toast('壁纸已上传到 NAS，所有设备同步');
      } catch (err) {
        this.toast('上传失败：' + err.message, 4000, true);
      }
      e.target.value = '';
    });
    $('#blurRange').addEventListener('input', (e) => {
      $('#blurVal').textContent = e.target.value;
      Store.mutate((c) => {
        c.appearance.wallpaper.blur = Number(e.target.value);
      });
      this.applyAppearance();
    });
    $('#dimRange').addEventListener('input', (e) => {
      $('#dimVal').textContent = e.target.value;
      Store.mutate((c) => {
        c.appearance.wallpaper.dim = Number(e.target.value) / 100;
      });
      this.applyAppearance();
    });
    $('#fontRange').addEventListener('input', (e) => {
      $('#fontVal').textContent = e.target.value;
      Store.mutate((c) => {
        c.appearance.fontSize = Number(e.target.value);
      });
      this.applyAppearance();
    });
    $('#gapRange').addEventListener('input', (e) => {
      $('#gapVal').textContent = e.target.value;
      Store.mutate((c) => {
        c.appearance.rowGap = Number(e.target.value);
      });
      this.applyAppearance();
    });

    $('#engineForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = normalizeUrl($('#engUrl').value);
      if (!url) return this.toast('请输入合法的 http/https 地址', 3000, true);
      if (!url.includes('{query}')) return this.toast('网址里必须包含 {query} 占位符', 3000, true);
      Store.mutate((c) => {
        c.search.engines.push({ id: uid('e'), name: $('#engName').value.trim().slice(0, 60), url });
      });
      $('#engineForm').reset();
      this.renderSearch();
      this.syncSettings();
    });
    $('#defaultEngine').addEventListener('change', (e) => {
      Store.mutate((c) => {
        c.search.default = e.target.value;
      });
      this.renderSearch();
    });
    $('#rememberEngine').addEventListener('change', (e) => Prefs.set('rememberEngine', e.target.checked));

    const bindFlag = (sel, apply, after) => {
      $(sel).addEventListener('change', (e) => {
        const on = e.target.checked;
        Store.mutate((c) => apply(c, on));
        this.applyAppearance();
        Widgets.renderPanels();
        if (after) after(on);
      });
    };
    bindFlag('#showClock', (c, on) => (c.appearance.widgets.clock = on));
    bindFlag('#showNotes', (c, on) => (c.appearance.widgets.notes = on));
    bindFlag('#showTodos', (c, on) => (c.appearance.widgets.todos = on));
    bindFlag('#showSeconds', (c, on) => (c.appearance.showSeconds = on), () => Widgets.tickClock());
    bindFlag('#clock24', (c, on) => (c.appearance.clock24 = on), () => Widgets.tickClock());
    $('#showWeather').addEventListener('change', (e) => {
      const on = e.target.checked;
      Store.mutate((c) => {
        c.appearance.widgets.weather = on;
        c.weather.enabled = on;
      });
      this.applyAppearance();
      Widgets.refreshWeather(true);
    });
    $('#iconDefault').addEventListener('change', (e) => Prefs.set('defaultIconKind', e.target.value));
    $('#iconTemplate').addEventListener('change', (e) => {
      const v = normalizeUrl(e.target.value);
      e.target.value = v;
      Store.mutate((c) => {
        c.appearance.iconTemplate = v;
      });
      this.renderGroups();
    });

    $('#cityInput').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = e.target.value.trim();
      const box = $('#cityResults');
      if (!q) return;
      box.hidden = false;
      box.innerHTML = '<li>搜索中…</li>';
      try {
        const list = await Widgets.searchCity(q);
        box.innerHTML = '';
        if (!list.length) box.innerHTML = '<li>没有匹配的城市</li>';
        for (const r of list) {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = r.name;
          b.addEventListener('click', () => {
            Store.mutate((c) => {
              c.weather.city = r.city;
              c.weather.lat = Number(r.lat.toFixed(4));
              c.weather.lon = Number(r.lon.toFixed(4));
              c.weather.enabled = true;
            });
            box.hidden = true;
            $('#cityInput').value = r.city;
            $('#showWeather').checked = true;
            Widgets.refreshWeather(true);
            this.toast('天气城市已设为 ' + r.city);
          });
          li.appendChild(b);
          box.appendChild(li);
        }
      } catch (err) {
        box.innerHTML = '<li></li>';
        box.firstElementChild.textContent = '搜索失败：' + err.message;
      }
    });

    $('#exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(Store.cfg, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nav-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!parsed || !Array.isArray(parsed.groups)) throw new Error('文件结构不对，缺少 groups');
        await Api.saveConfig(parsed);
        await Store.reloadConfig();
        Store.onChange();
        this.renderAll();
        this.syncSettings();
        this.toast('配置已导入');
      } catch (err) {
        this.toast('导入失败：' + err.message, 5000, true);
      }
    });

    $('#resetBtn').addEventListener('click', async () => {
      if (!confirm('确定清空所有自定义内容（分组与应用、容器组件、便签与待办、外观与搜索引擎），恢复初始配置？该操作不可撤销（建议先导出备份）。')) return;
      try {
        await Api.saveConfig({});
        await Store.reloadConfig();
        this.renderAll();
        this.syncSettings();
        this.toast('已清空为初始配置');
      } catch (err) {
        this.toast('重置失败：' + err.message, 4000, true);
      }
    });

    $('#credentialsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const account = $('#accountInput').value.trim();
      const next = $('#pwNew').value;
      if (!account) return this.toast('账号名不能为空', 3000, true);
      if (next !== $('#pwNew2').value) return this.toast('两次输入的新密码不一致', 3000, true);
      if (!next && account === Store.session.account) return this.toast('账号和密码都没有改动', 2500);
      if (next && next.length < 6) return this.toast('新密码至少 6 位', 3000, true);
      try {
        Store.session = await Api.credentials(account, $('#pwCurrent').value, next);
        $('#pwCurrent').value = $('#pwNew').value = $('#pwNew2').value = '';
        this.syncSettings();
        this.toast(next ? '账号与密码已更新' : '账号名已更新');
      } catch (err) {
        this.toast('修改失败：' + err.message, 4000, true);
      }
    });
    $('#logoutBtn2').addEventListener('click', () => this.logout());
  },

  /* ---------- toast ---------- */

  toastTimer: 0,

  toast(text, ms = 2200, bad = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('bad', Boolean(bad));
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.hidden = true), ms);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
