import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMusicService, selectMusicSession } from "../src/music-service.js";
import { createOverlayServer } from "../src/server.js";
import type { NativeMonitor, NativeState, SessionData } from "../native/index.cjs";

function session(id: string, source: string, status: "playing" | "paused" = "playing"): SessionData {
  return {
    sessionId: id,
    sourceAppUserModelId: source,
    media: null,
    playback: { status, playbackRate: 1 },
    timeline: null,
    revisions: { media: 0, playback: 0, timeline: 0 },
  };
}

function state(sessions: SessionData[]): NativeState {
  return {
    runId: "test",
    sequence: 1,
    currentSessionId: "browser",
    trackedTimelineSessionId: null,
    sessions,
  };
}

function observer() {
  let starts = 0;
  let stops = 0;
  let fail = false;
  let current = state([session("qq", "QQMusic.exe")]);
  const monitor: NativeMonitor = {
    start: async () => {
      starts += 1;
      if (fail) throw Object.assign(new Error("测试启动失败"), { code: "ERR_SMTC_MANAGER_UNAVAILABLE" });
      return current;
    },
    stop: async () => { stops += 1; },
    getState: () => current,
    refresh: async () => {},
    setTimelineTracking: async () => {},
    getThumbnail: async () => null,
  };
  return {
    monitor,
    get starts() { return starts; },
    get stops() { return stops; },
    setFail(value: boolean) { fail = value; },
    setState(value: NativeState) { current = value; },
  };
}

async function closeServer(app: Awaited<ReturnType<typeof createOverlayServer>>) {
  for (const socket of app.sockets.clients) socket.terminate();
  app.sockets.close();
  app.server.closeAllConnections();
  if (app.server.listening) await new Promise<void>((resolve) => app.server.close(() => resolve()));
}

test("音乐优先 QQ 音乐，包括暂停状态；否则使用系统会话", () => {
  const browser = session("browser", "chrome");
  const qq = session("qq", "QQMusic.exe", "paused");
  assert.equal(selectMusicSession(state([browser, qq])), qq);
  assert.equal(selectMusicSession(state([browser])), browser);
  assert.equal(selectMusicSession(state([])), null);
});

test("主服务在同一端口提供两个 Overlay、统一控制台、音乐状态和封面", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-music-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = observer();
  const current = state([session("qq", "QQMusic.exe")]);
  current.sessions[0].media = {
    title: "测试歌曲",
    artist: "测试歌手",
    subtitle: "",
    albumTitle: "专辑",
    albumArtist: "",
    genres: [],
    trackNumber: 1,
    albumTrackCount: 1,
    thumbnailId: "cover",
  };
  source.setState(current);
  source.monitor.getThumbnail = async (id, token) => {
    assert.equal(id, "qq");
    assert.equal(token, "cover");
    return { thumbnailId: token, contentType: null, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
  };
  const music = await createMusicService(source.monitor, { settingsFile: join(directory, "music.json") });
  const app = await createOverlayServer({
    dataFile: join(directory, "profiles.json"),
    music: {
      snapshot: music.snapshot,
      update: music.update,
      getThumbnail: music.getThumbnail,
      overlayUrl: "/overlay/music",
    },
  });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const overlays = await (await fetch(`${base}/api/overlays`)).json();
    assert.deepEqual(overlays.map((item: { id: string }) => item.id), ["queue", "music"]);
    const control = await (await fetch(`${base}/control`)).text();
    assert.match(control, /等候队列/);
    assert.match(control, /正在播放/);
    assert.equal((await fetch(`${base}/overlay/queue`)).status, 200);
    assert.match(await (await fetch(`${base}/overlay/music`)).text(), /音乐 Overlay/);
    const musicState = await (await fetch(`${base}/api/music/state`)).json();
    assert.equal(musicState.session.media.title, "测试歌曲");
    const controllerState = await (await fetch(`${base}/api/overlays/music/state`)).json();
    assert.equal(controllerState.overlayUrl, "/overlay/music");
    const cover = await fetch(base + musicState.coverUrl);
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const disabled = await (await fetch(`${base}/api/overlays/music/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(disabled.running, false);
    assert.equal((await fetch(`${base}/api/music/cover?session=qq&token=cover`)).status, 404);
    assert.equal((await fetch(`${base}/api/overlays/music/settings`, { method: "PATCH", body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/api/music/control`, { method: "POST" })).status, 404);
  } finally {
    await closeServer(app);
    await music.close();
  }
  assert.equal(source.stops, 1);
});

test("音乐开关停止观察，保存配置并在下次启动时保持关闭", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-music-settings-"));
  const settingsFile = join(directory, "music.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = observer();
  let service = await createMusicService(source.monitor, { settingsFile });
  const disabled = await service.update({ enabled: false });
  assert.equal(disabled.running, false);
  assert.equal(source.starts, 1);
  assert.equal(source.stops, 1);
  await Promise.all([
    service.update({ modules: { cover: false, status: false } }),
    service.update({ modules: { title: false, artistTitle: false } }),
    service.update({
      typography: {
        title: { fontSize: 42, bold: false, textColor: "#123456", outlineEnabled: true, outlineWidth: 3 },
        artistTitle: { fontFamily: "serif", textAlign: "right" },
      },
    }),
  ]);
  const saved = service.snapshot().settings;
  assert.deepEqual(saved.modules, { cover: false, status: false, title: false, artistTitle: false });
  assert.equal(saved.typography.title.fontSize, 42);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), saved);
  await service.close();
  service = await createMusicService(source.monitor, { settingsFile });
  assert.equal(source.starts, 1, "关闭的配置不应启动原生观察者");
  assert.deepEqual(service.snapshot().settings, saved);
  const enabled = await service.update({ enabled: true });
  assert.equal(enabled.running, true);
  assert.equal(source.starts, 2);
  await service.close();
});

test("非法配置不改变状态；原生观察者启动失败后可以重试", async () => {
  const source = observer();
  const service = await createMusicService(source.monitor);
  const original = service.snapshot().settings;
  for (const patch of [
    null,
    [],
    { enabled: "false" },
    { modules: { cover: 0 } },
    { modules: { missing: false } },
    { typography: { title: { fontSize: 200 } } },
    { typography: { title: { textColor: "red" } } },
  ]) {
    await assert.rejects(service.update(patch));
  }
  assert.deepEqual(service.snapshot().settings, original);
  await service.update({ enabled: false });
  source.setFail(true);
  await assert.rejects(service.update({ enabled: true }));
  assert.equal(service.snapshot().settings.enabled, false);
  assert.equal(service.snapshot().monitorError, "ERR_SMTC_MANAGER_UNAVAILABLE");
  source.setFail(false);
  assert.equal((await service.update({ enabled: true })).running, true);
  await service.close();
});
