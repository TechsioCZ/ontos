import type { OperationalScope } from '@app/core-runtime';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { Effect } from 'effect';

import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '../../shared/apis/privacy-owner-coverage.ts';
import { readPrivacyOwnerCoverage } from '../../src/api/privacy-owner-coverage.read.ts';
import { privacyOwnerCoverageForScope } from '../../src/services/privacy-owner-coverage.service.ts';
import type { PrivacyOwnerCoverageOptions } from '../../src/services/privacy-owner-coverage.service.ts';
import { decideOne, step } from './history-world.ts';
import { handoffDouble } from './intake-fixtures.ts';
import { intakeWorld } from './intake-world.ts';
import { runtimeDatabase } from './runtime-database.ts';

/**
 * TEST-ONLY native Communications owner for a consumer's real-composition test (#1410 AC-15). It runs the REAL Owner Coverage
 * Read handler over the REAL owner tables on native PostgreSQL as the runtime role, and answers in the SDK call vocabulary
 * Core's governed call uses, so a consumer's test goes Privacy -> Communications -> Privacy with no stub on the owner side.
 * The Messaging Adapter is a labelled double; nothing here is delivery or provider evidence, and the backup coverage is an
 * explicit input because Communications cannot observe platform backups itself.
 */

const readKey = 'communications.core.api.privacy-owner-coverage';

const scopeOf = (tenantId: string): OperationalScope => ({
  authContextRef: 'job:communications-owner-native:run:1',
  authMethod: 'system',
  correlationId: 'communications-owner-native',
  principalId: '00000000-0000-4000-8000-0000000000b1',
  tenantId,
});

const notFound: CallOutcome<PrivacyOwnerCoverageResponse> = { _tag: 'NotFound', reason: 'not found' };
const ownerUnavailable: CallOutcome<PrivacyOwnerCoverageResponse> = {
  _tag: 'Unavailable',
  reason: 'owner unavailable',
  retryable: true,
};

export const makeCommunicationsOwnerNative = Effect.fn('CommunicationsOwnerNative.make')(function* make() {
  const database = yield* runtimeDatabase();
  const world = yield* intakeWorld(database);
  const { tenantId } = world;
  /** One real request, decision, intent and attempt for the fixture recipient `customer-1` (a labelled handoff double). */
  const seedExistingOwnData = Effect.gen(function* seed() {
    const { intentId } = yield* decideOne(world);
    yield* step(world, handoffDouble(), intentId);
    return { intentId };
  });
  const call = (
    request: PrivacyOwnerCoverageRequest,
    options: PrivacyOwnerCoverageOptions,
    moduleReachable = true,
  ): Effect.Effect<CallOutcome<PrivacyOwnerCoverageResponse>> =>
    moduleReachable
      ? database
          .inTenant(tenantId, (transaction) =>
            readPrivacyOwnerCoverage(request, {
              readKey,
              scope: scopeOf(tenantId),
              services: { privacy: privacyOwnerCoverageForScope(transaction, scopeOf(tenantId), options) },
            }),
          )
          .pipe(
            Effect.map((answer): CallOutcome<PrivacyOwnerCoverageResponse> => ({ _tag: 'Ok', value: answer.result })),
            Effect.catchTags({
              ReadHandlerNotFound: () => Effect.succeed(notFound),
              ReadHandlerUnavailable: () => Effect.succeed(ownerUnavailable),
            }),
            Effect.orDie,
          )
      : Effect.succeed(ownerUnavailable);
  return { call, seedExistingOwnData, tenantId, world };
});
