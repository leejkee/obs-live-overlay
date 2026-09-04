import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const startupTaskName = "OBS Live Overlay";
export const startupUrl = "http://127.0.0.1:3000";

const execFileAsync = promisify(execFile);
const startupCommands = ["startup-enable", "startup-disable", "startup-status"] as const;

export type StartupCommand = typeof startupCommands[number];

export interface StartupStatus {
  enabled: boolean;
  available: boolean;
}

export interface StartupRuntime {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  nodePath?: string;
  cliPath?: string;
  dataFile?: string;
  execute?: (file: string, args: string[]) => Promise<void>;
  mutate?: (commands: WindowsCommand[]) => Promise<void>;
  checkOverlay?: () => Promise<boolean>;
  stopOverlay?: (controlFile: string) => Promise<boolean>;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface EnableStartupResult extends StartupStatus {
  alreadyAvailable: boolean;
  runnerPath: string;
}

export interface DisableStartupResult extends StartupStatus {
  wasEnabled: boolean;
}

export class StartupCommandError extends Error {}

export interface WindowsCommand {
  args: string[];
  ignoreFailure?: boolean;
}

export function isStartupCommand(value: string | undefined): value is StartupCommand {
  return startupCommands.includes(value as StartupCommand);
}

export async function enableStartup(runtime: StartupRuntime = {}): Promise<EnableStartupResult> {
  const context = startupContext(runtime);
  const token = await readStartupToken(context.controlPath) ?? randomBytes(32).toString("hex");
  const runner = createVbsRunner(context.nodePath, context.cliPath, context.dataFile, token);
  const taskXml = createTaskXml(context.userId, context.wscriptPath, context.runnerPath);
  await mkdir(dirname(context.runnerPath), { recursive: true });
  await writeFile(context.runnerPath, encodeUnicodeVbs(runner));
  await writeFile(context.taskXmlPath, encodeUnicodeText(taskXml));
  await writeFile(context.controlPath, `${JSON.stringify({ token }, null, 2)}\n`, "utf8");

  const alreadyAvailable = await context.checkOverlay();
  const commands: WindowsCommand[] = [{
    args: [
      "/Create",
      "/TN", startupTaskName,
      "/XML", context.taskXmlPath,
      "/F",
    ],
  }];
  if (!alreadyAvailable) commands.push({ args: ["/Run", "/TN", startupTaskName] });
  try {
    await context.mutate(commands);
  } catch (error) {
    throw systemCommandError("创建或立即启动 Windows 计划任务失败", error);
  }

  if (!alreadyAvailable) {
    if (!await waitForOverlay(true, context)) {
      throw new StartupCommandError(
        "计划任务已启用，但 Overlay 服务未能在 5 秒内启动。请运行 obs-live-overlay 查看前台错误。",
      );
    }
  }

  return { enabled: true, available: true, alreadyAvailable, runnerPath: context.runnerPath };
}

export async function disableStartup(runtime: StartupRuntime = {}): Promise<DisableStartupResult> {
  const context = startupContext(runtime);
  const wasEnabled = await taskExists(context);
  const wasAvailable = await context.checkOverlay();
  const requestedShutdown = wasAvailable
    ? await context.stopOverlay(context.controlPath)
    : false;

  if (wasEnabled) {
    try {
      await context.mutate([
        { args: ["/End", "/TN", startupTaskName], ignoreFailure: true },
        { args: ["/Delete", "/TN", startupTaskName, "/F"] },
      ]);
    } catch (error) {
      throw systemCommandError("删除 Windows 计划任务失败", error);
    }
  }
  await Promise.all([
    rm(context.runnerPath, { force: true }),
    rm(context.taskXmlPath, { force: true }),
    rm(context.controlPath, { force: true }),
  ]);

  const available = requestedShutdown
    ? !await waitForOverlay(false, context)
    : await context.checkOverlay();
  return { enabled: false, available, wasEnabled };
}

export async function startupStatus(runtime: StartupRuntime = {}): Promise<StartupStatus> {
  const context = startupContext(runtime);
  const [enabled, available] = await Promise.all([
    taskExists(context),
    context.checkOverlay(),
  ]);
  return { enabled, available };
}

export function createVbsRunner(nodePath: string, cliPath: string, dataFile: string, token: string): string {
  const command = [nodePath, cliPath, "--data-file", dataFile, "--startup-token", token]
    .map(quoteCommandArgument)
    .join(" ");
  return [
    "Dim shell",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `WScript.Quit shell.Run(\"${command.replaceAll("\"", "\"\"")}\", 0, True)`,
    "",
  ].join("\r\n");
}

export function createTaskXml(userId: string, wscriptPath: string, runnerPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>登录 Windows 后静默启动 OBS Live Overlay。</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(wscriptPath)}</Command>
      <Arguments>//B //NoLogo &quot;${escapeXml(runnerPath)}&quot;</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function startupContext(runtime: StartupRuntime) {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "win32") {
    throw new StartupCommandError("静默启动目前仅支持 Windows 11。");
  }
  const environment = runtime.environment ?? process.env;
  const localAppData = environment.LOCALAPPDATA;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
  const nodePath = runtime.nodePath ?? process.execPath;
  const cliPath = runtime.cliPath;
  const dataFile = runtime.dataFile;
  if (!localAppData) throw new StartupCommandError("无法确定 LOCALAPPDATA 目录。");
  if (!systemRoot) throw new StartupCommandError("无法确定 Windows 系统目录。");
  const userDomain = environment.USERDOMAIN;
  const userName = environment.USERNAME;
  if (!userDomain || !userName) throw new StartupCommandError("无法确定当前 Windows 用户。");
  if (!cliPath || !dataFile) throw new StartupCommandError("无法确定 CLI 或数据文件路径。");

  const startupDirectory = join(localAppData, "obs-live-overlay");
  return {
    nodePath,
    cliPath,
    dataFile,
    runnerPath: join(startupDirectory, "startup.vbs"),
    taskXmlPath: join(startupDirectory, "startup-task.xml"),
    controlPath: join(startupDirectory, "startup-control.json"),
    userId: `${userDomain}\\${userName}`,
    wscriptPath: join(systemRoot, "System32", "wscript.exe"),
    execute: runtime.execute ?? executeWindowsCommand,
    mutate: runtime.mutate
      ?? (runtime.execute
        ? async (commands: WindowsCommand[]) => executeCommands(commands, runtime.execute!)
        : async (commands: WindowsCommand[]) => executeElevatedWindowsCommands(
          commands,
          join(systemRoot, "System32", "schtasks.exe"),
          join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        )),
    checkOverlay: runtime.checkOverlay ?? checkOverlay,
    stopOverlay: runtime.stopOverlay ?? requestManagedShutdown,
    wait: runtime.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

async function taskExists(context: ReturnType<typeof startupContext>): Promise<boolean> {
  try {
    await context.execute("schtasks.exe", ["/Query", "/TN", startupTaskName]);
    return true;
  } catch {
    return false;
  }
}

async function waitForOverlay(expected: boolean, context: ReturnType<typeof startupContext>): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await context.checkOverlay() === expected) return true;
    await context.wait(250);
  }
  return false;
}

