import { createRequire } from 'node:module';
import type { NativeMonitor, NativeState, NativeEvent } from '@leejkee/obs-live-overlay/native';
const require = createRequire(import.meta.url);
const api: typeof import('@leejkee/obs-live-overlay/native') = require('@leejkee/obs-live-overlay/native');
const monitor: NativeMonitor = api.createMonitor((event: NativeEvent) => {
  if (event.type === 'media-changed') event.data.title satisfies string;
  if (event.type === 'resync') event.state satisfies NativeState;
});
await monitor.refresh('opaque', 'media');
// @ts-expect-error 观察者不提供播放器控制接口
await monitor.control('opaque', { type: 'play' });
// @ts-expect-error unsupported domain
await monitor.refresh('opaque', 'lyrics');
await monitor.stop();
