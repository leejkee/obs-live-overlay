import { typographyEditorMarkup } from "/typography-editor.js";
const elements = {
  form: document.querySelector("#add-form"),
  id: document.querySelector("#viewer-id"),
  list: document.querySelector("#queue-list"),
  queueOrganizer: document.querySelector("#queue-organizer"),
  empty: document.querySelector("#empty-state"),
  count: document.querySelector("#queue-count"),
  navCount: document.querySelector("#nav-count"),
  dequeue: document.querySelector("#dequeue-button"),
  moveUp: document.querySelector("#move-up-button"),
  moveDown: document.querySelector("#move-down-button"),
  profileSelect: document.querySelector("#profile-select"),
  createProfile: document.querySelector("#create-profile-button"),
  renameProfile: document.querySelector("#rename-profile-button"),
  deleteProfile: document.querySelector("#delete-profile-button"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#overlay-message-input"),
  clearMessage: document.querySelector("#clear-message-button"),
  contentForms: [...document.querySelectorAll("[data-overlay-content-form]")],
  contentInputs: [...document.querySelectorAll("[data-overlay-content-input]")],
  stopToggle: document.querySelector("#stop-toggle"),
  stopToggleLabel: document.querySelector("#stop-toggle-label"),
  dot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  toasts: document.querySelector("#toast-region"),
  typographyEditor: document.querySelector("#typography-editor"),
  typographySectionLabel: document.querySelector("#selected-style-label"),
  styleDialog: document.querySelector("#style-dialog"),
  closeStyleDialog: document.querySelector("#close-style-dialog"),
  sectionSelectors: [...document.querySelectorAll("[data-select-section]")],
  themeOptions: [...document.querySelectorAll("[data-theme-option]")],
};

const themeStorageKey = "obs-live-overlay:control-theme";

function setTheme(theme, persist = false) {
  const selectedTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selectedTheme;
  for (const option of elements.themeOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.themeOption === selectedTheme));
  }
  if (persist) {
    try { localStorage.setItem(themeStorageKey, selectedTheme); } catch { /* 主题仍可在当前页面生效。 */ }
  }
}

for (const option of elements.themeOptions) {
  option.addEventListener("click", () => setTheme(option.dataset.themeOption, true));
}

setTheme(document.documentElement.dataset.theme);

