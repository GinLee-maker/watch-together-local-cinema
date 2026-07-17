'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.PORT = '0';
process.env.DATA_DIR = path.join(__dirname, '.test-data');
process.env.HOST_TOKEN = 'test-host-token';
process.env.ROOM_TOKEN = 'test-room-token';

const { server, isIphoneCompatible, parseDuration, effectiveTimeline } = require('../server');

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

async function baseUrl() {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('recognizes Safari-friendly containers', () => {
  assert.equal(isIphoneCompatible('movie.mp4'), true);
  assert.equal(isIphoneCompatible('movie.MOV'), true);
  assert.equal(isIphoneCompatible('movie.mkv'), false);
});

test('parses FFmpeg duration output', () => {
  assert.equal(parseDuration('Duration: 02:03:04.50, start: 0.0'), 7384.5);
  assert.equal(parseDuration('no duration'), 0);
});

test('returns a well-formed effective timeline', () => {
  const timeline = effectiveTimeline();
  assert.equal(typeof timeline.mediaTime, 'number');
  assert.equal(typeof timeline.paused, 'boolean');
  assert.equal(typeof timeline.updatedAt, 'number');
});

test('protects host APIs and streams byte ranges', async () => {
  const base = await baseUrl();
  const denied = await fetch(`${base}/api/host-room`);
  assert.equal(denied.status, 403);

  const roomResponse = await fetch(`${base}/api/host-room`, { headers: { 'x-host-token': 'test-host-token' } });
  assert.deepEqual(await roomResponse.json(), { roomToken: 'test-room-token' });

  const form = new FormData();
  form.append('movie', new Blob(['fake-video-bytes']), 'sample.mp4');
  const upload = await fetch(`${base}/api/host/upload`, {
    method: 'POST',
    headers: { 'x-host-token': 'test-host-token' },
    body: form
  });
  assert.equal(upload.status, 200);

  const range = await fetch(`${base}/media/test-room-token/source`, { headers: { range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-3/16');
  assert.equal(await range.text(), 'fake');
});
