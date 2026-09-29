'use strict';

/* ---------- 整页一张画布 ----------
   主页上每一块（时钟、搜索框、天气、便签、待办、每个分组面板、每张容器组件与读数卡）
   都坐在同一个 #board 上，共用一套坐标、一套叠放序、一套手柄。

   实现靠的是 display:contents：固定排列之后，那四个流式容器（topbar / hero / panels / groups）
   和组件摆放区 dkLayer 只剩一层空壳——它们的盒子撤掉了，孩子却还在 DOM 树里，
   于是继承照旧（时钟那段居中还是从 .hero 来的），但绝对定位的参照物变成了 #board。
   这样一处 DOM 都不用搬，主页上那些「#groups .group」「#dkLayer .dk-tile」的选择器全都照旧。

   两种状态，由配置里有没有坐标说了算，没有开关：
   · 一个坐标都没写过 = 自动排版。页面就是原来那套流式版式，不写任何数字，
     也就没有「出厂位置摆错了」这回事。
   · 第一次拖动任何一块 = 把当场量到的每一块矩形一次性固定进配置，从此各摆各的。
     固定的是量到的实际位置（宽也按量到的写，钳位上下限都留够了余量），所以松手那一刻画面纹丝不动。

   拖动与缩放的落点先按格点取整（layout.grid，8~64px），靠近相邻模块的边或中线时磁吸并画参考线，
   磁吸赢过格点。窄屏那一层 CSS 把一切退回竖排，坐标整个不参与，也不动配置里的数字。 */

// 五块固定模块：sel 是它在页面里的节点。min / max 与服务端 sanitize 里那张 LAY_MODS 表一一对应，改一边就得改另一边。
// 上限都比「画布最宽能有多大」（1440 内容宽减内边距 ≈ 1380）留了余量：首次固定写的是量到的实际宽，不能被钳一下。
const BOARD_MODS = [
  { key: 'clock', sel: '#clockBox', name: '时钟', min: [180, 60], max: [1600, 900] },
  { key: 'search', sel: '#searchForm', name: '搜索框', min: [240, 40], max: [1600, 200] },
  { key: 'weather', sel: '#weatherChip', name: '天气', min: [60, 32], max: [480, 160] },
  { key: 'notes', sel: '#notesPanel', name: '便签', min: [240, 140], max: [1600, 900] },
  { key: 'todos', sel: '#todosPanel', name: '待办', min: [240, 140], max: [1600, 900] },
];
const BOARD_BY_KEY = new Map(BOARD_MODS.map((m) => [m.key, m]));
// 分组面板：整块上网格，组里的网址卡继续按图标档位自动排。高默认由内容撑，只有拖过下柄才写数字。
const GROUP_SPEC = { key: '', name: '分组', min: [260, 120], max: [1600, 2400] };
// 容器组件与读数卡沿用 docker.items 自己那套宽高（精确微调在「应用矩阵」那一栏）
const DK_SPEC = { key: '', name: '组件', min: [DK_TILE.minW, DK_TILE.minH], max: [DK_TILE.maxW, DK_TILE.maxH] };

// 磁吸判定距离：比一根手指按住不动的抖动大不了多少，比一个格点小得多
const MAG_PX = 6;
// 三个手柄：右边改宽、下边改高、右下角一起改
const RZ = [
  ['e', '改宽'],
  ['s', '改高'],
  ['se', '同时改宽和高'],
];

