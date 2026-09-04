import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createOverlayServer } from "../src/server.js";

describe("Overlay Service", () => {
  let app: Awaited<ReturnType<typeof createOverlayServer>>;
  let temporaryDirectory = "";
  let baseUrl = "";

  before(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "obs-live-overlay-server-"));
    app = await createOverlayServer({ dataFile: join(temporaryDirectory, "profiles.json") });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const client of app.sockets.clients) client.terminate();
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    await rm(temporaryDirectory, { recursive: true, force: true });
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
    assert.match(overlayStyles, /\.queue-header\s*\{[^}]*grid-template-columns:\s*minmax\(118px,\s*2fr\)\s*minmax\(0,\s*3fr\)/);
    assert.match(overlayStyles, /\.stopped-banner\s*\{[^}]*background:\s*#ffd60a;/);
    assert.match(overlayStyles, /\.stopped-banner\s*\{[^}]*border:\s*3px solid #ff3b30;/);
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

  it("创建、重命名、切换和删除 Profile", async () => {
    const createdResponse = await fetch(`${baseUrl}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "周末场" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const profileId = created.activeProfileId;
    assert.notEqual(profileId, "default");
    assert.equal(created.profile.name, "周末场");
    assert.deepEqual(created.state.items, []);

    const renamedResponse = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "周日场" }),
    });
    assert.equal((await renamedResponse.json()).profile.name, "周日场");

    const activatedResponse = await fetch(`${baseUrl}/api/profiles/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "default" }),
    });
    assert.equal((await activatedResponse.json()).activeProfileId, "default");

    const deletedResponse = await fetch(`${baseUrl}/api/profiles/${profileId}`, { method: "DELETE" });
    assert.equal(deletedResponse.status, 200);
    assert.equal((await deletedResponse.json()).profiles.length, 1);
  });
});

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}
