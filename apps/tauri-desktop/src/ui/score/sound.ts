/** Local, opt-in replay cues. No timers, queue, persistence or network. */
export type SoundState = "off" | "enabling" | "on" | "unavailable";
export const REPLAY_PITCHES: Record<string, number> = {error:220,permission:660,file:440,tool:330,shell:392,prompt:523,message:587,session:262,meta:196};
export function createReplaySound(changed: (state: SoundState) => void) {
  let context: AudioContext | undefined, enabled = false, version = 0, last = -Infinity, shown: SoundState = "off";
  const report = (state: SoundState) => { shown = state; changed(state); };
  let voice: {oscillator: OscillatorNode; gain: GainNode} | undefined;
  function stop() {
    if (!voice) return;
    const current = voice; voice = undefined;
    try { current.oscillator.stop(); } catch { /* already stopped */ }
    current.oscillator.disconnect(); current.gain.disconnect();
  }
  /** Stops and closes audio. A plain "off" keeps a failure the device reported unless `clearFailure` (the choice itself was turned off). */
  function disable(state: SoundState = "off", clearFailure = false) {
    version++; enabled = false; stop();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
    const old = context; context = undefined;
    if (old) { old.onstatechange = null; void old.close().catch(() => {}); }
    report(state === "off" && shown === "unavailable" && !clearFailure ? "unavailable" : state);
  }
  function visibility() { if (document.hidden) disable(); }
  function pagehide() { disable(); }
  async function enable() {
    disable();
    if (document.hidden) return;
    const token = version;
    report("enabling");
    try {
      const next = new AudioContext(); context = next;
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("pagehide", pagehide);
      await next.resume();
      if (version !== token) return;
      if (next.state !== "running") { disable("unavailable"); return; }
      enabled = true; last = -Infinity;
      next.onstatechange = () => { if (context === next && enabled && next.state !== "running") disable("unavailable"); };
      report("on");
    } catch { if (version === token) disable("unavailable"); }
  }
  function cue(category: string) {
    if (!enabled || !context || document.hidden) return;
    try {
      if (context.state !== "running") { disable("unavailable"); return; }
      const now = context.currentTime;
      if (now - last < .15) return;
      stop(); last = now;
      const oscillator = context.createOscillator(), gain = context.createGain();
      voice = {oscillator, gain};
      oscillator.type = "sine"; oscillator.frequency.value = Object.hasOwn(REPLAY_PITCHES, category) ? REPLAY_PITCHES[category] : 196;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(.025, now + .01);
      gain.gain.linearRampToValueAtTime(0, now + .08);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); if (voice?.oscillator === oscillator) voice = undefined; };
      oscillator.start(now); oscillator.stop(now + .08);
    } catch { disable("unavailable"); }
  }
  return {enable, disable: (clearFailure = false) => disable("off", clearFailure), stop, cue};
}
