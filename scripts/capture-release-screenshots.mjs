import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createOverlayServer } from "../dist/server.js";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "obs-live-overlay-release-"));
const app = await createOverlayServer({ dataFile: join(temporaryDirectory, "profiles.json") });
let chrome;

try {
  await new Promise((resolveListen) => app.server.listen(0, "127.0.0.1", resolveListen));
  const address = app.server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  for (const id of ["用户 1", "用户 2", "用户 3", "用户 4"]) {
    await jsonRequest(`${baseUrl}/api/overlays/queue/items`, { method: "POST", body: { id } });
  }
  await jsonRequest(`${baseUrl}/api/overlays/queue/content/title`, { method: "PUT", body: { content: "等待队列" } });
  await jsonRequest(`${baseUrl}/api/overlays/queue/message`, { method: "PUT", body: { message: "弹幕发送排队加入队列" } });
  const seededState = await jsonRequest(`${baseUrl}/api/overlays/queue/current`, { method: "PUT", body: { id: "用户 3" } });
  assert.deepEqual(seededState.items.map((item) => item.id), ["用户 3", "用户 1", "用户 2", "用户 4"]);
  assert.equal(seededState.currentId, "用户 3");

  const chromeExecutable = await findChrome();
  const debug = await startChrome(chromeExecutable, join(temporaryDirectory, "chrome-profile"));
  chrome = debug.process;

  const control = await openPage(debug.httpUrl, `${baseUrl}/control`, 1600, 1400);
  await control.evaluate(`new Promise((resolve) => {
    const check = () => document.querySelectorAll(".queue-row").length === 4 ? resolve(true) : setTimeout(check, 50);
    check();
  })`, true);
  const interaction = await control.evaluate(`(() => {
    const row = [...document.querySelectorAll(".queue-row")].find((item) => item.dataset.itemId === "用户 2");
    row?.click();
    document.querySelector("#move-up-button")?.click();
    return Boolean(row);
  })()`);
  assert.equal(interaction, true);
  await control.evaluate(`new Promise((resolve) => {
    const check = () => {
      const rows = [...document.querySelectorAll(".queue-row")];
      const ready = rows.map((row) => row.dataset.itemId).join(",") === "用户 3,用户 2,用户 1,用户 4"
        && rows[1]?.classList.contains("selected")
        && !document.querySelector("#move-up-button")?.disabled
        && !document.querySelector("#move-down-button")?.disabled;
      ready ? resolve(true) : setTimeout(check, 50);
    };
    check();
  })`, true);
  await control.screenshot(join(projectDirectory, "docs", "images", "control-console.png"));
  await control.close();

  const overlay = await openPage(debug.httpUrl, `${baseUrl}/overlay/queue`, 520, 500);
  const overlayState = await overlay.evaluate(`new Promise((resolve) => {
    const check = () => {
      const rows = [...document.querySelectorAll(".queue-item")];
      const ready = rows.length === 4
        && document.querySelector("#queue-heading")?.textContent === "等待队列"
        && document.querySelector("#overlay-message")?.textContent === "弹幕发送排队加入队列"
        && rows[0]?.classList.contains("current")
        && rows[0]?.textContent.includes("用户 3");
      ready ? resolve({ order: rows.map((row) => row.dataset.id), current: rows[0]?.textContent }) : setTimeout(check, 50);
    };
    check();
  })`, true);
  assert.deepEqual(overlayState.order, ["用户 3", "用户 2", "用户 1", "用户 4"]);
  assert.match(overlayState.current, /当前上号/);
  await overlay.screenshot(join(projectDirectory, "docs", "images", "queue-overlay.png"));
  await overlay.close();
} finally {
  for (const client of app.sockets.clients) client.terminate();
  if (app.server.listening) {
    await new Promise((resolveClose, reject) => app.server.close((error) => error ? reject(error) : resolveClose()));
  }
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([once(chrome, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 5000))]);
  }
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function jsonRequest(url, { method, body }) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error ?? `${method} ${url} 请求失败`);
  return payload;
}

async function findChrome() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* 继续查找下一个浏览器。 */ }
  }
  throw new Error("未找到可用于发布截图的 Chrome 或 Edge");
}

async function startChrome(executable, userDataDirectory) {
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDirectory}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.setEncoding("utf8");
  try {
    const websocketUrl = await new Promise((resolveDebug, reject) => {
      const timeout = setTimeout(() => reject(new Error("等待 Chrome 调试端口超时")), 15000);
      child.stderr.on("data", (chunk) => {
        const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (!match) return;
        clearTimeout(timeout);
        resolveDebug(match[1]);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome 在截图前退出（${code}）`));
      });
    });
    const endpoint = new URL(websocketUrl);
    return { process: child, httpUrl: `http://${endpoint.host}` };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

async function openPage(debugHttpUrl, url, width, height) {
  const response = await fetch(`${debugHttpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  assert.equal(response.ok, true, "无法创建 Chrome 页面");
  const target = await response.json();
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await client.send("Page.navigate", { url });
  await client.evaluate(`new Promise((resolve) => {
    const check = () => document.readyState === "complete" ? resolve(true) : setTimeout(check, 25);
    check();
  })`, true);
  return {
    evaluate: (expression, awaitPromise = false) => client.evaluate(expression, awaitPromise),
    screenshot: async (path) => {
      const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await writeFile(path, Buffer.from(result.data, "base64"));
    },
    close: async () => {
      client.close();
      await fetch(`${debugHttpUrl}/json/close/${target.id}`);
    },
  };
}

async function createCdpClient(websocketUrl) {
  const socket = new WebSocket(websocketUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolveResult, rejectResult } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectResult(new Error(message.error.message));
    else resolveResult(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveResult, rejectResult) => {
    const id = nextId++;
    pending.set(id, { resolveResult, rejectResult });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    evaluate: async (expression, awaitPromise = false) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    close: () => socket.close(),
  };
}
