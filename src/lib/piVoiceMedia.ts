import { PI_VOICE_FEATURES, type PhoneToPiFrame, type PiToPhoneFrame, type PiVoiceRequest } from "../../shared/pi-voice.ts";
import { nativeCallAudio } from "./nativeApp.ts";

/**
 * The phone as the audio device of a Pi pane's live voice call. Pi (pi-better-openai) keeps the
 * login, the realtime session and the coding agent; it asks this side to open the microphone,
 * make a WebRTC offer, take OpenAI's answer, and start and stop sending. The audio itself goes
 * from here to OpenAI over WebRTC and comes back the same way, so only SDP, control frames,
 * levels and the voice service's events cross to Pi. The remote protocol is the one Pi speaks to
 * a Linux audio computer over SSH; here the "computer" is a browser (see
 * src/live/remote/README.md in pi-better-openai).
 *
 * The reply arrives about 8 dB quieter than Read aloud, so it plays through the Web Audio graph,
 * raised and limited. Chrome's browser-wide echo cancellation, and Android's own, hear that
 * output too. The <audio> element still holds the stream, muted: without it Chrome gives a
 * remote stream's Web Audio source silence.
 *
 * While Pi parks the call (a long task runs and the voice session sleeps) the connection to OpenAI
 * is let go of but the microphone, the speaker and the connection to Pi stay: the next
 * `createOffer` builds a new connection on the same media, without another `open`.
 */

/** Pi pings every 5 s; the same silence after which Pi itself would give up on a vanished host */
const LEASE_MS = 20_000;
const LEVELS_MS = 100;
const DEFAULT_OPEN_WAIT_MS = 60_000;
const MAX_ERROR = 500;
/** +8 dB: the reply's speech level measured against Read aloud's */
const REPLY_GAIN = 2.5;

export interface PiVoiceTimers {
  every(run: () => void, ms: number): () => void;
  after(run: () => void, ms: number): () => void;
}

export const browserTimers: PiVoiceTimers = {
  every: (run, ms) => {
    const id = setInterval(run, ms);
    return () => clearInterval(id);
  },
  after: (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
};

export interface PiVoiceMediaDeps {
  /** the microphone, already allowed: asking happens in the tap that starts the call */
  stream: MediaStream;
  audio: HTMLAudioElement;
  audioContext: AudioContext | null;
  createPeer(): RTCPeerConnection;
  send(frame: PhoneToPiFrame): void;
  /** the call cannot go on; Pi has been told */
  onFailed(message: string): void;
  timers?: PiVoiceTimers;
}

const clamp = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

function rms(analyser: AnalyserNode | undefined, samples: Float32Array<ArrayBuffer>): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return clamp(Math.sqrt(sum / samples.length));
}

export class BrowserLiveMedia {
  readonly #deps: PiVoiceMediaDeps;
  readonly #timers: PiVoiceTimers;
  readonly #samples = new Float32Array(1024);
  #peer: RTCPeerConnection | undefined;
  #channel: RTCDataChannel | undefined;
  #opened: Promise<void> | undefined;
  #micAnalyser: AnalyserNode | undefined;
  #remoteAnalyser: AnalyserNode | undefined;
  #stopLease: (() => void) | undefined;
  #stopLevels: (() => void) | undefined;
  /** gives up the wait for the channel to open, when one is pending */
  #abortWait: ((reason: Error) => void) | undefined;
  #active = false;
  #muted = false;
  #closed = false;

  constructor(deps: PiVoiceMediaDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? browserTimers;
    this.#micAnalyser = this.#analyserOf(deps.stream);
  }

  /** The connection to Pi is up: say the device is here and what it can take, and start counting Pi's silence. */
  hello(): void {
    this.#armLease();
    this.#emit({ type: "hello", features: [...PI_VOICE_FEATURES] });
  }

  /** A frame from Pi. Only the ones about the audio device are acted on; any of them shows Pi is there. */
  receive(frame: PiToPhoneFrame): void {
    if (this.#closed) return;
    this.#armLease();
    switch (frame.type) {
      case "request":
        void this.#serve(frame);
        break;
      case "activate":
        this.#active = true;
        this.#syncTrack();
        this.#startLevels();
        break;
      case "mute":
        this.#muted = frame.muted;
        this.#syncTrack();
        break;
      case "park":
        this.#park();
        break;
      case "close":
        this.close();
        break;
      default:
        break;
    }
  }

  /** Linear 0..1 levels of what the microphone hears and what the reply plays. */
  sample(): { input: number; output: number } {
    return { input: this.#muted ? 0 : rms(this.#micAnalyser, this.#samples), output: this.#outputLevel() };
  }

  /** Releases the microphone, the speaker and the connection. Safe to repeat. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopLease?.();
    this.#stopLevels?.();
    this.#abortWait?.(new Error("The call ended."));
    for (const track of this.#deps.stream.getTracks()) track.stop();
    this.#dropPeer();
    this.#deps.audio.pause();
    this.#deps.audio.remove();
    void this.#deps.audioContext?.close().catch(() => undefined);
  }

  /**
   * Pi parks the call: the connection to OpenAI goes, and nothing is sent until Pi activates a new
   * one. The microphone, the speaker and Pi's lease stay.
   */
  #park(): void {
    this.#active = false;
    this.#syncTrack();
    this.#stopLevels?.();
    this.#stopLevels = undefined;
    this.#abortWait?.(new Error("The call is parked."));
    this.#dropPeer();
  }

  /** Lets go of the connection to OpenAI, quietly: whatever it still says is no one's. */
  #dropPeer(): void {
    const { audio } = this.#deps;
    if (this.#channel) {
      this.#channel.onopen = null;
      this.#channel.onmessage = null;
      this.#channel.close();
    }
    if (this.#peer) {
      this.#peer.ontrack = null;
      this.#peer.onconnectionstatechange = null;
      this.#peer.close();
    }
    this.#peer = undefined;
    this.#channel = undefined;
    this.#opened = undefined;
    this.#remoteAnalyser = undefined;
    audio.srcObject = null;
  }

