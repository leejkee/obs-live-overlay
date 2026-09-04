import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, createDefaultTypography, QueueStore, ValidationError } from "../src/queue-store.js";

describe("QueueStore", () => {
  it("自动把队首标记为 current，出队后切换到下一位", () => {
    const store = new QueueStore();
    store.enqueue(" User-A ");
    store.enqueue("User-B");
    assert.deepEqual(store.snapshot(), {
      items: [{ id: "User-A" }, { id: "User-B" }],
      currentId: "User-A",
      isQueueStopped: false,
      message: "",
      typography: createDefaultTypography(),
      revision: 2,
    });

    assert.equal(store.dequeue()?.id, "User-A");
    assert.equal(store.snapshot().currentId, "User-B");
    assert.equal(store.dequeue()?.id, "User-B");
    assert.equal(store.snapshot().currentId, null);
  });

  it("返回快照副本，外部不能修改内部状态", () => {
    const store = new QueueStore();
    store.enqueue("Viewer");
    const snapshot = store.snapshot();
    snapshot.items[0].id = "Changed";
    snapshot.items.push({ id: "Fake" });
    assert.deepEqual(store.snapshot().items, [{ id: "Viewer" }]);
  });

  it("拒绝空 ID 和重复 ID", () => {
    const store = new QueueStore();
    store.enqueue("Viewer");
    assert.throws(() => store.enqueue("   "), ValidationError);
    assert.throws(() => store.enqueue("Viewer"), ConflictError);
  });

  it("保存停止排队提示状态，重复设置相同值不增加版本", () => {
    const store = new QueueStore();
    assert.equal(store.snapshot().isQueueStopped, false);
    assert.equal(store.setQueueStopped(true), true);
    assert.equal(store.snapshot().revision, 1);
    store.setQueueStopped(true);
    assert.equal(store.snapshot().revision, 1);
    store.setQueueStopped(false);
    assert.equal(store.snapshot().isQueueStopped, false);
    assert.throws(() => store.setQueueStopped("true"), ValidationError);
  });

  it("保存、清空并验证 Overlay 消息", () => {
    const store = new QueueStore();
    assert.equal(store.setMessage("  今晚十点结束  "), "今晚十点结束");
    assert.equal(store.snapshot().message, "今晚十点结束");
    assert.equal(store.setMessage(""), "");
    assert.equal(store.snapshot().message, "");
    assert.throws(() => store.setMessage(123), ValidationError);
    assert.throws(() => store.setMessage("x".repeat(121)), ValidationError);
  });

  it("按区域保存字体、格式、字号、对齐和渲染设置", () => {
    const store = new QueueStore();
    assert.deepEqual(store.setTypography("title", {
      fontFamily: "serif",
      fontSize: 42,
      bold: false,
      italic: true,
      textAlign: "center",
      textColor: "#AABBCC",
      outlineColor: "#112233",
      outlineWidth: 3,
    }), {
      fontFamily: "serif",
      fontSize: 42,
      bold: false,
      italic: true,
      textAlign: "center",
      textColor: "#aabbcc",
      outlineColor: "#112233",
      outlineWidth: 3,
    });
    assert.equal(store.snapshot().revision, 1);
    store.setTypography("title", { fontSize: 42 });
    assert.equal(store.snapshot().revision, 1);
    assert.throws(() => store.setTypography("unknown", {}), ValidationError);
    assert.throws(() => store.setTypography("queue", { fontSize: 100 }), ValidationError);
    assert.throws(() => store.setTypography("queue", { fontFamily: "remote-font" }), ValidationError);
    assert.throws(() => store.setTypography("queue", { textColor: "white" }), ValidationError);
    assert.throws(() => store.setTypography("queue", { outlineColor: "#fff" }), ValidationError);
    assert.throws(() => store.setTypography("queue", { outlineWidth: 9 }), ValidationError);
  });
});
