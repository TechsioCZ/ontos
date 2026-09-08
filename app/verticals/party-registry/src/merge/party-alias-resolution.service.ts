import { and, eq } from 'drizzle-orm';
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
  readonly partyExists: (
    tenantId: string,
    partyId: string,
  ) => Effect.Effect<boolean, PartyAliasResolutionUnavailable>;
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

class PartyAliasResolution extends Context.Service<
  PartyAliasResolution,
  PartyAliasResolutionService
>()('@app/party-registry/merge/party-alias-resolution.service/PartyAliasResolution') {}

const partyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

export const makePartyAliasResolutionService = (
  lookup: PartyAliasLookup,
): PartyAliasResolutionService => {
  type ResolveFrom = (
    tenantId: string,
    requestedPartyId: string,
    currentPartyId: string,
    seen: ReadonlySet<string>,
    traversedAliasIds: readonly string[],
  ) => Effect.Effect<ResolvedPartyAlias, PartyAliasResolutionError>;
  const resolveFrom: ResolveFrom = Effect.fn(
    'makePartyAliasResolutionService.resolvePartyAlias.step',
  )((tenantId, requestedPartyId, currentPartyId, seen, traversedAliasIds) => {
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
                  resolveFrom(
                    tenantId,
                    requestedPartyId,
                    alias.canonicalPartyId,
                    new Set([...seen, currentPartyId]),
                    [...traversedAliasIds, currentPartyId],
                  ),
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
        Effect.flatMap((resolution) =>
          resolution.wasAlias
            ? new PartyAliasWriteRejected({
                aliasPartyRef: partyRef(tenantId, requestedPartyId),
                canonicalPartyRef: partyRef(tenantId, resolution.canonicalPartyId),
                code: 'party_alias_write_rejected',
                reason: 'New writes must explicitly target the canonical survivor Party',
              })
            : Effect.succeed(resolution),
        ),
      ),
    resolvePartyAlias,
  });
};

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

const makeTransactionPartyAliasResolutionService = (
  transaction: AliasTransaction,
): PartyAliasResolutionService =>
  makePartyAliasResolutionService({
    findAlias: (tenantId, aliasPartyId) =>
      transaction
        .select({
          aliasPartyId: partyAliases.aliasPartyId,
          canonicalPartyId: partyAliases.canonicalPartyId,
          tenantId: partyAliases.tenantId,
        })
        .from(partyAliases)
        .where(
          and(eq(partyAliases.tenantId, tenantId), eq(partyAliases.aliasPartyId, aliasPartyId)),
        )
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

export const resolvePartyAlias = (
  transaction: AliasTransaction,
  tenantId: string,
  partyId: string,
) => makeTransactionPartyAliasResolutionService(transaction).resolvePartyAlias(tenantId, partyId);

export const requireCanonicalPartyWriteTarget = (
  transaction: AliasTransaction,
  tenantId: string,
  partyId: string,
) =>
  makeTransactionPartyAliasResolutionService(transaction).requireCanonicalWriteTarget(
    tenantId,
    partyId,
  );