  /**
   * Everything sent to Pi goes through here: once the media is closed it says nothing. The call's
   * connection may by then belong to the next call, and Pi ends a call for a frame it did not ask for.
   */
  #emit(frame: PhoneToPiFrame): void {
    if (!this.#closed) this.#deps.send(frame);
  }

  #fail(message: string): void {
    if (this.#closed) return;
    this.#emit({ type: "failure", message });
    this.close();
    this.#deps.onFailed(message);
  }

  #armLease(): void {
    this.#stopLease?.();
    this.#stopLease = this.#timers.after(() => this.#fail("Pi stopped answering."), LEASE_MS);
  }

  #syncTrack(): void {
    const track = this.#deps.stream.getAudioTracks()[0];
    if (track) track.enabled = this.#active && !this.#muted;
  }

  async #serve(frame: PiVoiceRequest): Promise<void> {
    try {
      const sdp = await this.#perform(frame);
      this.#emit({ type: "response", id: frame.id, ok: true, ...(sdp ? { sdp } : {}) });
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_ERROR) || "The request failed.";
      this.#emit({ type: "response", id: frame.id, ok: false, error });
    }
  }

  async #perform(frame: PiVoiceRequest): Promise<string | undefined> {
    switch (frame.method) {
      case "open":
        return undefined;
      case "createOffer":
        return this.#makeOffer();
      case "acceptAnswer": {
        if (!this.#peer) throw new Error("No offer was made.");
        await this.#peer.setRemoteDescription({ type: "answer", sdp: frame.sdp });
        return undefined;
      }
      case "waitForOpen":
        await this.#waitForOpen(frame.timeoutMs ?? DEFAULT_OPEN_WAIT_MS);
        return undefined;
    }
  }

  async #makeOffer(): Promise<string> {
    const { stream, audio } = this.#deps;
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("The microphone is not available.");
    // nothing is sent until Pi says the session is connected, then only while not muted
    track.enabled = false;
    track.onended = () => this.#fail("The microphone stopped.");
    // an offer on media that already has a connection replaces it
    this.#dropPeer();
    const peer = this.#deps.createPeer();
    this.#peer = peer;
    peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    this.#channel = channel;
    this.#opened = new Promise((resolve) => {
      channel.onopen = () => resolve();
    });
    channel.onmessage = (event) => {
      if (typeof event.data === "string" && event.data) this.#emit({ type: "event", payload: event.data });
    };
    peer.ontrack = (event) => {
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      audio.srcObject = remote;
      audio.muted = this.#playLouder(remote);
      void audio.play().catch(() => undefined);
      this.#remoteAnalyser = this.#analyserOf(remote);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") this.#fail("The connection to the voice service failed.");
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("The connection made no offer.");
    return sdp;
  }

  #waitForOpen(ms: number): Promise<void> {
    const opened = this.#opened;
    if (!opened || !this.#channel) return Promise.reject(new Error("No offer was made."));
    if (this.#channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stop = this.#timers.after(() => {
        this.#abortWait = undefined;
        reject(new Error("The connection to the voice service did not open."));
      }, ms);
      this.#abortWait = (reason) => {
        stop();
        this.#abortWait = undefined;
        reject(reason);
      };
      void opened.then(() => {
        stop();
        this.#abortWait = undefined;
        resolve();
      });
    });
  }

  #startLevels(): void {
    this.#stopLevels?.();
    this.#stopLevels = this.#timers.every(() => {
      const { input, output } = this.sample();
      this.#emit({ type: "levels", input: clamp(input), output: clamp(output) });
    }, LEVELS_MS);
  }

  /** Plays the reply raised, with a limiter so its loudest moments can't clip; false where there is no Web Audio. */
  #playLouder(stream: MediaStream): boolean {
    const context = this.#deps.audioContext;
    if (!context || nativeCallAudio()) return false;
    try {
      const gain = context.createGain();
      gain.gain.value = REPLY_GAIN;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      context.createMediaStreamSource(stream).connect(gain).connect(limiter).connect(context.destination);
      return true;
    } catch {
      return false;
    }
  }

  #analyserOf(stream: MediaStream): AnalyserNode | undefined {
    const context = this.#deps.audioContext;
    if (!context) return undefined;
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = this.#samples.length;
      // the analyser is a tap on the reply as it arrives, before it is raised
      context.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    } catch {
      return undefined;
    }
  }

  /** The synchronization source's level where the browser gives one, else what the reply's own stream measures. */
  #outputLevel(): number {
    const receiver = this.#peer?.getReceivers().find((candidate) => candidate.track.kind === "audio");
    const level = receiver?.getSynchronizationSources?.()[0]?.audioLevel;
    return typeof level === "number" ? clamp(level) : rms(this.#remoteAnalyser, this.#samples);
  }
}