const Board = {
  /* ---------- 状态 ---------- */

  box(key) {
    const lay = Store.cfg && Store.cfg.layout;
    return (lay && lay.modules && lay.modules[key]) || null;
  },

  // 有没有坐标 = 有没有固定过排列。这一条是整个功能的总闸，不设单独的开关
  isFree() {
    const lay = Store.cfg && Store.cfg.layout;
    return Boolean(lay && lay.modules && Object.keys(lay.modules).length);
  },

  grid() {
    const lay = Store.cfg && Store.cfg.layout;
    const g = Number(lay && lay.grid);
    return Number.isFinite(g) && g >= 8 && g <= 64 ? g : 16;
  },

  // 窄屏那一层：版式退回竖排，坐标既不生效也不写，手柄与格点都不出现——和组件那一档的判据同一套
  narrow() {
    return window.matchMedia('(max-width: 720px)').matches;
  },

  // 绝对定位的模块还能算坐标；静态竖排的那一格（窄屏）什么都没有
  positioned(el) {
    return getComputedStyle(el).position === 'absolute';
  },

  elOf(key) {
    const fixed = BOARD_BY_KEY.get(key);
    if (fixed) return $(fixed.sel);
    if (key.startsWith('group:')) {
      const id = key.slice(6);
      return $$('#groups .group').find((s) => s.dataset.group === id) || null;
    }
    if (key.startsWith('dk:')) {
      const id = key.slice(3);
      return $(`#dkLayer .dk-tile[data-link="${CSS.escape(id)}"]`) || null;
    }
    return null;
  },

  /* ---------- 摆位置 ---------- */

  // 一份清单：页面上现在有哪些模块。自动态与固定态都从这儿过，两边都只看真实的 DOM
  mods() {
    const out = [];
    for (const spec of BOARD_MODS) {
      const el = $(spec.sel);
      if (el && !el.hidden) out.push({ key: spec.key, el, spec });
    }
    for (const el of $$('#groups .group')) {
      out.push({ key: 'group:' + el.dataset.group, el, spec: GROUP_SPEC });
    }
    const items = (Store.cfg && Store.cfg.docker && Store.cfg.docker.items) || [];
    for (const el of $$('#dkLayer .dk-tile')) {
      const item = items.find((l) => l.id === el.dataset.link);
      if (item) out.push({ key: 'dk:' + item.id, el, spec: DK_SPEC, item });
    }
    return out;
  },

  // renderAll 的最后一步：把该搬的搬上画布（其实只是打 class）、写变量、挂手柄、算画布尺寸
  render() {
    const board = $('#board');
    if (!board) return;
    const free = this.isFree();
    document.documentElement.dataset.free = free ? 'on' : 'off';
    const list = this.mods();
    if (!free) {
      board.style.height = '';
      board.style.removeProperty('--grid');
      // 自动排版这一档也得绑上 pointerdown：它是「拖第一下就把整页固定下来」的唯一入口
      for (const m of list) {
        this.strip(m.el);
        if (!this.narrow()) this.bind(m);
      }
      this.syncHandles(false);
      return;
    }
    board.style.setProperty('--grid', this.grid() + 'px');
    let bottom = 0;
    list.forEach((m, i) => {
      m.el.classList.add('mod');
      const b = this.boxOf(m);
      const x = Math.round(Number(b.x) || 0);
      const y = Math.round(Number(b.y) || 0);
      m.el.style.setProperty('--x', x + 'px');
      m.el.style.setProperty('--y', y + 'px');
      // 只给过一轴时另一轴留 auto：分组面板那种「宽定了、高随内容撑」就靠这一条
      if (Number.isFinite(Number(b.w))) m.el.style.setProperty('--w', Math.round(b.w) + 'px');
      else m.el.style.removeProperty('--w');
      if (Number.isFinite(Number(b.h))) m.el.style.setProperty('--h', Math.round(b.h) + 'px');
      else m.el.style.removeProperty('--h');
      m.el.style.setProperty('--z', String(Number(b.z) || 10 + i));
      bottom = Math.max(bottom, y + m.el.offsetHeight);
      if (!this.narrow()) this.bind(m);
    });
    // 绝对定位不撑页面：画布得自己按最下面那一块拉出来，不然摆到区外就滚不到
    board.style.height = bottom + 'px';
    this.syncHandles(true);
  },

  boxOf(m) {
    return m.item ? m.item : this.box(m.key) || {};
  },

  // 撤掉编辑模式留下的抓手与手柄，自动排版时一格都不该看见。
  // boardBound 不清：那个 pointerdown 监听器留着才让「自动排版下拖一下 = 固定整页」能用，重复挂由它自己挡住
  strip(el) {
    for (const n of el.querySelectorAll(':scope > .mod-grip, :scope > .mod-rz')) n.remove();
    el.classList.remove('mod');
    for (const p of ['--x', '--y', '--w', '--h', '--z']) el.style.removeProperty(p);
  },

  /* 抓手与手柄只在「编辑模式 + 已固定排列 + 宽屏」这一档出现。
     自动排版时没有抓手也拖得动：按住任意一块不点着的地方就能把整页固定下来，
     固定之后每一块都有抓手了，搜索框那种一整排都是输入区的块也就有了落点。 */
  decorate(el) {
    if (el.querySelector(':scope > .mod-grip')) return;
    const grip = document.createElement('i');
    grip.className = 'mod-grip';
    grip.title = '按住拖动这一块';
    el.appendChild(grip);
    for (const [side, tip] of RZ) {
      const h = document.createElement('i');
      h.className = 'mod-rz rz-' + side;
      h.dataset.rz = side;
      h.title = tip;
      el.appendChild(h);
    }
  },

  undecorate() {
    for (const m of this.mods()) {
      for (const n of m.el.querySelectorAll(':scope > .mod-grip, :scope > .mod-rz')) n.remove();
    }
  },

  decorateAll() {
    for (const m of this.mods()) this.decorate(m.el);
  },

  // 编辑模式开合、窄屏与自动排版都不该看见这些柄
  syncHandles(free) {
    if (free && Store.editMode && !this.narrow()) this.decorateAll();
    else this.undecorate();
  },

  /* ---------- 落点：格点为底，相邻参考线磁吸优先 ---------- */

  // 别的模块给的六条线：左中右、上中下。自己那条不算，否则永远吸在自己原位
  lines(except) {
    const b = this.boardBox();
    const out = [];
    for (const m of this.mods()) {
      if (m.el === except) continue;
      const r = m.el.getBoundingClientRect();
      const x = r.left - b.left;
      const y = r.top - b.top;
      out.push({ axis: 'x', pos: x }, { axis: 'x', pos: x + r.width / 2 }, { axis: 'x', pos: x + r.width });
      out.push({ axis: 'y', pos: y }, { axis: 'y', pos: y + r.height / 2 }, { axis: 'y', pos: y + r.height });
    }
    return out;
  },

  boardBox() {
    const r = $('#board').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width };
  },

  /* 一个数取整：先看相邻的线（赢过格点），没有可吸的就落到格点上。
     返回 {v, hit, on} —— on 为真说明这一头吸上了线，调用方要把它汇进参考线。 */
  magnet(v, near, grid) {
    let best = null;
    for (const line of near) {
      const d = Math.abs(line - v);
      if (d <= MAG_PX && (!best || d < Math.abs(best - v))) best = line;
    }
    if (best !== null) return { v: Math.round(best), hit: best, on: true };
    return { v: Math.round(v / grid) * grid, hit: null, on: false };
  },

  // 拖位置：四边都能吸，所以左上角与右下角各试一次，吸得近的那一头说了算
  snapMove(x, y, w, h, near, grid) {
    const xs = near.filter((l) => l.axis === 'x').map((l) => l.pos);
    const ys = near.filter((l) => l.axis === 'y').map((l) => l.pos);
    const left = this.magnet(x, xs, grid);
    const right = this.magnet(x + w, xs, grid);
    const top = this.magnet(y, ys, grid);
    const bottom = this.magnet(y + h, ys, grid);
    const fx = right.on && (!left.on || Math.abs(right.hit - (x + w)) < Math.abs(left.hit - x)) ? right : left;
    const fy = bottom.on && (!top.on || Math.abs(bottom.hit - (y + h)) < Math.abs(top.hit - y)) ? bottom : top;
    const out = {
      x: fx === left ? fx.v : Math.round(fx.hit - w),
      y: fy === top ? fy.v : Math.round(fy.hit - h),
      w,
      h,
      guides: [],
    };
    if (left.on) out.guides.push({ axis: 'x', pos: left.hit });
    if (right.on) out.guides.push({ axis: 'x', pos: right.hit });
    if (top.on) out.guides.push({ axis: 'y', pos: top.hit });
    if (bottom.on) out.guides.push({ axis: 'y', pos: bottom.hit });
    return out;
  },

  // 改尺寸：只动被拖的那两条边（右下角则同时动宽和高），另外两边钉在原位
  snapSize(side, box, dx, dy, near, grid) {
    const xs = near.filter((l) => l.axis === 'x').map((l) => l.pos);
    const ys = near.filter((l) => l.axis === 'y').map((l) => l.pos);
    const out = { x: box.x, y: box.y, w: box.w, h: box.h, guides: [] };
    if (side === 'e' || side === 'se') {
      const r = this.magnet(box.x + box.w + dx, xs, grid);
      out.w = Math.max(1, Math.round(r.v - box.x));
      if (r.on) out.guides.push({ axis: 'x', pos: r.hit });
    }
    if (side === 's' || side === 'se') {
      const b = this.magnet(box.y + box.h + dy, ys, grid);
      out.h = Math.max(1, Math.round(b.v - box.y));
      if (b.on) out.guides.push({ axis: 'y', pos: b.hit });
    }
    return out;
  },

  /* ---------- 画布能给的尺寸：横向不给溢出（body 收了 overflow-x，摆出屏外就再也够不着） ---------- */

  limitX(x, w) {
    const max = Math.max(0, Math.floor(this.boardBox().width) - w);
    return Math.min(Math.max(0, Math.round(x)), max);
  },

  limitW(x, w, spec) {
    const max = Math.min(spec.max[0], Math.max(0, Math.floor(this.boardBox().width) - x));
    return Math.max(spec.min[0], Math.round(Math.min(w, max)));
  },

  limitH(h, spec) {
    return Math.min(Math.max(Math.round(h), spec.min[1]), spec.max[1]);
  },

  /* ---------- 参考线 ---------- */

  paintGuides(list) {
    const board = $('#board');
    if (!board) return;
    let layer = $('#guideLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'guideLayer';
      layer.setAttribute('aria-hidden', 'true');
      board.appendChild(layer);
    }
    layer.innerHTML = '';
    for (const g of list) {
      const line = document.createElement('i');
      line.className = 'guide ' + (g.axis === 'x' ? 'v' : 'h');
      if (g.axis === 'x') line.style.left = g.pos + 'px';
      else line.style.top = g.pos + 'px';
      layer.appendChild(line);
    }
  },

  /* ---------- 拖动与缩放 ---------- */

  bind(m) {
    if (m.el.dataset.boardBound === '1') return;
    m.el.dataset.boardBound = '1';
    m.el.addEventListener('pointerdown', (e) => this.onDown(m, e));
  },

  onDown(m, e) {
    if (e.button !== 0 || this.busy || this.narrow()) return;
    if (!Store.editMode) return;
    const el = m.el;
    if (!el.isConnected) return;
    const handle = e.target instanceof Element ? e.target.closest('.mod-rz') : null;
    const grip = e.target instanceof Element ? e.target.closest('.mod-grip') : null;
    // 手指只认抓手和手柄：模块本体上一按就想拖，手机就没法滚页面了
    if (!grip && !handle && e.pointerType === 'touch') return;
    // 组里的网址卡、卡上的按钮、便签输入框：那些东西有自己的事，别顺手把整块搬走
    if (!handle && !grip) {
      const inner = e.target instanceof Element ? e.target.closest('button, a, input, textarea, select') : null;
      if (inner && inner !== el) return;
    }
    const b = this.boardBox();
    const r = el.getBoundingClientRect();
    const box = {
      x: Math.round(r.left - b.left),
      y: Math.round(r.top - b.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
    this.busy = {
      m,
      el,
      mode: handle ? 'rz' : 'move',
      side: handle ? handle.dataset.rz : '',
      x0: e.clientX,
      y0: e.clientY,
      box,
      spec: m.spec,
      moved: false,
      free: this.positioned(el),
    };
    this.onMove = (ev) => this.onDragMove(ev);
    this.onUp = () => this.onDragEnd();
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    document.body.classList.add('board-drag');
    e.preventDefault();
  },

  onDragMove(e) {
    const st = this.busy;
    if (!st) return;
    const dx = e.clientX - st.x0;
    const dy = e.clientY - st.y0;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    st.moved = true;
    if (!st.free) {
      // 自动排版下拖任何一块 = 先把整页固定下来。固定量的是当场真实的矩形，所以画完还是原来那幅画
      this.ensureFrozen();
      st.free = this.positioned(st.el);
      if (!st.free) return;
      const b = this.boardBox();
      const r = st.el.getBoundingClientRect();
      st.box = { x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    const grid = this.grid();
    const near = this.lines(st.el);
    const next =
      st.mode === 'move'
        ? this.snapMove(st.box.x + dx, st.box.y + dy, st.box.w, st.box.h, near, grid)
        : this.snapSize(st.side, st.box, dx, dy, near, grid);
    if (st.mode === 'move') {
      next.x = this.limitX(next.x, st.box.w);
    } else {
      next.w = this.limitW(next.x, next.w, st.spec);
      next.h = this.limitH(next.h, st.spec);
    }
    st.next = next;
    this.paintGuides(next.guides);
    st.el.style.setProperty('--x', next.x + 'px');
    st.el.style.setProperty('--y', Math.max(0, Math.round(next.y)) + 'px');
    if (st.mode === 'rz') {
      st.el.style.setProperty('--w', next.w + 'px');
      st.el.style.setProperty('--h', next.h + 'px');
    }
  },

  onDragEnd() {
    const st = this.busy;
    this.busy = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    document.body.classList.remove('board-drag');
    this.paintGuides([]);
    if (!st) return;
    if (!st.moved || !st.free || !st.next) {
      if (st.moved) this.render();
      return;
    }
    const n = st.next;
    const patch = { x: n.x, y: Math.max(0, Math.round(n.y)) };
    if (st.mode === 'rz') {
      patch.w = n.w;
      patch.h = n.h;
    } else {
      patch.z = this.topZ();
    }
    this.writeBox(st.m, patch);
    this.render();
    if (typeof App !== 'undefined' && App.renderDockerPane) App.renderDockerPane();
    if (typeof App !== 'undefined' && App.renderLayoutPane) App.renderLayoutPane();
  },

  // 顶到底：所有模块按现在配置里的叠放序取最大 +1，被拖的那块盖到最上面
  topZ() {
    let max = 0;
    for (const m of this.mods()) max = Math.max(max, Number(this.boxOf(m).z) || 0);
    return Math.min(4000, Math.max(10, max) + 1);
  },

  writeBox(m, patch) {
    Store.mutate((c) => {
      if (m.item) {
        const it = (c.docker.items || []).find((l) => l.id === m.item.id);
        if (!it) return;
        Object.assign(it, patch);
        return;
      }
      c.layout = c.layout || { grid: this.grid(), modules: {} };
      c.layout.modules = c.layout.modules || {};
      c.layout.modules[m.key] = Object.assign({}, c.layout.modules[m.key], patch);
    });
  },

  /* 首次固定：把当场量到的每一块矩形一次性写进配置，只重画画布、不重建 DOM——
     重建会把指针底下这一块换成新节点，这一次拖动就断了。
     分组面板只写宽不写高（高继续由组里的卡片自己撑，加一个应用不至于要再摆一次）；
     组件与读数卡的坐标直接换算成相对画布，写回它们自己的 docker.items.x/y，不留第二份数。 */
  ensureFrozen() {
    if (!Store.cfg) return;
    const board = $('#board');
    if (!board) return;
    const b = board.getBoundingClientRect();
    let z = 10;
    const patch = {};
    for (const m of this.mods()) {
      const r = m.el.getBoundingClientRect();
      const box = {
        x: this.limitX(Math.round(r.left - b.left), Math.round(r.width)),
        y: Math.max(0, Math.round(r.top - b.top)),
        z: z++,
      };
      // 分组面板的高留 auto：内容多高就多高，别一固定就把它钉死，以后加应用还得自己撑
      const keepH = !m.key.startsWith('group:');
      box.w = this.limitW(box.x, Math.round(r.width), m.spec);
      if (keepH) box.h = this.limitH(Math.round(r.height), m.spec);
      if (m.item) patch['dk:' + m.item.id] = { item: m.item, box };
      else patch[m.key] = { box };
    }
    Store.mutate((c) => {
      c.layout = c.layout || { grid: this.grid(), modules: {} };
      c.layout.modules = c.layout.modules || {};
      for (const [key, v] of Object.entries(patch)) {
        if (key.startsWith('dk:')) {
          const it = (c.docker.items || []).find((l) => l.id === v.item.id);
          if (it) Object.assign(it, v.box);
        } else {
          c.layout.modules[key] = Object.assign({}, c.layout.modules[key], v.box);
        }
      }
    });
    // 只重画画布：DOM 一个都不重建，指针底下这一块还是原来那个节点，拖动不会断
    this.render();
  },

  /* 恢复自动排版：坐标一格不留。组件那一份还得从画布坐标换算回 #dkLayer 坐标——
     而 dkLayer 只有在自动排版那一档才有自己的盒子，所以先清干净重画一次，再按量到的位移倒回去。 */
  resetAuto() {
    Store.mutate((c) => {
      c.layout = { grid: c.layout ? c.layout.grid : this.grid(), modules: {} };
    });
    if (typeof App !== 'undefined' && App.renderAll) App.renderAll();
    const board = $('#board');
    const dk = $('#dkLayer');
    if (board && dk) {
      const b = board.getBoundingClientRect();
      const d = dk.getBoundingClientRect();
      const off = { x: Math.round(d.left - b.left), y: Math.round(d.top - b.top) };
      if (off.x || off.y) {
        Store.mutate((c) => {
          for (const it of c.docker.items || []) {
            it.x = Math.max(0, Math.round((Number(it.x) || 0) - off.x));
            it.y = Math.max(0, Math.round((Number(it.y) || 0) - off.y));
          }
        });
        if (typeof App !== 'undefined' && App.renderAll) App.renderAll();
      }
    }
    if (typeof App !== 'undefined' && App.renderLayoutPane) App.renderLayoutPane();
    if (typeof App !== 'undefined' && App.toast) App.toast('已恢复自动排版', 2400);
  },

  /* ---------- 给设置那一栏用 ---------- */

  // 这一栏列的是「除了容器组件之外」的各块——组件的宽高滑块在「应用矩阵」那一栏，不重复列
  paneKeys() {
    const out = [];
    for (const spec of BOARD_MODS) {
      if (this.box(spec.key)) out.push({ key: spec.key, spec, name: spec.name });
    }
    for (const g of (Store.cfg && Store.cfg.groups) || []) {
      if (this.box('group:' + g.id)) out.push({ key: 'group:' + g.id, spec: GROUP_SPEC, name: g.name });
    }
    return out;
  },

  // 每一行的当前值：没写过的数用页面上量到的那一个当刻度起点
  current(key) {
    const box = this.box(key) || {};
    const el = this.elOf(key);
    const r = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      x: Number(box.x) || 0,
      y: Number(box.y) || 0,
      w: Number.isFinite(Number(box.w)) ? Number(box.w) : Math.round(r.width),
      h: Number.isFinite(Number(box.h)) ? Number(box.h) : Math.round(r.height),
      hasH: Number.isFinite(Number(box.h)),
    };
  },

  specOf(key) {
    if (String(key).startsWith('group:')) return GROUP_SPEC;
    if (String(key).startsWith('dk:')) return DK_SPEC;
    return BOARD_BY_KEY.get(key) || null;
  },
};

// 跨过 720px 那条线时重画一次：窄屏那一档坐标不参与，回到宽屏要按配置里的坐标重新摆
(function watchNarrow() {
  let was = null;
  const onResize = () => {
    const mq = window.matchMedia('(max-width: 720px)');
    const n = mq.matches;
    if (was === null || was === n) {
      was = n;
      return;
    }
    was = n;
    if (typeof App !== 'undefined' && App.renderAll) App.renderAll();
  };
  window.addEventListener('resize', onResize);
})();
