let wake = () => {};

export function requestRender() { wake(); }

// Keep a single pending frame and sleep once the scene stops changing.
export function createRenderLoop({ render, isAnimating, isPaused, requestFrame, cancelFrame }) {
  let frame = null;
  let disposed = false;
  function invalidate() {
    if (!disposed && frame === null && !isPaused()) frame = requestFrame(tick);
  }
  function tick() {
    frame = null;
    if (disposed || isPaused()) return;
    const wasAnimating = isAnimating();
    render();
    if (wasAnimating || isAnimating()) invalidate();
  }
  function dispose() {
    disposed = true;
    if (frame !== null) cancelFrame(frame);
    frame = null;
  }
  return { invalidate, dispose };
}

export function startRenderLoop(options) {
  const loop = createRenderLoop({
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: frame => cancelAnimationFrame(frame),
    ...options,
  });
  wake = loop.invalidate;
  wake();
  return loop;
}
