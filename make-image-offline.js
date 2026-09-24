#!/usr/bin/env node
/*
 * 没有 Docker 的机器上也能产出 make-image.sh 的那种镜像包。
 * 做法：从镜像仓库匿名拉 node:22-alpine 的层 → 解 gzip 得到官方未压缩层（逐层核对 diff_id）
 *      → 把本项目代码打成一层的 tar → 拼出 docker load 认识的 tar.gz（manifest.json + Config + Layers）。
 * 零依赖，只用 Node 标准库。产物用 ./deploy.sh --tar <文件> 加载。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

/* ---------------- 参数 ---------------- */

const ROOT = __dirname;
const ARG = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const o = {
    arch: 'amd64,arm64',
    image: process.env.IMAGE || 'local/nasphere',
    tag: process.env.TAG || readVersion(),
    out: process.env.OUT_DIR || 'dist',
    cache: '.image-cache',
    base: 'public.ecr.aws/docker/library/node:22-alpine,docker.io/library/node:22-alpine',
    gzip: 6,
    keepCache: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} 后面要跟一个值`);
      return v;
    };
    if (a === '--arch') o.arch = next();
    else if (a === '--tag') o.tag = next();
    else if (a === '--image') o.image = next();
    else if (a === '--out') o.out = next();
    else if (a === '--cache') o.cache = next();
    else if (a === '--base') o.base = next();
    else if (a === '--gzip') o.gzip = Number(next());
    else if (a === '--keep-cache') o.keepCache = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else die(`未知参数：${a}（-h 看用法）`);
  }
  if (o.arch === 'both') o.arch = 'amd64,arm64';
  o.arches = o.arch.split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of o.arches) if (a !== 'amd64' && a !== 'arm64') die(`只支持 amd64 / arm64，收到 ${a}`);
  if (!Number.isInteger(o.gzip) || o.gzip < 1 || o.gzip > 9) o.gzip = 6;
  return o;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'latest';
  } catch {
    return 'latest';
  }
}

function usage() {
  process.stdout.write(`用法：node make-image-offline.js [--arch amd64|arm64|both] [--tag 标签] [--out 目录]

  --arch   要出哪些平台的包，默认 amd64,arm64
  --tag    镜像标签，默认取 package.json 的 version
  --image  镜像名，默认 local/nasphere（要和 deploy.sh 对上）
  --out    产物目录，默认 dist
  --base   基础镜像源，逗号分隔依次尝试，默认 public.ecr.aws 再 docker.io
  --cache  层缓存目录，默认 .image-cache（重跑不重复下载）

产物 dist/nasphere-<tag>-linux-<arch>.tar.gz 连同 .sha256 传到 NAS：
  ./deploy.sh --tar dist/nasphere-${ARG.tag}-linux-amd64.tar.gz
