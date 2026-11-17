interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => unknown;
  setTimeout: (callback: () => void) => unknown;
}

const browserScheduler: FrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  setTimeout: (callback) => window.setTimeout(callback, 0),
};

export function disposeAfterPendingFrame(term: { dispose: () => void }, scheduler: FrameScheduler = browserScheduler): void {
  scheduler.requestAnimationFrame(() => {
    scheduler.setTimeout(() => term.dispose());
  });
}
