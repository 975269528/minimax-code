import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

interface DirectoryIdentity {
  targetPath: string;
  dev: number;
  ino: number;
}

interface Subscriber {
  onChange(): void;
  onError(): void;
}

interface SharedWatcher {
  watcher: FSWatcher;
  subscribers: Set<Subscriber>;
}

// Registries differ by workspace and selectors but commonly watch the same
// global Skill directories. Native watcher teardown can block the JS thread
// on macOS; evicting one registry must only release its own subscriptions.
const sharedWatchers = new Map<string, SharedWatcher>();

export function subscribeToSkillDirectory(
  target: DirectoryIdentity,
  subscriber: Subscriber,
): { close(): void } {
  // Include filesystem identity so replacing a directory at the same path
  // never reuses a watcher still bound to the removed directory.
  const key = JSON.stringify([path.resolve(target.targetPath), target.dev, target.ino]);
  let shared = sharedWatchers.get(key);
  if (!shared) {
    const subscribers = new Set<Subscriber>();
    const watcher = watch(target.targetPath, { persistent: false }, () => {
      for (const current of [...subscribers]) current.onChange();
    });
    shared = { watcher, subscribers };
    const created = shared;
    watcher.on('error', () => {
      if (sharedWatchers.get(key) !== created) return;
      sharedWatchers.delete(key);
      const currentSubscribers = [...subscribers];
      subscribers.clear();
      watcher.close();
      for (const current of currentSubscribers) current.onError();
    });
    sharedWatchers.set(key, shared);
  }
  const subscription = shared;
  subscription.subscribers.add(subscriber);
  return {
    close() {
      if (!subscription.subscribers.delete(subscriber)) return;
      if (subscription.subscribers.size > 0) return;
      if (sharedWatchers.get(key) === subscription) sharedWatchers.delete(key);
      subscription.watcher.close();
    },
  };
}