async function checkOverlay(): Promise<boolean> {
  try {
    const response = await fetch(`${startupUrl}/api/overlays`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload) && payload.some((item) => item?.id === "queue");
  } catch {
    return false;
  }
}

async function requestManagedShutdown(controlFile: string): Promise<boolean> {
  const token = await readStartupToken(controlFile);
  if (!token) return false;
  try {
    const response = await fetch(`${startupUrl}/api/system/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(750),
    });
    return response.status === 202;
  } catch {
    return false;
  }
}

async function readStartupToken(controlFile: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(controlFile, "utf8"));
    return typeof value?.token === "string" && /^[0-9a-f]{64}$/.test(value.token)
      ? value.token
      : undefined;
  } catch {
    return undefined;
  }
}

async function executeWindowsCommand(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args, { encoding: "utf8", windowsHide: true });
}

async function executeCommands(
  commands: WindowsCommand[],
  execute: (file: string, args: string[]) => Promise<void>,
): Promise<void> {
  for (const command of commands) {
    try {
      await execute("schtasks.exe", command.args);
    } catch (error) {
      if (!command.ignoreFailure) throw error;
    }
  }
}

async function executeElevatedWindowsCommands(
  commands: WindowsCommand[],
  schtasksPath: string,
  powershellPath: string,
): Promise<void> {
  const elevatedScript = [
    "$ErrorActionPreference = 'Stop'",
    ...commands.flatMap((command) => [
      `& ${powerShellLiteral(schtasksPath)} ${command.args.map(powerShellLiteral).join(" ")}`,
      ...(command.ignoreFailure ? [] : ["if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"]),
    ]),
    "exit 0",
  ].join("\r\n");
  const encodedScript = Buffer.from(elevatedScript, "utf16le").toString("base64");
  const argumentList = `-NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  const launcher = [
    `$process = Start-Process -FilePath ${powerShellLiteral(powershellPath)}`,
    ` -ArgumentList ${powerShellLiteral(argumentList)}`,
    " -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    "; exit $process.ExitCode",
  ].join("");
  await execFileAsync(
    powershellPath,
    ["-NoProfile", "-NonInteractive", "-Command", launcher],
    { encoding: "utf8", windowsHide: true },
  );
}

function quoteCommandArgument(value: string): string {
  if (/[\r\n\"]/.test(value)) throw new StartupCommandError("启动路径包含 Windows 不支持的字符。");
  return `"${value}"`;
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodeUnicodeVbs(value: string): Buffer {
  return encodeUnicodeText(value);
}

function encodeUnicodeText(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function systemCommandError(message: string, error: unknown): StartupCommandError {
  const detail = error instanceof Error ? error.message : String(error);
  return new StartupCommandError(`${message}：${detail}`);
}
