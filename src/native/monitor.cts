import { randomUUID } from 'node:crypto';
import type { NativeMonitor, NativeState, NativeEvent, SessionData, Domain, Thumbnail, SmtcError } from '../../native/index.cjs';

// This transport is internal. No WinRT handles or JavaScript business policy cross it.
export interface Backend {
  request(id: number, operation: string, sessionId: string, argument: string): void;
  cancel(id: number): void;
  close(): void;
  ref(active: boolean): void;
}
export interface Message {
  type: 'result' | 'notify' | 'closed'; id?: number; sessionId?: string; domain?: Domain | 'sessions' | 'resync' | 'revoke';
  data?: unknown; error?: { code: string; nativeCode?: string };
}
type Topology = { sessions: { sessionId: string; sourceAppUserModelId: string }[]; currentSessionId: string | null };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; operation: string; sessionId: string };
type Read = { dirty: boolean; promise: Promise<void> };
const domains: Domain[] = ['media', 'playback', 'timeline'];
function error(code: string, operation: string, sessionId?: string, nativeCode?: string): SmtcError {
  return Object.assign(new Error(`${operation}: ${code}`), { code, operation, ...(sessionId ? { sessionId } : {}), ...(nativeCode ? { nativeCode } : {}) });
}
// A separate lexical scope avoids retaining start()'s this through its other closures.
function receiver(weak: WeakRef<Monitor>, run: string) {
  return (message: Message) => weak.deref()?.receive(run, message);
}

// Exported only from the internal file so tests can inject a deterministic backend.
export function createMonitorWithBackend(onEvent: (event: NativeEvent) => void, factory: (callback: (message: Message) => void) => Backend,
  limits = { timeoutMs: 10_000, requests: 128, events: 256 }): NativeMonitor {
  return new Monitor(onEvent, factory, limits);
}

class Monitor implements NativeMonitor {
  private lifecycle: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new';
  private state: NativeState = { runId: '', sequence: 0, currentSessionId: null, trackedTimelineSessionId: null, sessions: [] };
  private backend?: Backend;
  private pending = new Map<number, Pending>();
  private nextRequest = 0;
  private explicit = 0;
  private reads = new Map<string, Read>();
  private thumbnails = new Map<string, Promise<Thumbnail | null>>();
  private startPromise?: Promise<NativeState>;
  private stopPromise?: Promise<void>;
  private closed?: () => void;
  private topology?: Promise<void>;
  private topologyDirty = false;
  private tracking: Promise<void> = Promise.resolve();
  private events: NativeEvent[] = [];
  private delivery?: NodeJS.Immediate;
  constructor(private onEvent: (event: NativeEvent) => void, private factory: (callback: (message: Message) => void) => Backend,
    private limits: { timeoutMs: number; requests: number; events: number }) {}