`);
}

/* ---------------- 小工具 ---------------- */

function log(m) { process.stdout.write(`\x1b[36m›\x1b[0m ${m}\n`); }
function ok(m) { process.stdout.write(`\x1b[32m✓\x1b[0m ${m}\n`); }
function warn(m) { process.stderr.write(`\x1b[33m!\x1b[0m ${m}\n`); }
function die(m) { process.stderr.write(`\x1b[31m✕\x1b[0m ${m}\n`); process.exit(1); }

const MB = (n) => (n / 1048576).toFixed(1) + 'MB';
const hexOf = (digest) => String(digest).replace(/^sha256:/, '');
const flat = (digest) => String(digest).replace(':', '-');

function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function hashAndTee(src, dst) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    const r = fs.createReadStream(src);
    const w = fs.createWriteStream(dst);
    r.on('data', (c) => { h.update(c); size += c.length; });
    r.on('error', reject);
    w.on('error', reject);
    w.on('close', () => resolve({ digest: h.digest('hex'), size }));
    r.pipe(w);
  });
}

function gunzipFile(src, dst) {
  return new Promise((resolve, reject) => {
    const r = fs.createReadStream(src);
    const g = zlib.createGunzip();
    const w = fs.createWriteStream(dst);
    let failed = null;
    r.on('error', (e) => { failed = e; });
    g.on('error', (e) => { failed = e; });
    w.on('error', (e) => { failed = e; });
    w.on('finish', () => (failed ? reject(failed) : resolve()));
    r.pipe(g).pipe(w);
  });
}

function open(urlStr, headers, follow) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: Object.assign({ 'User-Agent': 'nasphere-make-image/1.0' }, headers),
      },
      (res) => {
        const loc = res.headers.location;
        const redir = [301, 302, 303, 307, 308].includes(res.statusCode);
        if (redir && follow > 0 && loc) {
          res.resume();
          const nu = new URL(loc, u).toString();
          // 跳到 CDN/S3 时别把仓库的 bearer 带过去
          const h = Object.assign({}, headers);
          if (new URL(nu).hostname !== u.hostname) delete h.Authorization;
          return open(nu, h, follow - 1).then(resolve, reject);
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`请求 ${u.hostname} 超时`)));
    req.end();
  });
}

async function fetchJson(url, headers) {
  const res = await open(url, headers, 5);
  const buf = await readAll(res);
  if (res.statusCode >= 400) {
    throw Object.assign(new Error(`${res.statusCode} ${url}`), { statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf8').slice(0, 300) });
  }
  return { json: JSON.parse(buf.toString('utf8') || 'null'), headers: res.headers, buf };
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function download(url, headers, dst, expectDigest) {
  const tmp = dst + '.part';
  const res = await open(url, headers, 5);
  if (res.statusCode >= 400) {
    const body = await readAll(res);
    throw Object.assign(new Error(`${res.statusCode} ${url}`), { statusCode: res.statusCode, headers: res.headers, body: body.toString('utf8').slice(0, 300) });
  }
  const h = crypto.createHash('sha256');
  let got = 0;
  let lastMark = 0;
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(tmp);
    res.on('data', (c) => {
      h.update(c);
      got += c.length;
      if (got - lastMark > 16 * 1048576) {
        lastMark = got;
        process.stdout.write(`\r  ↳ ${MB(got)} / ${MB(Number(res.headers['content-length'] || expectDigest || got))}   `);
      }
    });
    res.on('error', reject);
    w.on('error', reject);
    w.on('close', () => {
      process.stdout.write('\r'.padEnd(60) + '\r');
      resolve();
    });
    res.pipe(w);
  });
  const digest = h.digest('hex');
  if (expectDigest && digest !== hexOf(expectDigest)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`下载内容校验不过：期望 ${expectDigest} 实际 sha256:${digest}`);
  }
  fs.renameSync(tmp, dst);
  return { digest, size: got };
}

/* ---------------- 仓库客户端 ---------------- */

// public.ecr/aws、registry-1.docker.io 都走标准的 401 + Bearer realm 流程，
// 首次拿到挑战头后再去换匿名 token。
function makeRegistry(base) {
  let host, repo, tag;
  {
    let s = String(base).trim();
    const at = s.lastIndexOf('@');
    if (at >= 0) throw new Error('暂不支持按 digest 引用基础镜像，用 tag：' + s);
    const c = s.lastIndexOf(':');
    if (c <= s.lastIndexOf('/')) throw new Error('基础镜像写法不对，例：public.ecr.aws/docker/library/node:22-alpine');
    tag = s.slice(c + 1);
    s = s.slice(0, c);
    const slash = s.indexOf('/');
    if (slash < 0 || (!s.slice(0, slash).includes('.') && !s.slice(0, slash).includes(':'))) {
      // node:22-alpine 这种简写按 docker.io 官方镜像处理
      host = 'registry-1.docker.io';
      repo = 'library/' + s;
    } else {
      host = s.slice(0, slash);
      repo = s.slice(slash + 1);
    }
  }
  const api = (p) => `https://${host}/v2/${repo}/${p}`;
  let token = null;

  async function authorize(challenge) {
    const m = /Bearer\s+(.*)/i.exec(challenge || '');
    const params = {};
    if (m) for (const kv of m[1].split(',')) {
      const e = /^\s*([A-Za-z]+)\s*=\s*"([^"]*)"\s*$/.exec(kv);
      if (e) params[e[1]] = e[2];
    }
    const realm = params.realm || `https://${host}/token/`;
    const url = new URL(realm);
    if (!url.searchParams.get('service')) url.searchParams.set('service', params.service || host);
    if (!url.searchParams.get('scope')) url.searchParams.set('scope', `repository:${repo}:pull`);
    const { json } = await fetchJson(url.toString(), {});
    token = json && (json.token || json.access_token);
    if (!token) throw new Error('仓库没给匿名 token：' + url.hostname);
  }

  async function getJson(url, accept, challenge) {
    const hdr = {};
    if (accept) hdr.Accept = accept;
    if (token) hdr.Authorization = 'Bearer ' + token;
    try {
      return await fetchJson(url, hdr);
    } catch (e) {
      if (e.statusCode !== 401) throw e;
      await authorize(challenge || e.headers['www-authenticate']);
      hdr.Authorization = 'Bearer ' + token;
      return fetchJson(url, hdr);
    }
  }

  async function getBlob(url, dst, expect, challenge) {
    const hdr = {};
    if (token) hdr.Authorization = 'Bearer ' + token;
    try {
      return await download(url, hdr, dst, expect);
    } catch (e) {
      if (e.statusCode !== 401) throw e;
      await authorize(challenge || e.headers['www-authenticate']);
      hdr.Authorization = 'Bearer ' + token;
      return download(url, hdr, dst, expect);
    }
  }

  return {
    host, repo, tag,
    ref: () => `${host}/${repo}:${tag}`,
    async index() {
      return (await getJson(api(`manifests/${tag}`), MANIFEST_ACCEPTS.join(','))).json;
    },
    async manifest(digest) {
      return (await getJson(api(`manifests/${digest}`), MANIFEST_ACCEPTS.join(','))).json;
    },
    async config(digest) {
      return (await getJson(api(`blobs/${digest}`), 'application/vnd.oci.image.config.v1+json,application/octet-stream')).json;
    },
    blob(digest, dst) {
      return getBlob(api(`blobs/${digest}`), dst, digest);
    },
  };
}

const MANIFEST_ACCEPTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

/* ---------------- tar 打包 ---------------- */

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) return { name: rest, prefix };
  }
  throw new Error('路径太长放不进 tar 头：' + name);
}

// 只写 GNU/POSIX 用得着的那几个字段；mtime 固定，同代码同字节
function tarHeader(name, { size = 0, mode = 0o644, type = '0', mtime = 0 }) {
  const { name: n, prefix } = splitName(name);
  const h = Buffer.alloc(512);
  h.write(n, 0, 'binary');
  h.write(mode.toString(8).padStart(7, '0'), 100, 'binary');
  h.write('0000000', 108, 'binary'); // uid = root
  h.write('0000000', 116, 'binary'); // gid = root
  h.write(size.toString(8).padStart(11, '0'), 124, 'binary');
  h.write(Math.floor(mtime).toString(8).padStart(11, '0'), 136, 'binary');
  h.write('        ', 148, 'binary'); // chksum 先填空格
  h.write(type, 156, 'binary');
  h.write('ustar\0', 257, 'binary');
  h.write('00', 263, 'binary');
  if (prefix) h.write(prefix, 345, 'binary');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'binary');
  return h;
}

const ZERO_BLOCK = Buffer.alloc(512);

class TarWriter {
  constructor(stream) {
    this.out = stream;
    this.pax = null;
  }

  async write(buf) {
    if (this.out.write(buf)) return;
    await new Promise((r) => this.out.once('drain', r));
  }

  async entry(name, { mode, type, mtime, size, srcFile, srcBuf }) {
    await this.write(tarHeader(name, { size, mode, type, mtime }));
    if (type === '5' || size === 0) {
      return;
    }
    if (srcBuf) {
      await this.write(srcBuf);
    } else {
      const r = fs.createReadStream(srcFile, { highWaterMark: 1 << 20 });
      for (;;) {
        const chunk = r.read();
        if (chunk === null) {
          if (r.destroyed || r.readableEnded) break;
          await new Promise((res, rej) => {
            r.once('readable', res);
            r.once('end', res);
            r.once('error', rej);
          });
          continue;
        }
        await this.write(chunk);
      }
      r.destroy();
    }
    const pad = (512 - (size % 512)) % 512;
    if (pad) await this.write(Buffer.alloc(pad));
  }

  async dir(name, { mode = 0o755, mtime = 0 } = {}) {
    await this.entry(name.endsWith('/') ? name : name + '/', { mode, type: '5', mtime, size: 0 });
  }

  async file(name, absPath, { mode = 0o644, mtime = 0 } = {}) {
    const size = fs.statSync(absPath).size;
    if (!size) return this.entry(name, { mode, type: '0', mtime, size: 0 });
    await this.entry(name, { mode, type: '0', mtime, size, srcFile: absPath });
  }

  async buffer(name, buf, { mode = 0o644, mtime = 0 } = {}) {
    await this.entry(name, { mode, type: '0', mtime, size: buf.length, srcBuf: buf });
  }

  async finish() {
    await this.write(ZERO_BLOCK);
    await this.write(ZERO_BLOCK);
  }
}

/* ---------------- tar 解包（只用于自校验） ---------------- */

class TarReader {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.pos = 0;
    this.buf = Buffer.alloc(1 << 20);
  }

  read(n) {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const r = fs.readSync(this.fd, out, off, Math.min(this.buf.length, n - off), this.pos + off);
      if (r === 0) break;
      off += r;
    }
    this.pos += off;
    return out.subarray(0, off);
  }

  skip(n) {
    this.pos += n;
  }

  // 顺序遍历成员，边读边算 sha256，payload 不整体进内存
  async each(onMember) {
    for (;;) {
      const h = this.read(512);
      if (h.length < 512) break;
      if (h.every((b) => b === 0)) {
        // 结尾可能还有第二个零块
        const h2 = this.read(512);
        if (h2.length && !h2.every((b) => b === 0)) throw new Error('tar 结构异常：零块之后还有内容');
        break;
      }
      const name = cstr(h.subarray(0, 100));
      const mode = parseInt(oct(h.subarray(100, 108)), 8);
      const size = parseInt(oct(h.subarray(124, 136)), 8);
      const type = String.fromCharCode(h[156] || 48);
      const prefix = cstr(h.subarray(345, 500));
      const want = parseInt(oct(h.subarray(148, 156)) || '0', 8);
      h.fill(32, 148, 156);
      let sum = 0;
      for (const b of h) sum += b;
      const full = prefix ? prefix + '/' + name : name;
      let hash = null;
      if (size) {
        const cr = crypto.createHash('sha256');
        let left = size;
        while (left > 0) {
          const c = this.read(Math.min(this.buf.length, left));
          if (!c.length) throw new Error(`成员 ${full} 数据不全`);
          cr.update(c);
          left -= c.length;
        }
        hash = cr.digest('hex');
      }
      const pad = (512 - (size % 512)) % 512;
      if (pad) this.skip(pad);
      await onMember({ name: full, size, mode, type, hash, chksumOk: sum === want });
    }
  }

  close() { fs.closeSync(this.fd); }
}

