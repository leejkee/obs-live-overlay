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
});