  start(): Promise<NativeState> {
    if (this.lifecycle === 'stopping') return Promise.reject(error('ERR_SMTC_SHUTTING_DOWN', 'start'));
    if (this.lifecycle === 'starting') return this.startPromise!;
    if (this.lifecycle === 'running') return Promise.resolve(this.getState());
    this.lifecycle = 'starting';
    this.state = { runId: randomUUID(), sequence: 0, currentSessionId: null, trackedTimelineSessionId: null, sessions: [] };
    const run = this.state.runId;
    const weak = new WeakRef(this);
    try { this.backend = this.factory(receiver(weak, run)); }
    catch (cause) { this.lifecycle = 'stopped'; return Promise.reject(cause); }
    this.startPromise = this.request<Topology>('start').then(topology => {
      this.assertRun(run, 'start');
      this.applyTopology(topology);
      this.lifecycle = 'running';
      const baseline = this.getState();
      // setImmediate delivery guarantees the awaiting caller sees the baseline first.
      this.events = this.events.filter(event => event.sequence > baseline.sequence);
      if (this.topologyDirty) this.scheduleTopology();
      this.refreshAll();
      return baseline;
    }).catch(async cause => {
      if (this.lifecycle !== 'stopping' && this.state.runId === run) await this.stop();
      throw cause;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.lifecycle === 'stopping') return this.stopPromise!;
    if (this.lifecycle === 'new' || this.lifecycle === 'stopped') return Promise.resolve();
    this.lifecycle = 'stopping';
    if (this.delivery) clearImmediate(this.delivery);
    this.delivery = undefined;
    this.events = [];
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error('ERR_SMTC_ABORTED', entry.operation, entry.sessionId)); }
    this.pending.clear();
    this.reads.clear(); this.thumbnails.clear(); this.topology = undefined; this.topologyDirty = false;
    this.tracking = Promise.resolve();
    this.stopPromise = new Promise(resolve => { this.closed = resolve; });
    this.backend!.ref(true); // Closing has a reserved channel and cannot time out locally.
    this.backend!.close();
    return this.stopPromise;
  }

  getState(): NativeState { return structuredClone(this.state); }

  async refresh(sessionId: string, domain: Domain): Promise<void> {
    return this.withRequest('refresh', async () => {
      this.session(sessionId, 'refresh');
      if (!domains.includes(domain)) throw error('ERR_SMTC_INVALID_ARGUMENT', 'refresh', sessionId);
      await this.read(sessionId, domain, true);
    });
  }

  async setTimelineTracking(sessionId: string | null): Promise<void> {
    return this.withRequest('setTimelineTracking', async deadline => {
      if (sessionId !== null) this.session(sessionId, 'setTimelineTracking');
      const run = this.state.runId;
      const next = this.tracking.catch(() => {}).then(async () => {
        this.assertRun(run, 'setTimelineTracking');
        if (performance.now() >= deadline) throw error('ERR_SMTC_TIMEOUT', 'setTimelineTracking', sessionId ?? undefined);
        if (sessionId !== null) this.session(sessionId, 'setTimelineTracking');
        await this.request('track', sessionId ?? '');
        this.assertRun(run, 'setTimelineTracking');
        this.state.trackedTimelineSessionId = sessionId;
        this.emit({ type: 'resync' });
        if (sessionId !== null) await this.read(sessionId, 'timeline', true);
      });
      this.tracking = next;
      return next;
    });
  }

  async getThumbnail(sessionId: string, thumbnailId: string): Promise<Thumbnail | null> {
    return this.withRequest('getThumbnail', async () => {
      const s = this.session(sessionId, 'getThumbnail');
      if (typeof thumbnailId !== 'string' || !thumbnailId) throw error('ERR_SMTC_INVALID_ARGUMENT', 'getThumbnail', sessionId);
      if (s.media?.thumbnailId !== thumbnailId) throw error('ERR_SMTC_STALE_THUMBNAIL', 'getThumbnail', sessionId);
      const key = `${sessionId}:${thumbnailId}`;
      let promise = this.thumbnails.get(key);
      if (!promise) {
        promise = this.request<Thumbnail | null>('thumbnail', sessionId, thumbnailId).then(result => {
          if (this.session(sessionId, 'getThumbnail').media?.thumbnailId !== thumbnailId) throw error('ERR_SMTC_STALE_THUMBNAIL', 'getThumbnail', sessionId);
          return result;
        }).catch(cause => { this.thumbnails.delete(key); throw cause; });
        this.thumbnails.set(key, promise);
      }
      const data = await promise;
      return data && { ...data, data: Buffer.from(data.data) };
    });
  }

  private async withRequest<T>(operation: string, action: (deadline: number) => Promise<T>): Promise<T> {
    this.running(operation);
    if (this.explicit >= this.limits.requests) throw error('ERR_SMTC_BUSY', operation);
    this.explicit++;
    let timer: NodeJS.Timeout | undefined;
    const deadline = performance.now() + this.limits.timeoutMs;
    try {
      const work = action(deadline);
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error('ERR_SMTC_TIMEOUT', operation)), this.limits.timeoutMs);
      })]);
    } finally { clearTimeout(timer); this.explicit--; }
  }
  private running(operation: string) {
    if (this.lifecycle !== 'running') throw error(this.lifecycle === 'stopping' ? 'ERR_SMTC_SHUTTING_DOWN' : 'ERR_SMTC_NOT_STARTED', operation);
  }
  private assertRun(run: string, operation: string) {
    if (this.state.runId !== run || !['running', 'starting'].includes(this.lifecycle)) throw error('ERR_SMTC_ABORTED', operation);
  }
  private session(id: string, operation: string): SessionData {
    if (typeof id !== 'string' || !id) throw error('ERR_SMTC_INVALID_ARGUMENT', operation);
    const session = this.state.sessions.find(s => s.sessionId === id);
    if (!session) throw error('ERR_SMTC_STALE_SESSION', operation, id);
    return session;
  }
  private request<T = unknown>(operation: string, sessionId = '', argument = ''): Promise<T> {
    if (this.pending.size >= this.limits.requests) return Promise.reject(error('ERR_SMTC_BUSY', operation, sessionId));
    const id = ++this.nextRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.backend?.cancel(id);
        this.updateRef();
        reject(error('ERR_SMTC_TIMEOUT', operation, sessionId));
      }, this.limits.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation, sessionId });
      this.updateRef();
      try { this.backend!.request(id, operation, sessionId, argument); }
      catch (cause) { clearTimeout(timer); this.pending.delete(id); this.updateRef(); reject(cause); }
    });
  }
  private updateRef() { if (this.lifecycle !== 'stopping') this.backend?.ref(this.pending.size > 0); }
  receive(run: string, message: Message) {
    if (run !== this.state.runId) return;
    if (message.type === 'closed') {
      if (this.delivery) clearImmediate(this.delivery);
      this.delivery = undefined; this.events = [];
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error('ERR_SMTC_ABORTED', entry.operation, entry.sessionId)); }
      this.pending.clear();
      this.backend = undefined;
      this.lifecycle = 'stopped';
      this.state.sessions = []; this.state.currentSessionId = null; this.state.trackedTimelineSessionId = null;
      this.closed?.(); this.closed = undefined;
      return;
    }
    if (message.type === 'result') {
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id!); this.updateRef();
      if (message.error) pending.reject(error(message.error.code, pending.operation, pending.sessionId, message.error.nativeCode));
      else pending.resolve(message.data);
      return;
    }
    if (this.lifecycle === 'starting') { this.topologyDirty = true; return; }
    if (this.lifecycle !== 'running') return;
    if (message.domain === 'revoke') {
      this.warning(error('ERR_SMTC_OPERATION_FAILED', 'revoke'), 'revoke');
      return;
    }
    if (message.domain === 'resync') {
      this.scheduleTopology();
      for (const s of this.state.sessions) {
        this.autoRead(s.sessionId, 'media'); this.autoRead(s.sessionId, 'playback');
        if (s.sessionId === this.state.trackedTimelineSessionId) this.autoRead(s.sessionId, 'timeline');
      }
      return;
    }
    if (message.domain === 'sessions') this.scheduleTopology();
    else if (message.sessionId && domains.includes(message.domain as Domain)) {
      const id = message.sessionId;
      if (this.state.sessions.some(s => s.sessionId === id)) this.autoRead(id, message.domain as Domain);
    }
  }
  private emit(payload: any) {
    const sequence = ++this.state.sequence;
    let event = { ...payload, runId: this.state.runId, sequence };
    if (payload.type === 'sessions-changed' || payload.type === 'resync') event.state = this.getState();
    if (this.events.length >= this.limits.events) {
      this.events = [];
      event = { type: 'resync', runId: this.state.runId, sequence, state: this.getState() };
    }
    this.events.push(structuredClone(event));
    if (!this.delivery) this.delivery = setImmediate(() => this.deliver());
  }
  private deliver() {
    this.delivery = undefined;
    if (this.lifecycle !== 'running') return;
    // Schedule remaining work before invoking user JS, even when it throws.
    const event = this.events.shift();
    if (this.events.length) this.delivery = setImmediate(() => this.deliver());
    if (event) this.onEvent(event);
  }
  private warning(cause: any, operation: string, sessionId?: string) {
    if (this.lifecycle !== 'running' || cause.code === 'ERR_SMTC_ABORTED' || cause.code === 'ERR_SMTC_STALE_SESSION') return;
    this.emit({ type: 'warning', code: cause.code ?? 'ERR_SMTC_OPERATION_FAILED', operation, ...(sessionId ? { sessionId } : {}), ...(cause.nativeCode ? { nativeCode: cause.nativeCode } : {}) });
  }
  private applyTopology(topology: Topology) {
    const old = new Map(this.state.sessions.map(s => [s.sessionId, s]));
    const previousCurrent = this.state.currentSessionId;
    this.state.sessions = topology.sessions.map(s => old.get(s.sessionId) ?? { ...s, media: null, playback: null, timeline: null, revisions: { media: 0, playback: 0, timeline: 0 } });
    const ids = new Set(topology.sessions.map(s => s.sessionId));
    this.state.currentSessionId = topology.currentSessionId && ids.has(topology.currentSessionId) ? topology.currentSessionId : null;
    if (!ids.has(this.state.trackedTimelineSessionId!)) this.state.trackedTimelineSessionId = null;
    for (const [id, pending] of this.pending) if (pending.sessionId && !ids.has(pending.sessionId)) {
      clearTimeout(pending.timer); this.pending.delete(id); this.backend?.cancel(id);
      pending.reject(error('ERR_SMTC_STALE_SESSION', pending.operation, pending.sessionId));
    }
    for (const key of this.thumbnails.keys()) if (![...ids].some(id => key.startsWith(`${id}:`))) this.thumbnails.delete(key);
    this.updateRef();
    this.emit({ type: 'sessions-changed' });
    if (previousCurrent !== this.state.currentSessionId) this.emit({ type: 'current-session-changed', currentSessionId: this.state.currentSessionId });
  }
  private scheduleTopology() {
    this.topologyDirty = true;
    if (this.topology) return;
    const run = this.state.runId;
    this.topology = (async () => {
      do {
        this.topologyDirty = false;
        const topology = await this.request<Topology>('sessions');
        this.assertRun(run, 'sessions');
        this.applyTopology(topology);
        this.refreshAll();
      } while (this.topologyDirty);
    })().catch(cause => this.warning(cause, 'sessions')).finally(() => { if (this.state.runId === run) this.topology = undefined; });
  }
  private refreshAll() {
    for (const s of this.state.sessions) for (const domain of ['media', 'playback'] as Domain[]) {
      if (s[domain] === null) this.autoRead(s.sessionId, domain);
    }
  }
  private autoRead(id: string, domain: Domain) {
    const run = this.state.runId;
    const existing = this.reads.get(`${id}:${domain}`);
    if (existing) { existing.dirty = true; return; }
    void this.read(id, domain, true).catch(cause => {
      if (this.state.runId !== run || this.lifecycle !== 'running') return;
      this.warning(cause, domain, id);
      // Re-enumerate once, without retrying a failing getter in a tight loop.
      if (cause.code === 'ERR_SMTC_OPERATION_FAILED' && !this.topology) {
        void this.request<Topology>('sessions').then(t => { if (this.lifecycle === 'running' && this.state.runId === run) this.applyTopology(t); }).catch(c => { if (this.state.runId === run) this.warning(c, 'sessions'); });
      }
    });
  }
  private read(id: string, domain: Domain, dirty: boolean): Promise<void> {
    const key = `${id}:${domain}`;
    const existing = this.reads.get(key);
    if (existing) { existing.dirty ||= dirty; return existing.promise; }
    const run = this.state.runId;
    const entry: Read = { dirty: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      do {
        entry.dirty = false;
        const data = await this.request<any>(domain, id);
        this.assertRun(run, domain);
        const session = this.session(id, domain);
        if (data?._smtcObsolete) entry.dirty = true;
        if (entry.dirty) continue;
        if (domain === 'media') for (const token of this.thumbnails.keys()) if (token.startsWith(`${id}:`)) this.thumbnails.delete(token);
        session[domain] = data;
        const revision = ++session.revisions[domain];
        this.emit({ type: `${domain}-changed`, sessionId: id, revision, data });
      } while (entry.dirty);
    })().finally(() => { if (this.reads.get(key) === entry) this.reads.delete(key); });
    this.reads.set(key, entry);
    return entry.promise;
  }
}
