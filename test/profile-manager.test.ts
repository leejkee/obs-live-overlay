import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.equal(persisted.version, 1);
    assert.equal(persisted.activeProfileId, "default");
  });

  it("为每个 Profile 独立保存队列并在重载后恢复", async () => {
    const { manager, file } = await createManager();
    const profile = await manager.createProfile("周末场");
    await manager.updateActiveQueue((queue) => {
      queue.enqueue("User-A");
      queue.setMessage("欢迎");
      queue.setQueueStopped(true);
    });
    await manager.activateProfile("default");
    assert.deepEqual(manager.activeQueueState().items, []);

    await manager.activateProfile(profile.id);
    const restored = await ProfileManager.load(file);
    assert.equal(restored.activeProfile().name, "周末场");
    assert.deepEqual(restored.activeQueueState().items, [{ id: "User-A" }]);
    assert.equal(restored.activeQueueState().message, "欢迎");
    assert.equal(restored.activeQueueState().isQueueStopped, true);
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
