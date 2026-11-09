import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
import type { Scope } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { collectInput, makeTestScope, newPaymentInput, withPersistence } from './database-fixture.ts';
import { COMPOSITION_R1, evidenceContextAccess, principalOf, seedCoreScope } from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1152 "Authority by fact family": COD customer collection is evidenced only by the "exact selected
 * carrier/shipping service for the corresponding COD capability". Both carriers below are configured
 * COD_CUSTOMER_COLLECTION authorities; only the carrier the Delivery owner confirmed for the selected
 * Delivery Offer (carried in the COD execution binding) may confirm the COLLECT.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const dpdCarrier = {
  accountRef: 'dpd-merchant-12',
  environment: 'production',
  sourceKind: 'CARRIER',
  sourceSystem: 'dpd',
} as const satisfies PaymentSourceBinding;
const pplCarrier = {
  accountRef: 'ppl-merchant-77',
  environment: 'production',
  sourceKind: 'CARRIER',
  sourceSystem: 'ppl',
} as const satisfies PaymentSourceBinding;

/** The binding create-payment records from the Delivery owner's SUPPORTED answer for the DPD offer. */
const dpdOfferBinding: PaymentExecutionBinding = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'dpd-cod-capability-evidence',
  carrier: { accountRef: 'dpd-merchant-12', environment: 'production', sourceSystem: 'dpd' },
  deliveryOfferRef: 'dpd-home-delivery-offer-1',
};

const openDatabase = Effect.gen(function* openDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  return {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  } satisfies EvidenceNativeDatabase;
});

/** Real Core Action runtime over the registered Payment Actions. */
const actionRuntime = Effect.fn('CodCarrierTest.actionRuntime')(function* actionRuntime(
  database: EvidenceNativeDatabase,
) {
  const crypto = yield* Crypto.Crypto;
  return makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    { checkActionPermission: () => Effect.succeed('allowed' as const) },
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
});

/** Configures DPD and PPL as COD collection carriers, then a pending COLLECT on a DPD-offer COD Payment. */
const codCollectionFrom = Effect.fn('CodCarrierTest.codCollectionFrom')(function* codCollectionFrom(
  source: PaymentSourceBinding,
) {
  const database = yield* openDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const principal = principalOf(scope);
  const actions = yield* actionRuntime(database);
  for (const carrier of [dpdCarrier, pplCarrier]) {
    yield* actions.runAction({
      payload: {
        factFamily: 'COD_CUSTOMER_COLLECTION',
        method: 'CASH_ON_DELIVERY',
        reason: 'Configured COD carrier',
        refundRoute: false,
        source: carrier,
        status: 'ACTIVE',
        submitterPrincipalIds: [principal.principalId],
      },
      principal,
      registration: configurePaymentSourceAuthorityAction,
      transport: { correlationId: 'cod-carrier-configure', idempotencyKey: randomUUID() },
    });
  }
  const paymentInput = yield* newPaymentInput(scope);
  const payment = yield* withPersistence(database.database, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding: dpdOfferBinding, method: 'CASH_ON_DELIVERY' }),
  );
  const collectRequest = yield* collectInput(
    scope,
    { amountMinor: 100_000, paymentId: payment.record.paymentId },
    'collect-1',
  );
  const collect = yield* withPersistence(database.database, scope, (persistence) =>
    persistence.insertOperation({ ...collectRequest, binding: dpdOfferBinding }),
  );
  const result = yield* actions
    .runAction({
      payload: {
        amount: { amountMinor: 100_000, currency: 'CZK' },
        deliveryOfferRef: 'dpd-home-delivery-offer-1',
        factFamily: 'COD_CUSTOMER_COLLECTION',
        factKind: 'COLLECTION_CONFIRMED',
        paymentId: payment.record.paymentId,
        source,
        sourceOccurrenceId: `${source.sourceSystem}-shipment-9`,
        sourceRevision: 1,
      },
      principal,
      registration: acceptPaymentObservationAction,
      transport: { correlationId: 'cod-carrier-collection', idempotencyKey: randomUUID() },
    })
    .pipe(Effect.result);
  const after = yield* withPersistence(database.database, scope, (persistence) =>
    persistence.loadAggregate(payment.record.paymentId),
  );
  const collectOutcome = after.operations.find(
    (operation) => operation.operationId === collect.record.operationId,
  )?.outcome;
  return { collectOutcome, result };
});

describe('#1152 COD customer collection authority is the exact selected carrier', () => {
  it.live(
    '#1152 a configured carrier that is not the selected Delivery Offer carrier cannot confirm COD collection',
    () =>
      native(
        Effect.gen(function* foreignCarrier() {
          const { collectOutcome, result } = yield* codCollectionFrom(pplCarrier);
          expect({ collectOutcome, result: result._tag }).toEqual({ collectOutcome: 'PENDING', result: 'Failure' });
          expect(JSON.stringify(result)).toContain('payment_source_authority_forbidden');
        }),
      ),
  );

  it.live('#1152 the carrier the Delivery owner confirmed for the selected offer confirms COD collection', () =>
    native(
      Effect.gen(function* selectedCarrier() {
        const { collectOutcome, result } = yield* codCollectionFrom(dpdCarrier);
        expect({ collectOutcome, result: result._tag }).toEqual({
          collectOutcome: 'EFFECT_CONFIRMED',
          result: 'Success',
        });
      }),
    ),
  );
});
