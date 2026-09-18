'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const supported = process.platform === 'win32' && process.arch === 'x64';
const entry = path.resolve(__dirname, '../../native/index.cjs');
const setup = `const {createMonitor}=require(${JSON.stringify(entry)});`;
function child(code, timeout = 20000) {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', setup + code], { encoding: 'utf8', timeout, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('原生加载入口支持当前平台或返回明确错误', () => {
  const { createMonitor } = require(entry);
  assert.throws(() => createMonitor(null), { code: 'ERR_SMTC_INVALID_ARGUMENT' });
  if (!supported) assert.throws(() => createMonitor(() => {}), { code: 'ERR_SMTC_UNSUPPORTED_PLATFORM' });
});
test('原生反复启停、停止中 start 拒绝、旧 run 不回调', { skip: !supported }, () => {
  child(`(async()=>{
    const assert=require('node:assert/strict'); let stopped=false;
    const monitor=createMonitor(()=>{assert.equal(stopped,false)});
    for(let i=0;i<30;i++) {
      stopped=false; const started=monitor.start(); const rejected=started.catch(e=>{assert.ok(['ERR_SMTC_ABORTED','ERR_SMTC_MANAGER_UNAVAILABLE'].includes(e.code),e.code)});
      const stopping=monitor.stop(); stopped=true;
      await assert.rejects(monitor.start(),{code:'ERR_SMTC_SHUTTING_DOWN'});
      await Promise.all([rejected,stopping]);
    }
  })().catch(e=>{console.error(e);process.exitCode=1});`);
});
test('原生监控不阻止自然退出，未显式 stop 也可清理', { skip: !supported }, () => {
  child(`const monitor=createMonitor(()=>{}); monitor.start().catch(e=>{if(e.code!=='ERR_SMTC_MANAGER_UNAVAILABLE')throw e});`);
});
test('原生 Worker 启动中与运行中 terminate 安全', { skip: !supported }, () => {
  child(`(async()=>{
    const {Worker}=require('node:worker_threads');
    for(let i=0;i<16;i++) {
      const worker=new Worker(${JSON.stringify(setup)}+
        "const {parentPort}=require('node:worker_threads'); const monitor=createMonitor(()=>{}); parentPort.postMessage('starting'); monitor.start().then(()=>parentPort.postMessage('ready'),e=>parentPort.postMessage(e.code)); setInterval(()=>{},1000);",{eval:true});
      await new Promise((resolve,reject)=>{let count=0;worker.on('message',()=>{if(++count===(i%2?2:1))resolve()});worker.once('error',reject)});
      await worker.terminate();
    }
  })().catch(e=>{console.error(e);process.exitCode=1});`, 30000);
});
test('原生 wrapper 可被 GC，不由 native callback 强引用', { skip: !supported }, () => {
  child(`(async()=>{
    const assert=require('node:assert/strict');
    let monitor=createMonitor(()=>{}); await monitor.start().catch(e=>{if(e.code!=='ERR_SMTC_MANAGER_UNAVAILABLE')throw e});
    const weak=new WeakRef(monitor); monitor=null;
    for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,25));global.gc();}
    assert.equal(weak.deref(),undefined);
  })().catch(e=>{console.error(e);process.exitCode=1});`);
});
test('原生独立实例的 environment 状态互不干扰', { skip: !supported }, () => {
  child(`(async()=>{
    const a=createMonitor(()=>{}),b=createMonitor(()=>{});
    try {const states=await Promise.all([a.start(),b.start()]);require('node:assert/strict').notEqual(states[0].runId,states[1].runId)}
    catch(e){if(e.code!=='ERR_SMTC_MANAGER_UNAVAILABLE')throw e}
    finally{await Promise.all([a.stop(),b.stop()])}
  })().catch(e=>{console.error(e);process.exitCode=1});`);
});
