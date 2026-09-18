import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

export async function createMusicServer(providedMonitor?: NativeMonitor) {
  const require = createRequire(import.meta.url);
  const monitor: NativeMonitor = providedMonitor
    ?? (require("../native/index.cjs") as typeof import("../native/index.cjs")).createMonitor(() => {});
  try { await monitor.start(); }
  catch (error) { await monitor.stop(); throw error; }
  const assets: Record<string, [string, string]> = {
    "/": ["music.html", "text/html"],
    "/overlay/music": ["music.html", "text/html"],
    "/overlay/music/": ["music.html", "text/html"],
    "/music.css": ["music.css", "text/css"],
    "/music.js": ["music.js", "text/javascript"],
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/music/state") {
        const session = selectMusicSession(monitor.getState());
        const thumbnailId = session?.media?.thumbnailId;
        const body = JSON.stringify({ session, coverUrl: session && thumbnailId
          ? `/api/music/cover?session=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(thumbnailId)}` : null });
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : body); return;
      }
      if (url.pathname === "/api/music/cover") {
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
      const status = code === "ERR_SMTC_STALE_SESSION" || code === "ERR_SMTC_STALE_THUMBNAIL" ? 404 : 503;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "暂时无法读取音乐信息", code }));
    }
  });
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([closed, monitor.stop()]);
    })();
  }
  return { server, close };
}
