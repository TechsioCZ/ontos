import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { HttpClient, HttpServerRequest } from 'effect/http';
import type { ActionRegistration } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { MerchandiseCommandPayloadSchema, MerchandiseErrorSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { recordsCarrier } from '../../shared/access-declarations.ts';
import { AKROS_LEGAL_ENTITY_ID, ESHOP_LEGAL_ENTITY_ID } from '../../shared/actions/command-guard.ts';
import { merchandiseRecordsGrants } from '../../src/services/persistence.service.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { manageCatalogAction } from '../../src/actions/manage-catalog.action.ts';
import { manageMarketsAction } from '../../src/actions/manage-markets.action.ts';
import { cleanupDemoAction } from '../../src/actions/cleanup-demo.action.ts';
import { changeProductImagesAction } from '../../src/actions/change-product-images.action.ts';
import { recordStockMovementAction } from '../../src/actions/record-stock-movement.action.ts';
import { changeOrderStatusAction } from '../../src/actions/change-order-status.action.ts';
import { placeStorefrontOrderAction } from '../../src/actions/place-storefront-order.action.ts';
import { proposeOrderChangesAction } from '../../src/actions/propose-order-changes.action.ts';
import { reviewOrderChangesAction } from '../../src/actions/review-order-changes.action.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TaxRateSource } from '../../src/services/tax-rates.ts';
import { TEST_TAX_BOOK } from '../support/tax-fixtures.ts';

const unusedRuntimeDependencies = Layer.mergeAll(
  Layer.succeed(TaxRateSource, { read: () => Effect.succeed(TEST_TAX_BOOK) }),
  Layer.mock(ActiveApplicationCompositionService, {}),
  Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die('Unexpected reference HTTP call')),
  ),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('http://merchandise.test/narrow-actions')),
  ),
);

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:merchandise-narrow-actions',
  authMethod: 'session' as const,
  legalEntityId: AKROS_LEGAL_ENTITY_ID,
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const scope = { ...principal, correlationId: 'narrow-actions' };
const decodedResult = Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: ['product-1'], revision: 2 });
const result = { entityIds: [...decodedResult.entityIds], revision: decodedResult.revision };
const registrations = [
  applyCommandAction,
  manageCatalogAction,
  manageMarketsAction,
  cleanupDemoAction,
  changeProductImagesAction,
  recordStockMovementAction,
  changeOrderStatusAction,
  placeStorefrontOrderAction,
  proposeOrderChangesAction,
  reviewOrderChangesAction,
] as const;

