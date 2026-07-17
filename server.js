'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'converted');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 ** 3);

for (const directory of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      roomToken: process.env.ROOM_TOKEN || parsed.roomToken || randomToken(),
      hostToken: process.env.HOST_TOKEN || parsed.hostToken || randomToken(),
      movie: parsed.movie || null,
      timeline: { mediaTime: 0, paused: true, rate: 1, updatedAt: Date.now() },
      transcode: { status: 'idle', progress: 0, speed: null, error: null }
    };
  } catch {
    return {
      roomToken: process.env.ROOM_TOKEN || randomToken(),
      hostToken: process.env.HOST_TOKEN || randomToken(),
      movie: null,
      timeline: { mediaTime: 0, paused: true, rate: 1, updatedAt: Date.now() },
      transcode: { status: 'idle', progress: 0, speed: null, error: null }
    };
  }
}

let state = readState();
let transcodeProcess = null;
let transcodeDuration = 0;

function persistState() {
  const safe = {
    roomToken: state.roomToken,
    hostToken: state.hostToken,
    movie: state.movie
  };
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(safe, null, 2));
  fs.renameSync(temp, STATE_FILE);
}

function extname(name) {
  return path.extname(name || '').toLowerCase();
}

function isIphoneCompatible(name) {
  return ['.mp4', '.m4v', '.mov'].includes(extname(name));
}

function publicState() {
  const movie = state.movie
    ? {
        name: state.movie.originalName,
        size: state.movie.size,
        uploadedAt: state.movie.uploadedAt,
        sourceAvailable: fs.existsSync(state.movie.sourcePath),
        iphoneAvailable: Boolean(state.movie.transcodedPath && fs.existsSync(state.movie.transcodedPath)),
        sourceCompatibleWithIphone: isIphoneCompatible(state.movie.originalName),
        version: state.movie.version
      }
    : null;

  return {
    movie,
    transcode: state.transcode,
    timeline: effectiveTimeline(),
    viewerCount: io ? [...io.sockets.sockets.values()].filter((s) => s.data.role === 'viewer').length : 0
  };
}

function effectiveTimeline() {
  const timeline = { ...state.timeline };
  if (!timeline.paused) {
    timeline.mediaTime += ((Date.now() - timeline.updatedAt) / 1000) * timeline.rate;
    timeline.updatedAt = Date.now();
  }
  return timeline;
}

function setTimeline(input) {
  const mediaTime = Number(input.mediaTime);
  const rate = Number(input.rate || 1);
  if (!Number.isFinite(mediaTime) || mediaTime < 0 || !Number.isFinite(rate) || rate <= 0 || rate > 4) {
    return false;
  }
  state.timeline = {
    mediaTime,
    paused: Boolean(input.paused),
    rate,
    updatedAt: Date.now()
  };
  return true;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

function tokenFromRequest(req) {
  return req.get('x-room-token') || req.query.room || req.params.token;
}

function requireRoom(req, res, next) {
  if (tokenFromRequest(req) !== state.roomToken) {
    return res.status(403).json({ error: '分享链接无效或已经更换。' });
  }
  next();
}

function requireHost(req, res, next) {
  const token = req.get('x-host-token') || req.query.host || req.params.token;
  if (token !== state.hostToken) {
    return res.status(403).json({ error: '需要主机权限。' });
  }
  next();
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const extension = extname(file.originalname).slice(0, 12);
    callback(null, `${Date.now()}-${randomToken(8)}${extension}`);
  }
});

const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

