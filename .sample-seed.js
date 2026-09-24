'use strict';
// 只往 demo（.demo-data）里灌一份示例配置，方便看效果；不属于交付物。
const fs = require('fs');

const BASE = 'http://127.0.0.1:18083';
const cookieJar = fs.readFileSync('.demo-cookies.txt', 'utf8').split(/\r?\n/).filter((l) => l.includes('nav_session')).map((l) => l.split('\t').slice(-2).join('=')).join('; ');

const cfg = JSON.parse(fs.readFileSync('.demo-data/config.json', 'utf8'));

cfg.appearance.title = '家庭 NAS · 控制中心';
cfg.appearance.iconSize = 'medium';
cfg.appearance.tileLayout = 'top';
cfg.appearance.fontSize = 13;
cfg.appearance.rowGap = 14;
cfg.appearance.widgets = { clock: true, notes: true, todos: true, weather: true };
cfg.appearance.wallpaper = { kind: 'gradient', value: 'midnight', fit: 'cover', blur: 0, dim: 0.42 };

cfg.groups = [
  {
    name: 'NAS 系统', icon: '🗄️', iconKind: 'emoji', netMode: 'lan', collapsed: false,
    links: [
      { title: '群晖 DSM', url: 'http://192.168.1.100:5000', icon: '🖥️', desc: '系统总入口' },
      { title: 'Lucky', url: 'http://192.168.1.100:16601', icon: '🧭', desc: '反向代理 / DDNS' },
      { title: 'File Station', url: 'http://192.168.1.100:5000/files', iconKind: 'auto', desc: '网盘文件' },
      { title: 'Container Manager', url: 'http://192.168.1.100:5000/docker', icon: '🐳', desc: '容器与compose' },
      { title: '监控大师', url: 'http://192.168.1.100:8080', icon: '📊', desc: 'CPU / 磁盘 / 温度' },
      { title: '路由器', url: 'http://192.168.1.1', icon: '📶', desc: 'OpenWrt' },
    ],
  },
  {
    name: '影音娱乐', icon: '🎬', iconKind: 'emoji', collapsed: false,
    links: [
      { title: 'Jellyfin', url: 'http://192.168.1.100:8096', urlLan: 'http://192.168.1.100:8096', icon: '🎞️', desc: '影视库' },
      { title: 'qBittorrent', url: 'http://192.168.1.100:8081', icon: '🌀', desc: '下载 · PT' },
      { title: '迅雷下载', url: 'http://192.168.1.100:2333', icon: '⚡', desc: '离线下载' },
      { title: 'Immich 相册', url: 'http://192.168.1.100:2283', icon: '📷', desc: '家庭照片备份' },
      { title: 'Navidrome', url: 'http://192.168.1.100:4533', icon: '🎵', desc: '自建音乐库' },
      { title: 'NAS 管理页（外网）', url: 'https://nas.example.com', urlLan: 'http://192.168.1.100:5000', icon: '🌐', desc: '内外网各一条' },
    ],
  },
  {
    name: '自建服务', icon: '🛠️', iconKind: 'emoji', collapsed: false,
    links: [
      { title: 'Home Assistant', url: 'http://192.168.1.100:8123', icon: '🏠', desc: '智能家居' },
      { title: 'Uptime Kuma', url: 'http://192.168.1.100:3001', icon: '🟢', desc: '服务可用性' },
      { title: 'Alist', url: 'http://192.168.1.100:5244', icon: '📀', desc: '多云盘挂载' },
      { title: 'Vaultwarden', url: 'http://192.168.1.100:8089', icon: '🔐', desc: '密码库' },
      { title: '本导航自己', url: 'http://192.168.1.100:8080', icon: '🧩', desc: '就是这个页面' },
    ],
  },
  {
    name: '外部网站', icon: '🌍', iconKind: 'emoji', netMode: 'wan', collapsed: false,
    links: [
      { title: 'ChatGPT', url: 'https://chat.openai.com', iconKind: 'auto', desc: '对话' },
      { title: 'GitHub', url: 'https://github.com', iconKind: 'auto', desc: '代码托管' },
      { title: 'Cloudflare', url: 'https://dash.cloudflare.com', iconKind: 'auto', desc: '域名 / DNS' },
      { title: '哔哩哔哩', url: 'https://www.bilibili.com', iconKind: 'auto', desc: '视频' },
      { title: '知乎', url: 'https://www.zhihu.com', iconKind: 'auto', desc: '问答' },
      { title: '什么值得买', url: 'https://www.smzdm.com', iconKind: 'auto', desc: '装备与好价' },
    ],
  },
];

cfg.docker = {
  w: 900,
  h: 268,
  collapsed: false,
  items: [
    { title: '本导航', container: 'nasphere', icon: '🧩', desc: '这个页面自己', url: 'http://192.168.1.100:8080', w: 262, h: 118 },
    { title: 'Immich 相册', container: 'jianyingge-photo', icon: '📷', desc: '照片后端', w: 262, h: 118 },
    { title: '迅雷', container: 'xunlei', icon: '⚡', desc: '离线下载', url: 'http://192.168.1.100:2333', w: 262, h: 118 },
    { title: 'qBittorrent', container: 'qbittorrent', icon: '🌀', desc: 'PT 下载', url: 'http://192.168.1.100:8081', w: 262, h: 118 },
    { title: 'Home Assistant', container: 'homeassistant', icon: '🏠', desc: '智能家居', url: 'http://192.168.1.100:8123', w: 262, h: 118 },
    { title: 'Lucky', container: 'lucky', icon: '🧭', desc: '反代 · DDNS', w: 262, h: 118 },
    { title: '停着的示例', container: 'stopped-demo', icon: '🧊', desc: '演示停止状态与「启动」键', w: 262, h: 118 },
  ],
};

cfg.notes = {
  text: '9 月：\n· 换两块 4T 盘（RAID 组重建）\n· Immich 升级到 v1.13，先看备份\n· 给外网那组补一层 2FA\n\n内网段：192.168.1.0/24 · NAS 在 .100',
  todos: ['把 Jellyfin 硬件转码打开', '给 Vaultwarden 做一次导出', '路由器固件升级后核对端口转发', '清一次下载盘的孤儿文件'],
};

(async () => {
  const res = await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieJar },
    body: JSON.stringify(cfg),
  });
  const text = await res.text();
  console.log('PUT', res.status, text.slice(0, 120));
  const back = await fetch(BASE + '/api/config', { headers: { Cookie: cookieJar } });
  const c = await back.json();
  console.log('groups:', c.groups.map((g) => g.name + '=' + g.links.length).join(' , '));
  console.log('docker:', c.docker.w + 'x' + c.docker.h, 'items=', c.docker.items.length, c.docker.items.map((i) => i.container).join(','));
})();
