const elements = {
  form: document.querySelector("#add-form"),
  id: document.querySelector("#viewer-id"),
  list: document.querySelector("#queue-list"),
  empty: document.querySelector("#empty-state"),
  count: document.querySelector("#queue-count"),
  navCount: document.querySelector("#nav-count"),
  dequeue: document.querySelector("#dequeue-button"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#overlay-message-input"),
  clearMessage: document.querySelector("#clear-message-button"),
  stopToggle: document.querySelector("#stop-toggle"),
  stopToggleLabel: document.querySelector("#stop-toggle-label"),
  dot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  toasts: document.querySelector("#toast-region"),
};

let state = { items: [], currentId: null, isQueueStopped: false, message: "", revision: 0 };
let socket;
let reconnectTimer;
let reconnectDelay = 500;

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function setState(nextState) {
  state = nextState;
  const hasItems = state.items.length > 0;
  elements.count.textContent = String(state.items.length);
  elements.navCount.textContent = String(state.items.length);
  elements.empty.hidden = hasItems;
  elements.list.hidden = !hasItems;
  elements.dequeue.disabled = !state.currentId;
  elements.stopToggle.classList.toggle("active", state.isQueueStopped);
  elements.stopToggle.setAttribute("aria-checked", String(state.isQueueStopped));
  elements.stopToggleLabel.textContent = state.isQueueStopped ? "已开启" : "已关闭";
  if (document.activeElement !== elements.messageInput) elements.messageInput.value = state.message ?? "";
  elements.clearMessage.disabled = !(state.message ?? "");
  elements.list.replaceChildren(...state.items.map(createRow));
}

function createRow(item, index) {
  const row = document.createElement("li");
  row.className = `queue-row${item.id === state.currentId ? " current" : ""}`;

  const position = document.createElement("span");
  position.className = "position";
  position.textContent = String(index + 1).padStart(2, "0");

  const content = document.createElement("div");
  content.className = "viewer-id";
  const id = document.createElement("strong");
  id.textContent = item.id;
  content.append(id);
  if (item.id === state.currentId) {
    const badge = document.createElement("span");
    badge.className = "current-badge";
    badge.textContent = "CURRENT";
    content.append(badge);
  }
  row.append(position, content);
  return row;
}

async function act(operation) {
  try {
    setState(await operation());
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败");
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = elements.id.value;
  await act(async () => {
    const nextState = await request("/api/overlays/queue/items", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    elements.id.value = "";
    elements.id.focus();
    return nextState;
  });
});

elements.dequeue.addEventListener("click", () => {
  act(() => request("/api/overlays/queue/dequeue", { method: "POST" }));
});

elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => request("/api/overlays/queue/message", {
    method: "PUT",
    body: JSON.stringify({ message: elements.messageInput.value }),
  }));
});

elements.clearMessage.addEventListener("click", () => {
  act(async () => {
    const nextState = await request("/api/overlays/queue/message", {
      method: "PUT",
      body: JSON.stringify({ message: "" }),
    });
    elements.messageInput.value = "";
    return nextState;
  });
});

elements.stopToggle.addEventListener("click", () => {
  act(() => request("/api/overlays/queue/stopped", {
    method: "PUT",
    body: JSON.stringify({ stopped: !state.isQueueStopped }),
  }));
});

function connect() {
  clearTimeout(reconnectTimer);
  setConnection("connecting");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => {
    reconnectDelay = 500;
    setConnection("connected");
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "state.updated" && message.overlayId === "queue") setState(message.state);
    } catch { /* 保留最后一次正确状态。 */ }
  });
  socket.addEventListener("close", () => {
    setConnection("disconnected");
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 8000);
  });
  socket.addEventListener("error", () => socket.close());
}

function setConnection(status) {
  elements.dot.className = `connection-dot ${status}`;
  elements.connectionLabel.textContent = {
    connected: "服务已连接",
    connecting: "正在连接服务",
    disconnected: "连接断开，正在重试",
  }[status];
}

function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  elements.toasts.append(item);
  setTimeout(() => item.remove(), 3500);
}

request("/api/overlays/queue/state").then(setState).catch((error) => toast(error.message));
connect();
