import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  normalizeContent,
  normalizeTypography,
  QueueStore,
  ValidationError,
  type PersistedQueueState,
  type QueueState,
} from "./queue-store.js";

const formatVersion = 5;
const supportedFormatVersions = new Set([1, 2, 3, 4, formatVersion]);
const defaultProfileId = "default";

interface StoredProfile {
  id: string;
  name: string;
  queue: PersistedQueueState;
}

interface StoredData {
  version: number;
  activeProfileId: string;
  profiles: StoredProfile[];
}

interface ProfileRecord {
  id: string;
  name: string;
  queue: QueueStore;
}

export interface ProfileSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ProfilesSnapshot {
  activeProfileId: string;
  profiles: ProfileSummary[];
}

export class ProfileManager {
  readonly #filePath: string;
  readonly #profiles = new Map<string, ProfileRecord>();
  #activeProfileId: string;
  #pendingWrite: Promise<void> = Promise.resolve();

  private constructor(filePath: string, data: StoredData) {
    this.#filePath = filePath;
    for (const profile of data.profiles) {
      this.#profiles.set(profile.id, {
        id: profile.id,
        name: profile.name,
        queue: new QueueStore(profile.queue),
      });
    }
    this.#activeProfileId = data.activeProfileId;
  }

  static async load(filePath: string): Promise<ProfileManager> {
    try {
      const raw = await readFile(filePath, "utf8");
      return new ProfileManager(filePath, parseStoredData(raw));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const manager = new ProfileManager(filePath, createInitialData());
      await manager.#save();
      return manager;
    }
  }

  profilesSnapshot(): ProfilesSnapshot {
    return {
      activeProfileId: this.#activeProfileId,
      profiles: [...this.#profiles.values()].map(({ id, name }) => ({
        id,
        name,
        isDefault: id === defaultProfileId,
      })),
    };
  }

  activeQueueState(): QueueState {
    return this.#activeProfile().queue.snapshot();
  }

  activeProfile(): ProfileSummary {
    const { id, name } = this.#activeProfile();
    return { id, name, isDefault: id === defaultProfileId };
  }

  async updateActiveQueue(operation: (queue: QueueStore) => void): Promise<QueueState> {
    return this.#exclusive(async () => {
      const queue = this.#activeProfile().queue;
      operation(queue);
      await this.#save();
      return queue.snapshot();
    });
  }

  async createProfile(value: unknown): Promise<ProfileSummary> {
    return this.#exclusive(async () => {
      const name = this.#normalizeUniqueName(value);
      const id = randomUUID();
      this.#profiles.set(id, { id, name, queue: new QueueStore() });
      this.#activeProfileId = id;
      await this.#save();
      return { id, name, isDefault: false };
    });
  }

  async renameProfile(profileId: string, value: unknown): Promise<ProfileSummary> {
    return this.#exclusive(async () => {
      const profile = this.#requireProfile(profileId);
      const name = this.#normalizeUniqueName(value, profileId);
      profile.name = name;
      await this.#save();
      return { id: profile.id, name, isDefault: profile.id === defaultProfileId };
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    return this.#exclusive(async () => {
      if (profileId === defaultProfileId) throw new ValidationError("默认 Profile 不能删除");
      this.#requireProfile(profileId);
      this.#profiles.delete(profileId);
      if (this.#activeProfileId === profileId) this.#activeProfileId = defaultProfileId;
      await this.#save();
    });
  }

  async activateProfile(profileId: string): Promise<QueueState> {
    return this.#exclusive(async () => {
      this.#requireProfile(profileId);
      this.#activeProfileId = profileId;
      await this.#save();
      return this.#activeProfile().queue.snapshot();
    });
  }

  #activeProfile(): ProfileRecord {
    return this.#requireProfile(this.#activeProfileId);
  }

  #requireProfile(profileId: string): ProfileRecord {
    const profile = this.#profiles.get(profileId);
    if (!profile) throw new ProfileNotFoundError("Profile 不存在");
    return profile;
  }

  #normalizeUniqueName(value: unknown, exceptId?: string): string {
    if (typeof value !== "string") throw new ValidationError("Profile 名称必须是字符串");
    const name = value.trim();
    if (!name) throw new ValidationError("Profile 名称不能为空");
    if (name.length > 40) throw new ValidationError("Profile 名称不能超过 40 个字符");
    const duplicate = [...this.#profiles.values()].some(
      (profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) throw new ProfileConflictError("Profile 名称已存在");
    return name;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pendingWrite.then(operation, operation);
    this.#pendingWrite = result.then(() => undefined, () => undefined);
    return result;
  }

  async #save(): Promise<void> {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    const data: StoredData = {
      version: formatVersion,
      activeProfileId: this.#activeProfileId,
      profiles: [...this.#profiles.values()].map(({ id, name, queue }) => ({
        id,
        name,
        queue: queue.persistedState(),
      })),
    };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function createInitialData(): StoredData {
  return {
    version: formatVersion,
    activeProfileId: defaultProfileId,
    profiles: [{
      id: defaultProfileId,
      name: "默认",
      queue: new QueueStore().persistedState(),
    }],
  };
}

function parseStoredData(raw: string): StoredData {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Profile 数据文件不是有效的 JSON");
  }
  if (!isRecord(value) || typeof value.version !== "number" || !supportedFormatVersions.has(value.version) || !Array.isArray(value.profiles)) {
    throw new Error("Profile 数据文件格式无效或版本不受支持");
  }
  const version = value.version;
  const profiles = value.profiles.map((profile) => parseProfile(profile, version));
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length || !ids.has(defaultProfileId)) {
    throw new Error("Profile 数据必须包含唯一的 default Profile");
  }
  if (typeof value.activeProfileId !== "string" || !ids.has(value.activeProfileId)) {
    throw new Error("Profile 数据中的当前 Profile 无效");
  }
  return { version: formatVersion, activeProfileId: value.activeProfileId, profiles };
}

function parseProfile(value: unknown, version: number): StoredProfile {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.queue)) {
    throw new Error("Profile 数据项格式无效");
  }
  const queue = value.queue;
  if (!Array.isArray(queue.items) || typeof queue.isQueueStopped !== "boolean" || typeof queue.message !== "string" || typeof queue.revision !== "number" || !Number.isInteger(queue.revision) || queue.revision < 0) {
    throw new Error("Profile 队列数据格式无效");
  }
  const items = queue.items.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) throw new Error("Profile 队列项格式无效");
    return { id: item.id };
  });
  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) throw new Error("Profile 队列中包含重复 ID");
  const currentId = version >= 4 ? queue.currentId : items[0]?.id ?? null;
  if ((currentId !== null && typeof currentId !== "string")
    || (typeof currentId === "string" && !itemIds.has(currentId))
    || (currentId === null && items.length > 0)) {
    throw new Error("Profile 当前上号用户无效");
  }
  return {
    id: value.id,
    name: value.name,
    queue: {
      items,
      currentId,
      isQueueStopped: queue.isQueueStopped,
      message: queue.message,
      content: normalizeContent(queue.content),
      typography: normalizeTypography(queue.typography),
      revision: queue.revision,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ProfileNotFoundError extends Error {}
export class ProfileConflictError extends Error {}
