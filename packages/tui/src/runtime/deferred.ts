import type { TuiRuntime } from './port.js';

const ASYNC_GENERATOR_METHODS = new Set([
  'sendMessage',
  'watchEvents',
  'watchSessionTurn',
  'watchSessionUsageCommits',
]);

/** Lets the product shell render while calls wait for the embedded Runtime to become available. */
export function createDeferredTuiRuntime(runtimePromise: Promise<TuiRuntime>): TuiRuntime {
  let resolvedRuntime: TuiRuntime | undefined;
  void runtimePromise.then(
    (runtime) => {
      resolvedRuntime = runtime;
    },
    () => undefined,
  );

  return new Proxy({} as TuiRuntime, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'isGoalEnabled') {
        return () => resolvedRuntime?.isGoalEnabled() ?? false;
      }
      if (typeof property !== 'string') return undefined;
      if (ASYNC_GENERATOR_METHODS.has(property)) {
        return (...args: unknown[]) => forwardAsyncGenerator(runtimePromise, property, args);
      }
      return async (...args: unknown[]) => {
        const runtime = await runtimePromise;
        const member = Reflect.get(runtime, property) as unknown;
        if (typeof member !== 'function') return member;
        return Reflect.apply(member, runtime, args) as unknown;
      };
    },
  });
}

async function* forwardAsyncGenerator(
  runtimePromise: Promise<TuiRuntime>,
  property: string,
  args: unknown[],
): AsyncGenerator<unknown> {
  const runtime = await runtimePromise;
  const member = Reflect.get(runtime, property) as unknown;
  if (typeof member !== 'function') return;
  const stream = Reflect.apply(member, runtime, args) as AsyncGenerator<unknown>;
  yield* stream;
}
