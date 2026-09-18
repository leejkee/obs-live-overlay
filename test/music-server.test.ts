import assert from "node:assert/strict";
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
