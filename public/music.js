const title = document.querySelector("#title");
const artist = document.querySelector("#artist");
const album = document.querySelector("#album");
const status = document.querySelector("#status");
const cover = document.querySelector("#cover");
let coverUrl = null;
let generation = 0;
const labels = { playing: "正在播放", paused: "已暂停", stopped: "已停止", changing: "正在切歌", opened: "播放器已打开", closed: "播放器已关闭", unknown: "播放状态未知" };
function setCover(url) {
  if (url === coverUrl) return;
  coverUrl = url;
  const current = ++generation;
  cover.hidden = true;
  cover.removeAttribute("src");
  if (!url) return;
  const image = new Image();
  image.onload = () => {
    if (current !== generation) return;
    cover.src = url; cover.hidden = false;
  };
  image.onerror = () => { if (current === generation) coverUrl = null; };
  image.src = url;
}
async function update() {
  try {
    const response = await fetch("/api/music/state", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("读取失败");
    const data = await response.json();
    const session = data.session;
    const playback = session?.playback?.status ?? "unknown";
    document.body.dataset.status = playback;
    status.textContent = session ? labels[playback] ?? labels.unknown : "等待播放器";
    title.textContent = session ? session.media?.title || "等待歌曲信息" : "暂无正在播放的音乐";
    artist.textContent = session ? session.media?.artist || "未知歌手" : "打开 QQ 音乐并播放歌曲";
    album.textContent = session?.media?.albumTitle || "";
    setCover(data.coverUrl);
  } catch {
    document.body.dataset.status = "disconnected";
    status.textContent = "连接中断 · 正在重连";
    title.textContent = "音乐服务暂不可用";
    artist.textContent = "请确认音乐服务正在运行";
    album.textContent = "";
    setCover(null);
  } finally { setTimeout(update, 1000); }
}
void update();
