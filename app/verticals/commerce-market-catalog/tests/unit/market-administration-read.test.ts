import type { OperationalScope } from '@app/core-runtime';
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';

import type { MarketLifecycleResult } from '../../shared/action-contracts.ts';
import { MarketAdministrationRequestSchema } from '../../shared/apis/market-administration.ts';
import {
  handleMarketAdministration,
  marketAdministrationGrants,
  marketAdministrationRead,
} from '../../src/api/market-administration.read.ts';
import { MarketAdministrationStateRowSchema } from '../../src/persistence/market-administration-state-persistence.ts';
import type {
  MarketAdministrationStatePersistence,
  MarketAdministrationStateRow,
} from '../../src/persistence/market-administration-state-persistence.ts';
import { MarketCatalogReadPersistenceUnavailable } from '../../src/persistence/market-history-routine.ts';
import { commerceMarketCatalogBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { activateMarketAction } from '../../src/actions/activate-market.action.ts';
import { associateStorefrontAction } from '../../src/actions/associate-storefront.action.ts';
import { createMarketAction } from '../../src/actions/create-market.action.ts';
import { manageMarketRetirementAdmissionAction } from '../../src/actions/manage-market-retirement-admission.action.ts';
import { removeStorefrontAssociationAction } from '../../src/actions/remove-storefront-association.action.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const marketId = '55555555-5555-4555-8555-555555555555';
const definitionRevisionId = '66666666-6666-4666-8666-666666666666';
const sourceActionInvocationId = '88888888-8888-4888-8888-888888888888';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContextRef: 'session:market-administration',
  authMethod: 'session',
  legalEntityId: sellerId,
  principalId,
  tenantId,
});
const scope: OperationalScope = {
  ...principal,
  correlationId: 'market-administration-test',
};

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const createKey = 'commerce.market-catalog.market.create';
const managementActions = [
  activateMarketAction,
  associateStorefrontAction,
  manageMarketRetirementAdmissionAction,
  removeStorefrontAssociationAction,
  retireMarketAction,
  reviseMarketDefinitionAction,
  reviseStorefrontAssociationAction,
  suspendMarketAction,
] as const;

const withMarket = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({ marketRef });
const withoutMarket = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({});

const decodeRow = Schema.decodeUnknownSync(MarketAdministrationStateRowSchema);
const baseRow = { currentDefinitionRevisionId: definitionRevisionId, marketId, revision: 3 };

const stateRow = (): MarketAdministrationStateRow => decodeRow(baseRow);
const stateRowWithAdmission = (admission: {
  readonly result?: MarketLifecycleResult;
  readonly status: 'ABORTED' | 'COMMITTED' | 'PENDING';
}): MarketAdministrationStateRow => {
  const retirementAdmission = { sourceActionInvocationId, status: admission.status };
  if (admission.result !== undefined) {
    Object.assign(retirementAdmission, { result: admission.result });
  }
  return decodeRow({ ...baseRow, retirementAdmission });
};

const committedResult: MarketLifecycleResult = {
  changed: true,
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: definitionRevisionId,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  lifecycle: 'RETIRED',
  marketRef,
  revision: 4,
};

const persistence = (
  state: Option.Option<MarketAdministrationStateRow> | 'unavailable',
): MarketAdministrationStatePersistence => ({
  state: () =>
    state === 'unavailable'
      ? Effect.fail(
          new MarketCatalogReadPersistenceUnavailable({
            code: 'market_catalog_read_persistence_unavailable',
            reason: 'unavailable',
          }),
        )
      : Effect.succeed(state),
});

const allGrants = { canAdminister: true, canCreateMarket: true };
const request = {
  input: withMarket,
  principal,
  registration: marketAdministrationRead,
  transport: { correlationId: scope.correlationId },
};

const context = (
  state: Option.Option<MarketAdministrationStateRow> | 'unavailable',
  grants: { readonly canAdminister: boolean; readonly canCreateMarket: boolean },
) => ({
  prepared: grants,
  readKey: 'commerce.market-catalog.api.market-administration',
  scope,
  services: persistence(state),
});

