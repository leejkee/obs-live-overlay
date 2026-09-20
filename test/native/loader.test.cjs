'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const directory = path.resolve(__dirname, '../../native');
const source = fs.readFileSync(path.join(directory, 'index.cjs'), 'utf8');
const localBinary = path.resolve(directory, '../build/native/Release/smtc-addon.node');

function load({ local = true, prebuildsOnly = false, broken = false } = {}) {
  const calls = [];
  const exports = {};
  const localBinding = { createBridge: class {} };
  const packagedBinding = { createBridge: class {} };
  const failure = new Error('invalid native binary');
  vm.runInNewContext(source, {
    __dirname: directory, exports,
    process: { platform: 'win32', arch: 'x64', env: prebuildsOnly ? { PREBUILDS_ONLY: '1' } : {} },
    require(id) {
      if (id === 'node:path') return path;
      if (id === 'node:os') return { release: () => '10.0.26100' };
      if (id === 'node:fs') return { existsSync: file => local && file === localBinary };
      if (id === '../dist/native/monitor.cjs') return { createMonitorWithBackend: (_callback, factory) => factory(() => {}) };
      if (id === localBinary) {
        calls.push('local');
        if (broken) throw failure;
        return localBinding;
      }
      if (id === 'node-gyp-build') return () => { calls.push('prebuilt'); return packagedBinding; };
      throw new Error(`Unexpected require: ${id}`);
    },
  });
  return { create: () => exports.createMonitor(() => {}), calls, localBinding, packagedBinding, failure };
}

test('开发入口优先加载 CMake.js 生成的 addon', () => {
  const setup = load();
  assert.ok(setup.create() instanceof setup.localBinding.createBridge);
  assert.deepEqual(setup.calls, ['local']);
});

test('缺少本地构建时使用随包加载器', () => {
  const setup = load({ local: false });
  assert.ok(setup.create() instanceof setup.packagedBinding.createBridge);
  assert.deepEqual(setup.calls, ['prebuilt']);
});

test('PREBUILDS_ONLY 跳过已有的本地构建', () => {
  const setup = load({ prebuildsOnly: true });
  assert.ok(setup.create() instanceof setup.packagedBinding.createBridge);
  assert.deepEqual(setup.calls, ['prebuilt']);
});

test('本地二进制损坏时保留原因，不静默加载旧版本', () => {
  const setup = load({ broken: true });
  assert.throws(setup.create, error => error.code === 'ERR_SMTC_BINARY_UNAVAILABLE' && error.cause === setup.failure);
  assert.deepEqual(setup.calls, ['local']);
});