app.get('/', (_req, res) => res.redirect(`/host/${state.hostToken}`));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get(['/host/:token', '/watch/:token'], (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.get('/api/state', requireRoom, (req, res) => {
  res.json({ ...publicState(), isHost: req.get('x-host-token') === state.hostToken });
});

app.get('/api/host-room', requireHost, (_req, res) => {
  res.json({ roomToken: state.roomToken });
});

app.post('/api/host/upload', requireHost, upload.single('movie'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到电影文件。' });

  if (transcodeProcess) {
    transcodeProcess.kill();
    transcodeProcess = null;
  }

  const previous = state.movie;
  state.movie = {
    originalName: req.file.originalname,
    size: req.file.size,
    sourcePath: req.file.path,
    transcodedPath: null,
    uploadedAt: new Date().toISOString(),
    version: randomToken(8)
  };
  state.timeline = { mediaTime: 0, paused: true, rate: 1, updatedAt: Date.now() };
  state.transcode = { status: 'idle', progress: 0, speed: null, error: null };
  persistState();

  if (previous) {
    for (const oldPath of [previous.sourcePath, previous.transcodedPath]) {
      if (oldPath && oldPath !== req.file.path) fs.rm(oldPath, { force: true }, () => {});
    }
  }

  io.emit('state', publicState());
  res.json(publicState());
});

function parseDuration(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function startTranscode(quality) {
  const source = state.movie.sourcePath;
  const destination = path.join(OUTPUT_DIR, `${state.movie.version}-${quality}.mp4`);
  const temporary = `${destination}.part.mp4`;
  const scale = quality === 'original'
    ? []
    : ['-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"];
  const args = [
    '-y', '-i', source,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...scale,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', temporary
  ];

  state.transcode = { status: 'running', progress: 0, speed: null, error: null, quality };
  transcodeDuration = 0;
  io.emit('state', publicState());

  const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
  transcodeProcess = child;
  let progressBuffer = '';
  let errorBuffer = '';

  child.stdout.on('data', (chunk) => {
    progressBuffer += chunk.toString();
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() || '';
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'out_time_us' && transcodeDuration > 0) {
        state.transcode.progress = Math.min(99, Math.max(0, Math.round((Number(value) / 1e6 / transcodeDuration) * 100)));
      }
      if (key === 'speed') state.transcode.speed = value;
      if (key === 'progress') io.emit('transcode', state.transcode);
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    errorBuffer = `${errorBuffer}${text}`.slice(-12000);
    if (!transcodeDuration) transcodeDuration = parseDuration(errorBuffer);
  });

  child.on('error', (error) => {
    transcodeProcess = null;
    fs.rm(temporary, { force: true }, () => {});
    state.transcode = {
      status: 'error', progress: 0, speed: null,
      error: error.code === 'ENOENT' ? '未找到 FFmpeg。请先运行 setup-windows.ps1，或安装 FFmpeg 后重试。' : error.message
    };
    io.emit('state', publicState());
  });

  child.on('close', (code) => {
    if (transcodeProcess !== child) return;
    transcodeProcess = null;
    if (code === 0 && fs.existsSync(temporary)) {
      fs.renameSync(temporary, destination);
      if (state.movie.transcodedPath && state.movie.transcodedPath !== destination) {
        fs.rm(state.movie.transcodedPath, { force: true }, () => {});
      }
      state.movie.transcodedPath = destination;
      state.movie.version = randomToken(8);
      state.transcode = { status: 'done', progress: 100, speed: null, error: null, quality };
      persistState();
    } else if (state.transcode.status === 'running') {
      fs.rm(temporary, { force: true }, () => {});
      state.transcode = {
        status: 'error', progress: 0, speed: null,
        error: `转码失败（FFmpeg 退出码 ${code}）。请确认文件包含可读取的视频轨道。`
      };
    }
    io.emit('state', publicState());
  });
}

app.post('/api/host/transcode', requireHost, (req, res) => {
  if (!state.movie || !fs.existsSync(state.movie.sourcePath)) {
    return res.status(400).json({ error: '请先选择电影。' });
  }
  if (transcodeProcess) return res.status(409).json({ error: '转码已经在进行中。' });
  const quality = req.body.quality === 'original' ? 'original' : '1080p';
  startTranscode(quality);
  res.status(202).json({ ok: true });
});

app.post('/api/host/transcode/cancel', requireHost, (_req, res) => {
  if (!transcodeProcess) return res.json({ ok: true });
  const child = transcodeProcess;
  transcodeProcess = null;
  state.transcode = { status: 'idle', progress: 0, speed: null, error: null };
  child.kill();
  io.emit('state', publicState());
  res.json({ ok: true });
});

function streamFile(req, res, filePath, contentType) {
  if (!filePath || !fs.existsSync(filePath)) return res.sendStatus(404);
  const size = fs.statSync(filePath).size;
  const range = req.headers.range;
  res.set({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Type': contentType });

  if (!range) {
    res.set('Content-Length', size);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) return res.status(416).set('Content-Range', `bytes */${size}`).end();
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return res.status(416).set('Content-Range', `bytes */${size}`).end();
  }
  res.status(206).set({
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get('/media/:token/source', requireRoom, (req, res) => {
  if (!state.movie) return res.sendStatus(404);
  const types = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
  streamFile(req, res, state.movie.sourcePath, types[extname(state.movie.originalName)] || 'application/octet-stream');
});

app.get('/media/:token/iphone', requireRoom, (req, res) => {
  streamFile(req, res, state.movie && state.movie.transcodedPath, 'video/mp4');
});

io.use((socket, next) => {
  const { roomToken, hostToken } = socket.handshake.auth || {};
  if (roomToken !== state.roomToken) return next(new Error('invalid room'));
  socket.data.role = hostToken === state.hostToken ? 'host' : 'viewer';
  next();
});

io.on('connection', (socket) => {
  socket.emit('state', publicState());
  io.emit('audience', publicState().viewerCount);

  socket.on('timeline', (timeline) => {
    if (socket.data.role !== 'host' || !setTimeline(timeline || {})) return;
    socket.broadcast.emit('timeline', effectiveTimeline());
  });

  socket.on('request-sync', () => socket.emit('timeline', effectiveTimeline()));
  socket.on('disconnect', () => io.emit('audience', publicState().viewerCount));
});

app.use((error, _req, res, _next) => {
  if (error && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '电影文件超过服务器允许的大小。' });
  }
  console.error(error);
  res.status(500).json({ error: '服务器处理请求时发生错误。' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n本地影院已启动： http://localhost:${PORT}/host/${state.hostToken}`);
  console.log(`观影链接（同一局域网或建立公网隧道后使用）： /watch/${state.roomToken}\n`);
});

function shutdown() {
  if (transcodeProcess) transcodeProcess.kill();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, effectiveTimeline, isIphoneCompatible, parseDuration };