describe('Market administration read', () => {
  it.effect('reports the aggregate revision, current definition and the newest native retirement admission', () =>
    Effect.gen(function* pendingRetirement() {
      const { result } = yield* handleMarketAdministration(
        withMarket,
        context(Option.some(stateRowWithAdmission({ status: 'PENDING' })), {
          canAdminister: true,
          canCreateMarket: false,
        }),
      );
      expect(result).toEqual({
        canCreateMarket: false,
        market: {
          canAdminister: true,
          currentDefinitionRevisionRef: {
            moduleId: 'commerce.market-catalog',
            resourceId: definitionRevisionId,
            resourceType: 'commerce.market-catalog.market-definition-revision',
            tenantId,
          },
          marketRef,
          retirement: { sourceActionInvocationId, status: 'PENDING' },
          revision: 3,
        },
      });
    }),
  );

  it.effect('reports the committed native result and omits a retirement never admitted', () =>
    Effect.gen(function* retirementOutcomes() {
      const committed = yield* handleMarketAdministration(
        withMarket,
        context(Option.some(stateRowWithAdmission({ result: committedResult, status: 'COMMITTED' })), allGrants),
      );
      expect(committed.result.market?.retirement).toEqual({
        result: committedResult,
        sourceActionInvocationId,
        status: 'COMMITTED',
      });
      const released = yield* handleMarketAdministration(
        withMarket,
        context(Option.some(stateRowWithAdmission({ status: 'ABORTED' })), allGrants),
      );
      expect(released.result.market?.retirement).toEqual({ sourceActionInvocationId, status: 'ABORTED' });
      const never = yield* handleMarketAdministration(withMarket, context(Option.some(stateRow()), allGrants));
      expect(never.result.market).not.toHaveProperty('retirement');
    }),
  );

  it.effect('answers only the creation grant without a Market and hides foreign or unknown Markets', () =>
    Effect.gen(function* scopeRules() {
      const overview = yield* handleMarketAdministration(withoutMarket, context(Option.none(), allGrants));
      expect(overview.result).toEqual({ canCreateMarket: true });
      const foreign = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({
        marketRef: { ...marketRef, tenantId: foreignTenantId },
      });
      const foreignError = yield* handleMarketAdministration(foreign, context(Option.some(stateRow()), allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(foreignError)).toBe(true);
      const missing = yield* handleMarketAdministration(withMarket, context(Option.none(), allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
      const unavailable = yield* handleMarketAdministration(withMarket, context('unavailable', allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(unavailable)).toBe(true);
      const mismatched = yield* handleMarketAdministration(
        withMarket,
        context(Option.some(decodeRow({ ...baseRow, marketId: foreignTenantId })), allGrants),
      ).pipe(Effect.flip);
      expect(mismatched).toBeInstanceOf(ReadHandlerUnavailable);
      const foreignRetirement = yield* handleMarketAdministration(
        withMarket,
        context(
          Option.some(
            stateRowWithAdmission({
              result: { ...committedResult, marketRef: { ...marketRef, resourceId: foreignTenantId } },
              status: 'COMMITTED',
            }),
          ),
          allGrants,
        ),
      ).pipe(Effect.flip);
      expect(foreignRetirement).toBeInstanceOf(ReadHandlerUnavailable);
    }),
  );

  it.effect('decides the actual Action carriers in the unchanged trusted company scope', () =>
    Effect.gen(function* grants() {
      const management = makeTestAccessDecision({
        answers: { [createKey]: { outcome: 'DENIED' } },
        defaultAnswer: { outcome: 'ALLOWED' },
      });
      const adminOnly = yield* marketAdministrationGrants(withMarket, scope).pipe(
        Effect.provideService(AccessDecisionGate, management),
      );
      expect(adminOnly).toEqual({ canAdminister: true, canCreateMarket: false });
      const actions = [createMarketAction, ...managementActions];
      expect(management.askedDecisions).toHaveLength(actions.length);
      for (const [index, question] of management.askedDecisions.entries()) {
        expect(question.carrier).toBe(actions[index]?.descriptor);
        expect(question.scope).toBe(scope);
        expect(question.legalEntityScope).toBe('required');
        expect(question.mode).toBe('run');
        expect(question).not.toHaveProperty('target');
        expect(question.carrier.accessDeclaration?.selectors).toEqual([]);
      }
      const creation = makeTestAccessDecision({
        answers: { [createKey]: { outcome: 'ALLOWED' } },
        defaultAnswer: { outcome: 'DENIED' },
      });
      const creator = yield* marketAdministrationGrants(withoutMarket, scope).pipe(
        Effect.provideService(AccessDecisionGate, creation),
      );
      expect(creator).toEqual({ canAdminister: false, canCreateMarket: true });
      expect(creation.askedDecisions).toHaveLength(1);
      expect(creation.askedDecisions[0]?.carrier).toBe(createMarketAction.descriptor);
      const unknown = yield* marketAdministrationGrants(withMarket, scope).pipe(
        Effect.provideService(AccessDecisionGate, makeTestAccessDecision({ unavailable: true })),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(unknown)).toBe(true);
    }),
  );

  it.effect('requires every advertised management capability, never approval or a partial grant', () =>
    Effect.gen(function* partialManagement() {
      for (const action of managementActions) {
        for (const outcome of ['DENIED', 'NEEDS_APPROVAL'] as const) {
          const key = action.descriptor.accessDeclaration?.key;
          assert(key !== undefined);
          const gate = makeTestAccessDecision({
            answers: { [key]: { outcome } },
            defaultAnswer: { outcome: 'ALLOWED' },
          });
          const grants = yield* marketAdministrationGrants(withMarket, scope).pipe(
            Effect.provideService(AccessDecisionGate, gate),
          );
          expect(grants).toEqual({ canAdminister: false, canCreateMarket: true });
        }
      }
      const approval = yield* marketAdministrationGrants(withoutMarket, scope).pipe(
        Effect.provideService(
          AccessDecisionGate,
          makeTestAccessDecision({ defaultAnswer: { outcome: 'NEEDS_APPROVAL' } }),
        ),
      );
      expect(approval).toEqual({ canAdminister: false, canCreateMarket: false });
    }),
  );

  it.effect('rejects foreign Markets and untrusted company context before asking the gate', () =>
    Effect.gen(function* invalidScope() {
      const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
      const foreign = yield* marketAdministrationGrants(
        { marketRef: { ...marketRef, tenantId: foreignTenantId } },
        scope,
      ).pipe(Effect.provideService(AccessDecisionGate, gate), Effect.flip);
      expect(foreign).toBeInstanceOf(ReadHandlerNotFound);
      const { legalEntityId: _company, ...tenantScope } = scope;
      const missingCompany = yield* marketAdministrationGrants(withMarket, tenantScope).pipe(
        Effect.provideService(AccessDecisionGate, gate),
        Effect.flip,
      );
      expect(missingCompany).toBeInstanceOf(ReadHandlerUnavailable);
      expect(gate.askedDecisions).toEqual([]);
    }),
  );
});

for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
  it.effect(`the registered administration Read refuses ${outcome} before owner or write-authority observation`, () =>
    Effect.gen(function* primaryGate() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        executeOwnerQuery: () => Effect.die('A refused administration Read must not load Market state'),
        operationTime: new Date('2026-11-07T00:00:00.000Z'),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: commerceMarketCatalogBackendRegistration,
        scope,
      });
      const failure = yield* harness.runtime
        .runRead(request)
        .pipe(Effect.provideService(AccessDecisionGate, gate.accessDecision), Effect.flip);
      expect(Schema.is(outcome === 'DENIED' ? ReadPermissionDenied : ReadPermissionUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(
        gate.accessDecision.askedDecisions.every(({ carrier }) => carrier.accessDeclaration?.kind === 'read'),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}

it.effect('fails unavailable administrative authority before the registered Read loads owner state', () =>
  Effect.gen(function* unavailableAuthority() {
    const gate = makeTestBoundAccessGate({
      answers: { [createKey]: { outcome: 'UNAVAILABLE' } },
      defaultAnswer: { outcome: 'ALLOWED' },
    });
    const harness = yield* makeReadTestHarness({
      accessDecision: gate.bound,
      executeOwnerQuery: () => Effect.die('Unavailable administrative authority must precede owner state'),
      operationTime: new Date('2026-11-07T00:00:00.000Z'),
      ownerAuthorizationDecision: 'allowed',
      ownerRegistration: commerceMarketCatalogBackendRegistration,
      scope,
    });
    const failure = yield* harness.runtime
      .runRead(request)
      .pipe(Effect.provideService(AccessDecisionGate, gate.accessDecision), Effect.flip);
    expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    expect(harness.snapshot().ownerQueries).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('answers creation-only requests without reading a Market or asking management rights', () =>
  Effect.gen(function* creationOnly() {
    const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
    const harness = yield* makeReadTestHarness({
      accessDecision: gate.bound,
      executeOwnerQuery: () => Effect.die('A creation-only request has no Market selector'),
      operationTime: new Date('2026-11-07T00:00:00.000Z'),
      ownerAuthorizationDecision: 'allowed',
      ownerRegistration: commerceMarketCatalogBackendRegistration,
      scope,
    });
    const response = yield* harness.runtime
      .runRead({ ...request, input: withoutMarket })
      .pipe(Effect.provideService(AccessDecisionGate, gate.accessDecision));
    expect(response).toEqual({ canCreateMarket: true });
    expect(harness.snapshot().ownerQueries).toEqual([]);
    const mutations = gate.accessDecision.askedDecisions.filter(
      ({ carrier }) => carrier.accessDeclaration?.kind === 'action',
    );
    expect(mutations).toHaveLength(2);
    expect(mutations.every(({ carrier }) => carrier === createMarketAction.descriptor)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
  it.effect(
    `rechecks current write authority after exact owner SQL and handles ${outcome} without a stale positive hint`,
    () =>
      Effect.gen(function* currentAdministration() {
        const answers: Record<string, TestGateAnswer> = {};
        const gate = makeTestBoundAccessGate({ answers, defaultAnswer: { outcome: 'ALLOWED' } });
        let ownerReads = 0;
        const harness = yield* makeReadTestHarness({
          accessDecision: gate.bound,
          executeOwnerQuery: ({ params, scope: installed, sql }) => {
            expect(installed).toEqual({ legalEntityId: sellerId, tenantId });
            expect(sql).toContain('read_market_administration_state');
            expect(params).toEqual([tenantId, sellerId, expect.objectContaining({ oid: 3802, value: { marketId } })]);
            ownerReads += 1;
            answers['commerce.market-catalog.market.retire'] = { outcome };
            return Effect.succeed([{ payload: baseRow }]);
          },
          operationTime: new Date('2026-11-07T00:00:00.000Z'),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: commerceMarketCatalogBackendRegistration,
          scope,
        });
        const observed = yield* harness.runtime.runRead(request).pipe(
          Effect.provideService(AccessDecisionGate, {
            ...gate.accessDecision,
            decideMany: (questions) => {
              const { statements } = harness.snapshot();
              expect(statements.filter((entry) => /^begin/iu.test(entry))).toHaveLength(
                statements.filter((entry) => /^(?:commit|rollback)/iu.test(entry)).length,
              );
              return gate.accessDecision.decideMany(questions);
            },
          }),
          Effect.result,
        );
        expect(ownerReads).toBe(1);
        if (outcome === 'DENIED') {
          expect(observed).toMatchObject({
            success: {
              canCreateMarket: true,
              market: {
                canAdminister: false,
                currentDefinitionRevisionRef: { resourceId: definitionRevisionId },
                marketRef,
                revision: baseRow.revision,
              },
            },
          });
        } else {
          expect(observed).toMatchObject({ failure: { _tag: 'ReadHandlerUnavailable' } });
        }
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
}
