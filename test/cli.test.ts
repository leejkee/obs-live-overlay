import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  CliArgumentError,
  defaultDataFile,
  defaultMusicSettingsFile,
  isMainModule,
  parseCliOptions,
  startOverlayServices,
} from "../src/cli.js";
import { createMusicService } from "../src/music-service.js";
import { createOverlayServer } from "../src/server.js";
import type { NativeMonitor, NativeState } from "../native/index.cjs";
import { isStartupCommand } from "../src/startup.js";

describe("CLI", () => {
  it("解析 host、port 和数据文件参数", () => {
    const options = parseCliOptions([
      "--host", "0.0.0.0",
      "--port", "4312",
      "--data-file", "./custom-data.json",
      "--music-settings-file", "./custom-music.json",
    ], {});
    assert.equal(options.host, "0.0.0.0");
    assert.equal(options.port, 4312);
    assert.match(options.dataFile, /custom-data\.json$/);
    assert.match(options.musicSettingsFile, /custom-music\.json$/);
  });

  it("支持环境变量和等号参数，并以命令行参数优先", () => {
    const options = parseCliOptions(["--port=4100", "--host=127.0.0.2"], {
      PORT: "4000",
      HOST: "127.0.0.1",
      OBS_OVERLAY_DATA_FILE: "environment.json",
      MUSIC_SETTINGS_FILE: "music-environment.json",
    });
    assert.equal(options.port, 4100);
    assert.equal(options.host, "127.0.0.2");
    assert.match(options.dataFile, /environment\.json$/);
    assert.match(options.musicSettingsFile, /music-environment\.json$/);
  });

  it("拒绝未知参数、缺失值和无效端口", () => {
    assert.throws(() => parseCliOptions(["--unknown"], {}), CliArgumentError);
    assert.throws(() => parseCliOptions(["--port"], {}), CliArgumentError);
    assert.throws(() => parseCliOptions(["--port", "70000"], {}), CliArgumentError);
    assert.throws(() => parseCliOptions(["--startup-token", "invalid"], {}), CliArgumentError);
  });

  it("接受静默实例使用的内部关闭令牌", () => {
    const token = "a".repeat(64);
    assert.equal(parseCliOptions(["--startup-token", token], {}).startupToken, token);
  });

  it("默认数据文件位于独立的应用数据目录", () => {
    const path = defaultDataFile({ LOCALAPPDATA: "C:\\AppData" }, "win32");
    assert.match(path.replaceAll("\\", "/"), /AppData\/obs-live-overlay\/profiles\.json$/);
    const musicPath = defaultMusicSettingsFile({ LOCALAPPDATA: "C:\\AppData" }, "win32");
    assert.match(musicPath.replaceAll("\\", "/"), /AppData\/obs-live-overlay\/music\.json$/);
  });

  it("统一启动队列与音乐服务，并在关闭时一起释放", async t => {
    const directory = await mkdtemp(join(tmpdir(), "obs-live-overlay-cli-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let starts = 0;
    let stops = 0;
    const state: NativeState = { runId: "test", sequence: 0, currentSessionId: null, trackedTimelineSessionId: null, sessions: [] };
    const monitor: NativeMonitor = {
      start: async () => { starts += 1; return state; },
      stop: async () => { stops += 1; },
      getState: () => state,
      refresh: async () => {},
      setTimelineTracking: async () => {},
      getThumbnail: async () => null,
    };
    const options = {
      ...parseCliOptions([], {}),
      port: 0,
      dataFile: join(directory, "profiles.json"),
      musicSettingsFile: join(directory, "music.json"),
    };
    const app = await startOverlayServices(options, {
      createOverlayServer,
      createMusicService: (_provided, serviceOptions) => createMusicService(monitor, serviceOptions),
    });
    assert.equal(app.queue.server.listening, true);
    assert.equal(starts, 1);
    const address = app.queue.server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/overlay/queue`)).status, 200);
    assert.equal((await fetch(`${base}/overlay/music`)).status, 200);
    await app.close();
    assert.equal(app.queue.server.listening, false);
    assert.equal(stops, 1);
  });

  it("识别 npm 全局命令的符号链接入口", () => {
    const modulePath = resolve("dist/cli.js");
    const commandLink = resolve("bin/obs-live-overlay");
    const canonicalize = (path: string) => path === commandLink ? modulePath : path;
    assert.equal(isMainModule(pathToFileURL(modulePath).href, commandLink, canonicalize), true);
    assert.equal(isMainModule(pathToFileURL(modulePath).href, undefined, canonicalize), false);
  });

  it("识别静默启动子命令", () => {
    assert.equal(isStartupCommand("startup-enable"), true);
    assert.equal(isStartupCommand("startup-disable"), true);
    assert.equal(isStartupCommand("startup-status"), true);
    assert.equal(isStartupCommand("start"), false);
  });
});
