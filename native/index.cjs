'use strict';
const { createMonitorWithBackend } = require('../dist/native/monitor.cjs');
const path = require('node:path');
const os = require('node:os');

exports.createMonitor = function createMonitor(onEvent) {
  if (typeof onEvent !== 'function') {
    throw Object.assign(new TypeError('onEvent 必须是函数'), { code: 'ERR_SMTC_INVALID_ARGUMENT', operation: 'createMonitor' });
  }
  const [major, , build] = os.release().split('.').map(Number);
  if (process.platform !== 'win32' || process.arch !== 'x64' || major < 10 || (major === 10 && build < 17763)) {
    throw Object.assign(new Error('SMTC 仅支持 Windows 10 1809+ / Windows 11 x64'), { code: 'ERR_SMTC_UNSUPPORTED_PLATFORM', operation: 'createMonitor' });
  }
  let binding;
  try { binding = require('node-gyp-build')(path.join(__dirname, '..')); }
  catch (cause) {
    throw Object.assign(new Error('缺少 SMTC 原生二进制；源码开发请运行 npm run build:native', { cause }), { code: 'ERR_SMTC_BINARY_UNAVAILABLE', operation: 'createMonitor' });
  }
  return createMonitorWithBackend(onEvent, callback => new binding.createBridge(callback));
};
