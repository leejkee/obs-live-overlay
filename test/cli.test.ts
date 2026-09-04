import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { CliArgumentError, defaultDataFile, isMainModule, parseCliOptions } from "../src/cli.js";
import { isStartupCommand } from "../src/startup.js";

describe("CLI", () => {
  it("解析 host、port 和数据文件参数", () => {
    const options = parseCliOptions([
      "--host", "0.0.0.0",
      "--port", "4312",
      "--data-file", "./custom-data.json",
    ], {});
    assert.equal(options.host, "0.0.0.0");
    assert.equal(options.port, 4312);
    assert.match(options.dataFile, /custom-data\.json$/);
  });

  it("支持环境变量和等号参数，并以命令行参数优先", () => {
    const options = parseCliOptions(["--port=4100", "--host=127.0.0.2"], {
      PORT: "4000",
      HOST: "127.0.0.1",
      OBS_OVERLAY_DATA_FILE: "environment.json",
    });
    assert.equal(options.port, 4100);
    assert.equal(options.host, "127.0.0.2");
    assert.match(options.dataFile, /environment\.json$/);
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
