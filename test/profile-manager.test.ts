import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "../src/profile-manager.js";
import { ValidationError } from "../src/queue-store.js";

describe("ProfileManager", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createManager() {
    const directory = await mkdtemp(join(tmpdir(), "obs-live-overlay-profiles-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "profiles.json");
    return { manager: await ProfileManager.load(file), file };
  }

  it("首次加载时创建 default Profile 和 JSON 文件", async () => {
    const { manager, file } = await createManager();
    assert.deepEqual(manager.profilesSnapshot(), {
      activeProfileId: "default",
      profiles: [{ id: "default", name: "默认", isDefault: true }],
    });
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.version, 5);
    assert.equal(persisted.activeProfileId, "default");
  });

  it("为每个 Profile 独立保存队列并在重载后恢复", async () => {
    const { manager, file } = await createManager();
    const profile = await manager.createProfile("周末场");
    await manager.updateActiveQueue((queue) => {
      queue.enqueue("User-A");
      queue.enqueue("User-B");
      queue.setCurrent("User-B");
      queue.setMessage("欢迎");
      queue.setContent("title", "周末等候队列");
      queue.setContent("stopped", "本场已满");
      queue.setQueueStopped(true);
      queue.setTypography("message", { fontFamily: "serif", fontSize: 31, italic: true, textColor: "#22ccaa", outlineColor: "#330055", outlineWidth: 2 });
    });
    await manager.activateProfile("default");
    assert.deepEqual(manager.activeQueueState().items, []);

    await manager.activateProfile(profile.id);
    const restored = await ProfileManager.load(file);
    assert.equal(restored.activeProfile().name, "周末场");
    assert.deepEqual(restored.activeQueueState().items, [{ id: "User-A" }, { id: "User-B" }]);
    assert.equal(restored.activeQueueState().currentId, "User-B");
    assert.equal(restored.activeQueueState().message, "欢迎");
    assert.deepEqual(restored.activeQueueState().content, { title: "周末等候队列", stopped: "本场已满" });
    assert.equal(restored.activeQueueState().isQueueStopped, true);
    assert.deepEqual(restored.activeQueueState().typography.message, {
      fontFamily: "serif",
      fontSize: 31,
      bold: true,
      italic: true,
      textAlign: "left",
      textColor: "#22ccaa",
      outlineColor: "#330055",
      outlineWidth: 2,
    });
  });

  it("加载旧版 Profile 时补充默认字体设置", async () => {
    const { file } = await createManager();
    const legacyData = {
      version: 1,
      activeProfileId: "default",
      profiles: [{
        id: "default",
        name: "默认",
        queue: { items: [], isQueueStopped: false, message: "", revision: 0 },
      }],
    };
    await writeFile(file, JSON.stringify(legacyData), "utf8");
    const restored = await ProfileManager.load(file);
    assert.equal(restored.activeQueueState().typography.title.fontSize, 30);
    assert.equal(restored.activeQueueState().typography.queue.fontFamily, "system");
    assert.equal(restored.activeQueueState().typography.queue.textColor, "#ffffff");
    assert.equal(restored.activeQueueState().typography.stopped.outlineWidth, 1);
  });

  it("加载第二版 Profile 时补充默认文字渲染设置", async () => {
    const { file } = await createManager();
    const legacyData = {
      version: 2,
      activeProfileId: "default",
      profiles: [{
        id: "default",
        name: "默认",
        queue: {
          items: [],
          isQueueStopped: false,
          message: "",
          revision: 0,
          typography: {
            title: { fontFamily: "serif", fontSize: 40, bold: true, italic: false, textAlign: "center" },
            message: { fontFamily: "system", fontSize: 22, bold: true, italic: false, textAlign: "left" },
            stopped: { fontFamily: "system", fontSize: 27, bold: true, italic: false, textAlign: "center" },
            queue: { fontFamily: "system", fontSize: 24, bold: true, italic: false, textAlign: "left" },
          },
        },
      }],
    };
    await writeFile(file, JSON.stringify(legacyData), "utf8");
    const restored = await ProfileManager.load(file);
    assert.equal(restored.activeQueueState().typography.title.fontFamily, "serif");
    assert.equal(restored.activeQueueState().typography.title.textColor, "#ffffff");
    assert.equal(restored.activeQueueState().typography.title.outlineColor, "#050505");
    assert.equal(restored.activeQueueState().typography.title.outlineWidth, 1);
  });

  it("加载第三版 Profile 时默认以队首作为当前上号用户", async () => {
    const { file } = await createManager();
    const legacyData = {
      version: 3,
      activeProfileId: "default",
      profiles: [{
        id: "default",
        name: "默认",
        queue: {
          items: [{ id: "User-A" }, { id: "User-B" }],
          isQueueStopped: false,
          message: "",
          revision: 2,
        },
      }],
    };
    await writeFile(file, JSON.stringify(legacyData), "utf8");
    const restored = await ProfileManager.load(file);
    assert.equal(restored.activeQueueState().currentId, "User-A");
  });

  it("加载第四版 Profile 时补充默认固定显示内容", async () => {
    const { file } = await createManager();
    const legacyData = {
      version: 4,
      activeProfileId: "default",
      profiles: [{
        id: "default",
        name: "默认",
        queue: {
          items: [],
          currentId: null,
          isQueueStopped: false,
          message: "",
          revision: 0,
        },
      }],
    };
    await writeFile(file, JSON.stringify(legacyData), "utf8");
    const restored = await ProfileManager.load(file);
    assert.deepEqual(restored.activeQueueState().content, { title: "等候队列", stopped: "不排了" });
  });

  it("支持重命名和删除，并保护 default Profile", async () => {
    const { manager } = await createManager();
    const profile = await manager.createProfile("临时");
    assert.equal((await manager.renameProfile(profile.id, "正式")).name, "正式");
    await manager.deleteProfile(profile.id);
    assert.equal(manager.profilesSnapshot().activeProfileId, "default");
    await assert.rejects(() => manager.deleteProfile("default"), ValidationError);
  });
});
