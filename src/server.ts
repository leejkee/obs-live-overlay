import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ConflictError, NotFoundError, QueueStore, ValidationError } from "./queue-store.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(currentDirectory, "..", "public");
const overlayId = "queue";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createOverlayServer() {
  const queue = new QueueStore();
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, queue);
    } catch (error) {
      handleError(error, response);
    }
  });
  const sockets = new WebSocketServer({ noServer: true });

  const broadcast = () => {
    const message = JSON.stringify(stateMessage(queue));
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
    socket.send(JSON.stringify(stateMessage(queue)));
  });

  async function route(request: IncomingMessage, response: ServerResponse, store: QueueStore) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (method === "GET" && url.pathname === "/api/overlays") {
      return json(response, 200, [{ id: overlayId, type: "queue", title: "等候队列" }]);
    }
    if (method === "GET" && url.pathname === `/api/overlays/${overlayId}/state`) {
      return json(response, 200, store.snapshot());
    }
    if (method === "POST" && url.pathname === `/api/overlays/${overlayId}/items`) {
      const body = await readJson(request);
      store.enqueue(body.id);
      broadcast();
      return json(response, 201, store.snapshot());
    }
    if (method === "POST" && url.pathname === `/api/overlays/${overlayId}/dequeue`) {
      store.dequeue();
      broadcast();
      return json(response, 200, store.snapshot());
    }
    if (method === "PUT" && url.pathname === `/api/overlays/${overlayId}/stopped`) {
      const body = await readJson(request);
      store.setQueueStopped(body.stopped);
      broadcast();
      return json(response, 200, store.snapshot());
    }
    if (method === "PUT" && url.pathname === `/api/overlays/${overlayId}/message`) {
      const body = await readJson(request);
      store.setMessage(body.message);
      broadcast();
      return json(response, 200, store.snapshot());
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

  return { server, queue, sockets };
}

function stateMessage(queue: QueueStore) {
  return { type: "state.updated", overlayId, state: queue.snapshot() };
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
  if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
  console.error(error);
  return json(response, 500, { error: "服务内部错误" });
}

function start() {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createOverlayServer();
  server.listen(port, host, () => {
    console.log(`OBS Live Overlay 已启动：http://${host}:${port}/control`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