function cstr(b) {
  const z = b.indexOf(0);
  return b.subarray(0, z < 0 ? b.length : z).toString('utf8');
}
function oct(b) {
  return b.toString('binary').replace(/[^0-7]/g, '').trim();
}

/* ---------------- 应用层 ---------------- */

const IGNORE = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

function listCopy(srcRoot, arcName) {
  const out = [{ arc: arcName + '/', dir: true, abs: srcRoot }];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs).sort()) {
      if (IGNORE.has(e) || e === 'node_modules') continue;
      const childRel = rel ? rel + '/' + e : e;
      const childAbs = path.join(abs, e);
      if (fs.statSync(childAbs).isDirectory()) {
        out.push({ arc: `${arcName}/${childRel}/`, dir: true, abs: childAbs });
        walk(childAbs, childRel);
      } else {
        out.push({ arc: `${arcName}/${childRel}`, abs: childAbs });
      }
    }
  };
  walk(srcRoot, '');
  return out;
}

function appLayerFiles() {
  const entries = [
    { arc: 'app/', dir: true, abs: ROOT },
    { arc: 'app/package.json', abs: path.join(ROOT, 'package.json') },
  ];
  for (const p of ['server', 'public']) {
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) die(`项目里缺 ${p}/，是不是在项目根目录跑的？`);
    entries.push(...listCopy(abs, 'app/' + p));
  }
  // Dockerfile 里 RUN mkdir -p /data && chmod 700 /data 的效果，手工补一个目录项
  entries.push({ arc: 'data/', dir: true, mode: 0o700, abs: ROOT });
  const seen = new Set();
  const files = [];
  for (const e of entries) {
    if (seen.has(e.arc)) continue;
    seen.add(e.arc);
    files.push(e);
  }
  files.sort((a, b) => (a.arc < b.arc ? -1 : a.arc > b.arc ? 1 : 0));
  return files;
}

