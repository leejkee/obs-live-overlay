/// <reference types="node" />
export type SessionId = string;
export type Status = 'closed' | 'opened' | 'changing' | 'stopped' | 'playing' | 'paused' | 'unknown';
export type Domain = 'media' | 'playback' | 'timeline';
export interface MediaProperties {
  title: string; subtitle: string; artist: string; albumTitle: string; albumArtist: string;
  genres: string[]; trackNumber: number; albumTrackCount: number; thumbnailId: string | null;
}
export interface PlaybackInfo {
  status: Status; playbackRate: number | null;
}
export interface Timeline {
  startTimeMs: number; endTimeMs: number; positionMs: number; minSeekTimeMs: number;
  maxSeekTimeMs: number; lastUpdatedTimeUtcMs: number | null; observedAtUtcMs: number;
}
export interface SessionData {
  sessionId: SessionId; sourceAppUserModelId: string;
  media: MediaProperties | null; playback: PlaybackInfo | null; timeline: Timeline | null;
  revisions: Record<Domain, number>;
}
export interface NativeState {
  runId: string; sequence: number; currentSessionId: SessionId | null;
  trackedTimelineSessionId: SessionId | null; sessions: SessionData[];
}
export interface Thumbnail { thumbnailId: string; contentType: string | null; data: Buffer }
export interface SmtcError extends Error { code: string; operation: string; sessionId?: SessionId; nativeCode?: string }
export type NativeEvent = { runId: string; sequence: number } & (
  | { type: 'sessions-changed' | 'resync'; state: NativeState }
  | { type: 'current-session-changed'; currentSessionId: SessionId | null }
  | { type: 'media-changed'; sessionId: SessionId; revision: number; data: MediaProperties }
  | { type: 'playback-changed'; sessionId: SessionId; revision: number; data: PlaybackInfo }
  | { type: 'timeline-changed'; sessionId: SessionId; revision: number; data: Timeline }
  | { type: 'warning'; code: string; operation: string; sessionId?: SessionId; nativeCode?: string }
);
export interface NativeMonitor {
  start(): Promise<NativeState>;
  stop(): Promise<void>;
  getState(): NativeState;
  refresh(sessionId: SessionId, domain: Domain): Promise<void>;
  setTimelineTracking(sessionId: SessionId | null): Promise<void>;
  getThumbnail(sessionId: SessionId, thumbnailId: string): Promise<Thumbnail | null>;
}
export function createMonitor(onEvent: (event: NativeEvent) => void): NativeMonitor;
