import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations, principalAuthBindings, principals } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import { PaymentSourceRejected } from '../../shared/domain/source-statement.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1153 "Integration/provider principals submit only their configured fact families/source bindings":
 * a principal that is not bound to any source authority must not learn, from the typed refusal alone,
 * whether a bank account / source binding is a configured ACTIVE authority of this Selling Legal
 * Entity. The refusals for a configured and an unconfigured binding are identical (tag, code, reason).
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const configuredBank = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;
const unconfiguredBank = { ...configuredBank, accountRef: 'CZ0000000000000000000001' } as const;

const isSourceRejected = Schema.is(PaymentSourceRejected);

it.live('#1153 an unbound principal cannot probe which source bindings are configured', () =>
  native(
    Effect.gen(function* probe() {
      const { admin, runtime } = yield* testDatabaseClients;
      const database: EvidenceNativeDatabase = {
        coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
        database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
        runtimeClient: runtime,
      };
      const scope = yield* makeTestScope;
      yield* seedCoreScope(database, scope);
      const staff = principalOf(scope);
      const probeId = randomUUID();
      yield* database.coreAdmin.insert(principals).values({
        displayName: 'Unbound integration',
        kind: 'human',
        principalId: probeId,
        status: 'active',
        tenantId: scope.tenantId,
      });
      yield* database.coreAdmin.insert(principalAuthBindings).values({
        authenticationNamespaceId: 'test.payment-evidence.v1',
        principalAuthBindingId: probeId,
        principalId: probeId,
        provider: 'better_auth',
        providerSubjectId: `payment-source-${probeId}`,
        status: 'active',
        subjectType: 'user',
        tenantId: scope.tenantId,
      });
      const prober = principalOf({ ...scope, principalId: probeId });
      const crypto = yield* Crypto.Crypto;
      const actions = makeActionRuntime(
        { executor: database.database },
        makeActionRepository(crypto),
        evidenceAllowedPermission,
        testOperationalScopeResolver,
        {
          ...openActionRuntimeOptions,
          accessDecision: makeScriptedBoundAccessGate('allowed').bound,
          contextAccess: evidenceContextAccess,
          ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
          ownerRegistration: paymentRegistration,
          resolveCompositionRevision: () => Effect.succeed(COMPOSITION_R1),
        },
      );
      yield* actions.runAction({
        payload: {
          factFamily: 'BANK_ACCOUNTING_RECEIPT',
          method: 'BANK_TRANSFER_ADVANCE',
          reason: 'The customer ERP is the accounting System of Record',
          refundRoute: false,
          source: configuredBank,
          status: 'ACTIVE',
          submitterPrincipalIds: [scope.principalId],
        },
        principal: staff,
        registration: configurePaymentSourceAuthorityAction,
        transport: { correlationId: 'source-unbound-refusal-config', idempotencyKey: randomUUID() },
      });
      const receipt = (source: typeof configuredBank | typeof unconfiguredBank) =>
        ({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          evidenceRef: 'voucher-probe',
          factFamily: 'BANK_ACCOUNTING_RECEIPT',
          factKind: 'COLLECTION_CONFIRMED',
          source,
          sourceOccurrenceId: `probe-${randomUUID()}`,
          sourceRevision: 1,
        }) satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
      const refusal = (source: typeof configuredBank | typeof unconfiguredBank) =>
        actions
          .runAction({
            payload: receipt(source),
            principal: prober,
            registration: acceptPaymentObservationAction,
            transport: { correlationId: 'source-unbound-refusal-probe', idempotencyKey: randomUUID() },
          })
          .pipe(
            Effect.flip,
            Effect.map((failure) => ({
              code: isSourceRejected(failure) ? failure.code : undefined,
              reason: isSourceRejected(failure) ? failure.reason : undefined,
              sourceRejected: isSourceRejected(failure),
            })),
          );
      const configured = yield* refusal(configuredBank);
      const unconfigured = yield* refusal(unconfiguredBank);
      expect(configured).toEqual({
        code: 'payment_source_authority_forbidden',
        reason:
          'The submitting principal is not bound to an active configured authority for this source binding and fact family',
        sourceRejected: true,
      });
      expect(unconfigured).toEqual(configured);
    }),
  ),
);
