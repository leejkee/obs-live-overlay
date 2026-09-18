import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMusicServer, selectMusicSession } from "../src/music-server.js";
import type { NativeMonitor, NativeState, SessionData } from "../native/index.cjs";

function session(id: string, source: string, status: "playing" | "paused" = "playing"): SessionData {
  return { sessionId: id, sourceAppUserModelId: source, media: null, playback: { status, playbackRate: 1 }, timeline: null, revisions: { media: 0, playback: 0, timeline: 0 } };
}
function state(sessions: SessionData[]): NativeState {
  return { runId: "test", sequence: 1, currentSessionId: "browser", trackedTimelineSessionId: null, sessions };
}
test("音乐优先 QQ 音乐，包括暂停状态；否则使用系统会话", () => {
  const browser = session("browser", "chrome");
  const qq = session("qq", "QQMusic.exe", "paused");
  assert.equal(selectMusicSession(state([browser, qq])), qq);
  assert.equal(selectMusicSession(state([browser])), browser);
  assert.equal(selectMusicSession(state([])), null);
});
test("音乐独立服务读取状态和封面、拒绝写入，并释放观察者", async () => {
  let current = state([session("qq", "QQMusic.exe")]);
  current.sessions[0].media = { title: "测试歌曲", artist: "测试歌手", subtitle: "", albumTitle: "专辑", albumArtist: "", genres: [], trackNumber: 1, albumTrackCount: 1, thumbnailId: "cover" };
  let stopped = 0;
  const monitor: NativeMonitor = {
    start: async () => current, stop: async () => { stopped++; }, getState: () => current,
    refresh: async () => {}, setTimelineTracking: async () => {},
    getThumbnail: async (id, token) => {
      assert.equal(id, "qq"); assert.equal(token, "cover");
      return { thumbnailId: token, contentType: null, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
    },
  };
  const app = await createMusicServer(monitor);
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address(); assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.match(await (await fetch(`${base}/overlay/music`)).text(), /音乐 Overlay/);
    const data = await (await fetch(`${base}/api/music/state`)).json();
    assert.equal(data.session.media.title, "测试歌曲");
    const cover = await fetch(base + data.coverUrl);
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal((await fetch(`${base}/api/music/control`, { method: "POST" })).status, 405);
    current = state([]);
    assert.equal((await (await fetch(`${base}/api/music/state`)).json()).session, null);
  } finally { await app.close(); }
  assert.equal(stopped, 1);
});

async function listen(app: Awaited<ReturnType<typeof createMusicServer>>) {
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    get: async () => (await fetch(`${base}/api/music/state`)).json(),
    patch: (body: unknown) => fetch(`${base}/api/music/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    base,
  };
}
function observer() {
  let starts = 0, stops = 0, fail = false;
  const monitor: NativeMonitor = {
    start: async () => { starts++; if (fail) throw Object.assign(new Error("测试启动失败"), { code: "ERR_SMTC_MANAGER_UNAVAILABLE" }); return state([]); },
    stop: async () => { stops++; }, getState: () => state([session("qq", "QQMusic.exe")]),
    refresh: async () => {}, setTimelineTracking: async () => {}, getThumbnail: async () => null,
  };
  return { monitor, get starts() { return starts; }, get stops() { return stops; }, setFail(value: boolean) { fail = value; } };
}
test("音乐总开关停止观察，保存配置并在重启后保持关闭，重新开启可恢复", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-music-settings-"));
  const settingsFile = join(directory, "music.json");
  t.after(async () => { await unlink(settingsFile).catch(() => {}); await unlink(`${settingsFile}.tmp`).catch(() => {}); await rmdir(directory); });
  const source = observer();
  let app = await createMusicServer(source.monitor, { settingsFile });
  try {
    let api = await listen(app);
    assert.match(await (await fetch(`${api.base}/control`)).text(), /音乐控制台/);
    assert.match(await (await fetch(`${api.base}/typography-editor.js`)).text(), /typographyEditorMarkup/);
    assert.equal(source.starts, 1);
    const disabled = await (await api.patch({ enabled: false })).json();
    assert.equal(disabled.running, false); assert.equal(disabled.session, null); assert.equal(source.stops, 1);
    assert.equal((await fetch(`${api.base}/api/music/cover?session=qq&token=cover`)).status, 404);
    await Promise.all([
      api.patch({ modules: { cover: false, status: false } }),
      api.patch({ modules: { title: false, artistTitle: false } }),
      api.patch({ typography: { title: { fontSize: 42, bold: false, textColor: "#123456", outlineEnabled: true, outlineWidth: 3 }, artistTitle: { fontFamily: "serif", textAlign: "right" } } }),
    ]);
    const saved = (await api.get()).settings;
    assert.deepEqual(saved.modules, { cover: false, status: false, title: false, artistTitle: false });
    assert.equal(saved.typography.title.fontSize, 42);
    assert.equal(saved.typography.artistTitle.textAlign, "right");
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), saved);
    await app.close();
    app = await createMusicServer(source.monitor, { settingsFile });
    api = await listen(app);
    assert.equal(source.starts, 1, "关闭的配置不应启动原生观察者");
    assert.deepEqual((await api.get()).settings, saved);
    const enabled = await (await api.patch({ enabled: true })).json();
    assert.equal(enabled.running, true); assert.equal(source.starts, 2);
    assert.equal(enabled.session.sessionId, "qq");
  } finally { await app.close(); }
});
test("非法音乐配置不落盘、不改变监控状态，播放器控制仍不可用", async () => {
  const source = observer(); const app = await createMusicServer(source.monitor);
  try {
    const api = await listen(app); const original = (await api.get()).settings;
    for (const patch of [null, [], { enabled: "false" }, { modules: { cover: 0 } }, { modules: { missing: false } }, { typography: { title: { fontSize: 200 } } }, { typography: { title: { textColor: "red" } } }, { typography: { title: null } }, { typography: { title: { bold: null } } }]) {
      assert.equal((await api.patch(patch)).status, 400);
    }
    assert.equal((await fetch(`${api.base}/api/music/settings`, { method: "PATCH", body: "{" })).status, 400);
    assert.deepEqual((await api.get()).settings, original);
    assert.equal(source.starts, 1); assert.equal(source.stops, 0);
    assert.equal((await fetch(`${api.base}/api/music/control`, { method: "POST" })).status, 405);
  } finally { await app.close(); }
});
test("原生启动失败时控制台仍可访问，开关可重试恢复", async () => {
  const source = observer(); source.setFail(true);
  const app = await createMusicServer(source.monitor);
  try {
    const api = await listen(app);
    assert.equal((await fetch(`${api.base}/control`)).status, 200);
    assert.equal((await api.get()).monitorError, "ERR_SMTC_MANAGER_UNAVAILABLE");
    assert.equal((await api.patch({ typography: { title: { fontSize: 30 } } })).status, 200, "原生不可用时仍能编辑样式");
    assert.equal(source.starts, 1);
    await api.patch({ enabled: false });
    assert.equal((await api.patch({ enabled: true })).status, 503);
    assert.equal((await api.get()).settings.enabled, false);
    source.setFail(false);
    assert.equal((await api.patch({ enabled: true })).status, 200);
    assert.equal((await api.get()).running, true);
    assert.equal((await api.get()).monitorError, null);
  } finally { await app.close(); }
});
