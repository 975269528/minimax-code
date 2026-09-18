const STARTUP_STATUS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const STARTUP_STATUS_INTERVAL_MS = 80;

export interface TuiStartupStatus {
  stop(): void;
}

export function startTuiStartupStatus(
  render: (status: string | undefined) => void,
): TuiStartupStatus {
  let frameIndex = 0;
  let stopped = false;

  const notify = (status: string | undefined) => {
    try {
      render(status);
    } catch {
      // Startup feedback must never affect Runtime or TUI initialization.
    }
  };
  const renderFrame = () => {
    if (stopped) return;
    notify(`${STARTUP_STATUS_FRAMES[frameIndex]} Starting server...`);
    frameIndex = (frameIndex + 1) % STARTUP_STATUS_FRAMES.length;
  };

  renderFrame();
  const interval = setInterval(renderFrame, STARTUP_STATUS_INTERVAL_MS);
  interval.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      notify(undefined);
    },
  };
}
