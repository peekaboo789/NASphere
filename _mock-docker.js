'use strict';
/* 本机没有 Docker：用一个假守护进程验证服务端那套客户端代码。仅测试用，验完删掉。 */
const http = require('http');

const PORT = Number(process.env.MOCK_DOCKER_PORT || 19999);
const booted = Date.now() - 3600e3;

const seeds = [
  { name: 'nasphere', image: 'nasphere:1.4.0', mem: 62 * 1024 * 1024, limit: 2 * 1024 ** 3, rate: 4e5 },
  { name: 'jianyingge-photo', image: 'immich-server:latest', mem: 731 * 1024 * 1024, limit: 4 * 1024 ** 3, rate: 9e6 },
  { name: 'xunlei', image: 'xiaoya/xunlei:2', mem: 240 * 1024 * 1024, limit: 2 * 1024 ** 3, rate: 2.4e6 },
  { name: 'qbittorrent', image: 'linuxserver/qbittorrent:4.6', mem: 410 * 1024 * 1024, limit: 2 * 1024 ** 3, rate: 6.5e6 },
  { name: 'homeassistant', image: 'homeassistant:2026.5', mem: 305 * 1024 * 1024, limit: 2 * 1024 ** 3, rate: 7e4 },
  { name: 'lucky', image: 'goodboy88/lucky:latest', mem: 33 * 1024 * 1024, limit: 2 * 1024 ** 3, rate: 1.2e5 },
  { name: 'stopped-demo', image: 'nginx:1.27', mem: 0, limit: 2 * 1024 ** 3, rate: 0 },
];

const ct = new Map();
for (const [i, s] of seeds.entries()) {
  ct.set(s.name, {
    ...s,
    id: (i + 1).toString(16).repeat(16).slice(0, 64),
    state: s.name === 'stopped-demo' ? 'exited' : 'running',
    status: s.name === 'stopped-demo' ? 'Exited (0) 3 hours ago' : 'Up 3 hours',
    startedAt: booted,
    rx: 320 * 1024 * 1024 + i * 1e7,
    tx: 96 * 1024 * 1024 + i * 1e7,
    cpu: 1e9 + i * 7e8,
  });
}

const sysCpu = () => 4e10 + (Date.now() - booted) * 3.6e3;
const ONLINE_CPUS = 4;

function send(res, code, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function statsOf(c) {
  const secs = (Date.now() - c.startedAt) / 1000;
  // 假容器的 CPU 占用按 rate 线性放大，取两个相邻采样点算差值
  const usage = (t) => c.cpu + c.rate * 0.9 * t;
  return {
    read: new Date().toISOString(),
    id: c.id,
    name: '/' + c.name,
    cpu_stats: {
      cpu_usage: { total_usage: usage(secs) },
      system_cpu_usage: sysCpu(),
      online_cpus: ONLINE_CPUS,
    },
    precpu_stats: {
      cpu_usage: { total_usage: usage(Math.max(0, secs - 1)) },
      system_cpu_usage: sysCpu() - 3.6e7,
      online_cpus: ONLINE_CPUS,
    },
    memory_stats: { usage: c.mem, limit: c.limit },
    networks: {
      eth0: { rx_bytes: c.rx + c.rate * secs, tx_bytes: c.tx + c.rate * 0.35 * secs },
    },
    pids_stats: { current: 12 },
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const path = u.pathname.replace(/^\/v1\.[0-9]+/, '');
  console.log('[mock]', req.method, u.pathname);

  if (path === '/_ping') return send(res, 200, 'OK');

  if (path === '/containers/json') {
    const rows = [...ct.values()].map((c) => ({
      Id: c.id,
      Names: ['/' + c.name],
      Image: c.image,
      ImageID: 'sha256:' + c.id.slice(0, 12),
      State: c.state,
      Status: c.state === 'running' ? 'Up 3 hours' : 'Exited (0) 3 hours ago',
      Created: Math.floor(c.startedAt / 1000),
      Labels: { 'org.opencontainers.image.title': c.image.split(':')[0] },
    }));
    return send(res, 200, u.searchParams.get('all') ? rows : rows.filter((r) => r.State === 'running'));
  }

  const m = /^\/containers\/([^/]+)\/(stats|start|stop|restart)$/.exec(path);
  if (!m) return send(res, 404, { message: 'page not found' });
  const name = decodeURIComponent(m[1]);
  const c = ct.get(name);
  if (!c) return send(res, 404, { message: `No such container: ${name}` });

  if (m[2] === 'stats') {
    // 真 Docker 对停着的容器取 stats 会报错
    if (c.state !== 'running') return send(res, 500, { message: `Can not get stat for container ${name}: container is not running` });
    return send(res, 200, statsOf(c));
  }

  if (m[2] === 'stop') {
    if (c.state !== 'running') return send(res, 304, '');
    c.state = 'exited';
    c.status = 'Exited (0) ' + new Date().toISOString();
    return send(res, 204, '');
  }
  if (m[2] === 'start') {
    if (c.state === 'running') return send(res, 304, '');
    c.state = 'running';
    c.startedAt = Date.now();
    c.cpu += 5e8;
    return send(res, 204, '');
  }
  c.startedAt = Date.now();
  return send(res, 204, '');
});

server.listen(PORT, '127.0.0.1', () => console.log('mock docker listening on', PORT));
