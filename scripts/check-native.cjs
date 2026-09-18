'use strict';
// Read-only real Windows acceptance probe. Does not log private song metadata.
const assert = require('node:assert/strict');
const { createMonitor } = require('../native/index.cjs');
const monitor = createMonitor(() => {});
(async () => {
  try {
    const state = await monitor.start();
    let images = 0;
    for (const session of state.sessions) {
      await monitor.refresh(session.sessionId, 'media');
      await monitor.refresh(session.sessionId, 'playback');
      await monitor.setTimelineTracking(session.sessionId);
      const data = monitor.getState().sessions.find(s => s.sessionId === session.sessionId);
      assert.ok(data.media && data.playback && data.timeline);
      if (data.media.thumbnailId) {
        const thumbnail = await monitor.getThumbnail(session.sessionId, data.media.thumbnailId);
        if (thumbnail) { assert.ok(Buffer.isBuffer(thumbnail.data)); assert.ok(thumbnail.data.length <= 4 * 1024 * 1024); images++; }
      }
    }
    await monitor.setTimelineTracking(null);
    console.log(JSON.stringify({ sessions: state.sessions.length, images, readOnly: true }));
  } finally { await monitor.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
