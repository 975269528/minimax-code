export interface TuiIdentifiedContribution {
  readonly id: string;
  readonly order?: number;
}

const CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;

/**
 * Deterministic registry for built-in product contributions.
 *
 * Composition roots may register entries during startup. Product surfaces only
 * consume the frozen snapshot, so active Runs never observe registration churn.
 */
export class TuiContributionRegistry<T extends TuiIdentifiedContribution> {
  private readonly entries = new Map<string, T>();
  private frozen = false;

  register(contribution: T): void {
    if (this.frozen) throw new Error('Contribution registry is already frozen.');
    validateContributionId(contribution.id);
    if (this.entries.has(contribution.id)) {
      throw new Error(`Duplicate contribution id: ${contribution.id}`);
    }
    this.entries.set(contribution.id, contribution);
  }

  registerAll(contributions: readonly T[]): void {
    for (const contribution of contributions) this.register(contribution);
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  list(): readonly T[] {
    return [...this.entries.values()].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
    );
  }

  freeze(): readonly T[] {
    this.frozen = true;
    return this.list();
  }
}

function validateContributionId(id: string): void {
  if (!id) throw new Error('Contribution id must be non-empty.');
  if (!CONTRIBUTION_ID_PATTERN.test(id)) {
    throw new Error(
      'Contribution id must use lowercase letters, numbers, dot, slash, underscore, or hyphen.',
    );
  }
}
