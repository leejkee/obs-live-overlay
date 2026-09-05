export interface QueueItem {
  id: string;
}

export const fontFamilies = ["system", "modern", "serif", "rounded", "mono"] as const;
export const textAlignments = ["left", "center", "right"] as const;
export const typographySections = ["title", "message", "stopped", "queue"] as const;
export const contentSections = ["title", "stopped"] as const;

export type FontFamily = typeof fontFamilies[number];
export type TextAlignment = typeof textAlignments[number];
export type TypographySection = typeof typographySections[number];
export type ContentSection = typeof contentSections[number];

export interface TextStyle {
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textAlign: TextAlignment;
  textColor: string;
  outlineColor: string;
  outlineWidth: number;
}

export type TypographySettings = Record<TypographySection, TextStyle>;
export type ContentSettings = Record<ContentSection, string>;

export interface QueueState {
  items: QueueItem[];
  currentId: string | null;
  isQueueStopped: boolean;
  message: string;
  content: ContentSettings;
  typography: TypographySettings;
  revision: number;
}

export interface PersistedQueueState {
  items: QueueItem[];
  currentId?: string | null;
  isQueueStopped: boolean;
  message: string;
  content?: Partial<ContentSettings>;
  typography?: TypographySettings;
  revision: number;
}

export class QueueStore {
  readonly #items: QueueItem[];
  #currentId: string | null;
  #isQueueStopped: boolean;
  #message: string;
  #content: ContentSettings;
  #typography: TypographySettings;
  #revision: number;

  constructor(initial?: PersistedQueueState) {
    this.#items = initial?.items.map((item) => ({ ...item })) ?? [];
    this.#currentId = normalizeInitialCurrentId(initial?.currentId, this.#items);
    this.#isQueueStopped = initial?.isQueueStopped ?? false;
    this.#message = initial?.message ?? "";
    this.#content = normalizeContent(initial?.content);
    this.#typography = normalizeTypography(initial?.typography);
    this.#revision = initial?.revision ?? 0;
  }

