// Replay sound is a Settings choice (MS-9), not a Score control. This is the one place the choice and the
// last audio state live: Settings writes the choice, the Score reads it when playback starts and reports
// what the audio device did, and Settings shows that state. Nothing leaves the device.
import type { SoundState } from "./sound";

const KEY = "firehose-replay-sound";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let on = read();
let last: SoundState = "off";
const subs = new Set<() => void>();
const notify = (): void => {
  for (const fn of [...subs]) fn();
};

export const replaySoundSetting = {
  get: (): boolean => on,
  set(next: boolean): void {
    if (next === on) return;
    on = next;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* not kept; the choice still holds for this run */
    }
    notify();
  },
  /** What the audio device did last: the Score reports it, Settings says it. */
  state: (): SoundState => last,
  report(state: SoundState): void {
    if (state === last) return;
    last = state;
    notify();
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
  /** Reads the kept choice again (a fresh launch). */
  reload(): void {
    on = read();
    notify();
  },
  /** Back to off with nothing kept (tests). */
  reset(): void {
    on = false;
    last = "off";
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
    notify();
  },
};