async function buildAppLayer(dst) {
  const files = appLayerFiles();
  const out = fs.createWriteStream(dst);
  const t = new TarWriter(out);
  for (const f of files) {
    if (f.dir) await t.dir(f.arc, { mode: f.mode || 0o755 });
    else await t.file(f.arc, f.abs, { mode: 0o644 });
  }
  await t.finish();
  // finish() 只写了两块收尾的零块，流还开着；不 end() 就永远等不到 close，进程会静默退出
  await new Promise((res, rej) => {
    out.on('error', rej);
    out.on('close', res);
    out.end();
  });
  const digest = sha256OfFile(dst);
  return { digest, size: fs.statSync(dst).size, files };
}

function sha256OfFile(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(1 << 20);
  for (;;) {
    const n = fs.readSync(fd, b, 0, b.length, null);
    if (n <= 0) break;
    h.update(b.subarray(0, n));
  }
  fs.closeSync(fd);
  return h.digest('hex');
}

/* ---------------- 镜像配置 ---------------- */

// Dockerfile 里那几条指令按同样顺序落到 config 上
const APP_ENV = { NODE_ENV: 'production', PORT: '8080', DATA_DIR: '/data' };
const HEALTHCHECK = {
  Test: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://127.0.0.1:\'+(process.env.PORT||8080)+\'/api/health\',r=>process.exit(r.statusCode===200?0:1)).on(\'error\',()=>process.exit(1))"'],
  Interval: 60000000000,
  Timeout: 50000000000,
  Retries: 3,
  StartPeriod: 15000000000,
};

