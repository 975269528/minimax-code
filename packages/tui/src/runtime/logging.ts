import { join } from 'node:path';
import { Writable } from 'node:stream';
import { formatWithOptions } from 'node:util';
import {
  configureImLogger,
  configureLocalRuntimeLogging,
  flushImLogger,
  flushLocalRuntimeLogging,
  logger,
  shutdownImLogger,
  shutdownLocalRuntimeLogging,
  type ConfigureImLoggerOptions,
  type ConfigureLocalRuntimeLoggingOptions,
  type LocalRuntimeLogger,
} from '@mavis/local-runtime-v2/logging';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
type RuntimeLogLevel = 'info' | 'warn' | 'error';

type ConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>;
type RuntimeLoggerLike = Pick<LocalRuntimeLogger, RuntimeLogLevel>;

export interface TuiRuntimeLogging {
  logDirectory: string;
  runDuringStartup<T>(operation: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TuiRuntimeLoggingDependencies {
  configureRuntime?: (options: ConfigureLocalRuntimeLoggingOptions) => void;
  configureIm?: (options: ConfigureImLoggerOptions) => void;
  flushRuntime?: () => Promise<void>;
  flushIm?: () => Promise<void>;
  shutdownRuntime?: () => Promise<void>;
  shutdownIm?: () => Promise<void>;
  runtimeLogger?: RuntimeLoggerLike;
  consoleRef?: ConsoleLike;
}

export function resolveTuiRuntimeLogDirectory(dataDir: string): string {
  return join(dataDir, 'v2', 'observability', 'logs');
}

export function createTuiRuntimeLogging(
  dataDir: string,
  dependencies: TuiRuntimeLoggingDependencies = {},
): TuiRuntimeLogging {
  const logDirectory = resolveTuiRuntimeLogDirectory(dataDir);
  const configureRuntime = dependencies.configureRuntime ?? configureLocalRuntimeLogging;
  const configureIm = dependencies.configureIm ?? configureImLogger;
  const flushRuntime = dependencies.flushRuntime ?? flushLocalRuntimeLogging;
  const flushIm = dependencies.flushIm ?? flushImLogger;
  const shutdownRuntime = dependencies.shutdownRuntime ?? shutdownLocalRuntimeLogging;
  const shutdownIm = dependencies.shutdownIm ?? shutdownImLogger;
  const runtimeLogger = dependencies.runtimeLogger ?? logger;
  const consoleRef = dependencies.consoleRef ?? console;
  const quietDestination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const loggerOptions = {
    colorize: false,
    destination: quietDestination,
  };

  configureRuntime({ dir: logDirectory, loggerOptions });
  configureIm({ dir: logDirectory, loggerOptions });

  const consoleMethods: readonly ConsoleMethod[] = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'trace',
  ];
  const originalConsoleMethods = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const isolatedConsoleMethods = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let consoleIsolationInstalled = false;

  const restoreConsole = () => {
    if (!consoleIsolationInstalled) return;
    for (const method of consoleMethods) {
      const original = originalConsoleMethods.get(method);
      if (original && consoleRef[method] === isolatedConsoleMethods.get(method)) {
        consoleRef[method] = original;
      }
    }
    originalConsoleMethods.clear();
    isolatedConsoleMethods.clear();
    consoleIsolationInstalled = false;
  };

  const installConsoleIsolation = () => {
    if (consoleIsolationInstalled) return;
    for (const method of consoleMethods) {
      originalConsoleMethods.set(method, consoleRef[method]);
      const isolated = (...args: unknown[]) => {
        const level = consoleMethodToRuntimeLevel(method);
        runtimeLogger[level](
          { source: 'mcode-runtime-console', consoleLevel: method },
          formatWithOptions({ colors: false, depth: 4 }, ...args),
        );
      };
      isolatedConsoleMethods.set(method, isolated);
      consoleRef[method] = isolated;
    }
    consoleIsolationInstalled = true;
  };

  return {
    logDirectory,
    async runDuringStartup<T>(operation: () => Promise<T>): Promise<T> {
      installConsoleIsolation();
      try {
        return await operation();
      } catch (error) {
        restoreConsole();
        throw error;
      }
    },
    async flush(): Promise<void> {
      await Promise.allSettled([flushRuntime(), flushIm()]);
    },
    async shutdown(): Promise<void> {
      restoreConsole();
      await Promise.allSettled([shutdownRuntime(), shutdownIm()]);
    },
  };
}

function consoleMethodToRuntimeLevel(method: ConsoleMethod): RuntimeLogLevel {
  if (method === 'warn') return 'warn';
  if (method === 'error') return 'error';
  return 'info';
}
