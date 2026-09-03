import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliArgumentError, defaultDataFile, parseCliOptions } from "../src/cli.js";

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
  });

  it("默认数据文件位于独立的应用数据目录", () => {
    const path = defaultDataFile({ LOCALAPPDATA: "C:\\AppData" });
    assert.match(path.replaceAll("\\", "/"), /AppData\/obs-live-overlay\/profiles\.json$/);
  });
});
