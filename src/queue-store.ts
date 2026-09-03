export interface QueueItem {
  id: string;
}

export interface QueueState {
  items: QueueItem[];
  currentId: string | null;
  isQueueStopped: boolean;
  message: string;
  revision: number;
}

export class QueueStore {
  readonly #items: QueueItem[] = [];
  #isQueueStopped = false;
  #message = "";
  #revision = 0;

  snapshot(): QueueState {
    return {
      items: this.#items.map((item) => ({ ...item })),
      currentId: this.#items[0]?.id ?? null,
      isQueueStopped: this.#isQueueStopped,
      message: this.#message,
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
    this.#revision += 1;
    return { ...item };
  }

  dequeue(): QueueItem | null {
    const item = this.#items.shift() ?? null;
    if (item) this.#revision += 1;
    return item ? { ...item } : null;
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
