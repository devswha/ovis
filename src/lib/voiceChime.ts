/** The two notes a live call opens and closes on, the agents app's own, made here rather than shipped as files. */
export type VoiceChimeKind = "open" | "close";

const SAMPLE_RATE = 44_100;

const tone = (time: number, frequency: number, { delay = 0, attack = 0.008, tau = 0.14, gain = 1 } = {}): number => {
  const t = time - delay;
  if (t < 0) return 0;
  return gain * (t < attack ? t / attack : 1) * Math.exp(-t / tau) * Math.sin(2 * Math.PI * frequency * t);
};

const sparkle = (time: number, delay: number, gain: number): number => {
  const t = time - delay;
  return t < 0 || t > 0.018 ? 0 : gain * Math.exp(-t / 0.006) * Math.sin(t * 18_700) * Math.sin(t * 9_331);
};

const mix = (kind: VoiceChimeKind, time: number): number => kind === "open"
  ? tone(time, 261.63, { tau: 0.2, gain: 0.2 }) + tone(time, 329.63, { delay: 0.058, tau: 0.22, gain: 0.22 }) + sparkle(time, 0.052, 0.016)
  : tone(time, 261.63, { tau: 0.1, gain: 0.28 }) + tone(time, 130.815, { attack: 0.014, tau: 0.12, gain: 0.14 }) + tone(time, 523.26, { attack: 0.004, tau: 0.05, gain: 0.07 });

function samples(kind: VoiceChimeKind): Float32Array<ArrayBuffer> {
  const seconds = kind === "open" ? 0.65 : 0.45;
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  for (let index = 0; index < out.length; index += 1) {
    const time = index / SAMPLE_RATE;
    out[index] = Math.tanh(mix(kind, time) * 1.15) * (time > seconds - 0.04 ? (seconds - time) / 0.04 : 1);
  }
  return out;
}

// made on the tap that opens a call, so the chimes can play later with no tap of their own
let context: AudioContext | null = null;
const buffers = new Map<VoiceChimeKind, AudioBuffer>();
let sounding = 0;

/** A running context holds the phone's audio output (and a wakelock) open; once the page is out of sight and no chime plays, let it go. The next chime resumes it. */
function rest(): void {
  if (sounding === 0 && document.visibilityState === "hidden") void context?.suspend().catch(() => undefined);
}

function chimeContext(): AudioContext | null {
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!context) {
    context = new AudioContextClass();
    document.addEventListener("visibilitychange", rest);
  }
  return context;
}

/** Readies the chimes on a tap, so the opening one can play once the call is ready to talk. */
export function primeVoiceChime(): void {
  void chimeContext()?.resume().catch(() => undefined);
}

/** Plays a chime; a browser without Web Audio stays quiet. */
export function playVoiceChime(kind: VoiceChimeKind): void {
  const target = chimeContext();
  if (!target) return;
  let buffer = buffers.get(kind);
  if (!buffer) {
    const data = samples(kind);
    buffer = target.createBuffer(1, data.length, SAMPLE_RATE);
    buffer.copyToChannel(data, 0);
    buffers.set(kind, buffer);
  }
  const source = target.createBufferSource();
  source.buffer = buffer;
  source.connect(target.destination);
  void target.resume().then(() => {
    sounding += 1;
    source.onended = () => { sounding -= 1; rest(); };
    source.start();
  }, () => undefined);
}
