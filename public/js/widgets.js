'use strict';

const Widgets = {
  timer: 0,
  weatherTimer: 0,
  cache: null,

  WMO: {
    0: ['☀️', '晴'],
    1: ['🌤️', '大部晴朗'],
    2: ['⛅', '多云'],
    3: ['☁️', '阴'],
    45: ['🌫️', '雾'],
    48: ['🌫️', '雾凇'],
    51: ['🌦️', '毛毛雨'],
    53: ['🌦️', '毛毛雨'],
    55: ['🌧️', '毛毛雨'],
    56: ['🌧️', '冻雨'],
    57: ['🌧️', '冻雨'],
    61: ['🌧️', '小雨'],
    63: ['🌧️', '中雨'],
    65: ['🌧️', '大雨'],
    66: ['🌧️', '冻雨'],
    67: ['🌧️', '冻雨'],
    71: ['🌨️', '小雪'],
    73: ['🌨️', '中雪'],
    75: ['❄️', '大雪'],
    77: ['❄️', '雪粒'],
    80: ['🌦️', '阵雨'],
    81: ['🌧️', '强阵雨'],
    82: ['⛈️', '暴雨'],
    85: ['🌨️', '阵雪'],
    86: ['❄️', '强阵雪'],
    95: ['⛈️', '雷暴'],
    96: ['⛈️', '雷暴伴冰雹'],
    99: ['⛈️', '强雷暴'],
  },

  startClock() {
    this.tickClock();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tickClock(), 1000);
  },

  tickClock() {
    const ap = Store.cfg?.appearance;
    if (!ap) return;
    const now = new Date();
    const h = ap.clock24 ? String(now.getHours()).padStart(2, '0') : String(((now.getHours() + 11) % 12) + 1);
    const m = String(now.getMinutes()).padStart(2, '0');
    let text = h + ':' + m;
    if (ap.showSeconds) text += ':' + String(now.getSeconds()).padStart(2, '0');
    if (!ap.clock24) text += now.getHours() < 12 ? ' AM' : ' PM';
    const timeEl = $('#clockTime');
    const dateEl = $('#clockDate');
    const greetEl = $('#greeting');
    if (timeEl) timeEl.textContent = text;
    if (dateEl) {
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
      dateEl.textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${week}`;
    }
    if (greetEl) greetEl.textContent = this.greeting(now);
  },

  greeting(now) {
    const h = now.getHours();
    const name = Prefs.get('name', '');
    const tail = name ? `，${name}` : '';
    if (h < 5) return '深夜了，注意休息' + tail;
    if (h < 9) return '早上好' + tail;
    if (h < 12) return '上午好' + tail;
    if (h < 14) return '中午好' + tail;
    if (h < 18) return '下午好' + tail;
    if (h < 23) return '晚上好' + tail;
    return '夜深了' + tail;
  },

  async refreshWeather(force) {
    const w = Store.cfg?.weather;
    const chip = $('#weatherChip');
    if (!chip || !w || !w.enabled || !Store.cfg.appearance.widgets.weather) {
      if (chip) chip.hidden = true;
      return;
    }
    if (!force && this.cache && Date.now() - this.cache.at < 15 * 60000) {
      this.paintWeather(this.cache.data);
      return;
    }
    chip.hidden = false;
    chip.textContent = '天气加载中…';
    const url =
      'https://api.open-meteo.com/v1/forecast?latitude=' +
      encodeURIComponent(w.lat) +
      '&longitude=' +
      encodeURIComponent(w.lon) +
      '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      this.cache = { at: Date.now(), data };
      this.paintWeather(data);
    } catch (e) {
      chip.textContent = '⚠️ 天气不可用';
      chip.title = '无法连接 open-meteo：' + e.message;
    }
  },

  paintWeather(data) {
    const chip = $('#weatherChip');
    if (!chip || !data?.current) return;
    const c = data.current;
    const [icon, label] = this.WMO[c.weather_code] || ['🌡️', '—'];
    const lo = Math.round(data.daily?.temperature_2m_min?.[0] ?? c.temperature_2m);
    const hi = Math.round(data.daily?.temperature_2m_max?.[0] ?? c.temperature_2m);
    chip.textContent = `${icon} ${Math.round(c.temperature_2m)}° ${label} ${lo}~${hi}°`;
    chip.title = `${Store.cfg.weather.city || '当前位置'} · 体感 ${Math.round(c.apparent_temperature)}° · 湿度 ${c.relative_humidity_2m}% · 风速 ${c.wind_speed_10m} km/h（点击设置城市）`;
  },

  async searchCity(name) {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=8&language=zh&format=json&name=' + encodeURIComponent(name);
    const res = await fetch(url);
    if (!res.ok) throw new Error('城市搜索失败');
    const data = await res.json();
    return (data.results || []).map((r) => ({
      name: [r.country, r.admin1, r.name].filter(Boolean).join(' / '),
      lat: r.latitude,
      lon: r.longitude,
      city: r.name,
    }));
  },

  renderPanels() {
    const cfg = Store.cfg;
    if (!cfg) return;
    const notesPanel = $('#notesPanel');
    const todosPanel = $('#todosPanel');
    notesPanel.hidden = !cfg.appearance.widgets.notes;
    todosPanel.hidden = !cfg.appearance.widgets.todos;
    $('#panels').hidden = notesPanel.hidden && todosPanel.hidden;

    const area = $('#notesArea');
    if (area.dataset.focused !== '1' && area.value !== cfg.notes.text) area.value = cfg.notes.text;
    $('#notesHint').textContent = cfg.notes.text.length ? cfg.notes.text.length + ' 字' : '';

    const list = $('#todoList');
    list.innerHTML = '';
    for (const t of cfg.notes.todos) {
      const li = document.createElement('li');
      li.className = t.done ? 'done' : '';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.done;
      cb.addEventListener('change', () => {
        Store.mutate((c) => {
          const it = c.notes.todos.find((x) => x.id === t.id);
          if (it) it.done = cb.checked;
        });
        this.renderPanels();
      });
      const span = document.createElement('span');
      span.textContent = t.text;
      const del = document.createElement('button');
      del.type = 'button';
      del.title = '删除';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        Store.mutate((c) => {
          c.notes.todos = c.notes.todos.filter((x) => x.id !== t.id);
        });
        this.renderPanels();
      });
      li.append(cb, span, del);
      list.appendChild(li);
    }
    const done = cfg.notes.todos.filter((t) => t.done).length;
    $('#todoProgress').textContent = cfg.notes.todos.length ? `${done} / ${cfg.notes.todos.length}` : '';
  },

  bindPanels() {
    const area = $('#notesArea');
    area.addEventListener('focus', () => (area.dataset.focused = '1'));
    area.addEventListener('blur', () => (area.dataset.focused = ''));
    area.addEventListener('input', () => {
      Store.mutate((c) => {
        c.notes.text = area.value.slice(0, 20000);
      });
      $('#notesHint').textContent = area.value.length + ' 字';
    });

    $('#todoForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#todoInput');
      const text = input.value.trim();
      if (!text) return;
      Store.mutate((c) => c.notes.todos.push({ id: uid('t'), text: text.slice(0, 200), done: false }));
      input.value = '';
      this.renderPanels();
    });
  },

  stopAll() {
    clearInterval(this.timer);
    clearTimeout(this.weatherTimer);
  },
};
