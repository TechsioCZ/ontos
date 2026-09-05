// expect-count: 1
import { Effect } from 'effect';

/** A module-local alias over `Effect.Effect` hides every member return type from the matcher. */
type Op<A> = Effect.Effect<A, Error>;

export interface TenantSettingsRepository {
  readonly load: (tenantId: string) => Op<string>;
  readonly save: (tenantId: string, value: string) => Op<void>;
}

export const loadSettings = (repository: TenantSettingsRepository): Op<string> =>
  repository.load('tenant');
