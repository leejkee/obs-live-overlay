import type { NativeMonitor } from '@leejkee/obs-live-overlay/native';
const api: typeof import('@leejkee/obs-live-overlay/native') = require('@leejkee/obs-live-overlay/native');
const monitor: NativeMonitor = api.createMonitor(() => {});
void monitor.start().then(state => state.sessions[0]?.sourceAppUserModelId);
void monitor.getThumbnail('opaque', 'token').then(image => { if (image) image.data satisfies Buffer; });
void monitor.stop();
