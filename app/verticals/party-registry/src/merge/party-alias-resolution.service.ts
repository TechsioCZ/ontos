import { and, eq, inArray } from 'drizzle-orm';
import { Context, Effect, Option } from 'effect';

import type { PartyAliasResolutionError } from '../../shared/domain/merge-alias-resolution.ts';
import {
  PartyAliasResolutionBrokenChain,
  PartyAliasResolutionCrossTenant,
  PartyAliasResolutionCycle,
  PartyAliasResolutionUnavailable,
  PartyAliasWriteRejected,
} from '../../shared/domain/merge-alias-resolution.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { parties, partyAliases } from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';

export interface PartyAliasLookupRow {
  readonly aliasPartyId: string;
  readonly canonicalPartyId: string;
  readonly tenantId: string;
}

export interface PartyAliasLookup {
  readonly findAlias: (
    tenantId: string,
    aliasPartyId: string,
  ) => Effect.Effect<Option.Option<PartyAliasLookupRow>, PartyAliasResolutionUnavailable>;
  readonly partyExists: (tenantId: string, partyId: string) => Effect.Effect<boolean, PartyAliasResolutionUnavailable>;
}

export interface ResolvedPartyAlias {
  readonly canonicalPartyId: string;
  readonly requestedPartyId: string;
  readonly traversedAliasIds: readonly string[];
  readonly wasAlias: boolean;
}

export interface PartyAliasResolutionService {
  readonly requireCanonicalWriteTarget: (
    tenantId: string,
    partyId: string,
  ) => Effect.Effect<ResolvedPartyAlias, PartyAliasResolutionError | PartyAliasWriteRejected>;
  readonly resolvePartyAlias: (
    tenantId: string,
    partyId: string,
  ) => Effect.Effect<ResolvedPartyAlias, PartyAliasResolutionError>;
}

class PartyAliasResolution extends Context.Service<PartyAliasResolution, PartyAliasResolutionService>()(
  '@app/party-registry/merge/party-alias-resolution.service/PartyAliasResolution',
) {}

const partyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

export const makePartyAliasResolutionService = (lookup: PartyAliasLookup): PartyAliasResolutionService => {
  type ResolveFrom = (
    tenantId: string,
    requestedPartyId: string,
    currentPartyId: string,
    seen: ReadonlySet<string>,
    traversedAliasIds: readonly string[],
  ) => Effect.Effect<ResolvedPartyAlias, PartyAliasResolutionError>;
  const resolveFrom: ResolveFrom = Effect.fn('makePartyAliasResolutionService.resolvePartyAlias.step')((
    tenantId,
    requestedPartyId,
    currentPartyId,
    seen,
    traversedAliasIds,
  ) => {
    if (seen.has(currentPartyId)) {
      return new PartyAliasResolutionCycle({
        code: 'party_alias_resolution_cycle',
        partyId: currentPartyId,
        reason: 'Party Alias chain contains a cycle',
        tenantId,
      });
    }
    return lookup.findAlias(tenantId, currentPartyId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            lookup.partyExists(tenantId, currentPartyId).pipe(
              Effect.flatMap((exists) =>
                exists
                  ? Effect.succeed({
                      canonicalPartyId: currentPartyId,
                      requestedPartyId,
                      traversedAliasIds,
                      wasAlias: traversedAliasIds.length > 0,
                    })
                  : new PartyAliasResolutionBrokenChain({
                      code: 'party_alias_resolution_broken_chain',
                      missingPartyId: currentPartyId,
                      reason: 'Party Alias chain does not terminate at a canonical Party',
                      tenantId,
                    }),
              ),
            ),
          onSome: (alias) =>
            alias.tenantId !== tenantId || alias.aliasPartyId !== currentPartyId
              ? new PartyAliasResolutionCrossTenant({
                  aliasPartyId: currentPartyId,
                  code: 'party_alias_resolution_cross_tenant',
                  reason: 'Party Alias lookup crossed its trusted tenant boundary',
                  tenantId,
                })
              : Effect.suspend(() =>
                  resolveFrom(tenantId, requestedPartyId, alias.canonicalPartyId, new Set([...seen, currentPartyId]), [
                    ...traversedAliasIds,
                    currentPartyId,
                  ]),
                ),
        }),
      ),
    );
  });
  const resolvePartyAlias = Effect.fn('makePartyAliasResolutionService.resolvePartyAlias')(
    (tenantId: string, partyId: string) => resolveFrom(tenantId, partyId, partyId, new Set(), []),
  );

  return PartyAliasResolution.of({
    requireCanonicalWriteTarget: (tenantId, requestedPartyId) =>
      resolvePartyAlias(tenantId, requestedPartyId).pipe(
        Effect.filterOrFail(
          (resolution) => !resolution.wasAlias,
          (resolution) =>
            new PartyAliasWriteRejected({
              aliasPartyRef: partyRef(tenantId, requestedPartyId),
              canonicalPartyRef: partyRef(tenantId, resolution.canonicalPartyId),
              code: 'party_alias_write_rejected',
              reason: 'New writes must explicitly target the canonical survivor Party',
            }),
        ),
      ),
    resolvePartyAlias,
  });
};

