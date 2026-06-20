/**
 * Microphone recorder.
 *
 * Thin wrapper around MediaRecorder + getUserMedia that hides the
 * cross-browser mime-type negotiation. iOS WKWebView prefers `audio/mp4`
 * (AAC); Android Chrome prefers `audio/webm` (Opus). We probe and pick
 * whatever the platform claims to support.
 *
 * Owns no UI state — callers drive the lifecycle and observe the returned
 * Blob. Permission denials surface as rejected promises so the UI layer
 * can decide how to message the user.
 */

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  /** Suggested filename extension matching mimeType (no leading dot). */
  ext: string;
  /** Duration in seconds, derived from start→stop wall clock. */
  durationSec: number;
}

/** Pick the best mime type available on this runtime. */
function pickMimeType(): { mime: string; ext: string } {
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: 'audio/mp4', ext: 'm4a' },          // iOS WKWebView native
    { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
    { mime: 'audio/webm;codecs=opus', ext: 'webm' }, // Chromium
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) {
      return c;
    }
  }
  // Last resort — let the platform default decide.
  return { mime: '', ext: 'webm' };
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private resolveStop: ((r: RecordingResult) => void) | null = null;
  private rejectStop: ((err: Error) => void) | null = null;

  /** True once start() has succeeded and stop() hasn't yet been called. */
  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  /**
   * Begin recording. Throws if permission is denied or the platform lacks
   * MediaRecorder/getUserMedia support.
   */
  async start(): Promise<void> {
    if (this.recorder) {
      throw new Error('Recorder already started');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风录音 (getUserMedia 不可用)');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('当前环境不支持 MediaRecorder');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error('麦克风权限被拒绝');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('未检测到麦克风设备');
      }
      throw new Error(`麦克风启动失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const { mime, ext } = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      // Some browsers throw on unsupported mime even after isTypeSupported
      // returns true. Fall back to platform default.
      recorder = new MediaRecorder(stream);
    }
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    this.startedAt = performance.now();

    recorder.addEventListener('dataavailable', evt => {
      if (evt.data && evt.data.size > 0) this.chunks.push(evt.data);
    });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(this.chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      const durationSec = Math.max(0, (performance.now() - this.startedAt) / 1000);
      const result: RecordingResult = {
        blob,
        mimeType: blob.type,
        ext,
        durationSec,
      };
      this.cleanup();
      this.resolveStop?.(result);
      this.resolveStop = null;
      this.rejectStop = null;
    });
    recorder.addEventListener('error', evt => {
      const err = (evt as unknown as { error?: Error }).error ?? new Error('录音异常');
      this.cleanup();
      this.rejectStop?.(err);
      this.resolveStop = null;
      this.rejectStop = null;
    });

    recorder.start();
  }

  /**
   * Stop recording and resolve with the final Blob. Safe to call after
   * start() — calling without an active recording resolves with an empty
   * blob synchronously.
   */
  stop(): Promise<RecordingResult> {
    if (!this.recorder || this.recorder.state === 'inactive') {
      return Promise.resolve({
        blob: new Blob([], { type: 'audio/webm' }),
        mimeType: 'audio/webm',
        ext: 'webm',
        durationSec: 0,
      });
    }
    return new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
      try {
        this.recorder!.stop();
      } catch (err) {
        this.cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Abort the recording and discard any buffered audio. Idempotent.
   * Use when the user cancels (e.g. swipes up to cancel mid-record).
   */
  cancel(): void {
    if (!this.recorder) return;
    try {
      if (this.recorder.state !== 'inactive') {
        // Detach handlers so the resolved promise (if any) doesn't fire
        // with stale data.
        this.resolveStop = null;
        this.rejectStop = null;
        this.recorder.stop();
      }
    } catch {
      // ignore — cleanup unconditionally
    }
    this.cleanup();
  }

  private cleanup() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