function buildImageConfig(baseCfg, baseManifest, appDiffId, stampIso) {
  const b = baseCfg.config || {};
  const env = Array.isArray(b.Env) ? b.Env.slice() : [];
  for (const [k, v] of Object.entries(APP_ENV)) {
    const i = env.findIndex((e) => e.split('=')[0] === k);
    if (i >= 0) env[i] = `${k}=${v}`;
    else env.push(`${k}=${v}`);
  }
  const cfg = {
    Hostname: '',
    Domainname: '',
    User: b.User || '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: env,
    Cmd: ['node', 'server/index.js'],
    Healthcheck: HEALTHCHECK,
    Entrypoint: b.Entrypoint || null,
    Image: baseCfg.digest || null,
    Volumes: b.Volumes || null,
    WorkingDir: '/app',
    ExposedPorts: Object.assign({ '8080/tcp': {} }, b.ExposedPorts || {}),
    Labels: b.Labels || {},
  };
  const history = Array.isArray(baseCfg.history) ? baseCfg.history.slice() : [];
  history.push({
    created: stampIso,
    created_by: 'COPY package.json server/ public/ /app/ ; RUN mkdir -p /data && chmod 700 /data',
    empty_layer: false,
  });
  return {
    architecture: baseManifest.architecture || baseCfg.architecture,
    variant: baseManifest.variant || baseCfg.variant || undefined,
    os: baseManifest.os || baseCfg.os || 'linux',
    config: cfg,
    rootfs: { type: 'layers', diff_ids: [...(baseCfg.rootfs?.diff_ids || []), 'sha256:' + appDiffId] },
    history,
    created: stampIso,
  };
}

/* ---------------- 组装 docker load 包 ---------------- */

async function writeSaveTar({ dstGz, cfgBuf, cfgHex, layers, repoTag }) {
  const out = fs.createWriteStream(dstGz);
  const gz = zlib.createGzip({ level: ARG.gzip });
  out.on('error', (e) => warn('写出错：' + e.message));
  const t = new TarWriter(gz);
  gz.pipe(out);

  await t.buffer(`${cfgHex}.json`, cfgBuf, { mode: 0o600 });
  for (const l of layers) await t.file(`${l.digest}/layer.tar`, l.file, { mode: 0o600 });

  const manifest = [{
    Config: `${cfgHex}.json`,
    RepoTags: [repoTag],
    Layers: layers.map((l) => `${l.digest}/layer.tar`),
  }];
  await t.buffer('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'), { mode: 0o600 });
  const repos = {};
  repos[repoTag.split(':')[0]] = { [repoTag.split(':')[1] || 'latest']: cfgHex };
  await t.buffer('repositories', Buffer.from(JSON.stringify(repos) + '\n', 'utf8'), { mode: 0o600 });

  await t.finish();
  await new Promise((res, rej) => {
    gz.end();
    gz.on('finish', () => {
      if (out.writableEnded || out.destroyed) res();
      else out.on('close', res);
    });
    gz.on('error', rej);
    out.on('error', rej);
  });
}

