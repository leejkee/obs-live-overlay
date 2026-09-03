import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createOverlayServer } from "../src/server.js";

describe("Overlay Service", () => {
  const app = createOverlayServer();
  let baseUrl = "";

  before(async () => {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const client of app.sockets.clients) client.terminate();
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  });

  it("提供控制台和 Overlay 页面", async () => {
    const [control, overlay, overlayCss] = await Promise.all([
      fetch(`${baseUrl}/control`),
      fetch(`${baseUrl}/overlay/queue`),
      fetch(`${baseUrl}/overlay.css`),
    ]);
    assert.equal(control.status, 200);
    assert.match(await control.text(), /等候队列/);
    assert.equal(overlay.status, 200);
    const overlayHtml = await overlay.text();
    assert.match(overlayHtml, /queue-list/);
    assert.match(overlayHtml, /不排了/);
    assert.match(overlayHtml, /overlay-message/);
    assert.match(overlayHtml, /<div class="title-area">[\s\S]*<\/header>\s*<div id="overlay-message"[\s\S]*<\/div>\s*<div id="empty-message"/);
    assert.doesNotMatch(overlayHtml, /停止排队/);
    assert.doesNotMatch(overlayHtml, /LIVE QUEUE|queue-count/);
    assert.match(await (await fetch(`${baseUrl}/overlay.js`)).text(), /当前上号/);
    const overlayStyles = await overlayCss.text();
    assert.match(overlayStyles, /\.overlay\s*\{[^}]*background:\s*transparent;/);
    assert.match(overlayStyles, /--current-accent:\s*#ff7a00/);
    assert.match(overlayStyles, /-webkit-text-stroke/);
    assert.doesNotMatch(overlayStyles, /linear-gradient|filter:\s*blur|box-shadow/);
  });

  it("通过 REST 修改状态并用 WebSocket 广播", async () => {
    const wsUrl = baseUrl.replace("http:", "ws:") + "/ws";
    const socket = new WebSocket(wsUrl);
    await onceMessage(socket);
    const broadcastPromise = onceMessage(socket);

    const response = await fetch(`${baseUrl}/api/overlays/queue/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "User-A" }),
    });
    assert.equal(response.status, 201);
    const message = JSON.parse(await broadcastPromise);
    assert.equal(message.type, "state.updated");
    assert.equal(message.state.items[0].id, "User-A");
    assert.equal(message.state.currentId, "User-A");
    socket.close();
  });

  it("验证错误请求", async () => {
    const response = await fetch(`${baseUrl}/api/overlays/queue/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: " " }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /不能为空/);
  });

  it("切换停止排队提示并通过 WebSocket 广播", async () => {
    const wsUrl = baseUrl.replace("http:", "ws:") + "/ws";
    const socket = new WebSocket(wsUrl);
    await onceMessage(socket);
    const broadcastPromise = onceMessage(socket);

    const response = await fetch(`${baseUrl}/api/overlays/queue/stopped`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopped: true }),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.isQueueStopped, true);
    const message = JSON.parse(await broadcastPromise);
    assert.equal(message.state.isQueueStopped, true);
    socket.close();
  });

  it("更新 Overlay 消息并通过 WebSocket 广播", async () => {
    const wsUrl = baseUrl.replace("http:", "ws:") + "/ws";
    const socket = new WebSocket(wsUrl);
    await onceMessage(socket);
    const broadcastPromise = onceMessage(socket);

    const response = await fetch(`${baseUrl}/api/overlays/queue/message`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "欢迎加入" }),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.message, "欢迎加入");
    const message = JSON.parse(await broadcastPromise);
    assert.equal(message.state.message, "欢迎加入");
    socket.close();
  });
});

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}