const commandTests = <Payload extends Schema.ConstraintDecoder<unknown>, Owner extends string>(
  registration: ActionRegistration<
    Payload,
    typeof ApplyCommandResultSchema,
    typeof MerchandiseErrorSchema,
    typeof applyCommandAction.descriptor.domainEvents,
    Owner,
    NonNullable<typeof applyCommandAction._services>,
    NonNullable<typeof applyCommandAction._handlerRequirements>
  >,
  command: (typeof MerchandiseCommandPayloadSchema.Encoded)['command'],
) => {
  const key = Schema.decodeUnknownSync(Schema.String)(registration.descriptor.accessDeclaration?.key);
  it.effect(`${registration.descriptor.actionKey} executes only under its own registered authority`, () =>
    Effect.gen(function* narrowCommand() {
      const gate = makeTestBoundAccessGate({
        answers: { [key]: { outcome: 'ALLOWED' } },
        defaultAnswer: { outcome: 'DENIED' },
      });
      let writes = 0;
      const harness = yield* makeActionTestHarness({
        accessDecision: gate.bound,
        ownerRegistration: merchandiseRegistration,
        services: [
          bindActionTestServices(registration, {
            apply: (actual, revision) =>
              Effect.sync(() => {
                expect(Predicate.isTagged(actual, command._tag)).toBe(true);
                expect(revision).toBe(1);
                writes += 1;
                return result;
              }),
            productImage: () => Effect.die('A command must not read media'),
            records: () => Effect.die('A command must not read the catalog'),
          }),
        ],
      });
      const actual = yield* harness.runtime.runAction({
        payload: { command, expectedRevision: 1 },
        principal,
        registration,
        transport: { correlationId: 'narrow-command', idempotencyKey: registration.descriptor.actionKey },
      });
      expect(actual.revision).toBe(2);
      expect(writes).toBe(1);
      expect(harness.snapshot().committed).toHaveLength(1);
      expect(gate.accessDecision.askedDecisions.every(({ carrier }) => carrier.accessDeclaration?.key === key)).toBe(
        true,
      );
    }).pipe(Effect.provide(unusedRuntimeDependencies)),
  );
  it.effect(`${registration.descriptor.actionKey} does not commit on approval-only authority`, () =>
    Effect.gen(function* approvalOnly() {
      const harness = yield* makeActionTestHarness({
        access: 'needs_approval',
        ownerRegistration: merchandiseRegistration,
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: { command, expectedRevision: 1 },
          principal,
          registration,
          transport: { correlationId: 'approval-only', idempotencyKey: registration.descriptor.actionKey },
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      expect(harness.snapshot().committed).toEqual([]);
      expect(harness.snapshot().transactionCount).toBe(0);
    }).pipe(Effect.provide(unusedRuntimeDependencies)),
  );
  if (registration.descriptor.actionKey !== manageCatalogAction.descriptor.actionKey) {
    it.effect(`catalog management cannot substitute for ${registration.descriptor.actionKey}`, () =>
      Effect.gen(function* noBroadSubstitute() {
        const harness = yield* makeActionTestHarness({
          access: { 'demo.merchandise.catalog.manage': 'allowed' },
          ownerRegistration: merchandiseRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration,
            transport: { correlationId: 'no-broad-grant', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().transactionCount).toBe(0);
      }).pipe(Effect.provide(unusedRuntimeDependencies)),
    );
  }
  if (!Predicate.isTagged(command, 'CreateProduct')) {
    it.effect(`the original dispatcher cannot bypass ${registration.descriptor.actionKey}`, () =>
      Effect.gen(function* noDispatcherBypass() {
        const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: merchandiseRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'no-bypass', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPayloadValidationError')).toBe(true);
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().transactionCount).toBe(0);
      }).pipe(Effect.provide(unusedRuntimeDependencies)),
    );
  }
};
commandTests(applyCommandAction, {
  _tag: 'CreateProduct',
  active: true,
  category: 'Hardware',
  lowStockThreshold: 0,
  name: 'Bolt',
  priceMinor: 100,
  sku: 'BOLT',
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
});
commandTests(manageCatalogAction, { _tag: 'UpdateProduct', id: 'product-1', patch: { name: 'Bolt' } });
commandTests(manageMarketsAction, { _tag: 'RemoveMarket', marketId: '50000000-0000-4000-8000-000000000001' });
commandTests(cleanupDemoAction, { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Remove demo fixture' });
commandTests(changeProductImagesAction, {
  _tag: 'ChangeProductImages',
  change: { _tag: 'Reorder', images: [] },
  id: 'product-1',
});
commandTests(recordStockMovementAction, {
  _tag: 'RecordStockMovement',
  delta: 1,
  productId: 'product-1',
  reason: 'RECEIPT',
});
commandTests(changeOrderStatusAction, { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CONFIRMED' });
commandTests(placeStorefrontOrderAction, {
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: 'order-request-1',
  lines: [{ expectedUnitPriceMinor: 121, productId: 'product-1', quantity: 1 }],
  shippingMethod: 'OSOBNI_ODBER',
});
commandTests(proposeOrderChangesAction, {
  _tag: 'AiProposeChanges',
  changes: [
    { operation: { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CONFIRMED' }, reason: 'Customer confirmed' },
  ],
  instruction: 'Confirm the order',
});
commandTests(reviewOrderChangesAction, { _tag: 'AiDecideChanges', changeIds: ['change-1'], decision: 'approve' });

for (const registration of registrations) {
  it.effect(`${registration.descriptor.actionKey} cannot grant another operation's UI capability`, () =>
    Effect.gen(function* independentCapabilities() {
      const key = Schema.decodeUnknownSync(Schema.String)(registration.descriptor.accessDeclaration?.key);
      const gate = makeTestAccessDecision({
        answers: {
          [key]: { outcome: 'ALLOWED' },
          [recordsCarrier.accessDeclaration.key]: { outcome: 'ALLOWED' },
        },
        defaultAnswer: { outcome: 'DENIED' },
      });
      const grants = yield* merchandiseRecordsGrants(scope, {}).pipe(Effect.provideService(AccessDecisionGate, gate));
      const capabilities = [
        [grants.catalog, manageCatalogAction],
        [grants.cleanup, cleanupDemoAction],
        [grants.createProduct, applyCommandAction],
        [grants.images, changeProductImagesAction],
        [grants.markets, manageMarketsAction],
        [grants.proposeOrderChanges, proposeOrderChangesAction],
        [grants.reviewOrderChanges, reviewOrderChangesAction],
        [grants.status, changeOrderStatusAction],
        [grants.stock, recordStockMovementAction],
        [grants.storefrontOrder, placeStorefrontOrderAction],
      ] as const;
      for (const [allowed, owner] of capabilities) {
        expect(allowed).toBe(owner === registration);
      }
      expect(grants.writeAll).toBe(registration !== proposeOrderChangesAction);
      expect(gate.askedLists).toEqual([]);
      expect(gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
        recordsCarrier.accessDeclaration.key,
        ...registrations.map(({ descriptor }) => descriptor.accessDeclaration?.key),
      ]);
    }).pipe(Effect.provide(unusedRuntimeDependencies)),
  );
}
it.effect('records authority alone does not become a catalog write or typed proposal authority', () =>
  Effect.gen(function* readOnly() {
    const gate = makeTestAccessDecision({
      answers: { [recordsCarrier.accessDeclaration.key]: { outcome: 'ALLOWED' } },
      defaultAnswer: { outcome: 'DENIED' },
    });
    const grants = yield* merchandiseRecordsGrants(scope, {}).pipe(Effect.provideService(AccessDecisionGate, gate));
    expect(grants.readAll).toBe(true);
    expect(grants.writeAll).toBe(false);
    expect(grants.proposeOrderChanges).toBe(false);
  }),
);
it.effect('a storefront view receives no staff write capabilities even if its gate could grant them', () =>
  Effect.gen(function* storefront() {
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const grants = yield* merchandiseRecordsGrants(
      { ...scope, authMethod: 'api_key', legalEntityId: ESHOP_LEGAL_ENTITY_ID },
      { view: { storefront: true } },
    ).pipe(Effect.provideService(AccessDecisionGate, gate));
    expect(grants.writeAll).toBe(false);
    expect(grants.catalog).toBe(false);
    expect(grants.cleanup).toBe(false);
    expect(gate.askedDecisions).toHaveLength(1);
  }),
);

for (const outcome of ['DENIED', 'UNAVAILABLE', 'NEEDS_APPROVAL'] as const) {
  it.effect(`records ${outcome} never becomes a staff read or catalog authority`, () =>
    Effect.gen(function* readDenied() {
      const gate = makeTestAccessDecision({ defaultAnswer: { outcome } });
      expect(
        yield* merchandiseRecordsGrants(scope, {}).pipe(
          Effect.provideService(AccessDecisionGate, gate),
          Effect.isFailure,
        ),
      ).toBe(true);
      expect(gate.askedDecisions).toHaveLength(1);
      expect(gate.askedLists).toEqual([]);
    }),
  );
}
it.effect('workload admission is confined to the known storefront protocol, never staff or another company', () =>
  Effect.gen(function* workloadProtocol() {
    const scripted = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const gate: AccessDecisionService = {
      ...scripted,
      decide: (input: Parameters<typeof scripted.decide>[0]) =>
        scripted
          .decide(input)
          .pipe(Effect.map((decision): AccessDecision => ({ ...decision, reasons: [{ code: 'allow.workload' }] }))),
    };
    for (const [currentScope, request] of [
      [scope, {}],
      [scope, { view: { storefront: true } }],
      [
        { ...scope, authMethod: 'api_key' as const, legalEntityId: '30000000-0000-4000-8000-000000000001' },
        { view: { storefront: true } },
      ],
    ] as const) {
      expect(
        yield* merchandiseRecordsGrants(currentScope, request).pipe(
          Effect.provideService(AccessDecisionGate, gate),
          Effect.isFailure,
        ),
      ).toBe(true);
    }
    const grants = yield* merchandiseRecordsGrants(
      { ...scope, authMethod: 'api_key', legalEntityId: ESHOP_LEGAL_ENTITY_ID },
      { view: { storefront: true } },
    ).pipe(Effect.provideService(AccessDecisionGate, gate));
    expect(grants.readAll).toBe(true);
    expect(grants.writeAll).toBe(false);
    expect(grants.catalog).toBe(false);
  }),
);