/* ---------------- 自校验 ---------------- */

async function verifyPackage({ pkg, cfgHex, cfgJson, repoTag, appLayerFile, appFiles, baseCfg }) {
  const problems = [];

  // 先把 gzip 解开落成临时 tar，再顺序扫一遍（150MB 级别，不进内存）
  const tmp = pkg + '.check.tar';
  await new Promise((res, rej) => {
    const w = fs.createWriteStream(tmp);
    w.on('error', rej);
    w.on('close', res);
    fs.createReadStream(pkg).pipe(zlib.createGunzip()).pipe(w);
  });

  const members = new Map();
  const layerOrder = [];
  const tr = new TarReader(tmp);
  await tr.each((m) => {
    members.set(m.name, m);
    if (!m.chksumOk) problems.push(`头校验和不对：${m.name}`);
    const mm = /^([0-9a-f]{64})\/layer\.tar$/.exec(m.name);
    if (mm) layerOrder.push({ hex: mm[1], hash: m.hash, size: m.size });
  });
  tr.close();

  // config 的文件名必须真等于它自己的 sha256，否则 docker 认成的镜像 ID 就不是它
  const cfgMember = members.get(`${cfgHex}.json`);
  if (!cfgMember) problems.push('包里找不到 manifest 指的那个 config json');
  else if (cfgMember.hash !== cfgHex) problems.push(`config 内容 sha256 与文件名不符：${cfgMember.hash}`);

  // manifest.json 引用的每个成员都要在包里，且层顺序与 diff_ids 对齐
  const manifestBuf = readTarMember(tmp, 'manifest.json');
  if (!manifestBuf) problems.push('包里缺 manifest.json');
  let mres = null;
  try { mres = JSON.parse(manifestBuf.toString('utf8'))[0]; } catch (e) { problems.push('manifest.json 解析失败：' + e.message); }

  if (mres) {
    if (mres.Config !== `${cfgHex}.json`) problems.push('manifest.Config 指错了 config');
    if (!mres.RepoTags || !mres.RepoTags.includes(repoTag)) problems.push('manifest.RepoTags 缺 ' + repoTag);
    for (const p of mres.Layers) {
      if (!members.get(p)) problems.push('manifest 引用的层不在包里：' + p);
    }
    if (mres.Layers.length !== cfgJson.rootfs.diff_ids.length) {
      problems.push(`层数与 diff_ids 不一致：${mres.Layers.length} vs ${cfgJson.rootfs.diff_ids.length}`);
    }
    mres.Layers.forEach((p, i) => {
      const hex = /^([0-9a-f]{64})\//.exec(p);
      const want = hexOf(cfgJson.rootfs.diff_ids[i]);
      if (!hex || hex[1] !== want) problems.push(`第 ${i + 1} 层目录名 ${hex && hex[1]} ≠ diff_id ${want}`);
      const got = layerOrder.find((l) => l.hex === want);
      if (got && got.hash !== want) problems.push(`第 ${i + 1} 层内容 sha256 ${got.hash.slice(0, 12)}… ≠ diff_id ${want.slice(0, 12)}…`);
    });
  }

  // 未压缩层数量要和基础镜像一致，diff_ids 前缀要完全照抄官方 config
  const baseDiff = (baseCfg.rootfs && baseCfg.rootfs.diff_ids) || [];
  baseDiff.forEach((d, i) => {
    if (cfgJson.rootfs.diff_ids[i] !== d) problems.push(`基础层 ${i + 1} 的 diff_id 被改动了`);
  });

  // 非空 history 条目数要跟 diff_ids 对齐，否则 docker 会抱怨
  const nonEmpty = (cfgJson.history || []).filter((h) => !h.empty_layer).length;
  if (nonEmpty !== cfgJson.rootfs.diff_ids.length) {
    problems.push(`history 非空条目 ${nonEmpty} ≠ 层数 ${cfgJson.rootfs.diff_ids.length}`);
  }

  // 应用层内容与磁盘上的文件逐个比对
  const appHex = sha256OfFile(appLayerFile);
  if ('sha256:' + appHex !== cfgJson.rootfs.diff_ids[cfgJson.rootfs.diff_ids.length - 1]) {
    problems.push('应用层 digest 与 diff_ids 末位不符');
  }
  const inTar = new Map();
  const tr4 = new TarReader(appLayerFile);
  await tr4.each((m) => inTar.set(m.name, m));
  tr4.close();
  for (const f of appFiles) {
    const m = inTar.get(f.arc);
    if (!m) { problems.push('应用层少了：' + f.arc); continue; }
    if (f.dir) {
      if (m.type !== '5') problems.push('应为目录：' + f.arc);
      if (f.mode && m.mode !== f.mode) problems.push(`${f.arc} 权限 ${m.mode.toString(8)} ≠ ${f.mode.toString(8)}`);
    } else {
      if (m.size !== fs.statSync(f.abs).size) problems.push(`${f.arc} 字节数与磁盘上不一致`);
    }
  }

  fs.rmSync(tmp, { force: true });
  return problems;
}

