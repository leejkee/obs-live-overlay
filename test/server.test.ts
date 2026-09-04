import assert from "node:assert/strict";
import { once } from "node:events";
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
    const [control, overlay, overlayCss, controlCss] = await Promise.all([
      fetch(`${baseUrl}/control`),
      fetch(`${baseUrl}/overlay/queue`),
      fetch(`${baseUrl}/overlay.css`),
      fetch(`${baseUrl}/control.css`),
    ]);
    assert.equal(control.status, 200);
    const controlHtml = await control.text();
    assert.match(controlHtml, /等候队列/);
    assert.equal(controlHtml.match(/data-typography-section=/g)?.length, 1);
    assert.match(controlHtml, /data-content-section="queue"/);
    assert.match(controlHtml, /data-content-section="title"/);
    assert.match(controlHtml, /data-content-section="message"/);
    assert.match(controlHtml, /data-content-section="stopped"/);
    assert.match(controlHtml, /data-theme-option="light"/);
    assert.match(controlHtml, /data-theme-option="dark"/);
    assert.equal(overlay.status, 200);
    const overlayHtml = await overlay.text();
    assert.match(overlayHtml, /queue-list/);
    assert.match(overlayHtml, /不排了/);
    assert.match(overlayHtml, /overlay-message/);
    assert.match(overlayHtml, /<div class="title-area">[\s\S]*<\/header>\s*<div id="overlay-message"[\s\S]*<\/div>\s*<div id="empty-message"/);
    assert.doesNotMatch(overlayHtml, /停止排队/);
    assert.doesNotMatch(overlayHtml, /LIVE QUEUE|queue-count/);
    assert.match(await (await fetch(`${baseUrl}/overlay.js`)).text(), /当前上号/);
    const controlScript = await (await fetch(`${baseUrl}/control.js`)).text();
    assert.match(controlScript, /data-text-color/);
    assert.match(controlScript, /data-outline-color/);
    assert.match(controlScript, /data-outline-width/);
    assert.match(controlScript, /obs-live-overlay:control-theme/);
    assert.match(controlScript, /\/api\/overlays\/queue\/current/);
    const controlStyles = await controlCss.text();
    assert.match(controlStyles, /:root\[data-theme="light"\]/);
    assert.doesNotMatch(controlStyles, /gradient|box-shadow|backdrop-filter|animation|transition/i);
    for (const match of controlStyles.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const channels = match[1].length === 3
        ? [...match[1]].map((channel) => Number.parseInt(channel.repeat(2), 16))
        : (match[1].match(/.{2}/g) ?? []).map((channel) => Number.parseInt(channel, 16));
      assert.equal(new Set(channels).size, 1, `控制台主题包含非灰度颜色 ${match[0]}`);
    }
    for (const match of controlStyles.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
      assert.equal(match[1], match[2], `控制台主题包含非灰度颜色 ${match[0]}`);
      assert.equal(match[2], match[3], `控制台主题包含非灰度颜色 ${match[0]}`);
    }
    const overlayStyles = await overlayCss.text();
    assert.match(overlayStyles, /\.overlay\s*\{[^}]*background:\s*transparent;/);
    assert.match(overlayStyles, /--current-background:\s*rgba\(0,\s*0,\s*0,\s*\.45\)/);
    assert.match(overlayStyles, /\.queue-item\.current\s*\{[^}]*background:\s*var\(--current-background\)/);
    assert.doesNotMatch(overlayStyles, /\.queue-item\.current\s*\{[^}]*border:\s*3px/);
    assert.match(overlayStyles, /\.queue-header\s*\{[^}]*grid-template-columns:\s*minmax\(118px,\s*2fr\)\s*minmax\(0,\s*3fr\)/);
    assert.match(overlayStyles, /\.stopped-banner\s*\{[^}]*background:\s*transparent;/);
    assert.match(overlayStyles, /\.stopped-banner\s*\{[^}]*border:\s*0;/);
    assert.doesNotMatch(overlayStyles, /#ffd60a|#ff3b30/);
    assert.match(overlayStyles, /-webkit-text-stroke/);
    assert.doesNotMatch(overlayStyles, /linear-gradient|filter:\s*blur|box-shadow/);
    assert.match(overlayStyles, /@keyframes queue-insert/);
    assert.match(overlayStyles, /@keyframes queue-eject/);
    assert.doesNotMatch(overlayStyles, /transition|will-change/i);
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

  it("指定当前上号用户时不改变队列顺序，并支持当前用户出队", async () => {
    await fetch(`${baseUrl}/api/overlays/queue/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "User-B" }),
    });
    const wsUrl = baseUrl.replace("http:", "ws:") + "/ws";
    const socket = new WebSocket(wsUrl);
    await onceMessage(socket);
    const broadcastPromise = onceMessage(socket);

    const response = await fetch(`${baseUrl}/api/overlays/queue/current`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "User-B" }),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.items.map((item: { id: string }) => item.id), ["User-A", "User-B"]);
    assert.equal(state.currentId, "User-B");
    const message = JSON.parse(await broadcastPromise);
    assert.equal(message.state.currentId, "User-B");

    const dequeueResponse = await fetch(`${baseUrl}/api/overlays/queue/dequeue`, { method: "POST" });
    const dequeuedState = await dequeueResponse.json();
    assert.deepEqual(dequeuedState.items, [{ id: "User-A" }]);
    assert.equal(dequeuedState.currentId, "User-A");
    socket.close();

    const missingResponse = await fetch(`${baseUrl}/api/overlays/queue/current`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "Missing" }),
    });
    assert.equal(missingResponse.status, 404);
  });

  it("更新字体设置并通过 WebSocket 广播", async () => {
    const wsUrl = baseUrl.replace("http:", "ws:") + "/ws";
    const socket = new WebSocket(wsUrl);
    await onceMessage(socket);
    const broadcastPromise = onceMessage(socket);

    const response = await fetch(`${baseUrl}/api/overlays/queue/typography/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fontFamily: "serif", fontSize: 38, italic: true, textColor: "#ffee22", outlineColor: "#112233", outlineWidth: 3 }),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.typography.title.fontSize, 38);
    assert.equal(state.typography.title.textColor, "#ffee22");
    assert.equal(state.typography.title.outlineColor, "#112233");
    assert.equal(state.typography.title.outlineWidth, 3);
    const message = JSON.parse(await broadcastPromise);
    assert.equal(message.state.typography.title.fontFamily, "serif");
    socket.close();

    const invalidResponse = await fetch(`${baseUrl}/api/overlays/queue/typography/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outlineWidth: 20 }),
    });
    assert.equal(invalidResponse.status, 400);
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

  it("只允许持有静默启动令牌的请求关闭托管实例", async () => {
    const token = "b".repeat(64);
    const managed = await createOverlayServer({
      dataFile: join(temporaryDirectory, "managed-profiles.json"),
      shutdownToken: token,
    });
    await new Promise<void>((resolve) => managed.server.listen(0, "127.0.0.1", resolve));
    const address = managed.server.address() as AddressInfo;
    const shutdownUrl = `http://127.0.0.1:${address.port}/api/system/shutdown`;

    const rejected = await fetch(shutdownUrl, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    assert.equal(rejected.status, 404);

    const shutdownRequested = once(managed.server, "shutdownRequested");
    const accepted = await fetch(shutdownUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { stopping: true });
    await shutdownRequested;
    await new Promise<void>((resolve, reject) => {
      managed.server.close((error) => error ? reject(error) : resolve());
    });
    managed.sockets.close();
  });
});

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}
