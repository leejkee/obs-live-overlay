import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Release workflow", () => {
  it("使用 npm Trusted Publishing 且不依赖长期 Token", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
    assert.match(workflow, /package-manager-cache:\s*false/);
    assert.match(workflow, /npm publish/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  });

  it("记录每次发布必须执行的截图与清理规则", async () => {
    const releaseRules = await readFile("RELEASE.md", "utf8");
    assert.match(releaseRules, /docs\/images\/control-console\.png/);
    assert.match(releaseRules, /docs\/images\/queue-overlay\.png/);
    assert.match(releaseRules, /用户 1/);
    assert.match(releaseRules, /等待队列/);
    assert.match(releaseRules, /弹幕发送排队加入队列/);
    assert.match(releaseRules, /Node\.js 进程/);
    assert.match(releaseRules, /监听端口/);
    assert.match(releaseRules, /npm run verify/);
  });
});
