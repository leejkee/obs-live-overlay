import { createRequire } from 'node:module';

// 当前项目使用 ES modules，通过 require 加载原生 addon。
const require = createRequire(import.meta.url);
const { createMonitor } = require('./native/index.cjs');
const monitor = createMonitor(event => console.log('SMTC 事件：', event));
const finish = () => monitor.stop();
process.once('SIGINT', finish);
process.once('SIGTERM', finish);
try {
  console.log('启动状态：', await monitor.start());
  // 空闲监控不会阻止退出；示例主动保活 30 秒，并在结束时关闭。
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 30_000);
    process.once('SIGINT', () => { clearTimeout(timer); resolve(); });
    process.once('SIGTERM', () => { clearTimeout(timer); resolve(); });
  });
} finally {
  await monitor.stop();
  process.removeListener('SIGINT', finish);
  process.removeListener('SIGTERM', finish);
}
