import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeTextStyle, ValidationError, type TextStyle } from "./queue-store.js";

export interface MusicSettings {
  enabled: boolean;
  modules: { cover: boolean; status: boolean; title: boolean; artistTitle: boolean };
  typography: { title: TextStyle; artistTitle: TextStyle };
}
export function defaultMusicSettings(): MusicSettings {
  const style: TextStyle = { fontFamily: "system", fontSize: 25, bold: true, textAlign: "left", textColor: "#ffffff", outlineEnabled: false, outlineColor: "#050505", outlineWidth: 1 };
  return { enabled: true, modules: { cover: true, status: true, title: true, artistTitle: true },
    typography: { title: style, artistTitle: { ...style, fontSize: 16, bold: false, textColor: "#d0d6df" } } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("音乐配置必须是对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError("包含未知的音乐配置字段");
}
export function updateMusicSettings(current: MusicSettings, input: unknown): MusicSettings {
  const patch = record(input);
  keys(patch, ["enabled", "modules", "typography"]);
  const next = structuredClone(current);
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") throw new ValidationError("音乐开关必须是布尔值");
    next.enabled = patch.enabled;
  }
  if ("modules" in patch) {
    const modules = record(patch.modules); keys(modules, Object.keys(next.modules));
    for (const [key, value] of Object.entries(modules)) {
      if (typeof value !== "boolean") throw new ValidationError("模块开关必须是布尔值");
      next.modules[key as keyof MusicSettings["modules"]] = value;
    }
  }
  if ("typography" in patch) {
    const typography = record(patch.typography); keys(typography, ["title", "artistTitle"]);
    for (const section of ["title", "artistTitle"] as const) {
      if (section in typography) {
        const style = record(typography[section]); keys(style, Object.keys(next.typography[section]));
        if (Object.values(style).some(value => value === null)) throw new ValidationError("字体属性不能为 null");
        next.typography[section] = normalizeTextStyle(style, next.typography[section]);
      }
    }
  }
  return next;
}
export async function loadMusicSettings(file?: string): Promise<MusicSettings> {
  if (!file) return defaultMusicSettings();
  try { return updateMusicSettings(defaultMusicSettings(), JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultMusicSettings();
    throw error;
  }
}
export async function saveMusicSettings(file: string | undefined, settings: MusicSettings) {
  if (!file) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await rename(`${file}.tmp`, file);
}