function readTarMember(file, wantName) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 0;
    const h = Buffer.alloc(512);
    for (;;) {
      if (fs.readSync(fd, h, 0, 512, pos) < 512) return null;
      if (h.every((b) => b === 0)) return null;
      const name = cstr(h.subarray(0, 100));
      const prefix = cstr(h.subarray(345, 500));
      const size = parseInt(oct(h.subarray(124, 136)), 8) || 0;
      const full = prefix ? prefix + '/' + name : name;
      const dataStart = pos + 512;
      if (full === wantName) {
        const body = Buffer.alloc(size);
        let off = 0;
        while (off < size) off += fs.readSync(fd, body, off, size - off, dataStart + off);
        return body;
      }
      pos = dataStart + Math.ceil(size / 512) * 512;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- 主流程 ---------------- */

async function prepareBase(reg, arch, cacheDir) {
  const idx = await reg.index();
  const entry = (idx.manifests || []).find((m) => m.platform && m.platform.architecture === arch && m.platform.os === 'linux');
  if (!entry) throw new Error(`${reg.ref()} 里没有 linux/${arch}`);
  const manifest = (await reg.manifest(entry.digest));
  if (!manifest.layers || !manifest.config) throw new Error('基础镜像 manifest 里没有 layers/config');
  const baseCfg = await reg.config(manifest.config.digest);

  const out = [];
  for (let i = 0; i < manifest.layers.length; i++) {
    const l = manifest.layers[i];
    const want = (baseCfg.rootfs && baseCfg.rootfs.diff_ids[i]) || null;
    if (!want) throw new Error(`基础镜像 config 里没有第 ${i + 1} 层的 diff_id，没法核对`);
    const cKey = hexOf(l.digest);
    const uKey = hexOf(want);
    const gzPath = path.join(cacheDir, 'blobs', `${cKey}.gz`);
    const tarPath = path.join(cacheDir, 'blobs', `${uKey}.tar`);
    fs.mkdirSync(path.dirname(gzPath), { recursive: true });

    if (fs.existsSync(tarPath) && sha256OfFile(tarPath) === uKey) {
      log(`  基础层 ${i + 1}/${manifest.layers.length} 用缓存（${MB(fs.statSync(tarPath).size)}）`);
    } else {
      fs.rmSync(tarPath, { force: true });
      if (!(fs.existsSync(gzPath) && sha256OfFile(gzPath) === cKey)) {
        log(`  下载基础层 ${i + 1}/${manifest.layers.length}（${MB(l.size || 0)}）`);
        await reg.blob(l.digest, gzPath);
      }
      if (!/gzip$/.test(l.mediaType || '')) {
        // 未压缩层直接照搬，diff_id 就等于 blob digest
        const r = await hashAndTee(gzPath, tarPath);
        if (r.digest !== uKey) throw new Error(`第 ${i + 1} 层未压缩 digest 不符`);
      } else {
        await gunzipFile(gzPath, tarPath);
        const got = sha256OfFile(tarPath);
        if (got !== uKey) {
          fs.rmSync(tarPath, { force: true });
          throw new Error(`第 ${i + 1} 层解开后 sha256 ${got.slice(0, 16)}… 与官方 diff_id ${uKey.slice(0, 16)}… 不一致`);
        }
      }
      log(`  ✓ 第 ${i + 1} 层与官方 diff_id 对上（未压缩 ${MB(fs.statSync(tarPath).size)}）`);
    }
    out.push({ digest: uKey, file: tarPath, size: fs.statSync(tarPath).size });
  }
  return { manifest, baseCfg, entry, layers: out };
}

async function buildOne(arch) {
  const cacheDir = path.resolve(ROOT, ARG.cache);
  const outDir = path.resolve(ROOT, ARG.out);
  fs.mkdirSync(path.join(cacheDir, 'blobs'), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const bases = ARG.base.split(',').map((s) => s.trim()).filter(Boolean);
  const bErr = [];
  let reg = null;
  let base = null;
  for (const b of bases) {
    try {
      const r = makeRegistry(b);
      log(`基础镜像 ${r.ref()} → linux/${arch}`);
      base = await prepareBase(r, arch, cacheDir);
      reg = r;
      break;
    } catch (e) {
      bErr.push(`${b}: ${e.message}`);
      warn(`这个源不行（${b}）：${e.message}`);
    }
  }
  if (!base) die('所有基础镜像源都没拿到：\n  ' + bErr.join('\n  '));

  // 仓库里同一 tag 会随时间更新，记下来源 digest 免得下次以为还是它
  const stampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  log('打应用层（package.json + server/ + public/ + /data）');
  const appLayerFile = path.join(cacheDir, `app-layer-${ARG.tag}-${arch}.tar`);
  const app = await buildAppLayer(appLayerFile);
  log(`  应用层 ${app.files.length} 项、${MB(app.size)}，sha256 ${app.digest.slice(0, 16)}…`);

  const cfg = buildImageConfig(base.baseCfg, base.manifest, app.digest, stampIso);
  if (!cfg.architecture) die('没拿到基础镜像的 architecture');
  const cfgBuf = Buffer.from(JSON.stringify(cfg), 'utf8');
  const cfgHex = sha256Buf(cfgBuf);

  const layers = [...base.layers, { digest: app.digest, file: appLayerFile, size: app.size }];
  const repoTag = `${ARG.image}:${ARG.tag}`;
  const file = path.join(outDir, `nasphere-${ARG.tag}-linux-${arch}.tar.gz`);

  log(`拼镜像包 ${path.relative(ROOT, file)}（gzip -${ARG.gzip}，${layers.length} 层、约 ${MB(layers.reduce((a, l) => a + l.size, 0))}）`);
  await writeSaveTar({ dstGz: file, cfgBuf, cfgHex, layers, repoTag });
  const size = fs.statSync(file).size;
  ok(`${path.relative(ROOT, file)}  ${MB(size)}`);

  const sum = sha256OfFile(file);
  fs.writeFileSync(file + '.sha256', `${sum}  ${path.basename(file)}\n`);
  log(`校验值已写 ${path.relative(ROOT, file)}.sha256`);

  log('自校验包结构');
  const problems = await verifyPackage({
    pkg: file, cfgHex, cfgJson: cfg, repoTag,
    appLayerFile, appFiles: app.files, baseCfg: base.baseCfg,
  });
  if (problems.length) {
    for (const p of problems) warn('  ' + p);
    die('自校验没通过，这个包别往 NAS 上传');
  }
  ok('  包结构、层 digest、history、应用层内容全部对得上');

  if (!ARG.keepCache) {
    for (const l of layers) if (l.file.startsWith(cacheDir) && l.file.endsWith(`app-layer-${ARG.tag}-${arch}.tar`)) fs.rmSync(l.file, { force: true });
  }
  return { file, size, sum, repoTag, arch, baseRef: reg.ref(), baseDigest: base.entry.digest, cfgHex };
}

async function main() {
  if (ARG.help) { usage(); return; }
  if (!fs.existsSync(path.join(ROOT, 'Dockerfile'))) die('请在项目根目录跑（没找到 Dockerfile）');
  const done = [];
  for (const a of ARG.arches) {
    process.stdout.write(`\n=== linux/${a} ===\n`);
    done.push(await buildOne(a));
  }
  process.stdout.write('\n产物：\n');
  for (const d of done) {
    process.stdout.write(`  linux/${d.arch.padEnd(5)} ${path.relative(ROOT, d.file)}  ${MB(d.size)}\n`);
    process.stdout.write(`           RepoTags=${d.repoTag}  镜像 ID=${d.cfgHex.slice(0, 12)}\n`);
  }
  process.stdout.write(`\n传到 NAS 后在 NAS 的项目目录里：\n  ./deploy.sh --tar dist/nasphere-${ARG.tag}-linux-amd64.tar.gz\n\n校验：sha256sum -c dist/*.sha256\n基础镜像缓存留在 ${ARG.cache}/，删掉即可重新拉。\n`);
}

main().catch((e) => die((e && e.stack) || String(e)));