const defaultTypography = {
  title: { fontFamily: "system", fontSize: 30, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  message: { fontFamily: "system", fontSize: 22, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  stopped: { fontFamily: "system", fontSize: 27, bold: true, textAlign: "center", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
  queue: { fontFamily: "system", fontSize: 24, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: true, outlineColor: "#050505", outlineWidth: 1 },
};
const typographySectionLabels = {
  queue: "队列内容",
  title: "队列标题",
  message: "Overlay 消息",
  stopped: "停止排队提示",
};
let typographyTimer;
let selectedTypographySection = null;
let selectedQueueItemId = null;

let state = {
  items: [],
  currentId: null,
  isQueueStopped: false,
  message: "",
  content: { title: "等候队列", stopped: "不排了" },
  typography: defaultTypography,
  revision: 0,
};
let profilesState = { profiles: [], activeProfileId: "" };
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
  elements.queueOrganizer.hidden = !hasItems;
  if (!state.items.some((item) => item.id === selectedQueueItemId)) selectedQueueItemId = null;
  elements.dequeue.disabled = !state.currentId;
  elements.stopToggle.classList.toggle("active", state.isQueueStopped);
  elements.stopToggle.setAttribute("aria-checked", String(state.isQueueStopped));
  elements.stopToggleLabel.textContent = state.isQueueStopped ? "显示停止提示" : "显示队列标题";
  if (document.activeElement !== elements.messageInput) elements.messageInput.value = state.message ?? "";
  for (const input of elements.contentInputs) {
    if (document.activeElement !== input) input.value = state.content?.[input.dataset.overlayContentInput] ?? "";
  }
  elements.clearMessage.disabled = !(state.message ?? "");
  elements.list.replaceChildren(...state.items.map(createRow));
  updateQueueOrderControls();
  syncTypographyEditor();
}

function initializeTypographyEditor() {
  const editor = elements.typographyEditor;
  editor.innerHTML = typographyEditorMarkup();

  editor.addEventListener("input", (event) => {
    if (!event.target.matches("[data-font-size], [data-text-color], [data-outline-color], [data-outline-width]")) return;
    if (event.target.matches("[data-font-size]")) updateSizeOutputs(editor, event.target.value);
    updateRenderingOutputs(editor);
    setTypographySaveState(editor, "saving");
    clearTimeout(typographyTimer);
    typographyTimer = setTimeout(saveTypography, 220);
  });
  editor.addEventListener("change", (event) => {
    if (!event.target.matches("[data-font-family], [data-font-size], [data-text-color], [data-outline-enabled], [data-outline-color], [data-outline-width]")) return;
    if (event.target.matches("[data-outline-enabled]")) updateOutlineControlsState(editor);
    clearTimeout(typographyTimer);
    void saveTypography();
  });
  editor.addEventListener("click", (event) => {
    const formatButton = event.target.closest("[data-format]");
    if (formatButton) {
      formatButton.setAttribute("aria-pressed", String(formatButton.getAttribute("aria-pressed") !== "true"));
      void saveTypography();
      return;
    }
    const alignButton = event.target.closest("[data-align]");
    if (!alignButton) return;
    for (const button of editor.querySelectorAll("[data-align]")) {
      button.setAttribute("aria-pressed", String(button === alignButton));
    }
    void saveTypography();
  });

  for (const selector of elements.sectionSelectors) {
    selector.addEventListener("click", () => openTypographyEditor(selector.dataset.selectSection));
  }
  elements.closeStyleDialog.addEventListener("click", () => elements.styleDialog.close());
  elements.styleDialog.addEventListener("click", (event) => {
    if (event.target !== elements.styleDialog) return;
    const bounds = elements.styleDialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) elements.styleDialog.close();
  });
}

function openTypographyEditor(section) {
  if (!defaultTypography[section]) return;
  clearTimeout(typographyTimer);
  selectedTypographySection = section;
  elements.typographyEditor.dataset.typographySection = section;
  elements.typographySectionLabel.textContent = typographySectionLabels[section];
  setTypographySaveState(elements.typographyEditor, "idle");
  syncTypographyEditor();
  if (!elements.styleDialog.open) elements.styleDialog.showModal();
}

function syncTypographyEditor() {
  const editor = elements.typographyEditor;
  if (!selectedTypographySection || !editor.querySelector("[data-font-family]")) return;
  const style = { ...defaultTypography[selectedTypographySection], ...state.typography?.[selectedTypographySection] };
  editor.querySelector("[data-font-family]").value = style.fontFamily;
  editor.querySelector("[data-font-size]").value = String(style.fontSize);
  updateSizeOutputs(editor, style.fontSize);
  editor.querySelector('[data-format="bold"]').setAttribute("aria-pressed", String(style.bold));
  for (const button of editor.querySelectorAll("[data-align]")) {
    button.setAttribute("aria-pressed", String(button.dataset.align === style.textAlign));
  }
  editor.querySelector("[data-text-color]").value = style.textColor;
  editor.querySelector("[data-outline-enabled]").checked = style.outlineEnabled;
  editor.querySelector("[data-outline-color]").value = style.outlineColor;
  editor.querySelector("[data-outline-width]").value = String(style.outlineWidth);
  updateOutlineControlsState(editor);
  updateRenderingOutputs(editor);
}

function updateSizeOutputs(editor, value) {
  editor.querySelector("[data-font-size-output]").textContent = `${value} px`;
  editor.querySelector("[data-font-size-box]").textContent = value;
}

function updateRenderingOutputs(editor) {
  const textColor = editor.querySelector("[data-text-color]").value;
  const outlineColor = editor.querySelector("[data-outline-color]").value;
  const outlineWidth = editor.querySelector("[data-outline-width]").value;
  editor.querySelector("[data-text-color-value]").textContent = textColor;
  editor.querySelector("[data-outline-color-value]").textContent = outlineColor;
  editor.querySelector("[data-outline-width-output]").textContent = `${outlineWidth} px`;
  editor.querySelector("[data-outline-width-box]").textContent = outlineWidth;
}

function updateOutlineControlsState(editor) {
  const enabled = editor.querySelector("[data-outline-enabled]").checked;
  const controls = editor.querySelector("[data-outline-controls]");
  controls.classList.toggle("disabled", !enabled);
  for (const input of controls.querySelectorAll("input")) input.disabled = !enabled;
}

function readTypography(editor) {
  return {
    fontFamily: editor.querySelector("[data-font-family]").value,
    fontSize: Number(editor.querySelector("[data-font-size]").value),
    bold: editor.querySelector('[data-format="bold"]').getAttribute("aria-pressed") === "true",
    textAlign: editor.querySelector('[data-align][aria-pressed="true"]').dataset.align,
    textColor: editor.querySelector("[data-text-color]").value,
    outlineEnabled: editor.querySelector("[data-outline-enabled]").checked,
    outlineColor: editor.querySelector("[data-outline-color]").value,
    outlineWidth: Number(editor.querySelector("[data-outline-width]").value),
  };
}

async function saveTypography() {
  clearTimeout(typographyTimer);
  const editor = elements.typographyEditor;
  const section = selectedTypographySection;
  setTypographySaveState(editor, "saving");
  try {
    const nextState = await request(`/api/overlays/queue/typography/${encodeURIComponent(section)}`, {
      method: "PUT",
      body: JSON.stringify(readTypography(editor)),
    });
    setState(nextState);
    setTypographySaveState(editor, "saved");
    setTimeout(() => setTypographySaveState(editor, "idle"), 1200);
  } catch (error) {
    toast(error instanceof Error ? error.message : "字体设置保存失败");
    syncTypographyEditor();
    setTypographySaveState(editor, "idle");
  }
}

function setTypographySaveState(editor, status) {
  const label = editor.querySelector("[data-save-state]");
  label.className = `save-state${status === "idle" ? "" : ` ${status}`}`;
  label.textContent = { idle: "自动保存", saving: "保存中…", saved: "已保存" }[status];
}

function setProfiles(nextProfiles, activeProfileId) {
  profilesState = { profiles: nextProfiles, activeProfileId };
  elements.profileSelect.replaceChildren(...nextProfiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    return option;
  }));
  elements.profileSelect.value = activeProfileId;
  const activeProfile = nextProfiles.find((profile) => profile.id === activeProfileId);
  elements.renameProfile.disabled = !activeProfile;
  elements.deleteProfile.disabled = !activeProfile || activeProfile.isDefault;
}