/** Set-based lookups for resolving many Parties at once. */
export interface PartyAliasBatchLookup {
  readonly findAliases: (
    tenantId: string,
    aliasPartyIds: readonly string[],
  ) => Effect.Effect<readonly PartyAliasLookupRow[], PartyAliasResolutionUnavailable>;
  readonly existingParties: (
    tenantId: string,
    partyIds: readonly string[],
  ) => Effect.Effect<ReadonlySet<string>, PartyAliasResolutionUnavailable>;
}

/**
 * Resolves many Parties to their canonical survivor with the same rules and failures as `resolvePartyAlias`, but
 * with two set-based lookups per alias-chain level instead of two lookups per Party (lists stay O(chain depth)
 * round trips to the database). Returns requested Party id -> canonical Party id.
 */
interface PendingPartyAlias {
  readonly current: string;
  readonly requested: string;
  readonly seen: ReadonlySet<string>;
}

type PartyAliasBatchStep =
  | { readonly kind: 'pending'; readonly entry: PendingPartyAlias }
  | { readonly kind: 'resolved'; readonly current: string; readonly requested: string };

const resolvePartyAliasBatchLevel = Effect.fn('PartyAliasResolutionService.resolvePartyAliasBatchLevel')(
  function* resolveBatchLevel(
    lookup: PartyAliasBatchLookup,
    tenantId: string,
    pending: readonly PendingPartyAlias[],
    resolved: ReadonlyMap<string, string>,
  ): Effect.fn.Return<ReadonlyMap<string, string>, PartyAliasResolutionError> {
    if (pending.length === 0) {
      return resolved;
    }
    const current = [...new Set(pending.map((entry) => entry.current))];
    const aliases = new Map((yield* lookup.findAliases(tenantId, current)).map((row) => [row.aliasPartyId, row]));
    const terminal = current.filter((partyId) => !aliases.has(partyId));
    const existing = terminal.length === 0 ? new Set<string>() : yield* lookup.existingParties(tenantId, terminal);
    const steps = yield* Effect.forEach(
      pending,
      (entry): Effect.Effect<PartyAliasBatchStep, PartyAliasResolutionError> => {
        const alias = aliases.get(entry.current);
        if (alias === undefined) {
          if (!existing.has(entry.current)) {
            return new PartyAliasResolutionBrokenChain({
              code: 'party_alias_resolution_broken_chain',
              missingPartyId: entry.current,
              reason: 'Party Alias chain does not terminate at a canonical Party',
              tenantId,
            });
          }
          return Effect.succeed({ kind: 'resolved', current: entry.current, requested: entry.requested });
        }
        if (alias.tenantId !== tenantId) {
          return new PartyAliasResolutionCrossTenant({
            aliasPartyId: entry.current,
            code: 'party_alias_resolution_cross_tenant',
            reason: 'Party Alias lookup crossed its trusted tenant boundary',
            tenantId,
          });
        }
        const seen = new Set([...entry.seen, entry.current]);
        if (seen.has(alias.canonicalPartyId)) {
          return new PartyAliasResolutionCycle({
            code: 'party_alias_resolution_cycle',
            partyId: alias.canonicalPartyId,
            reason: 'Party Alias chain contains a cycle',
            tenantId,
          });
        }
        return Effect.succeed({
          kind: 'pending',
          entry: { current: alias.canonicalPartyId, requested: entry.requested, seen },
        });
      },
      { concurrency: 1 },
    );
    const next = steps.flatMap((step) => (step.kind === 'pending' ? [step.entry] : []));
    const completed = steps.flatMap((step) =>
      step.kind === 'resolved' ? [[step.requested, step.current] as const] : [],
    );
    return yield* Effect.suspend(() =>
      resolvePartyAliasBatchLevel(lookup, tenantId, next, new Map([...resolved, ...completed])),
    );
  },
);

