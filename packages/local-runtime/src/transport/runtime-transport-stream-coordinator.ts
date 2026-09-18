export interface RuntimeTransportStreamCoordinator {
  /** Claims an endpoint and returns a release function for that claim. */
  claim(key: string, onSuperseded: () => void): () => void;
  /** Drops all claims when the owning runtime is torn down. */
  clear(): void;
}

interface ActiveStreamClaim {
  onSuperseded: () => void;
  release: () => void;
}

/**
 * Owns single-flight state above individual MessagePort hosts. A renderer
 * reconnect or a second window must supersede the same long-lived endpoint,
 * while releasing a stale claim must never remove a newer claimant.
 */
export function createRuntimeTransportStreamCoordinator(): RuntimeTransportStreamCoordinator {
  const active = new Map<string, ActiveStreamClaim>();

  return {
    claim(key, onSuperseded) {
      active.get(key)?.onSuperseded();
      let released = false;
      const claim = {} as ActiveStreamClaim;
      claim.onSuperseded = onSuperseded;
      claim.release = () => {
        if (released) return;
        released = true;
        if (active.get(key) === claim) active.delete(key);
      };
      active.set(key, claim);
      return claim.release;
    },
    clear() {
      active.clear();
    },
  };
}
