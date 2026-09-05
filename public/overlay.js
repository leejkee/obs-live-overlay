const list = document.querySelector("#queue-list");
const empty = document.querySelector("#empty-message");
const queueTitle = document.querySelector("#queue-title");
const stoppedBanner = document.querySelector("#stopped-banner");
const overlayMessage = document.querySelector("#overlay-message");
const connection = document.querySelector("#connection-status");
const root = document.documentElement;

const fontStacks = {
  system: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',
  modern: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  serif: '"Noto Serif CJK SC", "Songti SC", SimSun, serif',
  rounded: '"Arial Rounded MT Bold", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", "Microsoft YaHei", monospace',
};
const boldWeights = { title: 700, message: 800, stopped: 900, queue: 750 };
const defaultTypography = {
  title: { fontFamily: "system", fontSize: 30, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  message: { fontFamily: "system", fontSize: 22, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  stopped: { fontFamily: "system", fontSize: 27, bold: true, textAlign: "center", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  queue: { fontFamily: "system", fontSize: 24, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
};

let socket;
let reconnectTimer;
let reconnectDelay = 500;
let hasRendered = false;

function update(nextState) {
  applyTypography(nextState.typography);
  queueTitle.textContent = nextState.content?.title ?? "等候队列";
  stoppedBanner.textContent = nextState.content?.stopped ?? "不排了";
  const message = nextState.message ?? "";
  overlayMessage.textContent = message;
  overlayMessage.hidden = !message;
  stoppedBanner.hidden = !nextState.isQueueStopped;
  const nextItems = nextState.items;
  const nextIds = new Set(nextItems.map((item) => item.id));
  const currentNodes = new Map(
    [...list.querySelectorAll(".queue-item:not(.ejecting)")].map((node) => [node.dataset.id, node]),
  );
  const oldPositions = new Map(
    [...currentNodes].map(([id, node]) => [id, node.getBoundingClientRect()]),
  );
  const listRect = list.getBoundingClientRect();

  for (const [id, node] of currentNodes) {
    if (nextIds.has(id)) continue;
    const rect = oldPositions.get(id);
    const clone = node.cloneNode(true);
    clone.classList.remove("inserting");
    clone.classList.add("ejecting");
    clone.style.top = `${rect.top - listRect.top}px`;
    clone.style.height = `${rect.height}px`;
    clone.addEventListener("animationend", () => clone.remove(), { once: true });
    setTimeout(() => clone.remove(), 500);
    list.append(clone);
    node.remove();
    currentNodes.delete(id);
  }

  const fragment = document.createDocumentFragment();
  nextItems.forEach((item, index) => {
    let node = currentNodes.get(item.id);
    if (!node) {
      node = createItem(item);
      if (hasRendered) {
        node.classList.add("inserting");
        node.addEventListener("animationend", () => node.classList.remove("inserting"), { once: true });
      }
    }
    node.classList.toggle("current", item.id === nextState.currentId);
    node.querySelector(".queue-position").textContent = String(index + 1).padStart(2, "0");
    node.querySelector(".queue-name").textContent = item.id;
    fragment.append(node);
  });
  list.prepend(fragment);

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const [id, node] of currentNodes) {
      const oldRect = oldPositions.get(id);
      const newRect = node.getBoundingClientRect();
      if (!oldRect || oldRect.top === newRect.top) continue;
      node.animate(
        [{ transform: `translateY(${oldRect.top - newRect.top}px)` }, { transform: "translateY(0)" }],
        { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" },
      );
    }
  }

  empty.hidden = nextItems.length > 0;
  hasRendered = true;
}

function applyTypography(typography = defaultTypography) {
  for (const section of Object.keys(defaultTypography)) {
    const style = { ...defaultTypography[section], ...typography?.[section] };
    const outlineWidth = style.outlineEnabled ? style.outlineWidth : 0;
    root.style.setProperty(`--${section}-font-family`, fontStacks[style.fontFamily] ?? fontStacks.system);
    root.style.setProperty(`--${section}-font-size`, `${style.fontSize}px`);
    root.style.setProperty(`--${section}-font-weight`, String(style.bold ? boldWeights[section] : 400));
    root.style.setProperty(`--${section}-text-align`, style.textAlign);
    root.style.setProperty(`--${section}-text-color`, style.textColor);
    root.style.setProperty(`--${section}-outline-color`, style.outlineColor);
    root.style.setProperty(`--${section}-outline-width`, `${outlineWidth}px`);
    root.style.setProperty(`--${section}-outline-offset`, `${-outlineWidth}px`);
  }
  const stoppedAlignment = typography?.stopped?.textAlign ?? defaultTypography.stopped.textAlign;
  root.style.setProperty("--stopped-content-align", {
    left: "flex-start",
    center: "center",
    right: "flex-end",
  }[stoppedAlignment]);
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
