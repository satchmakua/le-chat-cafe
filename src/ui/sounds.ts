// AIM-era room sounds, synthesized with Web Audio — no audio files to ship (DESIGN
// §12.5). A door creaks open on arrivals, swings shut on departures, and a soft
// two-note chime means someone said your name or messaged you.

import type { Cue } from '../util/cues';

let ctx: AudioContext | null = null;

/** The shared context, created on first use. Browsers start it suspended until the
 *  page has had a click or keypress; resuming on every cue picks that up. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

interface Tone {
  type: OscillatorType;
  from: number; // Hz
  to?: number; // glide target, Hz
  at: number; // seconds after now
  dur: number; // seconds
  gain: number; // peak, 0..1
}

function play(ac: AudioContext, t: Tone): void {
  const start = ac.currentTime + t.at;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = t.type;
  osc.frequency.setValueAtTime(t.from, start);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.dur);
  // Fast attack, exponential tail — a pluck, not a beep.
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(t.gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
  osc.connect(env).connect(ac.destination);
  osc.start(start);
  osc.stop(start + t.dur + 0.05);
}

const CUES: Record<Cue, Tone[]> = {
  // A creak upward, then the latch.
  'door-open': [
    { type: 'triangle', from: 210, to: 520, at: 0, dur: 0.28, gain: 0.12 },
    { type: 'square', from: 1250, at: 0.27, dur: 0.04, gain: 0.05 },
  ],
  // A creak downward, then the thud of the door meeting the frame.
  'door-close': [
    { type: 'triangle', from: 520, to: 190, at: 0, dur: 0.24, gain: 0.12 },
    { type: 'sine', from: 95, to: 60, at: 0.22, dur: 0.16, gain: 0.22 },
  ],
  // Two bell notes, E6 then B5.
  chime: [
    { type: 'sine', from: 1318.5, at: 0, dur: 0.55, gain: 0.1 },
    { type: 'sine', from: 987.8, at: 0.13, dur: 0.7, gain: 0.1 },
  ],
};

export function playCue(cue: Cue): void {
  const ac = audio();
  if (!ac) return;
  for (const tone of CUES[cue]) play(ac, tone);
}