function applyServerMessage(message) {
  if (message.type !== "state.updated" || message.overlayId !== "queue") return;
  setProfiles(message.profiles, message.activeProfileId);
  setState(message.state);
}

function createRow(item, index) {
  const row = document.createElement("li");
  const isSelected = item.id === selectedQueueItemId;
  row.className = `queue-row${item.id === state.currentId ? " current" : ""}${isSelected ? " selected" : ""}`;
  row.dataset.itemId = item.id;
  row.dataset.accessibleLabel = `${item.id}，序号 ${index + 1}${item.id === state.currentId ? "，当前上号" : ""}`;
  row.tabIndex = 0;
  updateQueueRowAccessibility(row, isSelected);
  row.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    selectQueueItem(item.id);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectQueueItem(item.id);
  });

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
    badge.textContent = "当前上号";
    content.append(badge);
  } else {
    const setCurrentButton = document.createElement("button");
    setCurrentButton.className = "set-current-button";
    setCurrentButton.type = "button";
    setCurrentButton.textContent = "设为当前";
    setCurrentButton.setAttribute("aria-label", `将 ${item.id} 设为当前上号`);
    setCurrentButton.addEventListener("click", () => {
      act(() => request("/api/overlays/queue/current", {
        method: "PUT",
        body: JSON.stringify({ id: item.id }),
      }));
    });
    content.append(setCurrentButton);
  }
  row.append(position, content);
  return row;
}

