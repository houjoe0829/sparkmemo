/**
 * Floating microphone button for the mobile capture view.
 *
 * Visual:
 *   - 48×48 circle anchored bottom-right, position: fixed
 *   - Bottom offset follows the body class `jp-hide-mobile-toolbar`:
 *     toolbar visible → 80px (clears the toolbar), hidden → 24px.
 *     The CSS handles the transition; we just set the position.
 *
 * Interaction:
 *   - press-and-hold to record (PointerDown)
 *   - release to transcribe (PointerUp) — actual STT call lives in the
 *     caller's onComplete hook so this widget stays UI-only
 *   - swipe up >80px while pressed → cancel
 *   - 60s hard cap auto-stops and emits onComplete
 *   - too-short press (<500ms) silently discards (misclick guard)
 *
 * State machine:
 *   idle → recording → (transcribing) → idle | error
 *   any state + cancel → idle (silently)
 *
 * The component owns no STT logic. The caller passes an onComplete that
 * receives the audio blob; this is where the actual API call happens.
 * That keeps recorder + STT testable independently and matches the
 * design's "first ship recorder, then bolt on STT" slicing.
 */

import { Notice, setIcon } from 'obsidian';

import { MicRecorder, RecordingResult } from './recorder';

export interface FloatingMicOptions {
  /** Parent element to fix-position the button inside (typically the
   *  capture view's root). Used only as an anchor for documentSheet z-index
   *  and DOM lifecycle — the button itself is `position: fixed` so it
   *  paints relative to the viewport. */
  container: HTMLElement;
  /** Max recording duration in seconds before auto-stop. */
  maxSeconds: number;
  /** Called when a valid recording completes (after the min-duration
   *  guard). The callback should perform STT and any UI follow-up. */
  onComplete: (result: RecordingResult) => Promise<void> | void;
}

type State = 'idle' | 'recording' | 'transcribing' | 'error';

const MIN_DURATION_MS = 500;
const CANCEL_SWIPE_PX = 80;

export class FloatingMic {
  private readonly opts: FloatingMicOptions;
  private readonly btn: HTMLButtonElement;
  private readonly recorder: MicRecorder;

  private state: State = 'idle';
  private pressStartedAt = 0;
  private pressStartY = 0;
  private maxStopTimer: number | null = null;
  private tickTimer: number | null = null;
  private cancelled = false;

  // Bound handlers (kept around so we can removeEventListener cleanly)
  private readonly onPointerDown = (e: PointerEvent) => this.handleDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.handleMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.handleUp(e);
  private readonly onPointerCancel = () => this.cancel('指针取消');

