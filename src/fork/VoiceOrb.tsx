import { useEffect, useRef, useState } from "react";

import type { PiVoicePhase } from "../../shared/pi-voice.ts";
import { advanceOrbMotion, createOrbMotionDriver, orbModeFor, orbVolumeLevel } from "../lib/orbMotion.ts";
import { ORB_FRAGMENT_SHADER, ORB_FROST_COLORS, ORB_VERTEX_SHADER } from "../lib/orbShader.ts";

/**
 * The voice call's orb: the glass-liquid sphere of the agents app on a small WebGL canvas, swelling
 * with the reply and drawing in as the user speaks (lib/orbMotion.ts). The canvas draws the liquid;
 * its scale and opacity are CSS, as in the agents app, so the shader runs once per frame at most.
 * Where WebGL is missing or its context is lost, a plain disc in the theme's colors takes its
 * place with the same motion.
 */
export function VoiceOrb({ phase, levels }: { phase: PiVoicePhase | "ended"; levels: () => { input: number; output: number } }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const disc = useRef<HTMLDivElement>(null);
  const [plain, setPlain] = useState(false);
  // read each frame, so the loop never restarts when the phase changes
  const latest = useRef({ phase, levels });
  latest.current = { phase, levels };

  useEffect(() => {
    const target = plain ? disc.current : canvas.current;
    if (!target) return;
    const gl = plain ? null : openOrb(canvas.current!, () => setPlain(true));
    if (!plain && !gl) {
      setPlain(true);
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const driver = createOrbMotionDriver();
    let size = 0;
    const resize = () => {
      const side = box.current?.clientWidth ?? 0;
      if (!gl || side === size) return;
      size = side;
      const pixels = Math.max(1, Math.ceil(side * Math.max(1, window.devicePixelRatio || 1)));
      gl.canvas.width = pixels;
      gl.canvas.height = pixels;
      gl.draw(0, pixels);
    };
    const watcher = new ResizeObserver(resize);
    if (box.current) watcher.observe(box.current);
    resize();

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const { phase: current, levels: read } = latest.current;
      const { input, output } = read();
      const motion = advanceOrbMotion(driver, orbVolumeLevel(input), orbVolumeLevel(output), orbModeFor(current), (now - last) / 1000);
      last = now;
      target.style.transform = `scale(${motion.scale.toFixed(4)})`;
      target.style.opacity = motion.opacity.toFixed(3);
      // reduced motion keeps the swell but not the flow: the liquid is drawn once, at rest
      if (gl && !still) gl.draw(motion.time, gl.canvas.width);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      last = performance.now();
      if (document.visibilityState === "visible") frame = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      document.removeEventListener("visibilitychange", start);
      cancelAnimationFrame(frame);
      watcher.disconnect();
      gl?.release();
    };
  }, [plain]);

  return (
    <div className="pi-voice-orb" ref={box} aria-hidden="true">
      {plain ? <div className="pi-voice-orb-disc" ref={disc} /> : <canvas className="pi-voice-orb-canvas" ref={canvas} />}
    </div>
  );
}

interface OrbGl {
  canvas: HTMLCanvasElement;
  draw(time: number, pixels: number): void;
  release(): void;
}

/** The orb's WebGL program on `canvas`, or null where it cannot be made; `onLost` hears of a lost context. */
function openOrb(canvas: HTMLCanvasElement, onLost: () => void): OrbGl | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, ORB_VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, ORB_FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // one triangle that covers the canvas
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, "uResolution");
  const time = gl.getUniformLocation(program, "uTime");
  ["uColorA", "uColorB", "uColorC", "uColorD"].forEach((name, index) => gl.uniform3fv(gl.getUniformLocation(program, name), ORB_FROST_COLORS[index]!));
  gl.clearColor(0, 0, 0, 0);
  const lost = (event: Event) => {
    event.preventDefault();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  return {
    canvas,
    draw(seconds, pixels) {
      gl.viewport(0, 0, pixels, pixels);
      gl.uniform2f(resolution, pixels, pixels);
      gl.uniform1f(time, seconds);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    release() {
      canvas.removeEventListener("webglcontextlost", lost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
