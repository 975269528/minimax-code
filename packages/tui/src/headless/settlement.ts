import { performance } from 'node:perf_hooks';

import type { TuiActiveRunControlPort } from '../runtime/port.js';

/** A timeout envelope is not proof that Runtime has released the active turn. */
export async function waitForExecSettlement(
  runtime: TuiActiveRunControlPort,
  sessionId: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        runtime.getActiveRun(sessionId),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - performance.now()));
        }),
      ]);
      if (!snapshot || snapshot.sessionId !== sessionId) return false;
      if (snapshot.state === 'idle' || snapshot.state === 'terminal') return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  return false;
}
