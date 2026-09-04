import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ConflictError, NotFoundError, ValidationError } from "./queue-store.js";
import { ProfileConflictError, ProfileManager, ProfileNotFoundError } from "./profile-manager.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(currentDirectory, "..", "public");
const overlayId = "queue";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function createOverlayServer(options: { dataFile?: string; shutdownToken?: string } = {}) {
  const profiles = await ProfileManager.load(options.dataFile ?? join(currentDirectory, "..", "data", "profiles.json"));
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, profiles, options.shutdownToken, () => {
        setImmediate(() => server.emit("shutdownRequested"));
      });
    } catch (error) {
      handleError(error, response);
    }
  });
  const sockets = new WebSocketServer({ noServer: true });

  const broadcast = () => {
    const message = JSON.stringify(stateMessage(profiles));
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });

  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify(stateMessage(profiles)));
  });

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    manager: ProfileManager,
    shutdownToken: string | undefined,
    requestShutdown: () => void,
  ) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (method === "GET" && url.pathname === "/api/overlays") {
      return json(response, 200, [{ id: overlayId, type: "queue", title: "等候队列" }]);
    }
    if (method === "GET" && url.pathname === `/api/overlays/${overlayId}/state`) {
      return json(response, 200, manager.activeQueueState());
    }
    if (method === "GET" && url.pathname === "/api/profiles") {
      return json(response, 200, manager.profilesSnapshot());
    }
    if (method === "POST" && url.pathname === "/api/system/shutdown") {
      if (!shutdownToken || !validShutdownToken(request.headers.authorization, shutdownToken)) {
        return json(response, 404, { error: "接口不存在" });
      }
      json(response, 202, { stopping: true });
      requestShutdown();
      return;
    }
    if (method === "POST" && url.pathname === "/api/profiles") {
      const body = await readJson(request);
      await manager.createProfile(body.name);
      broadcast();
      return json(response, 201, stateMessage(manager));
    }
    if (method === "PUT" && url.pathname === "/api/profiles/active") {
      const body = await readJson(request);
      await manager.activateProfile(body.profileId);
      broadcast();
      return json(response, 200, stateMessage(manager));
    }
    const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (profileMatch && method === "PATCH") {
      const body = await readJson(request);
      await manager.renameProfile(decodeURIComponent(profileMatch[1]), body.name);
      broadcast();
      return json(response, 200, stateMessage(manager));
    }
    if (profileMatch && method === "DELETE") {
      await manager.deleteProfile(decodeURIComponent(profileMatch[1]));
      broadcast();
      return json(response, 200, stateMessage(manager));
    }
    if (method === "POST" && url.pathname === `/api/overlays/${overlayId}/items`) {
      const body = await readJson(request);
      await manager.updateActiveQueue((queue) => { queue.enqueue(body.id); });
      broadcast();
      return json(response, 201, manager.activeQueueState());
    }
    if (method === "POST" && url.pathname === `/api/overlays/${overlayId}/dequeue`) {
      await manager.updateActiveQueue((queue) => { queue.dequeue(); });
      broadcast();
      return json(response, 200, manager.activeQueueState());
    }
    if (method === "PUT" && url.pathname === `/api/overlays/${overlayId}/current`) {
      const body = await readJson(request);
      await manager.updateActiveQueue((queue) => { queue.setCurrent(body.id); });
      broadcast();
      return json(response, 200, manager.activeQueueState());
    }
    if (method === "PUT" && url.pathname === `/api/overlays/${overlayId}/stopped`) {
      const body = await readJson(request);
      await manager.updateActiveQueue((queue) => { queue.setQueueStopped(body.stopped); });
      broadcast();
      return json(response, 200, manager.activeQueueState());
    }
    if (method === "PUT" && url.pathname === `/api/overlays/${overlayId}/message`) {
      const body = await readJson(request);
      await manager.updateActiveQueue((queue) => { queue.setMessage(body.message); });
      broadcast();
      return json(response, 200, manager.activeQueueState());
    }
    const typographyMatch = url.pathname.match(new RegExp(`^/api/overlays/${overlayId}/typography/([^/]+)$`));
    if (method === "PUT" && typographyMatch) {
      const body = await readJson(request);
      await manager.updateActiveQueue((queue) => {
        queue.setTypography(decodeURIComponent(typographyMatch[1]), body);
      });
      broadcast();
      return json(response, 200, manager.activeQueueState());
    }

    if (method !== "GET" && method !== "HEAD") throw new NotFoundError("接口不存在");
    if (url.pathname === "/") return redirect(response, "/control");
    if (url.pathname === "/control" || url.pathname === "/control/") {
      return serveFile(response, "control.html", method === "HEAD");
    }
    if (url.pathname === `/overlay/${overlayId}` || url.pathname === `/overlay/${overlayId}/`) {
      return serveFile(response, "overlay.html", method === "HEAD");
    }
    if (/^\/(control|overlay)\.(js|css)$/.test(url.pathname)) {
      return serveFile(response, url.pathname.slice(1), method === "HEAD");
    }
    throw new NotFoundError("页面不存在");
  }

  return { server, profiles, sockets };
}

function validShutdownToken(authorization: string | undefined, expected: string): boolean {
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function stateMessage(profiles: ProfileManager) {
  const profilesState = profiles.profilesSnapshot();
  return {
    type: "state.updated",
    overlayId,
    activeProfileId: profilesState.activeProfileId,
    profiles: profilesState.profiles,
    profile: profiles.activeProfile(),
    state: profiles.activeQueueState(),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new ValidationError("请求内容过大");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ValidationError("JSON 格式无效");
  }
}

async function serveFile(response: ServerResponse, filename: string, headOnly: boolean) {
  try {
    const content = await readFile(join(publicDirectory, filename));
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filename)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": content.length,
    });
    response.end(headOnly ? undefined : content);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new NotFoundError("静态文件不存在");
    throw error;
  }
}

function json(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { Location: location });
  response.end();
}

function handleError(error: unknown, response: ServerResponse) {
  if (response.headersSent) return response.end();
  if (error instanceof ValidationError) return json(response, 400, { error: error.message });
  if (error instanceof ConflictError) return json(response, 409, { error: error.message });
  if (error instanceof ProfileConflictError) return json(response, 409, { error: error.message });
  if (error instanceof ProfileNotFoundError) return json(response, 404, { error: error.message });
  if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
  console.error(error);
  return json(response, 500, { error: "服务内部错误" });
}

async function start() {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const { server } = await createOverlayServer({ dataFile: process.env.OBS_OVERLAY_DATA_FILE });
  server.listen(port, host, () => {
    console.log(`OBS Live Overlay 已启动：http://${host}:${port}/control`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((error) => {
    console.error("OBS Live Overlay 启动失败：", error);
    process.exitCode = 1;
  });
}