  constructor(opts: FloatingMicOptions) {
    this.opts = opts;
    this.recorder = new MicRecorder();

    this.btn = document.body.createEl('button', {
      cls: 'jp-floating-mic',
      attr: { 'aria-label': '按住说话', type: 'button' },
    });
    setIcon(this.btn, 'mic');

    // Pointer events cover touch + mouse + pen in one model
    this.btn.addEventListener('pointerdown', this.onPointerDown);
    this.btn.addEventListener('pointermove', this.onPointerMove);
    this.btn.addEventListener('pointerup', this.onPointerUp);
    this.btn.addEventListener('pointercancel', this.onPointerCancel);
    // Prevent the long-press iOS callout / text selection
    this.btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  /** Tear down. Always-show on unmount: clear any state classes. */
  destroy() {
    this.btn.removeEventListener('pointerdown', this.onPointerDown);
    this.btn.removeEventListener('pointermove', this.onPointerMove);
    this.btn.removeEventListener('pointerup', this.onPointerUp);
    this.btn.removeEventListener('pointercancel', this.onPointerCancel);
    this.clearTimers();
    this.recorder.cancel();
    this.btn.remove();
  }

  /** Force the button into a transient transcribing state. Used by the
   *  caller while the STT request is in flight. */
  setTranscribing(on: boolean) {
    this.setState(on ? 'transcribing' : 'idle');
  }

  /** Briefly flash error state then return to idle. */
  flashError(message?: string) {
    this.setState('error');
    if (message) new Notice(message);
    window.setTimeout(() => {
      if (this.state === 'error') this.setState('idle');
    }, 1800);
  }

  // ── Pointer handlers ────────────────────────────────────────────────────

  private async handleDown(e: PointerEvent) {
    if (this.state !== 'idle') return;
    e.preventDefault();
    this.cancelled = false;
    this.pressStartedAt = performance.now();
    this.pressStartY = e.clientY;
    // Capture so subsequent move/up events still fire even if the finger
    // leaves the button.
    try { this.btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    try {
      await this.recorder.start();
    } catch (err) {
      this.flashError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Recorder is live — flip state and start the visual timer
    this.setState('recording');
    this.startTicker();

    // Hard cap
    this.maxStopTimer = window.setTimeout(() => {
      if (this.state === 'recording') void this.finishUp();
    }, this.opts.maxSeconds * 1000);
  }

  private handleMove(e: PointerEvent) {
    if (this.state !== 'recording') return;
    const dy = this.pressStartY - e.clientY;
    if (dy > CANCEL_SWIPE_PX) {
      // Swiped far enough — visually mark as "release to cancel"
      this.btn.addClass('jp-floating-mic--will-cancel');
    } else {
      this.btn.removeClass('jp-floating-mic--will-cancel');
    }
  }

  private async handleUp(e: PointerEvent) {
    if (this.state !== 'recording') return;
    const dy = this.pressStartY - e.clientY;
    if (dy > CANCEL_SWIPE_PX) {
      this.cancel('已取消');
      return;
    }
    await this.finishUp();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async finishUp() {
    this.clearTimers();
    this.btn.removeClass('jp-floating-mic--will-cancel');

    const elapsed = performance.now() - this.pressStartedAt;
    if (elapsed < MIN_DURATION_MS) {
      // Misclick guard: too short to be a real recording
      this.recorder.cancel();
      this.setState('idle');
      return;
    }

    let result: RecordingResult;
    try {
      result = await this.recorder.stop();
    } catch (err) {
      this.flashError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (this.cancelled) return; // raced with a cancel call

    this.setState('transcribing');
    try {
      await this.opts.onComplete(result);
      this.setState('idle');
    } catch (err) {
      this.flashError(err instanceof Error ? err.message : String(err));
    }
  }

  private cancel(reason: string) {
    this.cancelled = true;
    this.clearTimers();
    this.recorder.cancel();
    this.btn.removeClass('jp-floating-mic--will-cancel');
    this.setState('idle');
    new Notice(reason);
  }

  private setState(next: State) {
    this.state = next;
    this.btn.removeClass(
      'jp-floating-mic--recording',
      'jp-floating-mic--transcribing',
      'jp-floating-mic--error',
    );
    if (next === 'recording') this.btn.addClass('jp-floating-mic--recording');
    else if (next === 'transcribing') this.btn.addClass('jp-floating-mic--transcribing');
    else if (next === 'error') this.btn.addClass('jp-floating-mic--error');

    // Reset the timer label when leaving recording
    if (next !== 'recording') this.btn.setAttr('data-elapsed', '');
  }

  private startTicker() {
    const updateLabel = () => {
      const elapsed = (performance.now() - this.pressStartedAt) / 1000;
      const mm = Math.floor(elapsed / 60);
      const ss = Math.floor(elapsed % 60).toString().padStart(2, '0');
      this.btn.setAttr('data-elapsed', `${mm}:${ss}`);
    };
    updateLabel();
    this.tickTimer = window.setInterval(updateLabel, 250);
  }

  private clearTimers() {
    if (this.maxStopTimer !== null) {
      window.clearTimeout(this.maxStopTimer);
      this.maxStopTimer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