  snapshot(): QueueState {
    return {
      items: this.#items.map((item) => ({ ...item })),
      currentId: this.#currentId,
      isQueueStopped: this.#isQueueStopped,
      message: this.#message,
      content: { ...this.#content },
      typography: cloneTypography(this.#typography),
      revision: this.#revision,
    };
  }

  persistedState(): PersistedQueueState {
    return {
      items: this.#items.map((item) => ({ ...item })),
      currentId: this.#currentId,
      isQueueStopped: this.#isQueueStopped,
      message: this.#message,
      content: { ...this.#content },
      typography: cloneTypography(this.#typography),
      revision: this.#revision,
    };
  }

  enqueue(value: unknown): QueueItem {
    const id = normalizeId(value);
    if (this.#items.some((item) => item.id === id)) {
      throw new ConflictError("该 ID 已在队列中");
    }
    const item = { id };
    this.#items.push(item);
    if (this.#currentId === null) this.#currentId = item.id;
    this.#revision += 1;
    return { ...item };
  }

  dequeue(): QueueItem | null {
    if (this.#currentId === null) return null;
    const currentIndex = this.#items.findIndex((item) => item.id === this.#currentId);
    if (currentIndex < 0) return null;
    const [item] = this.#items.splice(currentIndex, 1);
    this.#currentId = this.#items[currentIndex]?.id ?? this.#items[0]?.id ?? null;
    this.#revision += 1;
    return { ...item };
  }

  setCurrent(value: unknown): QueueItem {
    const id = normalizeId(value);
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) throw new NotFoundError("该 ID 不在队列中");
    if (this.#currentId !== id) {
      this.#currentId = id;
      this.#revision += 1;
    }
    return { ...item };
  }

  setQueueStopped(value: unknown): boolean {
    if (typeof value !== "boolean") throw new ValidationError("停止排队状态必须是布尔值");
    if (this.#isQueueStopped !== value) {
      this.#isQueueStopped = value;
      this.#revision += 1;
    }
    return this.#isQueueStopped;
  }

  setMessage(value: unknown): string {
    if (typeof value !== "string") throw new ValidationError("消息必须是字符串");
    const message = value.trim();
    if (message.length > 120) throw new ValidationError("消息不能超过 120 个字符");
    if (this.#message !== message) {
      this.#message = message;
      this.#revision += 1;
    }
    return this.#message;
  }

  setContent(sectionValue: unknown, value: unknown): string {
    const section = normalizeContentSection(sectionValue);
    const content = normalizeContentValue(value);
    if (this.#content[section] !== content) {
      this.#content[section] = content;
      this.#revision += 1;
    }
    return this.#content[section];
  }

  setTypography(sectionValue: unknown, value: unknown): TextStyle {
    const section = normalizeTypographySection(sectionValue);
    const current = this.#typography[section];
    const next = normalizeTextStyle(value, current);
    if (!sameTextStyle(current, next)) {
      this.#typography[section] = next;
      this.#revision += 1;
    }
    return { ...this.#typography[section] };
  }
}

export function createDefaultContent(): ContentSettings {
  return { title: "等候队列", stopped: "不排了" };
}

export function normalizeContent(value: unknown): ContentSettings {
  const defaults = createDefaultContent();
  if (value === undefined) return defaults;
  if (!isRecord(value)) throw new ValidationError("显示内容格式无效");
  return {
    title: value.title === undefined ? defaults.title : normalizeContentValue(value.title),
    stopped: value.stopped === undefined ? defaults.stopped : normalizeContentValue(value.stopped),
  };
}

export function createDefaultTypography(): TypographySettings {
  return {
    title: { fontFamily: "system", fontSize: 30, bold: true, italic: false, textAlign: "left", textColor: "#ffffff", outlineColor: "#050505", outlineWidth: 1 },
    message: { fontFamily: "system", fontSize: 22, bold: true, italic: false, textAlign: "left", textColor: "#ffffff", outlineColor: "#050505", outlineWidth: 1 },
    stopped: { fontFamily: "system", fontSize: 27, bold: true, italic: false, textAlign: "center", textColor: "#ffffff", outlineColor: "#050505", outlineWidth: 1 },
    queue: { fontFamily: "system", fontSize: 24, bold: true, italic: false, textAlign: "left", textColor: "#ffffff", outlineColor: "#050505", outlineWidth: 1 },
  };
}

export function normalizeTypography(value: unknown): TypographySettings {
  const defaults = createDefaultTypography();
  if (value === undefined) return defaults;
  if (!isRecord(value)) throw new ValidationError("字体设置格式无效");
  return {
    title: normalizeTextStyle(value.title, defaults.title),
    message: normalizeTextStyle(value.message, defaults.message),
    stopped: normalizeTextStyle(value.stopped, defaults.stopped),
    queue: normalizeTextStyle(value.queue, defaults.queue),
  };
}

function normalizeTypographySection(value: unknown): TypographySection {
  if (typeof value !== "string" || !typographySections.includes(value as TypographySection)) {
    throw new ValidationError("字体设置区域无效");
  }
  return value as TypographySection;
}

function normalizeContentSection(value: unknown): ContentSection {
  if (typeof value !== "string" || !contentSections.includes(value as ContentSection)) {
    throw new ValidationError("显示内容区域无效");
  }
  return value as ContentSection;
}

function normalizeContentValue(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("显示内容必须是字符串");
  const content = value.trim();
  if (!content) throw new ValidationError("显示内容不能为空");
  if (content.length > 40) throw new ValidationError("显示内容不能超过 40 个字符");
  return content;
}

function normalizeTextStyle(value: unknown, fallback: TextStyle): TextStyle {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) throw new ValidationError("字体样式格式无效");
  const fontFamily = value.fontFamily ?? fallback.fontFamily;
  const fontSize = value.fontSize ?? fallback.fontSize;
  const bold = value.bold ?? fallback.bold;
  const italic = value.italic ?? fallback.italic;
  const textAlign = value.textAlign ?? fallback.textAlign;
  const textColor = value.textColor ?? fallback.textColor;
  const outlineColor = value.outlineColor ?? fallback.outlineColor;
  const outlineWidth = value.outlineWidth ?? fallback.outlineWidth;
  if (typeof fontFamily !== "string" || !fontFamilies.includes(fontFamily as FontFamily)) {
    throw new ValidationError("字体类型无效");
  }
  if (typeof fontSize !== "number" || !Number.isInteger(fontSize) || fontSize < 10 || fontSize > 96) {
    throw new ValidationError("字号必须是 10 到 96 之间的整数");
  }
  if (typeof bold !== "boolean" || typeof italic !== "boolean") {
    throw new ValidationError("字体格式必须是布尔值");
  }
  if (typeof textAlign !== "string" || !textAlignments.includes(textAlign as TextAlignment)) {
    throw new ValidationError("文字对齐方式无效");
  }
  if (!isHexColor(textColor)) throw new ValidationError("文字颜色必须是六位十六进制颜色");
  if (!isHexColor(outlineColor)) throw new ValidationError("描边颜色必须是六位十六进制颜色");
  if (typeof outlineWidth !== "number" || !Number.isInteger(outlineWidth) || outlineWidth < 0 || outlineWidth > 8) {
    throw new ValidationError("描边宽度必须是 0 到 8 之间的整数");
  }
  return {
    fontFamily: fontFamily as FontFamily,
    fontSize,
    bold,
    italic,
    textAlign: textAlign as TextAlignment,
    textColor: textColor.toLowerCase(),
    outlineColor: outlineColor.toLowerCase(),
    outlineWidth,
  };
}

function cloneTypography(value: TypographySettings): TypographySettings {
  return {
    title: { ...value.title },
    message: { ...value.message },
    stopped: { ...value.stopped },
    queue: { ...value.queue },
  };
}

function sameTextStyle(left: TextStyle, right: TextStyle): boolean {
  return left.fontFamily === right.fontFamily
    && left.fontSize === right.fontSize
    && left.bold === right.bold
    && left.italic === right.italic
    && left.textAlign === right.textAlign
    && left.textColor === right.textColor
    && left.outlineColor === right.outlineColor
    && left.outlineWidth === right.outlineWidth;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInitialCurrentId(value: string | null | undefined, items: QueueItem[]): string | null {
  if (value === undefined) return items[0]?.id ?? null;
  if (value === null) {
    if (items.length > 0) throw new ValidationError("非空队列必须指定当前上号用户");
    return null;
  }
  if (!items.some((item) => item.id === value)) throw new ValidationError("当前上号用户不在队列中");
  return value;
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("ID 必须是字符串");
  const id = value.trim();
  if (!id) throw new ValidationError("ID 不能为空");
  if (id.length > 80) throw new ValidationError("ID 不能超过 80 个字符");
  return id;
}

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
