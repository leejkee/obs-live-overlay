import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createVbsRunner,
  createTaskXml,
  disableStartup,
  enableStartup,
  startupStatus,
  startupTaskName,
  StartupCommandError,
  type StartupRuntime,
} from "../src/startup.js";

interface CommandCall {
  file: string;
  args: string[];
}

async function testRuntime(overrides: Partial<StartupRuntime> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "obs-live-overlay-startup-"));
  const calls: CommandCall[] = [];
  let taskExists = false;
  const runtime: StartupRuntime = {
    platform: "win32",
    environment: {
      LOCALAPPDATA: directory,
      SystemRoot: "C:\\Windows",
      USERDOMAIN: "测试电脑",
      USERNAME: "用户",
    },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\用户\\npm\\node_modules\\@leejkee\\obs-live-overlay\\dist\\cli.js",
    dataFile: join(directory, "obs-live-overlay", "profiles.json"),
    execute: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "/Query" && !taskExists) throw new Error("任务不存在");
      if (args[0] === "/Create") taskExists = true;
      if (args[0] === "/Delete") taskExists = false;
    },
    checkOverlay: async () => false,
    stopOverlay: async () => false,
    wait: async () => undefined,
    ...overrides,
  };
  return { directory, calls, runtime, hasTask: () => taskExists };
}

describe("Windows 静默启动", () => {
  it("生成隐藏运行且等待 Node.js 退出的 Unicode VBS", () => {
    const source = createVbsRunner(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\用户\\模块\\cli.js",
      "C:\\用户\\数据\\profiles.json",
      "0".repeat(64),
    );
    assert.match(source, /shell\.Run\(/);
    assert.match(source, /, 0, True\)/);
    assert.match(source, /""C:\\Program Files\\nodejs\\node\.exe""/);
    assert.match(source, /--data-file/);
    assert.match(source, /--startup-token/);
  });

  it("生成不受电池和运行时限影响的当前用户任务 XML", () => {
    const xml = createTaskXml(
      "电脑&域\\用户",
      "C:\\Windows\\System32\\wscript.exe",
      "C:\\用户 甲\\startup.vbs",
    );
    assert.match(xml, /<UserId>电脑&amp;域\\用户<\/UserId>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(xml, /&quot;C:\\用户 甲\\startup\.vbs&quot;/);
  });

  it("创建登录任务并立即启动服务", async () => {
    let healthChecks = 0;
    const fixture = await testRuntime({
      checkOverlay: async () => {
        healthChecks += 1;
        return healthChecks >= 2;
      },
    });
    const result = await enableStartup(fixture.runtime);
    assert.equal(result.enabled, true);
    assert.equal(result.available, true);
    assert.equal(result.alreadyAvailable, false);
    assert.deepEqual(fixture.calls.map((call) => call.args[0]), ["/Create", "/Run"]);
    const createCall = fixture.calls[0];
    assert.equal(createCall.file, "schtasks.exe");
    assert.ok(createCall.args.includes("/XML"));
    assert.ok(createCall.args.includes(startupTaskName));
    const raw = await readFile(result.runnerPath);
    assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]);
    assert.match(
      raw.subarray(2).toString("utf16le"),
      /C:\\用户\\npm\\node_modules\\@leejkee\\obs-live-overlay\\dist\\cli\.js/,
    );
  });

  it("服务已可访问时只更新任务而不重复启动", async () => {
    const fixture = await testRuntime({ checkOverlay: async () => true });
    const result = await enableStartup(fixture.runtime);
    assert.equal(result.alreadyAvailable, true);
    assert.deepEqual(fixture.calls.map((call) => call.args[0]), ["/Create"]);
  });

  it("查询启用状态和服务可用性", async () => {
    const fixture = await testRuntime({ checkOverlay: async () => true });
    await enableStartup(fixture.runtime);
    fixture.calls.length = 0;
    const status = await startupStatus(fixture.runtime);
    assert.deepEqual(status, { enabled: true, available: true });
    assert.deepEqual(fixture.calls.map((call) => call.args[0]), ["/Query"]);
  });

  it("停止并删除任务，重复禁用保持成功", async () => {
    let available = true;
    const fixture = await testRuntime({
      checkOverlay: async () => available,
      stopOverlay: async () => {
        available = false;
        return true;
      },
    });
    // 使用闭包清晰模拟真实任务状态，避免调用 Windows Task Scheduler。
    let taskExists = false;
    fixture.runtime.execute = async (file, args) => {
      fixture.calls.push({ file, args });
      if (args[0] === "/Query" && !taskExists) throw new Error("任务不存在");
      if (args[0] === "/Create") taskExists = true;
      if (args[0] === "/Delete") taskExists = false;
    };
    await enableStartup(fixture.runtime);
    fixture.calls.length = 0;
    const first = await disableStartup(fixture.runtime);
    assert.deepEqual(first, { enabled: false, available: false, wasEnabled: true });
    assert.deepEqual(fixture.calls.map((call) => call.args[0]), ["/Query", "/End", "/Delete"]);
    fixture.calls.length = 0;
    const second = await disableStartup(fixture.runtime);
    assert.equal(second.wasEnabled, false);
    assert.deepEqual(fixture.calls.map((call) => call.args[0]), ["/Query"]);
  });

  it("拒绝非 Windows 平台", async () => {
    await assert.rejects(
      enableStartup({ platform: "linux" }),
      (error: unknown) => error instanceof StartupCommandError && /Windows 11/.test(error.message),
    );
  });

  it("明确报告计划任务创建失败", async () => {
    const fixture = await testRuntime({
      execute: async () => { throw new Error("拒绝访问"); },
    });
    await assert.rejects(enableStartup(fixture.runtime), /创建或立即启动 Windows 计划任务失败.*拒绝访问/);
  });

  it("明确报告计划任务删除失败", async () => {
    let taskExists = true;
    const fixture = await testRuntime({
      execute: async (_file, args) => {
        if (args[0] === "/Query" && !taskExists) throw new Error("任务不存在");
        if (args[0] === "/Delete") {
          taskExists = false;
          throw new Error("拒绝访问");
        }
      },
    });
    await assert.rejects(disableStartup(fixture.runtime), /删除 Windows 计划任务失败.*拒绝访问/);
  });

  it("保留已注册任务并报告立即启动超时", async () => {
    const fixture = await testRuntime();
    await assert.rejects(enableStartup(fixture.runtime), /计划任务已启用.*5 秒/);
    assert.equal(fixture.hasTask(), true);
  });
});
