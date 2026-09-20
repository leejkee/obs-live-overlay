'use strict';
// 构建成功后放入 node-gyp-build 支持的随包预编译目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.equal(process.platform, 'win32', '原生产物必须在 Windows 上打包');
assert.equal(process.arch, 'x64', '原生产物必须使用 x64 构建环境');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'build/native-prebuild/Release/smtc-addon.node');
const directory = path.join(root, 'prebuilds/win32-x64');
// 沿用既有文件名，覆盖旧产物，避免目录内混入两个可被加载器选中的版本。
const destination = path.join(directory, '@leejkee+obs-live-overlay.node');
assert.ok(fs.existsSync(source), '缺少原生产物，请先运行 npm run package:native');
fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(source, destination);
console.log(`已生成原生预编译产物：${path.relative(root, destination)}`);
