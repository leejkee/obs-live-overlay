import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createMonitorWithBackend, type Backend, type Message } from '../src/native/monitor.cts';

function fixture(limits = { timeoutMs: 500, requests: 128, events: 256 }) {
  let callback: (message: Message) => void;
  let serial = 0;
  let topology = { sessions: [{ sessionId: 's1', sourceAppUserModelId: 'raw-player-id' }], currentSessionId: 's1' as string | null };
  const requests: { id: number; op: string; session: string; arg: string }[] = [];
  const held = new Set<string>();
  const cancelled: number[] = [];
  const events: any[] = [];
  let closeCount = 0;
  let active = false;
  function result(id: number, data: unknown) { callback({ type: 'result', id, data }); }
  function respond(r: typeof requests[number]) {
    if (r.op === 'start' || r.op === 'sessions') result(r.id, structuredClone(topology));
    else if (r.op === 'media') result(r.id, { title: '原始标题', subtitle: '', artist: '', albumTitle: '', albumArtist: '', genres: ['raw'], trackNumber: 0, albumTrackCount: 0, thumbnailId: `t${++serial}` });
    else if (r.op === 'playback') result(r.id, { status: 'paused', playbackRate: null });
    else if (r.op === 'timeline') result(r.id, { startTimeMs: 0, endTimeMs: 1000, positionMs: 42, minSeekTimeMs: 0, maxSeekTimeMs: 1000, lastUpdatedTimeUtcMs: null, observedAtUtcMs: 1234 });
    else if (r.op === 'thumbnail') result(r.id, { thumbnailId: r.arg, contentType: 'image/png', data: Buffer.from([1, 2, 3]) });
    else result(r.id, null);
  }
  const monitor = createMonitorWithBackend(e => events.push(e), cb => {
    callback = cb;
    return {
      request(id, op, session, arg) {
        const r = { id, op, session, arg }; requests.push(r);
        if (!held.has(op)) setImmediate(() => respond(r));
      },
      cancel(id) { cancelled.push(id); },
      close() { closeCount++; setImmediate(() => callback({ type: 'closed' })); },
      ref(value) { active = value; },
    } satisfies Backend;
  }, limits);
  return { monitor, events, requests, held, cancelled, result,
    notify: (domain: Message['domain'], sessionId = 's1') => callback({ type: 'notify', domain, sessionId }),
    fail: (id: number, code = 'ERR_SMTC_OPERATION_FAILED') => callback({ type: 'result', id, error: { code, nativeCode: '0x80004005' } }),
    topology: (value: typeof topology) => { topology = value; },
    get closeCount() { return closeCount; }, get active() { return active; },
  };
}
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function ready(f: ReturnType<typeof fixture>) { await f.monitor.start(); await settle(); }

