'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && fs.existsSync(npmCli), '请使用 npm run test:package:native 运行');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'smtc-package-'));
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, npm_config_node_gyp: path.join(temporary, 'compiler-must-not-run.cjs') },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root))[0];
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes('native/index.cjs'));
  assert.ok(files.includes('native/index.d.cts'));
  assert.ok(files.includes('dist/native/monitor.cjs'));
  assert.ok(files.some(file => /^prebuilds\/win32-x64\/.*\.node$/.test(file)));
  assert.ok(!files.some(file => file.startsWith('src/') || file.startsWith('test/') || file.startsWith('build/')));
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'smtc-install-check', private: true }));
  npm(['install', '--omit=dev', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], temporary);
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const api = require('@leejkee/obs-live-overlay/native');
    const monitor = api.createMonitor(() => {});
    monitor.start().catch(e => {
      if(e.code !== 'ERR_SMTC_MANAGER_UNAVAILABLE') throw e;
    }).finally(() => monitor.stop()).catch(e => {console.error(e);process.exitCode=1});
  `], { cwd: temporary, encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, PREBUILDS_ONLY: '1' } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log('发布包入口、类型、预编译产物和普通安装加载验证通过。');
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('smtc-package-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
