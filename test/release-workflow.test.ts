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
    assert.match(releaseRules, /docs\/images\/music-overlay\.png/);
    assert.match(releaseRules, /用户 1/);
    assert.match(releaseRules, /等待队列/);
    assert.match(releaseRules, /弹幕发送排队加入队列/);
    assert.match(releaseRules, /示例歌曲/);
    assert.match(releaseRules, /示例歌手/);
    assert.match(releaseRules, /Node\.js 进程/);
    assert.match(releaseRules, /监听端口/);
    assert.match(releaseRules, /npm run verify/);
  });

  it("CI/CD 只验证 Node.js 24 和 26", async () => {
    const [ciWorkflow, nativeWorkflow, releaseRules] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/native.yml", "utf8"),
      readFile("RELEASE.md", "utf8"),
    ]);
    assert.doesNotMatch(ciWorkflow, /node-version:\s*(20|22)\b/);
    assert.match(ciWorkflow, /node-version:\s*24\b/);
    assert.match(ciWorkflow, /node-version:\s*26\b/);
    assert.match(nativeWorkflow, /node-version:\s*\[24, 26\]/);
    assert.doesNotMatch(nativeWorkflow, /node-version:\s*(20|22)\b/);
    assert.match(releaseRules, /Node 24\/26/);
  });
});
