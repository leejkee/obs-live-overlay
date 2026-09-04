#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOverlayServer } from "./server.js";
import {
  disableStartup,
  enableStartup,
  isStartupCommand,
  startupStatus,
  startupTaskName,
  startupUrl,
  StartupCommandError,
} from "./startup.js";

export interface CliOptions {
  host: string;
  port: number;
  dataFile: string;
  startupToken?: string;
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { version: string };

export function defaultDataFile(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const baseDirectory = environment.XDG_DATA_HOME
    || (platform === "win32" ? environment.LOCALAPPDATA : undefined)
    || join(homedir(), ".local", "share");
  return join(baseDirectory || homedir(), "obs-live-overlay", "profiles.json");
}

export function parseCliOptions(args: string[], environment: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    host: environment.HOST || "127.0.0.1",
    port: parsePort(environment.PORT || "3000"),
    dataFile: resolve(environment.OBS_OVERLAY_DATA_FILE || defaultDataFile(environment)),
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host") options.host = requiredValue(args, ++index, "--host");
    else if (argument.startsWith("--host=")) options.host = argument.slice("--host=".length);
    else if (argument === "--port" || argument === "-p") options.port = parsePort(requiredValue(args, ++index, argument));
    else if (argument.startsWith("--port=")) options.port = parsePort(argument.slice("--port=".length));
    else if (argument === "--data-file") options.dataFile = resolve(requiredValue(args, ++index, "--data-file"));
    else if (argument.startsWith("--data-file=")) options.dataFile = resolve(argument.slice("--data-file=".length));
    else if (argument === "--startup-token") options.startupToken = startupToken(requiredValue(args, ++index, "--startup-token"));
    else throw new CliArgumentError(`未知参数：${argument}`);
  }

  if (!options.host.trim()) throw new CliArgumentError("host 不能为空");
  return options;
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(packageJson.version);
    return;
  }

  const command = args[0];
  if (isStartupCommand(command)) {
    if (args.length !== 1) throw new CliArgumentError(`${command} 不接受额外参数`);
    const startupRuntime = {
      cliPath: fileURLToPath(import.meta.url),
      dataFile: defaultDataFile(),
    };
    if (command === "startup-enable") {
      const result = await enableStartup(startupRuntime);
      console.log("静默启动已启用。");
      console.log(`计划任务：${startupTaskName}`);
      console.log(result.alreadyAvailable
        ? `Overlay 服务已在运行：${startupUrl}`
        : `Overlay 服务已启动：${startupUrl}`);
      return;
    }
    if (command === "startup-disable") {
      const result = await disableStartup(startupRuntime);
      console.log(result.wasEnabled ? "静默启动已关闭。" : "静默启动原本未启用。");
      console.log(result.available
        ? "Overlay 服务仍可访问，可能存在独立的前台实例。"
        : "Overlay 服务已停止。");
      return;
    }
    const status = await startupStatus(startupRuntime);
    console.log(`静默启动：${status.enabled ? "已启用" : "未启用"}`);
    console.log(`Overlay 服务：${status.available ? `可访问（${startupUrl}）` : "未运行"}`);
    return;
  }

  const options = parseCliOptions(args);
  const { server, sockets } = await createOverlayServer({
    dataFile: options.dataFile,
    shutdownToken: options.startupToken,
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const baseUrl = `http://${options.host}:${options.port}`;
  console.log("OBS Live Overlay 已启动");
  console.log(`控制台：${baseUrl}/control`);
  console.log(`OBS Overlay：${baseUrl}/overlay/queue`);
  console.log(`数据文件：${options.dataFile}`);
  console.log("按 Ctrl+C 停止服务");

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    server.off("shutdownRequested", handleSignal);
    console.log("\n正在停止 OBS Live Overlay…");
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    sockets.close();
    console.log("服务已停止");
    process.exit(0);
  };
  const handleSignal = () => { void shutdown(); };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  server.once("shutdownRequested", handleSignal);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliArgumentError(`端口无效：${value}`);
  }
  return port;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new CliArgumentError(`${option} 缺少参数值`);
  return value;
}

function helpText(): string {
  return `OBS Live Overlay ${packageJson.version}

用法：
  obs-live-overlay [选项]
  obs-live-overlay <命令>

命令（Windows 11）：
  startup-enable        启用登录后静默启动，并立即启动服务
  startup-disable       停止服务并关闭静默启动
  startup-status        查看静默启动及 Overlay 服务状态

选项：
  -p, --port <端口>       HTTP 服务端口，默认 3000
      --host <地址>       监听地址，默认 127.0.0.1
      --data-file <路径>  Profile JSON 数据文件
  -v, --version           显示版本
  -h, --help              显示帮助
`;
}

export class CliArgumentError extends Error {}

export function isMainModule(
  moduleUrl: string,
  entryPoint: string | undefined,
  canonicalize: (path: string) => string = realpathSync,
): boolean {
  if (!entryPoint) return false;
  try {
    return canonicalize(fileURLToPath(moduleUrl)) === canonicalize(resolve(entryPoint));
  } catch {
    return false;
  }
}

function startupToken(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new CliArgumentError("内部启动令牌无效");
  return value;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli().catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error("启动失败：端口已被占用，请使用 --port 指定其他端口。");
    } else if (error instanceof CliArgumentError) {
      console.error(`参数错误：${error.message}\n使用 --help 查看帮助。`);
    } else if (error instanceof StartupCommandError) {
      console.error(`静默启动操作失败：${error.message}`);
    } else {
      console.error("OBS Live Overlay 启动失败：", error);
    }
    process.exitCode = 1;
  });
}
