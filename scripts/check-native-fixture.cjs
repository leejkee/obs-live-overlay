'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createMonitor } = require('../native/index.cjs');
const executable = path.resolve(__dirname, '../build/native/Release/smtc_fixture.exe');
assert.ok(fs.existsSync(executable), '先运行 npm run build:native:fixture');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smtc-fixture-'));
const audio = path.join(temporary, 'silence.wav');
const pcm = Buffer.alloc(8000 * 60 + 44, 128);
pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(8000, 28); pcm.writeUInt16LE(1, 32); pcm.writeUInt16LE(8, 34);
pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40); fs.writeFileSync(audio, pcm);
const title = `SMTC fixture ${randomUUID()}`;
const events = [];
const monitor = createMonitor(event => events.push(event));
let fixture;
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(25); }
  throw new Error(message);
}
(async () => {
  try {
    await monitor.start();
    fixture = spawn(executable, [audio, title], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = ''; fixture.stderr.on('data', chunk => { stderr += chunk; });
    fixture.on('error', error => { stderr += error.message; });
    const session = await until(() => monitor.getState().sessions.find(s => s.media?.title === title), '未发现测试媒体会话');
    const id = session.sessionId;
    const state = () => monitor.getState().sessions.find(s => s.sessionId === id);
    await monitor.setTimelineTracking(id);
    assert.equal('control' in monitor, false);
    for (const [action, expected] of [['pause', 'paused'], ['play', 'playing']]) {
      fixture.stdin.write(`${action}\n`);
      await until(() => state()?.playback?.status === expected, `${action} 后未观察到状态变化`);
    }
    fixture.stdin.write('track\n');
    await until(() => state()?.media?.title === `${title} changed` && state()?.media?.trackNumber === 1, '未观察到播放器切歌');
    fixture.stdin.write('position\n');
    await until(() => state()?.timeline?.positionMs === 5000, '未观察到播放器进度变化');
    const exited = once(fixture, 'exit'); fixture.stdin.end('stop\n'); await exited;
    await until(() => !state(), '测试播放器退出后会话未移除');
    await assert.rejects(monitor.refresh(id, 'media'), { code: 'ERR_SMTC_STALE_SESSION' });
    assert.equal(stderr, '');
    // An actual oversized WinRT thumbnail stream must fail before allocating its bytes.
    const width = 1300, height = 1100, size = 54 + width * height * 3;
    const bitmap = Buffer.alloc(size);
    bitmap.write('BM', 0); bitmap.writeUInt32LE(size, 2); bitmap.writeUInt32LE(54, 10);
    bitmap.writeUInt32LE(40, 14); bitmap.writeInt32LE(width, 18); bitmap.writeInt32LE(height, 22);
    bitmap.writeUInt16LE(1, 26); bitmap.writeUInt16LE(24, 28); bitmap.writeUInt32LE(size - 54, 34);
    const image = path.join(temporary, 'oversized.bmp'); fs.writeFileSync(image, bitmap);
    const largeTitle = `${title} large`;
    fixture = spawn(executable, [audio, largeTitle, image], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    fixture.on('error', () => {}); fixture.stderr.resume(); fixture.stdout.resume();
    const large = await until(() => monitor.getState().sessions.find(s => s.media?.title === largeTitle && s.media.thumbnailId), '未发现超限封面测试会话');
    await assert.rejects(monitor.getThumbnail(large.sessionId, large.media.thumbnailId), { code: 'ERR_SMTC_OPERATION_FAILED' });
    console.log(JSON.stringify({ isolatedFixture: true, thumbnailLimit: true, observerOnly: true, events: [...new Set(events.map(e => e.type))] }));
  } finally {
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, 'exit');
      fixture.kill(); await exited;
    }
    await monitor.stop();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('smtc-fixture-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
