import { Effect, Layer } from 'effect';

import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { AccessIntent } from '../decision/authority.ts';
import type { AccessIntentSource, DecisionAuthorityPort } from '../decision/authority.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';

/** The four decision reads of the intent loader, seen as a port rather than as a service. */
export type AccessIntentReads = Pick<
  TenantIntentLoaderService,
  | 'loadAuthorityCells'
  | 'loadAuthorityCellsMany'
  | 'loadConfigureBases'
  | 'loadConnection'
  | 'loadScope'
  | 'loadTeamIds'
>;

/**
 * The decision side of Core's access intent (CUTOVER-PLAN §3.1 step 6). PostgreSQL holds intent and
 * SpiceDB is only its projection, so the engine's four reads are answered by the one intent loader
 * lane C02a owns; this module adds nothing but the two adaptations the seam needs:
 *
 * 1. the loader's methods take the caller's `OperationalScope` first (O66), so the port is built per
 *    request instead of being one process-wide instance;
 * 2. an unreadable intent is `UNAVAILABLE`, never an empty answer — an empty membership, cell or team
 *    set would deny a person who holds them.
 */

const intentUnavailable = (cause: AccessIntentError) =>
  accessDecisionUnavailable('The access intent of this request could not be read', cause);

/** The engine's ports for one request scope, answered by the intent loader. */
export const decisionAuthorityOf = (reads: AccessIntentReads, scope: OperationalScope): DecisionAuthorityPort => ({
  readCells: (query) => reads.loadAuthorityCells(scope, query).pipe(Effect.mapError(intentUnavailable)),
  readCellsMany: (queries) => reads.loadAuthorityCellsMany(scope, queries).pipe(Effect.mapError(intentUnavailable)),
  readConfigureBases: (query) => reads.loadConfigureBases(scope, query).pipe(Effect.mapError(intentUnavailable)),
  readConnection: (query) => reads.loadConnection(scope, query).pipe(Effect.mapError(intentUnavailable)),
  readScope: (query) => reads.loadScope(scope, query).pipe(Effect.mapError(intentUnavailable)),
  readTeamIds: (query) => reads.loadTeamIds(scope, query).pipe(Effect.mapError(intentUnavailable)),
});

/** The seam's intent source, built once from the one loader over Core's own rows. */
export const AccessIntentLive: Layer.Layer<AccessIntent, never, TenantIntentLoader> = Layer.effect(
  AccessIntent,
  Effect.gen(function* accessIntentLive() {
    const reads = yield* TenantIntentLoader;
    const source: AccessIntentSource = {
      authorityFor: (scope: OperationalScope) => decisionAuthorityOf(reads, scope),
      joined: (transaction: CoreTransaction) => {
        // A loader that cannot join keeps the request source; the shipped loader joins its own
        // `callerTransactions` factory, so an owner-phase decision reads the owner's transaction.
        const joinedReads = reads.joined?.(transaction) ?? reads;
        return { authorityFor: (scope: OperationalScope) => decisionAuthorityOf(joinedReads, scope) };
      },
    };
    return source;
  }),
);
