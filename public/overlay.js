const list = document.querySelector("#queue-list");
const empty = document.querySelector("#empty-message");
const stoppedBanner = document.querySelector("#stopped-banner");
const overlayMessage = document.querySelector("#overlay-message");
const connection = document.querySelector("#connection-status");

let socket;
let reconnectTimer;
let reconnectDelay = 500;
let hasRendered = false;

function update(nextState) {
  const message = nextState.message ?? "";
  overlayMessage.textContent = message;
  overlayMessage.hidden = !message;
  stoppedBanner.hidden = !nextState.isQueueStopped;
  const nextItems = nextState.items;
  const nextIds = new Set(nextItems.map((item) => item.id));
  const currentNodes = new Map([...list.querySelectorAll(".queue-item:not(.leaving)")].map((node) => [node.dataset.id, node]));
  const oldPositions = new Map([...currentNodes].map(([id, node]) => [id, node.getBoundingClientRect()]));
  const listRect = list.getBoundingClientRect();

  for (const [id, node] of currentNodes) {
    if (!nextIds.has(id)) {
      const rect = oldPositions.get(id);
      const clone = node.cloneNode(true);
      clone.classList.add("leaving");
      clone.style.top = `${rect.top - listRect.top}px`;
      clone.style.height = `${rect.height}px`;
      clone.addEventListener("animationend", () => clone.remove(), { once: true });
      list.append(clone);
      node.remove();
      currentNodes.delete(id);
    }
  }

  const fragment = document.createDocumentFragment();
  const newIds = new Set();
  nextItems.forEach((item, index) => {
    let node = currentNodes.get(item.id);
    if (!node) {
      node = createItem(item);
      newIds.add(item.id);
    }
    node.classList.toggle("current", item.id === nextState.currentId);
    node.querySelector(".queue-position").textContent = String(index + 1).padStart(2, "0");
    node.querySelector(".queue-name").textContent = item.id;
    fragment.append(node);
  });
  list.prepend(fragment);

  for (const item of nextItems) {
    const node = list.querySelector(`[data-id="${CSS.escape(item.id)}"]:not(.leaving)`);
    if (!node) continue;
    if (newIds.has(item.id)) {
      if (hasRendered) node.classList.add("entering");
      continue;
    }
    const oldRect = oldPositions.get(item.id);
    const newRect = node.getBoundingClientRect();
    if (!oldRect || oldRect.top === newRect.top) continue;
    node.animate(
      [{ transform: `translateY(${oldRect.top - newRect.top}px)` }, { transform: "translateY(0)" }],
      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }

  empty.hidden = nextItems.length > 0;
  hasRendered = true;
}

function createItem(item) {
  const row = document.createElement("li");
  row.className = "queue-item";
  row.dataset.id = item.id;
  const position = document.createElement("span");
  position.className = "queue-position";
  const name = document.createElement("span");
  name.className = "queue-name";
  name.textContent = item.id;
  const current = document.createElement("span");
  current.className = "current-label";
  current.textContent = "当前上号";
  row.append(position, name, current);
  return row;
}

function connect() {
  clearTimeout(reconnectTimer);
  showConnection("正在连接服务…");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => {
    reconnectDelay = 500;
    hideConnection();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "state.updated" && message.overlayId === "queue") update(message.state);
    } catch { /* Ignore malformed messages and keep the last good frame. */ }
  });
  socket.addEventListener("close", () => {
    showConnection("服务连接已断开，正在重试…");
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 8000);
  });
  socket.addEventListener("error", () => socket.close());
}

function showConnection(text) {
  connection.textContent = text;
  connection.classList.add("visible");
}

function hideConnection() {
  connection.classList.remove("visible");
}

fetch("/api/overlays/queue/state")
  .then((response) => {
    if (!response.ok) throw new Error("无法获取初始状态");
    return response.json();
  })
  .then(update)
  .catch(() => showConnection("服务暂时不可用，正在重试…"));
connect();
