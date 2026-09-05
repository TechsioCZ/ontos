import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import {
  PartyAliasResolutionBrokenChain,
  PartyAliasResolutionCrossTenant,
  PartyAliasResolutionCycle,
  PartyAliasResolutionUnavailable,
  PartyAliasWriteRejected,
} from '../../shared/domain/merge-alias-resolution.ts';
import type { PartyAliasResolutionError } from '../../shared/domain/merge-alias-resolution.ts';
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
  ) => Effect.Effect<PartyAliasLookupRow | null, PartyAliasResolutionUnavailable>;
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

const partyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

export const makePartyAliasResolutionService = (
  lookup: PartyAliasLookup,
): PartyAliasResolutionService => {
  const resolvePartyAlias = (
    tenantId: string,
    partyId: string,
  ): Effect.Effect<ResolvedPartyAlias, PartyAliasResolutionError> =>
    Effect.gen(function* resolveCompleteAliasChain() {
      const seen = new Set<string>();
      const traversedAliasIds: string[] = [];
      let currentPartyId = partyId;

      for (;;) {
        if (seen.has(currentPartyId)) {
          return yield* new PartyAliasResolutionCycle({
            code: 'party_alias_resolution_cycle',
            partyId: currentPartyId,
            reason: 'Party Alias chain contains a cycle',
            tenantId,
          });
        }
        const alias = yield* lookup.findAlias(tenantId, currentPartyId);
        if (alias === null) {
          const exists = yield* lookup.partyExists(tenantId, currentPartyId);
          if (!exists) {
            return yield* new PartyAliasResolutionBrokenChain({
              code: 'party_alias_resolution_broken_chain',
              missingPartyId: currentPartyId,
              reason: 'Party Alias chain does not terminate at a canonical Party',
              tenantId,
            });
          }
          return {
            canonicalPartyId: currentPartyId,
            requestedPartyId: partyId,
            traversedAliasIds,
            wasAlias: traversedAliasIds.length > 0,
          };
        }
        if (alias.tenantId !== tenantId || alias.aliasPartyId !== currentPartyId) {
          return yield* new PartyAliasResolutionCrossTenant({
            aliasPartyId: currentPartyId,
            code: 'party_alias_resolution_cross_tenant',
            reason: 'Party Alias lookup crossed its trusted tenant boundary',
            tenantId,
          });
        }
        seen.add(currentPartyId);
        traversedAliasIds.push(currentPartyId);
        currentPartyId = alias.canonicalPartyId;
      }
    });

  return {
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
  };
};

type AliasTransaction = Pick<PartyTransaction, 'select'>;

const unavailable = () =>
  new PartyAliasResolutionUnavailable({
    code: 'party_alias_resolution_unavailable',
    reason: 'Party Alias resolution is temporarily unavailable',
  });
const attempt = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: unavailable, try: operation });

export const makeTransactionPartyAliasResolutionService = (
  transaction: AliasTransaction,
): PartyAliasResolutionService =>
  makePartyAliasResolutionService({
    findAlias: (tenantId, aliasPartyId) =>
      attempt(() =>
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
          .limit(1),
      ).pipe(Effect.map(([alias]) => alias ?? null)),
    partyExists: (tenantId, partyId) =>
      attempt(() =>
        transaction
          .select({ partyId: parties.partyId })
          .from(parties)
          .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, partyId)))
          .limit(1),
      ).pipe(Effect.map((rows) => rows.length === 1)),
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