export const makeBatchPartyAliasResolution = (lookup: PartyAliasBatchLookup) =>
  Effect.fn('makeBatchPartyAliasResolution.resolvePartyAliases')((tenantId: string, partyIds: readonly string[]) =>
    resolvePartyAliasBatchLevel(
      lookup,
      tenantId,
      [...new Set(partyIds)].map((partyId) => ({ current: partyId, requested: partyId, seen: new Set<string>() })),
      new Map(),
    ),
  );

type AliasTransaction = Pick<PartyTransaction, 'select'>;

const attachCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
const unavailable = (cause?: unknown) =>
  attachCause(
    new PartyAliasResolutionUnavailable({
      code: 'party_alias_resolution_unavailable',
      reason: 'Party Alias resolution is temporarily unavailable',
    }),
    cause,
  );

const makeTransactionPartyAliasResolutionService = (transaction: AliasTransaction): PartyAliasResolutionService =>
  makePartyAliasResolutionService({
    findAlias: (tenantId, aliasPartyId) =>
      transaction
        .select({
          aliasPartyId: partyAliases.aliasPartyId,
          canonicalPartyId: partyAliases.canonicalPartyId,
          tenantId: partyAliases.tenantId,
        })
        .from(partyAliases)
        .where(and(eq(partyAliases.tenantId, tenantId), eq(partyAliases.aliasPartyId, aliasPartyId)))
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.map(([alias]) => Option.fromNullishOr(alias)),
        ),
    partyExists: (tenantId, partyId) =>
      transaction
        .select({ partyId: parties.partyId })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, partyId)))
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.map((rows) => rows.length === 1),
        ),
  });

/** Batch form of {@link resolvePartyAlias} for lists: requested Party id -> canonical Party id. */
export const resolvePartyAliases = (transaction: AliasTransaction, tenantId: string, partyIds: readonly string[]) =>
  makeBatchPartyAliasResolution({
    existingParties: (lookupTenantId, ids) =>
      transaction
        .select({ partyId: parties.partyId })
        .from(parties)
        .where(and(eq(parties.tenantId, lookupTenantId), inArray(parties.partyId, [...ids])))
        .pipe(
          Effect.mapError(unavailable),
          Effect.map((rows) => new Set(rows.map((row) => row.partyId))),
        ),
    findAliases: (lookupTenantId, ids) =>
      transaction
        .select({
          aliasPartyId: partyAliases.aliasPartyId,
          canonicalPartyId: partyAliases.canonicalPartyId,
          tenantId: partyAliases.tenantId,
        })
        .from(partyAliases)
        .where(and(eq(partyAliases.tenantId, lookupTenantId), inArray(partyAliases.aliasPartyId, [...ids])))
        .pipe(Effect.mapError(unavailable)),
  })(tenantId, partyIds);

export const resolvePartyAlias = (transaction: AliasTransaction, tenantId: string, partyId: string) =>
  makeTransactionPartyAliasResolutionService(transaction).resolvePartyAlias(tenantId, partyId);

export const requireCanonicalPartyWriteTarget = (transaction: AliasTransaction, tenantId: string, partyId: string) =>
  makeTransactionPartyAliasResolutionService(transaction).requireCanonicalWriteTarget(tenantId, partyId);
