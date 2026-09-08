import { Effect } from 'effect';

/** Data types and option bags are not service seams (dataTypePattern). */
export interface LoadPrincipalInput {
  readonly principalId: string;
}
export interface LoadPrincipalOutput {
  readonly status: string;
}
export interface RuntimeConfig {
  readonly build: (key: string) => Effect.Effect<string>;
}
export interface PrincipalRow {
  readonly id: string;
}

/** Service-named but with no effectful member: a plain value contract. */
export interface PrincipalNameResolver {
  readonly displayName: string;
  readonly aliases: readonly string[];
}

/** Effect only in a *parameter* position — the member returns nothing effectful. */
export interface PrincipalLoggerGateway {
  readonly attach: (effect: Effect.Effect<void>) => void;
}

/** Module-private contracts are not handed across an ownership boundary. */
interface InternalCacheRepository {
  readonly get: (key: string) => Effect.Effect<string>;
}
export const internalCache = (cache: InternalCacheRepository) => cache.get('k');