test('SMTC 启动基线、缓存复制、重复启停与 run 隔离', async t => {
  const f = fixture(); t.after(() => f.monitor.stop());
  const first = f.monitor.start(); assert.equal(f.monitor.start(), first);
  const baseline = await first;
  assert.equal(baseline.sessions[0].media, null); assert.equal(f.events.length, 0);
  await settle(); assert.equal(f.monitor.getState().sessions[0].media?.title, '原始标题');
  const copy = f.monitor.getState(); copy.sessions.length = 0;
  assert.equal(f.monitor.getState().sessions.length, 1);
  assert.ok(f.events.every(e => e.sequence > baseline.sequence)); assert.equal(f.active, false);
  const stop = f.monitor.stop(); assert.equal(f.monitor.stop(), stop);
  await assert.rejects(f.monitor.start(), { code: 'ERR_SMTC_SHUTTING_DOWN' });
  await stop; assert.equal(f.closeCount, 1);
  assert.notEqual((await f.monitor.start()).runId, baseline.runId);
});
test('SMTC 无会话时启动成功，current 必须属于同一拓扑', async t => {
  const f = fixture(); t.after(() => f.monitor.stop());
  f.topology({ sessions: [], currentSessionId: 'missing' });
  const state = await f.monitor.start(); assert.deepEqual(state.sessions, []); assert.equal(state.currentSessionId, null);
});
test('SMTC 同域在途读取合并，过期结果不提交', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f); f.held.add('media');
  const revision = f.monitor.getState().sessions[0].revisions.media;
  const refresh = f.monitor.refresh('s1', 'media'); const first = f.requests.at(-1)!;
  f.notify('media'); f.notify('media');
  const old = { ...f.monitor.getState().sessions[0].media!, title: '过期' };
  f.result(first.id, old); await tick();
  assert.equal(f.monitor.getState().sessions[0].revisions.media, revision);
  const second = f.requests.at(-1)!; assert.notEqual(second.id, first.id);
  f.result(second.id, { ...old, title: '最新' }); await refresh;
  assert.equal(f.monitor.getState().sessions[0].media?.title, '最新');
});
test('SMTC 同来源重建会话不会复用旧 ID，迟到读取结果无效', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f); f.held.add('media');
  const rejected = assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_STALE_SESSION' });
  const id = f.requests.at(-1)!.id;
  f.topology({ sessions: [{ sessionId: 's2', sourceAppUserModelId: 'raw-player-id' }], currentSessionId: 's2' });
  f.notify('sessions'); await settle(); await rejected; f.result(id, { title: '迟到结果' });
  await assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_STALE_SESSION' });
  assert.equal(f.monitor.getState().sessions[0].sessionId, 's2');
});
test('SMTC 只读接口与参数错误以 Promise reject 暴露', async t => {
  const f = fixture(); t.after(() => f.monitor.stop());
  await assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_NOT_STARTED' }); await ready(f);
  assert.equal('control' in f.monitor, false);
  await assert.rejects(f.monitor.refresh('s1', 'bad' as any), { code: 'ERR_SMTC_INVALID_ARGUMENT' });
});
test('SMTC 时间线顺序切换，首次绑定立即读取且不插值', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f);
  await Promise.all([f.monitor.setTimelineTracking('s1'), f.monitor.setTimelineTracking(null)]);
  assert.deepEqual(f.requests.filter(r => r.op === 'track').map(r => r.session), ['s1', '']);
  const state = f.monitor.getState(); assert.equal(state.trackedTimelineSessionId, null);
  assert.equal(state.sessions[0].timeline?.positionMs, 42); assert.equal(state.sessions[0].timeline?.lastUpdatedTimeUtcMs, null);
});
test('SMTC 封面请求合并、Buffer 独立、旧 token 失效', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f);
  const token = f.monitor.getState().sessions[0].media!.thumbnailId!;
  const [a, b] = await Promise.all([f.monitor.getThumbnail('s1', token), f.monitor.getThumbnail('s1', token)]);
  assert.equal(f.requests.filter(r => r.op === 'thumbnail').length, 1); a!.data[0] = 9; assert.equal(b!.data[0], 1);
  await f.monitor.refresh('s1', 'media');
  await assert.rejects(f.monitor.getThumbnail('s1', token), { code: 'ERR_SMTC_STALE_THUMBNAIL' });
});
test('SMTC 自动读取失败保留缓存并携带 HRESULT 诊断', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f);
  const previous = f.monitor.getState().sessions[0].media;
  f.held.add('media'); f.notify('media'); f.fail(f.requests.at(-1)!.id); await settle();
  assert.deepEqual(f.monitor.getState().sessions[0].media, previous);
  assert.ok(f.events.some(e => e.type === 'warning' && e.nativeCode === '0x80004005'));
});
test('SMTC 超时取消、迟到结果忽略、显式请求限流', async t => {
  const f = fixture({ timeoutMs: 40, requests: 2, events: 256 }); t.after(() => f.monitor.stop()); await ready(f); f.held.add('media'); f.held.add('playback');
  const results = Promise.all([
    assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_TIMEOUT' }),
    assert.rejects(f.monitor.refresh('s1', 'playback'), { code: 'ERR_SMTC_TIMEOUT' }),
  ]);
  await assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_BUSY' });
  await results; assert.equal(f.cancelled.length, 2);
  for (const id of f.cancelled) f.result(id, { title: '迟到结果' });
});
test('SMTC 停止取消在途调用且停止后无用户事件', async () => {
  const f = fixture(); await ready(f); f.held.add('media');
  const rejected = assert.rejects(f.monitor.refresh('s1', 'media'), { code: 'ERR_SMTC_ABORTED' });
  const count = f.events.length; const id = f.requests.at(-1)!.id;
  await f.monitor.stop(); await rejected; f.notify('media'); f.result(id, { title: '迟到结果' }); await settle();
  assert.equal(f.events.length, count);
});
test('SMTC 启动期间停止，启动 Promise 不悬挂', async () => {
  const f = fixture(); f.held.add('start');
  const started = assert.rejects(f.monitor.start(), { code: 'ERR_SMTC_ABORTED' }); await f.monitor.stop(); await started;
});
test('SMTC 背压使用递增 resync 快照，完成通道不丢失', async t => {
  const f = fixture({ timeoutMs: 500, requests: 128, events: 2 }); t.after(() => f.monitor.stop()); await ready(f); f.held.add('playback');
  for (let i = 0; i < 10; i++) {
    const refresh = f.monitor.refresh('s1', 'playback');
    f.result(f.requests.at(-1)!.id, { ...f.monitor.getState().sessions[0].playback!, status: 'playing' }); await refresh;
  }
  await settle(); const resync = [...f.events].reverse().find(e => e.type === 'resync'); assert.ok(resync);
  assert.equal(resync.sequence, resync.state.sequence);
  for (let i = 1; i < f.events.length; i++) assert.ok(f.events[i].sequence > f.events[i - 1].sequence);
});
test('SMTC 原生过期标记只触发补读，不进入公共缓存', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f); f.held.add('media');
  const previous = f.monitor.getState().sessions[0].media;
  const refresh = f.monitor.refresh('s1', 'media'); const first = f.requests.at(-1)!.id;
  f.result(first, { _smtcObsolete: true }); await tick();
  assert.deepEqual(f.monitor.getState().sessions[0].media, previous);
  assert.notEqual(f.requests.at(-1)!.id, first);
  f.result(f.requests.at(-1)!.id, { ...previous, title: '有效结果' }); await refresh;
  assert.equal(f.monitor.getState().sessions[0].media?.title, '有效结果');
});
test('SMTC 读取失败后的封面请求可以重试，空封面返回 null', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); await ready(f); f.held.add('thumbnail');
  const token = f.monitor.getState().sessions[0].media!.thumbnailId!;
  const failed = assert.rejects(f.monitor.getThumbnail('s1', token), { code: 'ERR_SMTC_OPERATION_FAILED' });
  f.fail(f.requests.at(-1)!.id); await failed;
  const retried = f.monitor.getThumbnail('s1', token); f.result(f.requests.at(-1)!.id, null);
  assert.equal(await retried, null); assert.equal(f.requests.filter(r => r.op === 'thumbnail').length, 2);
});
test('SMTC 已排队的时间线切换超时后不执行', async t => {
  const f = fixture({ timeoutMs: 40, requests: 128, events: 256 }); t.after(() => f.monitor.stop()); await ready(f); f.held.add('track');
  const first = assert.rejects(f.monitor.setTimelineTracking('s1'), { code: 'ERR_SMTC_TIMEOUT' });
  const second = assert.rejects(f.monitor.setTimelineTracking(null), { code: 'ERR_SMTC_TIMEOUT' });
  await Promise.all([first, second]); await settle();
  assert.equal(f.requests.filter(r => r.op === 'track').length, 1);
});
