import {
  hasValidBackgroundTaskHostMetadata,
  readBackgroundTaskOriginMetadata,
  type BackgroundTaskOriginMetadata,
} from '../../contracts.js';

export {
  hasValidBackgroundTaskHostMetadata,
  readBackgroundTaskOriginMetadata,
  type BackgroundTaskOriginMetadata,
};

export function createBackgroundTaskHostMetadata(
  origin: BackgroundTaskOriginMetadata,
): Readonly<Record<string, unknown>> {
  return {
    backgroundTaskOrigin: {
      kind: origin.kind,
      taskIds: [...origin.taskIds],
      ...(origin.observedTerminalCount === undefined
        ? {}
        : { observedTerminalCount: origin.observedTerminalCount }),
    },
  };
}