function selectQueueItem(id) {
  selectedQueueItemId = id;
  for (const row of elements.list.querySelectorAll(".queue-row")) {
    const isSelected = row.dataset.itemId === id;
    row.classList.toggle("selected", isSelected);
    updateQueueRowAccessibility(row, isSelected);
  }
  updateQueueOrderControls();
}

function updateQueueRowAccessibility(row, isSelected) {
  row.setAttribute("aria-label", `${row.dataset.accessibleLabel}${isSelected ? "，已选择" : "，按回车选择"}`);
}

function updateQueueOrderControls() {
  const selectedIndex = state.items.findIndex((item) => item.id === selectedQueueItemId);
  elements.moveUp.disabled = selectedIndex <= 0;
  elements.moveDown.disabled = selectedIndex < 0 || selectedIndex >= state.items.length - 1;
}

function moveSelectedQueueItem(direction) {
  if (!selectedQueueItemId) return;
  act(() => request("/api/overlays/queue/items/order", {
    method: "PUT",
    body: JSON.stringify({ id: selectedQueueItemId, direction }),
  }));
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

elements.moveUp.addEventListener("click", () => moveSelectedQueueItem("up"));
elements.moveDown.addEventListener("click", () => moveSelectedQueueItem("down"));

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

for (const form of elements.contentForms) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const section = form.dataset.overlayContentForm;
    const input = form.querySelector(`[data-overlay-content-input="${section}"]`);
    act(() => request(`/api/overlays/queue/content/${encodeURIComponent(section)}`, {
      method: "PUT",
      body: JSON.stringify({ content: input.value }),
    }));
  });
}

elements.stopToggle.addEventListener("click", () => {
  act(() => request("/api/overlays/queue/stopped", {
    method: "PUT",
    body: JSON.stringify({ stopped: !state.isQueueStopped }),
  }));
});

elements.profileSelect.addEventListener("change", () => {
  profileAct(() => request("/api/profiles/active", {
    method: "PUT",
    body: JSON.stringify({ profileId: elements.profileSelect.value }),
  }));
});

elements.createProfile.addEventListener("click", () => {
  const name = window.prompt("请输入新 Profile 名称");
  if (name !== null) {
    profileAct(() => request("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name }),
    }));
  }
});

elements.renameProfile.addEventListener("click", () => {
  const profile = profilesState.profiles.find((item) => item.id === profilesState.activeProfileId);
  if (!profile) return;
  const name = window.prompt("请输入新的 Profile 名称", profile.name);
  if (name !== null) {
    profileAct(() => request(`/api/profiles/${encodeURIComponent(profile.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }));
  }
});

elements.deleteProfile.addEventListener("click", () => {
  const profile = profilesState.profiles.find((item) => item.id === profilesState.activeProfileId);
  if (!profile || profile.isDefault) return;
  if (window.confirm(`确定删除 Profile“${profile.name}”及其全部队列数据吗？`)) {
    profileAct(() => request(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" }));
  }
});

async function profileAct(operation) {
  try {
    applyServerMessage(await operation());
  } catch (error) {
    toast(error instanceof Error ? error.message : "Profile 操作失败");
    setProfiles(profilesState.profiles, profilesState.activeProfileId);
  }
}

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
      applyServerMessage(message);
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

Promise.all([
  request("/api/overlays/queue/state"),
  request("/api/profiles"),
]).then(([queueState, profileState]) => {
  setProfiles(profileState.profiles, profileState.activeProfileId);
  setState(queueState);
}).catch((error) => toast(error.message));
connect();

initializeTypographyEditor();
