export type GitChangesMode = 'fast' | 'full';

interface FullRequest<TBase, TFull> {
  base: Promise<TBase>;
  result: Promise<TFull>;
}

/**
 * Shares only work that is still in flight. Completed values are deliberately
 * not retained, so a later request always observes a fresh Git snapshot.
 */
export class WorkspaceGitChangesCoordinator<TBase, TFull> {
  private readonly baseRequests = new Map<string, Promise<TBase>>();
  private readonly fullRequests = new Map<string, FullRequest<TBase, TFull>>();

  constructor(
    private readonly loadBase: (workspace: string) => Promise<TBase>,
    private readonly loadFull: (workspace: string, base: TBase) => Promise<TFull>,
  ) {}

  getChanges(workspace: string, mode: 'fast'): Promise<TBase>;
  getChanges(workspace: string, mode: 'full'): Promise<TFull>;
  getChanges(workspace: string, mode: GitChangesMode): Promise<TBase | TFull> {
    if (mode === 'fast') {
      // A full request owns the same base snapshot for its entire lifetime.
      // Reuse it even after the base promise has settled but enrichment is
      // still running.
      const fullRequest = this.fullRequests.get(workspace);
      if (fullRequest) {
        return fullRequest.base;
      }
      return this.getBase(workspace);
    }

    const existing = this.fullRequests.get(workspace);
    if (existing) {
      return existing.result;
    }

    const base = this.getBase(workspace);
    const result = base.then((snapshot) => this.loadFull(workspace, snapshot));
    const request = { base, result };
    this.fullRequests.set(workspace, request);
    this.clearAfterSettled(this.fullRequests, workspace, request, result);
    return result;
  }

  /**
   * Detaches every in-flight snapshot for one workspace. Existing callers may
   * still finish, but requests that start after this barrier cannot join those
   * pre-mutation promises.
   */
  invalidate(workspace: string): void {
    this.baseRequests.delete(workspace);
    this.fullRequests.delete(workspace);
  }

  clear(): void {
    this.baseRequests.clear();
    this.fullRequests.clear();
  }

  private getBase(workspace: string): Promise<TBase> {
    const existing = this.baseRequests.get(workspace);
    if (existing) {
      return existing;
    }

    const request = Promise.resolve().then(() => this.loadBase(workspace));
    this.baseRequests.set(workspace, request);
    this.clearAfterSettled(this.baseRequests, workspace, request, request);
    return request;
  }

  private clearAfterSettled<TValue, TEntry>(
    requests: Map<string, TEntry>,
    workspace: string,
    entry: TEntry,
    settled: Promise<TValue>,
  ): void {
    const clear = () => {
      if (requests.get(workspace) === entry) requests.delete(workspace);
    };
    void settled.then(clear, clear);
  }
}
