import {
  ProjectServiceError,
  type ProjectRecord,
  type ProjectReference,
} from '../session-system/index.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
import type {
  PinFailureReason,
  PinItem,
  PinItemType,
  PinMutation,
  PinRef,
  PinServiceOptions,
} from './contracts.js';

const PINNED_ITEMS_ORDER_PREFERENCE_KEY = 'pinned-items-order';
const PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY = 'pinned-items-preview-train-migrated';

export class PinServiceError extends Error {
  constructor(
    readonly reason: PinFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'PinServiceError';
  }
}

export class PinService {
  private readonly nowMs: () => number;
  private writeQueue: Promise<void> = Promise.resolve();
  private legacyMigrationPromise?: Promise<PinRef[]>;

  constructor(private readonly options: PinServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async isSessionPinned(sessionId: string): Promise<boolean> {
    return (await this.readRefs()).some((ref) => ref.type === 'session' && ref.id === sessionId);
  }

  async pinAgent(agentName: string, pinned: boolean, insertIndex?: number): Promise<PinMutation> {
    const id = requireId(agentName, 'agent');
    return this.serializeWrite(async () => {
      const agent = await this.options.agents.get(id);
      if (!agent) throw new PinServiceError('agent-not-found', `Agent ${id} was not found`);
      const refs = updateRefs(
        await this.readRefsInWriteLane(),
        { type: 'agent', id },
        pinned,
        insertIndex,
      );
      await this.writeRefs(refs);
      return {
        item: pinned ? { ref: { type: 'agent', id }, agent } : undefined,
        items: await this.hydrate(refs),
      };
    });
  }

  async pinSession(sessionId: string, pinned: boolean, insertIndex?: number): Promise<PinMutation> {
    const id = requireId(sessionId, 'session');
    return this.serializeWrite(async () => {
      const session = await this.options.sessions.get(id);
      if (!session) throw new PinServiceError('session-not-found', `Session ${id} was not found`);
      const refs = updateRefs(
        await this.readRefsInWriteLane(),
        { type: 'session', id },
        pinned,
        insertIndex,
      );
      await this.writeRefs(refs);
      return {
        item: pinned ? { ref: { type: 'session', id }, session } : undefined,
        items: await this.hydrate(refs),
      };
    });
  }

  async pinProject(reference: ProjectReference, pinned: boolean): Promise<ProjectRecord> {
    return this.serializeWrite(async () => {
      const refs = await this.readRefsInWriteLane();
      const [canonicalReference] = await this.options.projects.canonicalizeReferences([reference]);
      if (!canonicalReference) {
        throw new ProjectServiceError('project-required', 'project reference is required');
      }
      await this.writeRefs(updateRefs(refs, projectReferencePinRef(canonicalReference), pinned));
      const project = await this.options.projects.resolve(canonicalReference, true);
      const projected = await this.options.projectRepository.setPinned(
        project.projectId,
        pinned,
        this.nowMs(),
      );
      if (!projected) throw new ProjectServiceError('project-not-found', 'project not found');
      return projected;
    });
  }

  async putProjectsOrder(
    references: readonly ProjectReference[],
  ): Promise<readonly ProjectRecord[]> {
    return this.serializeWrite(async () => {
      const refs = await this.readRefsInWriteLane();
      const canonicalReferences = await this.options.projects.canonicalizeReferences(references);
      await this.writeRefs(
        reorderProjectRefs(refs, canonicalReferences.map(projectReferencePinRef)),
      );
      const projects = await this.options.projects.resolveOrder(canonicalReferences);
      await this.options.projectRepository.putOrder(
        projects.map(({ projectId }) => projectId),
        this.nowMs(),
      );
      return projects;
    });
  }

  async addImportedSession(sessionId: string): Promise<void> {
    const ref = { type: 'session' as const, id: requireId(sessionId, 'session') };
    await this.serializeWrite(async () => {
      const refs = await this.readRefsInWriteLane();
      if (refs.some((candidate) => pinRefKey(candidate) === pinRefKey(ref))) return;
      await this.writeRefs([...refs, ref]);
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.mutateOwnedRef({ type: 'session', id: requireId(sessionId, 'session') }, false);
  }

  async removeAgent(agentName: string): Promise<void> {
    await this.mutateOwnedRef({ type: 'agent', id: requireId(agentName, 'agent') }, false);
  }

  async getOrder(): Promise<readonly PinItem[]> {
    return this.hydrate(await this.readRefs(), true);
  }

  async putOrder(input: readonly PinRef[]): Promise<readonly PinItem[]> {
    const refs = validateRefs(input);
    return this.serializeWrite(async () => {
      const existingKeys = new Set((await this.readRefsForValidation()).map(pinRefKey));
      await this.validateEntities(refs, existingKeys);
      await this.readRefsInWriteLane();
      await this.writeRefs(refs);
      await this.syncProjects(refs);
      return this.hydrate(refs, true);
    });
  }

  private async validateEntities(
    refs: readonly PinRef[],
    existingKeys: ReadonlySet<string>,
  ): Promise<void> {
    for (const ref of refs) {
      if (ref.type === 'agent' && !(await this.options.agents.get(ref.id))) {
        if (existingKeys.has(pinRefKey(ref))) continue;
        throw new PinServiceError('agent-not-found', `Agent ${ref.id} was not found`);
      }
      if (ref.type === 'session' && !(await this.options.sessions.get(ref.id))) {
        if (existingKeys.has(pinRefKey(ref))) continue;
        throw new PinServiceError('session-not-found', `Session ${ref.id} was not found`);
      }
    }
  }

  private async syncProjects(refs: readonly PinRef[]): Promise<void> {
    const projectRefs = refs.filter((ref) => ref.type === 'project');
    const orderedProjectIds: number[] = [];
    for (const ref of projectRefs) {
      const project = await this.resolveProject(ref.id);
      if (project) orderedProjectIds.push(project.projectId);
    }

    await this.syncProjectPinnedStates(new Set(orderedProjectIds));
    if (orderedProjectIds.length > 0) {
      await this.options.projectRepository.putOrder(orderedProjectIds, this.nowMs());
    }
  }

  private async syncProjectPinnedStates(selected: ReadonlySet<number>): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.options.projectRepository.listPage({
        includeHiddenProjects: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const project of page.projects) {
        if (project.pinned !== selected.has(project.projectId)) {
          await this.options.projectRepository.setPinned(
            project.projectId,
            selected.has(project.projectId),
            this.nowMs(),
          );
        }
      }
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
  }

  private async resolveProject(id: string): Promise<ProjectRecord | undefined> {
    if (id !== 'default' && !id.startsWith('workspace:')) {
      throw new PinServiceError('invalid-ref', `Project ref ${id} is invalid`);
    }
    try {
      return await this.options.projects.resolve({ projectKey: id });
    } catch {
      return undefined;
    }
  }

  private async hydrate(refs: readonly PinRef[], preserveMissing = false): Promise<PinItem[]> {
    const items: PinItem[] = [];
    for (const ref of refs) {
      let item: PinItem | undefined;
      if (ref.type === 'agent') {
        const agent = await this.options.agents.get(ref.id);
        if (agent) item = { ref, agent };
      } else if (ref.type === 'session') {
        const session = await this.options.sessions.get(ref.id);
        if (session) item = { ref, session };
      } else {
        const project = await this.resolveProject(ref.id);
        if (project) item = { ref, project };
      }
      if (item) items.push(item);
      else if (preserveMissing) items.push({ ref });
    }
    return items;
  }

  private async readRefs(): Promise<PinRef[]> {
    if (!this.options.legacyOrder && !this.options.legacyPinnedAgents) {
      return this.readStoredRefs();
    }
    if (
      readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
      true
    ) {
      return this.readStoredRefs();
    }
    this.legacyMigrationPromise ??= this.serializeWrite(() => this.readRefsInWriteLane());
    return this.legacyMigrationPromise;
  }

  private async readRefsInWriteLane(): Promise<PinRef[]> {
    const refs = await this.readStoredRefs();
    const legacyOrder = this.options.legacyOrder ?? (async () => []);
    if (!this.options.legacyOrder && !this.options.legacyPinnedAgents) return refs;
    if (
      readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
      true
    ) {
      return refs;
    }
    return this.migrateLegacyOrder(refs, legacyOrder);
  }

  private async readRefsForValidation(): Promise<PinRef[]> {
    const refs = await this.readStoredRefs();
    if (
      (!this.options.legacyOrder && !this.options.legacyPinnedAgents) ||
      readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
        true
    ) {
      return refs;
    }
    return this.mergeLegacyOrder(refs, this.options.legacyOrder ?? (async () => []));
  }

  private async readStoredRefs(): Promise<PinRef[]> {
    const raw = readPreferenceValue(this.options.db, PINNED_ITEMS_ORDER_PREFERENCE_KEY);
    return !Array.isArray(raw)
      ? []
      : raw.flatMap((value): PinRef[] => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const type = Reflect.get(value, 'type');
          const id = Reflect.get(value, 'id');
          if (
            (type !== 'agent' && type !== 'session' && type !== 'project') ||
            typeof id !== 'string'
          ) {
            return [];
          }
          try {
            return [validateRef({ type, id })];
          } catch {
            return [];
          }
        });
  }

  private async migrateLegacyOrder(
    current: PinRef[],
    legacyOrder: () => Promise<readonly PinRef[]>,
  ): Promise<PinRef[]> {
    const merged = await this.mergeLegacyOrder(current, legacyOrder);
    await this.writeRefs(merged);
    upsertPreferenceValue(
      this.options.db,
      PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY,
      true,
    );
    return merged;
  }

  private async mergeLegacyOrder(
    current: readonly PinRef[],
    legacyOrder: () => Promise<readonly PinRef[]>,
  ): Promise<PinRef[]> {
    const legacy = (await legacyOrder()).flatMap((ref): PinRef[] => {
      try {
        return [validateRef(ref)];
      } catch {
        return [];
      }
    });
    const base = legacy.length > 0 ? legacy : current;
    const seen = new Set(base.map(pinRefKey));
    const appendedCurrent = current.filter((ref) => {
      const key = pinRefKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const legacyAgents = (await this.options.legacyPinnedAgents?.()) ?? [];
    const appendedAgents = legacyAgents
      .flatMap((item): Array<{ ref: PinRef; pinnedAt: number | null }> => {
        try {
          return [{ ref: validateRef({ type: 'agent', id: item.id }), pinnedAt: item.pinnedAt }];
        } catch {
          return [];
        }
      })
      .sort(
        (left, right) =>
          (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) ||
          pinRefKey(left.ref).localeCompare(pinRefKey(right.ref)),
      )
      .flatMap(({ ref }) => {
        const key = pinRefKey(ref);
        if (seen.has(key)) return [];
        seen.add(key);
        return [ref];
      });
    return [...base, ...appendedCurrent, ...appendedAgents];
  }

  private async writeRefs(refs: readonly PinRef[]): Promise<void> {
    upsertPreferenceValue(this.options.db, PINNED_ITEMS_ORDER_PREFERENCE_KEY, refs);
  }

  private async mutateOwnedRef(ref: PinRef, present: boolean): Promise<void> {
    await this.serializeWrite(async () => {
      const refs = updateRefs(await this.readRefsInWriteLane(), ref, present);
      await this.writeRefs(refs);
    });
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function requireId(value: string, type: PinItemType): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PinServiceError('invalid-ref', `${type} id is required`);
  }
  return value.trim();
}

function validateRef(ref: PinRef): PinRef {
  const id = requireId(ref.id, ref.type);
  if (ref.type === 'project' && id !== 'default' && !id.startsWith('workspace:')) {
    throw new PinServiceError('invalid-ref', `Project ref ${id} is invalid`);
  }
  return { type: ref.type, id };
}

function pinRefKey(ref: PinRef): string {
  const id =
    ref.type === 'agent' && ref.id.toLowerCase().startsWith('agent:')
      ? ref.id.slice('agent:'.length)
      : ref.id;
  return `${ref.type}:${id}`;
}

function projectReferencePinRef(reference: ProjectReference): PinRef {
  if (!reference.projectKey) {
    throw new ProjectServiceError('project-required', 'project reference is required');
  }
  return validateRef({ type: 'project', id: reference.projectKey });
}

function reorderProjectRefs(refs: readonly PinRef[], ordered: readonly PinRef[]): PinRef[] {
  const orderedKeys = new Set(ordered.map(pinRefKey));
  const projects = [
    ...ordered,
    ...refs.filter((ref) => ref.type === 'project' && !orderedKeys.has(pinRefKey(ref))),
  ];
  let projectIndex = 0;
  const reordered = refs.map((ref) =>
    ref.type === 'project' ? (projects[projectIndex++] ?? ref) : ref,
  );
  return [...reordered, ...projects.slice(projectIndex)];
}

function validateRefs(input: readonly PinRef[]): PinRef[] {
  const seen = new Set<string>();
  return input.map((value) => {
    const ref = validateRef(value);
    const key = pinRefKey(ref);
    if (seen.has(key)) throw new PinServiceError('duplicate-ref', 'Pinned items must be unique');
    seen.add(key);
    return ref;
  });
}

function updateRefs(
  refs: readonly PinRef[],
  item: PinRef,
  pinned: boolean,
  insertIndex?: number,
): PinRef[] {
  const key = pinRefKey(item);
  const without = refs.filter((ref) => pinRefKey(ref) !== key);
  if (!pinned) return without;
  const index =
    insertIndex === undefined || !Number.isFinite(insertIndex)
      ? without.length
      : Math.max(0, Math.min(without.length, Math.trunc(insertIndex)));
  return [...without.slice(0, index), item, ...without.slice(index)];
}
