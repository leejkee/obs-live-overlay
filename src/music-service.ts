import { createRequire } from "node:module";
import { loadMusicSettings, saveMusicSettings, updateMusicSettings } from "./music-settings.js";
import type { NativeMonitor, NativeState } from "../native/index.cjs";

// Prefer QQ Music; otherwise use the Windows current session, then a playing session.
export function selectMusicSession(state: NativeState) {
  const sessions = state.sessions;
  const qq = sessions.filter((session) => /qqmusic|qq音乐/i.test(session.sourceAppUserModelId));
  return qq.find((session) => session.playback?.status === "playing") ?? qq[0]
    ?? sessions.find((session) => session.sessionId === state.currentSessionId)
    ?? sessions.find((session) => session.playback?.status === "playing") ?? sessions[0] ?? null;
}

// Some players omit or mislabel the WinRT stream MIME type.
export function coverContentType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function createMusicService(
  providedMonitor?: NativeMonitor,
  options: { settingsFile?: string } = {},
) {
  const require = createRequire(import.meta.url);
  let settings = await loadMusicSettings(options.settingsFile);
  let monitor = providedMonitor;
  let running = false;
  let monitorError: string | null = null;
  let closing: Promise<void> | undefined;
  let mutations: Promise<unknown> = Promise.resolve();

  async function setRunning(enabled: boolean) {
    if (!enabled) {
      const wasRunning = running;
      running = false;
      if (wasRunning) await monitor?.stop();
      monitorError = null;
      return;
    }
    if (running) return;
    try {
      monitor ??= (require("../native/index.cjs") as typeof import("../native/index.cjs")).createMonitor(() => {});
      await monitor.start();
      running = true;
      monitorError = null;
    } catch (error) {
      running = false;
      monitorError = (error as { code?: string }).code ?? "ERR_SMTC_OPERATION_FAILED";
      await monitor?.stop();
      throw error;
    }
  }

  // Keep the HTTP controller available even when the native backend cannot start.
  if (settings.enabled) await setRunning(true).catch(() => {});

  function snapshot() {
    const session = running && monitor ? selectMusicSession(monitor.getState()) : null;
    const thumbnailId = session?.media?.thumbnailId;
    return {
      settings,
      running,
      monitorError,
      session,
      coverUrl: settings.modules.cover && session && thumbnailId
        ? `/api/music/cover?session=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(thumbnailId)}`
        : null,
    };
  }

  function update(input: unknown) {
    const operation = mutations.then(async () => {
      if (closing) throw new Error("音乐服务正在关闭");
      const next = updateMusicSettings(settings, input);
      const previous = settings;
      const changeRunning = Object.hasOwn(input as object, "enabled");
      if (changeRunning) await setRunning(next.enabled);
      try {
        await saveMusicSettings(options.settingsFile, next);
      } catch (error) {
        if (changeRunning) await setRunning(previous.enabled).catch(() => {});
        throw error;
      }
      settings = next;
      return snapshot();
    });
    mutations = operation.catch(() => {});
    return operation;
  }

  async function getThumbnail(sessionId: string, thumbnailId: string) {
    if (!running || !monitor || !settings.modules.cover) return null;
    return monitor.getThumbnail(sessionId, thumbnailId);
  }

  function close() {
    return closing ??= (async () => {
      await mutations;
      await setRunning(false);
    })();
  }

  return { close, getThumbnail, snapshot, update };
}
