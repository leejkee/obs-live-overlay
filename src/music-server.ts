import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadMusicSettings, saveMusicSettings, updateMusicSettings } from "./music-settings.js";
import { ValidationError } from "./queue-store.js";
import type { NativeMonitor, NativeState } from "../native/index.cjs";

// Prefer QQ Music; otherwise use the Windows current session, then a playing session.
export function selectMusicSession(state: NativeState) {
  const sessions = state.sessions;
  const qq = sessions.filter(s => /qqmusic|qq音乐/i.test(s.sourceAppUserModelId));
  return qq.find(s => s.playback?.status === "playing") ?? qq[0]
    ?? sessions.find(s => s.sessionId === state.currentSessionId)
    ?? sessions.find(s => s.playback?.status === "playing") ?? sessions[0] ?? null;
}

// Some players omit or mislabel the WinRT stream MIME type.
export function coverContentType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function createMusicServer(providedMonitor?: NativeMonitor, options: { settingsFile?: string } = {}) {
  const require = createRequire(import.meta.url);
  let settings = await loadMusicSettings(options.settingsFile);
  let monitor = providedMonitor;
  let running = false;
  let monitorError: string | null = null;
  let closing: Promise<void> | undefined;
  let mutations: Promise<unknown> = Promise.resolve();
  async function setRunning(enabled: boolean) {
    if (!enabled) {
      running = false;
      await monitor?.stop();
      monitorError = null;
      return;
    }
    if (running) return;
    try {
      monitor ??= (require("../native/index.cjs") as typeof import("../native/index.cjs")).createMonitor(() => {});
      await monitor.start();
      running = true;
      monitorError = null;
    } catch (error) {
      running = false;
      monitorError = (error as { code?: string }).code ?? "ERR_SMTC_OPERATION_FAILED";
      await monitor?.stop();
      throw error;
    }
  }
  // Keep the controller available even when the native backend cannot start.
  if (settings.enabled) await setRunning(true).catch(() => {});
  function snapshot() {
    const session = running && monitor ? selectMusicSession(monitor.getState()) : null;
    const thumbnailId = session?.media?.thumbnailId;
    return { settings, running, monitorError, session, coverUrl: settings.modules.cover && session && thumbnailId
      ? `/api/music/cover?session=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(thumbnailId)}` : null };
  }
  function update(input: unknown) {
    const operation = mutations.then(async () => {
      if (closing) throw new Error("音乐服务正在关闭");
      const next = updateMusicSettings(settings, input);
      const previous = settings;
      const changeRunning = Object.hasOwn(input as object, "enabled");
      if (changeRunning) await setRunning(next.enabled);
      try { await saveMusicSettings(options.settingsFile, next); }
      catch (error) { if (changeRunning) await setRunning(previous.enabled).catch(() => {}); throw error; }
      settings = next;
      return snapshot();
    });
    mutations = operation.catch(() => {});
    return operation;
  }
  const assets: Record<string, [string, string]> = {
    "/": ["music-control.html", "text/html"],
    "/control": ["music-control.html", "text/html"],
    "/control/": ["music-control.html", "text/html"],
    "/music-control.js": ["music-control.js", "text/javascript"],
    "/music-control.css": ["music-control.css", "text/css"],
    "/control.css": ["control.css", "text/css"],
    "/typography-editor.js": ["typography-editor.js", "text/javascript"],
    "/overlay/music": ["music.html", "text/html"],
    "/overlay/music/": ["music.html", "text/html"],
    "/music.css": ["music.css", "text/css"],
    "/music.js": ["music.js", "text/javascript"],
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "PATCH" && url.pathname === "/api/music/settings") {
        const result = await update(await readJson(request));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result)); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
      }
      if (url.pathname === "/api/music/state") {
        const body = JSON.stringify(snapshot());
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : body); return;
      }
      if (url.pathname === "/api/music/cover") {
        if (!running || !monitor || !settings.modules.cover) { response.writeHead(404); response.end(); return; }
        const image = await monitor.getThumbnail(url.searchParams.get("session") ?? "", url.searchParams.get("token") ?? "");
        if (!image) { response.writeHead(404); response.end(); return; }
        const contentType = coverContentType(image.data);
        if (!contentType) { response.writeHead(415); response.end(); return; }
        response.writeHead(200, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" });
        response.end(request.method === "HEAD" ? undefined : image.data); return;
      }
      const asset = assets[url.pathname];
      if (!asset) { response.writeHead(404); response.end(); return; }
      const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = error instanceof ValidationError ? 400 : code === "ERR_SMTC_STALE_SESSION" || code === "ERR_SMTC_STALE_THUMBNAIL" ? 404 : 503;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof ValidationError ? error.message : "暂时无法读取或保存音乐配置", code }));
    }
  });
  function close() {
    return closing ??= (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await mutations;
      await setRunning(false);
      await closed;
    })();
  }
  return { server, close };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new ValidationError("请求内容过大");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ValidationError("JSON 格式无效"); }
}
