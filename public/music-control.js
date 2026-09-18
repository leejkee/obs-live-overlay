import { typographyEditorMarkup } from "/typography-editor.js";

const enabled = document.querySelector("#music-enabled");
const notice = document.querySelector("#music-notice");
const runtime = document.querySelector("#music-runtime-status");
const navStatus = document.querySelector("#music-nav-status");
const dialog = document.querySelector("#music-style-dialog");
const editor = document.querySelector("#music-typography-editor");
const preview = document.querySelector("#music-preview-frame");
const previewLink = document.querySelector("#music-preview-link");
const overlayUrl = document.querySelector("#music-overlay-url");
const labels = { title: "歌曲名称", artistTitle: "歌手名称 - 歌曲名称" };
editor.innerHTML = typographyEditorMarkup();

let settings;
let selected = "title";
let pending = 0;
let writes = Promise.resolve();
let failure = false;

function message(text, error = false) {
  notice.textContent = text;
  notice.dataset.error = String(error);
}

async function request(path, options) {
  const response = await fetch(path, { ...options, cache: "no-store", signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error([data.error, data.code].filter(Boolean).join(" · "));
  return data;
}

function render(data) {
  settings = data.settings;
  enabled.checked = settings.enabled;
  enabled.disabled = false;
  navStatus.textContent = data.running ? "开" : "关";
  for (const input of document.querySelectorAll("[data-music-module]")) {
    input.checked = settings.modules[input.dataset.musicModule];
    input.disabled = false;
  }
  for (const button of document.querySelectorAll("[data-music-style]")) button.disabled = false;
  runtime.textContent = data.monitorError ? `监控启动失败：${data.monitorError}，可关闭后重新开启。`
    : data.running ? "音乐监控已开启" : "音乐监控已关闭";
  if (data.overlayUrl && preview.dataset.url !== data.overlayUrl) {
    preview.dataset.url = data.overlayUrl;
    preview.src = data.overlayUrl;
    previewLink.href = data.overlayUrl;
    overlayUrl.textContent = data.overlayUrl;
  }
}

function save(patch) {
  pending++;
  message("正在保存…");
  writes = writes.then(async () => {
    try {
      const data = await request("/api/overlays/music/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      failure = false;
      if (pending === 1) {
        render(data);
        message("已保存，OBS 画面将同步更新");
      }
    } catch (error) {
      failure = true;
      message(error.message, true);
      try {
        render(await request("/api/overlays/music/state"));
        if (dialog.open) syncEditor();
      } catch { /* 轮询会继续重试。 */ }
    } finally {
      pending--;
    }
  });
}

enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
for (const input of document.querySelectorAll("[data-music-module]")) {
  input.addEventListener("change", () => save({ modules: { [input.dataset.musicModule]: input.checked } }));
}

function outputs() {
  for (const [selector, output, box] of [
    ["font-size", "font-size-output", "font-size-box"],
    ["outline-width", "outline-width-output", "outline-width-box"],
  ]) {
    const value = editor.querySelector(`[data-${selector}]`).value;
    editor.querySelector(`[data-${output}]`).textContent = `${value} px`;
    editor.querySelector(`[data-${box}]`).textContent = value;
  }
  for (const key of ["text-color", "outline-color"]) {
    editor.querySelector(`[data-${key}-value]`).textContent = editor.querySelector(`[data-${key}]`).value;
  }
  const outline = editor.querySelector("[data-outline-enabled]").checked;
  for (const input of editor.querySelectorAll("[data-outline-controls] input")) input.disabled = !outline;
}

function syncEditor() {
  const style = settings.typography[selected];
  for (const [attr, key] of [
    ["font-family", "fontFamily"],
    ["font-size", "fontSize"],
    ["text-color", "textColor"],
    ["outline-color", "outlineColor"],
    ["outline-width", "outlineWidth"],
  ]) editor.querySelector(`[data-${attr}]`).value = style[key];
  editor.querySelector("[data-outline-enabled]").checked = style.outlineEnabled;
  editor.querySelector("[data-format]").setAttribute("aria-pressed", String(style.bold));
  for (const button of editor.querySelectorAll("[data-align]")) {
    button.setAttribute("aria-pressed", String(button.dataset.align === style.textAlign));
  }
  outputs();
}

for (const button of document.querySelectorAll("[data-music-style]")) {
  button.addEventListener("click", async () => {
    await writes;
    selected = button.dataset.musicStyle;
    document.querySelector("#music-style-label").textContent = `当前编辑：${labels[selected]}`;
    syncEditor();
    dialog.showModal();
  });
}
document.querySelector("#close-music-style").addEventListener("click", () => dialog.close());
editor.addEventListener("input", outputs);
editor.addEventListener("change", event => {
  const fields = {
    fontFamily: "font-family",
    fontSize: "font-size",
    textColor: "text-color",
    outlineEnabled: "outline-enabled",
    outlineColor: "outline-color",
    outlineWidth: "outline-width",
  };
  for (const [key, attr] of Object.entries(fields)) {
    if (!event.target.matches(`[data-${attr}]`)) continue;
    const value = key === "outlineEnabled" ? event.target.checked
      : ["fontSize", "outlineWidth"].includes(key) ? Number(event.target.value) : event.target.value;
    save({ typography: { [selected]: { [key]: value } } });
  }
  outputs();
});
editor.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.format) {
    const bold = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(bold));
    save({ typography: { [selected]: { bold } } });
  } else if (button.dataset.align) {
    for (const option of editor.querySelectorAll("[data-align]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    save({ typography: { [selected]: { textAlign: button.dataset.align } } });
  }
});

async function poll() {
  if (!pending) {
    try {
      const data = await request("/api/overlays/music/state");
      if (!pending) {
        render(data);
        if (dialog.open && !editor.contains(document.activeElement)) syncEditor();
      }
      if (!failure && !pending) message("已连接 · 修改自动保存");
    } catch {
      message("连接中断，正在重连…", true);
      navStatus.textContent = "?";
    }
  }
  setTimeout(poll, 1000);
}
void poll();
