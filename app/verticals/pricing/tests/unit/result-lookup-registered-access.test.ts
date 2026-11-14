import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  makeActionRuntimeLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationContextDenied,
  OperationAuthenticationRequired,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { OperationalScope, ReadRuntimeService } from '@app/core-runtime';
import { ActionPermission, ActionRepositoryLive } from '@app/core-runtime/actions/runtime-wiring';
import { makeTestAccessGateLayers, makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import {
  makeModuleContractFixture,
  makeOwnerApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestOwnerQuery } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { PgTypes } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Match } from 'effect';
import { TestClock } from 'effect/testing';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { describe, expect, it } from 'effect-rstest';

import { CommercialFeeResultLookupApi } from '../../shared/apis/commercial-fee-result-lookup.ts';
import { ContractualDiscountResultLookupApi } from '../../shared/apis/contractual-discount-result-lookup.ts';
import { PriceResultLookupApi } from '../../shared/apis/price-result-lookup.ts';
import { QuantityTierResultLookupApi } from '../../shared/apis/quantity-tier-result-lookup.ts';
import { QuotationResultLookupApi } from '../../shared/apis/quotation-result-lookup.ts';
import { ZeroFloorAuthorizationResultLookupApi } from '../../shared/apis/zero-floor-authorization-result-lookup.ts';
import { commercialFeeResultLookupRead } from '../../src/api/commercial-fee-result-lookup.read.ts';
import { contractualDiscountResultLookupRead } from '../../src/api/contractual-discount-result-lookup.read.ts';
import { priceResultLookupRead } from '../../src/api/price-result-lookup.read.ts';
import { quantityTierResultLookupRead } from '../../src/api/quantity-tier-result-lookup.read.ts';
import { quotationResultLookupRead } from '../../src/api/quotation-result-lookup.read.ts';
import { zeroFloorAuthorizationResultLookupRead } from '../../src/api/zero-floor-authorization-result-lookup.read.ts';

const actionInvocationId = '79700000-0000-4000-8000-000000000001';
const scope: OperationalScope = {
  authBindingId: '79700000-0000-4000-8000-000000000002',
  authContextRef: 'session:pricing-registered-result-access',
  authMethod: 'session',
  correlationId: 'pricing-registered-result-access',
  legalEntityId: '79700000-0000-4000-8000-000000000003',
  principalId: '79700000-0000-4000-8000-000000000004',
  tenantId: '79700000-0000-4000-8000-000000000005',
};
const priceFamily = {
  name: 'price',
  outcome: 'PRICE_ACTION_RESULT_ABSENT',
  routine: 'lookup_price_action_result_v1',
} as const;
const families = [
  {
    name: 'commercial-fee',
    outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT',
    routine: 'lookup_commercial_fee_action_result_v1',
  },
  {
    name: 'contractual-discount',
    outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT',
    routine: 'lookup_contractual_discount_result_v1',
  },
  priceFamily,
  { name: 'quantity-tier', outcome: 'QUANTITY_TIER_RESULT_ABSENT', routine: 'lookup_quantity_tier_action_result_v1' },
  { name: 'quotation', outcome: 'QUOTATION_RESULT_ABSENT', routine: 'lookup_pricing_quotation_invocation_v1' },
  {
    name: 'zero-floor-authorization',
    outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT',
    routine: 'lookup_zero_floor_authorization_result_v1',
  },
] as const;
type Family = (typeof families)[number];
const reads = [
  commercialFeeResultLookupRead,
  contractualDiscountResultLookupRead,
  priceResultLookupRead,
  quantityTierResultLookupRead,
  quotationResultLookupRead,
  zeroFloorAuthorizationResultLookupRead,
] as const;

// A test-owned publication of the original private registrations, not a replacement production owner.
const base = makeModuleContractFixture({ appId: 'pricing-result-access-test', moduleId: 'commerce.pricing' }).manifest;
const ownerRegistration = defineVerticalRuntimeRegistration({
  actions: [],
  manifest: defineOntosModuleManifest({
    ...base,
    publicSurface: {
      ...base.publicSurface,
      api: {
        'commercial-fee-result-lookup': CommercialFeeResultLookupApi,
        'contractual-discount-result-lookup': ContractualDiscountResultLookupApi,
        'price-result-lookup': PriceResultLookupApi,
        'quantity-tier-result-lookup': QuantityTierResultLookupApi,
        'quotation-result-lookup': QuotationResultLookupApi,
        'zero-floor-authorization-result-lookup': ZeroFloorAuthorizationResultLookupApi,
      },
      components: {},
    },
  }),
  outboxWorkers: [],
  reads,
});

interface ReceiptLookupProbeInput {
  readonly actingPrincipalId?: string;
  readonly actionInvocationId: string;
  readonly legalEntityId?: string;
  readonly tenantId?: string;
}

const runLookup = Effect.fn('test.runOriginalPricingResultRead')(function* runLookup(
  runtime: ReadRuntimeService,
  family: Family,
  principal: OperationalScope = scope,
  probeInput?: ReceiptLookupProbeInput,
) {
  const input = probeInput ?? { actionInvocationId };
  const transport = { correlationId: principal.correlationId };
  return yield* Match.value(family.name).pipe(
    Match.when('commercial-fee', () =>
      runtime.runRead({ input, principal, registration: commercialFeeResultLookupRead, transport }),
    ),
    Match.when('contractual-discount', () =>
      runtime.runRead({ input, principal, registration: contractualDiscountResultLookupRead, transport }),
    ),
    Match.when('price', () => runtime.runRead({ input, principal, registration: priceResultLookupRead, transport })),
    Match.when('quantity-tier', () =>
      runtime.runRead({ input, principal, registration: quantityTierResultLookupRead, transport }),
    ),
    Match.when('quotation', () =>
      runtime.runRead({ input, principal, registration: quotationResultLookupRead, transport }),
    ),
    Match.when('zero-floor-authorization', () =>
      runtime.runRead({ input, principal, registration: zeroFloorAuthorizationResultLookupRead, transport }),
    ),
    Match.exhaustive,
  );
});

const makeHarness = Effect.fn('test.makePricingResultHarness')(function* makeHarness(
  family: Family,
  options: {
    readonly access?: 'allowed' | 'denied' | 'unavailable';
    readonly commit?: 'absent' | 'open' | 'succeeded' | 'unavailable';
    readonly operationalScope?: OperationalScope;
    readonly ownerFound?: boolean;
    readonly ownerInvocationId?: string;
  } = {},
) {
  const operationalScope = options.operationalScope ?? scope;
  const composition = yield* makeOwnerApplicationCompositionFixture({
    appId: 'pricing-result-access-test',
    ownerRegistration,
  });
  const gate = makeTestBoundAccessGate(
    Match.value(options.access).pipe(
      Match.when('denied', () => ({})),
      Match.when('unavailable', () => ({ unavailable: true })),
      Match.orElse(() => ({ defaultAnswer: { outcome: 'ALLOWED' as const } })),
    ),
  );
  const queries: ReadTestOwnerQuery[] = [];
  const harness = yield* makeReadTestHarness({
    accessDecision: gate.bound,
    applicationComposition: composition.applicationComposition,
    compositionRevision: composition.snapshot.composition.revision,
    executeOwnerQuery: (query) => {
      queries.push(query);
      if (query.sql.includes('from "core"."action_invocations"')) {
        expect(query.sql).toContain('"principal_id" =');
        expect(query.sql).toContain('"tenant_id" =');
        expect(query.sql).toContain('"legal_entity_id" =');
        expect(query.sql).toContain('for update');
        expect(query.params).toEqual([
          actionInvocationId,
          operationalScope.legalEntityId,
          operationalScope.tenantId,
          operationalScope.principalId,
          1,
        ]);
        if (options.commit === 'unavailable') {
          return Effect.fail(
            new SqlError({ reason: new ConnectionError({ cause: 'Controlled commit repository outage' }) }),
          );
        }
        const belongsToActor =
          operationalScope.tenantId === scope.tenantId &&
          operationalScope.legalEntityId === scope.legalEntityId &&
          operationalScope.principalId === scope.principalId;
        return Effect.succeed(
          options.commit === undefined || options.commit === 'absent' || !belongsToActor
            ? []
            : [
                Object.fromEntries([
                  ['actionInvocationId', actionInvocationId],
                  [
                    'completedAt',
                    options.commit === 'succeeded'
                      ? DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-28T12:00:00Z'))
                      : null,
                  ],
                  ['requestHash', 'original-request-hash'],
                  ['status', options.commit === 'succeeded' ? 'succeeded' : 'received'],
                  ['actionKey', 'commerce.pricing.define-price'],
                ]),
              ],
        );
      }
      if (!query.sql.includes(`"pricing"."${family.routine}"`)) {
        return Effect.die(`Unexpected result lookup SQL: ${query.sql}`);
      }
      const actorParams =
        family.name === 'quotation'
          ? [operationalScope.principalId, actionInvocationId]
          : [PgTypes.jsonb({ actingPrincipalId: operationalScope.principalId, actionInvocationId })];
      expect(query.params).toEqual([operationalScope.tenantId, operationalScope.legalEntityId, ...actorParams]);
      expect(query.scope).toEqual({
        legalEntityId: operationalScope.legalEntityId,
        tenantId: operationalScope.tenantId,
      });
      return Effect.succeed([
        {
          payload:
            options.ownerFound === true
              ? {
                  actionInvocationId,
                  outcome: 'PRICE_ACTION_RESULT_FOUND',
                  result: { outcome: 'EFFECTIVE_TIME_INVALID' },
                }
              : {
                  actionInvocationId: options.ownerInvocationId ?? actionInvocationId,
                  outcome: family.name === 'quotation' ? 'NOT_FOUND' : family.outcome,
                },
        },
      ]);
    },
    expectedDeployment: composition.expectedDeployment,
    operationTime: DateTime.toDateUtc(yield* DateTime.now),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration,
    scope: operationalScope,
  });
  const moduleState = ModuleStateGateLive.pipe(Layer.provide(TenantModuleStateServiceLive));
  const entrypoints = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleState));
  // Commit recovery uses the real repository. The retired execution permission port must never run.
  const actionLayer = makeActionRuntimeLive(composition.expectedDeployment, ownerRegistration).pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionRepositoryLive,
        moduleState,
        entrypoints,
        Layer.succeed(ActionPermission, {
          checkActionPermission: () => Effect.die('Receipt recovery must not execute an Action'),
        }),
        Layer.succeed(ActiveApplicationCompositionService, composition.applicationComposition),
        makeTestAccessGateLayers(),
      ),
    ),
    Layer.provide(harness.ownerServices),
  );
  const actionRuntime = Context.get(yield* Layer.build(actionLayer), ActionRuntime);
  return { actionRuntime, gate, harness, queries };
});

it.layer(Layer.merge(NodeCrypto.layer, TestClock.layer()))('original Pricing receipt Read lifecycle', (suite) => {
  for (const family of families) {
    suite.effect(
      `${family.name} admits its dedicated RUN capability and invokes only the scoped original routine`,
      () =>
        Effect.scoped(
          Effect.gen(function* allowedReceiptRead() {
            const fixture = yield* makeHarness(family);
            const result = yield* runLookup(fixture.harness.runtime, family).pipe(
              Effect.provideService(ActionRuntime, fixture.actionRuntime),
            );
            expect(result).toEqual({ actionInvocationId, outcome: family.outcome });
            expect(fixture.queries.filter((query) => query.sql.includes(`"${family.routine}"`))).toHaveLength(1);
            expect(fixture.gate.accessDecision.askedDecisions).not.toHaveLength(0);
            for (const question of fixture.gate.accessDecision.askedDecisions) {
              expect(question.carrier.accessDeclaration?.key).toBe(`commerce.pricing.${family.name}.read-result`);
              expect(question.mode ?? 'run').toBe('run');
            }
            expect(fixture.harness.snapshot().evidenceWrites).toBe(1);
          }),
        ),
    );
    for (const access of ['denied', 'unavailable'] as const) {
      suite.effect(`${family.name} ${access} stops before preparation and original owner SQL`, () =>
        Effect.scoped(
          Effect.gen(function* refusedReceiptRead() {
            const fixture = yield* makeHarness(family, { access });
            const failure = yield* runLookup(fixture.harness.runtime, family).pipe(
              Effect.provideService(ActionRuntime, fixture.actionRuntime),
              Effect.flip,
            );
            expect(failure).toBeInstanceOf(access === 'denied' ? ReadPermissionDenied : ReadPermissionUnavailable);
            expect(fixture.queries).toEqual([]);
            expect(fixture.harness.snapshot().evidenceWrites).toBe(access === 'denied' ? 1 : 0);
          }),
        ),
      );
    }
    for (const changedIdentity of [
      { principalId: '79700000-0000-4000-8000-000000000007' },
      { tenantId: '79700000-0000-4000-8000-000000000008' },
    ]) {
      suite.effect(
        `${family.name} refuses a Principal or Tenant inconsistent with its persisted binding ${Object.keys(changedIdentity)[0]}`,
        () =>
          Effect.scoped(
            Effect.gen(function* inconsistentAuthentication() {
              const fixture = yield* makeHarness(family);
              const failure = yield* runLookup(fixture.harness.runtime, family, { ...scope, ...changedIdentity }).pipe(
                Effect.provideService(ActionRuntime, fixture.actionRuntime),
                Effect.flip,
              );
              expect(failure).toBeInstanceOf(
                'principalId' in changedIdentity ? OperationAuthenticationRequired : OperationContextDenied,
              );
              expect(fixture.queries).toEqual([]);
              expect(fixture.gate.accessDecision.askedDecisions).toEqual([]);
            }),
          ),
      );
    }
    suite.effect(`${family.name} requires a trusted Company before entering its original factory`, () =>
      Effect.scoped(
        Effect.gen(function* missingCompany() {
          const fixture = yield* makeHarness(family);
          const { legalEntityId: _legalEntityId, ...tenantScope } = scope;
          const failure = yield* runLookup(fixture.harness.runtime, family, tenantScope).pipe(
            Effect.provideService(ActionRuntime, fixture.actionRuntime),
            Effect.flip,
          );
          expect(failure).toBeInstanceOf(OperationContextDenied);
          expect(fixture.queries).toEqual([]);
        }),
      ),
    );
    suite.effect(`${family.name} rejects caller-supplied receipt ownership before owner SQL`, () =>
      Effect.scoped(
        Effect.gen(function* callerCannotSelectReceiptOwner() {
          const fixture = yield* makeHarness(family);
          const failure = yield* runLookup(fixture.harness.runtime, family, scope, {
            actingPrincipalId: '79700000-0000-4000-8000-000000000007',
            actionInvocationId,
            legalEntityId: '79700000-0000-4000-8000-000000000009',
            tenantId: '79700000-0000-4000-8000-000000000008',
          }).pipe(Effect.provideService(ActionRuntime, fixture.actionRuntime), Effect.flip);
          expect(failure).toBeInstanceOf(ReadInputValidationError);
          expect(fixture.queries).toEqual([]);
        }),
      ),
    );
    suite.effect(`${family.name} refuses an owner response naming another invocation`, () =>
      Effect.scoped(
        Effect.gen(function* mismatchedOwnerInvocation() {
          const fixture = yield* makeHarness(family, { ownerInvocationId: '79700000-0000-4000-8000-000000000010' });
          const failure = yield* runLookup(fixture.harness.runtime, family).pipe(
            Effect.provideService(ActionRuntime, fixture.actionRuntime),
            Effect.flip,
          );
          expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
          expect(fixture.queries.filter((query) => query.sql.includes(`"${family.routine}"`))).toHaveLength(1);
        }),
      ),
    );
  }
  suite.effect(
    'Price recovers a committed result only after the original Core repository proves its own invocation',
    () =>
      Effect.scoped(
        Effect.gen(function* recoverCommittedPrice() {
          const fixture = yield* makeHarness(priceFamily, { commit: 'succeeded', ownerFound: true });
          expect(
            yield* runLookup(fixture.harness.runtime, priceFamily).pipe(
              Effect.provideService(ActionRuntime, fixture.actionRuntime),
            ),
          ).toEqual({
            actionInvocationId,
            outcome: 'PRICE_ACTION_RESULT_FOUND',
            result: { outcome: 'EFFECTIVE_TIME_INVALID' },
          });
          expect(fixture.queries).toHaveLength(2);
          expect(fixture.queries[0]?.sql).toContain('"core"."action_invocations"');
          expect(fixture.queries[1]?.sql).toContain('"lookup_price_action_result_v1"');
          const { statements } = fixture.harness.snapshot();
          const commitQueryIndex = statements.findIndex((statement) =>
            statement.includes('"core"."action_invocations"'),
          );
          const ownerQueryIndex = statements.findIndex((statement) =>
            statement.includes('"lookup_price_action_result_v1"'),
          );
          expect(
            statements.slice(commitQueryIndex + 1, ownerQueryIndex).some((statement) => /^commit$/iu.test(statement)),
          ).toBe(true);
        }),
      ),
  );
  for (const commit of ['absent', 'open', 'succeeded'] as const) {
    suite.effect(`Price fails closed on ${commit} Core state disagreeing with the owner receipt`, () =>
      Effect.scoped(
        Effect.gen(function* disagreeingCommitState() {
          const fixture = yield* makeHarness(priceFamily, { commit, ownerFound: commit !== 'succeeded' });
          expect(
            yield* runLookup(fixture.harness.runtime, priceFamily).pipe(
              Effect.provideService(ActionRuntime, fixture.actionRuntime),
            ),
          ).toEqual({
            actionInvocationId,
            outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE',
            retryable: true,
          });
        }),
      ),
    );
  }
  suite.effect(
    'Price retains a retryable unavailable result without an owner query when the real Core repository is unavailable',
    () =>
      Effect.scoped(
        Effect.gen(function* unavailableCommitAuthority() {
          const fixture = yield* makeHarness(priceFamily, { commit: 'unavailable', ownerFound: true });
          expect(
            yield* runLookup(fixture.harness.runtime, priceFamily).pipe(
              Effect.provideService(ActionRuntime, fixture.actionRuntime),
            ),
          ).toEqual({
            actionInvocationId,
            outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE',
            retryable: true,
          });
          expect(fixture.queries).toHaveLength(1);
          expect(fixture.queries[0]?.sql).toContain('"core"."action_invocations"');
        }),
      ),
  );
  for (const foreignIdentity of [
    { principalId: '79700000-0000-4000-8000-000000000007' },
    { tenantId: '79700000-0000-4000-8000-000000000008' },
    { legalEntityId: '79700000-0000-4000-8000-000000000009' },
  ]) {
    suite.effect(
      `Price cannot use another ${Object.keys(foreignIdentity)[0]}'s Core commit as its recovery authority`,
      () =>
        Effect.scoped(
          Effect.gen(function* foreignCommitOwner() {
            const operationalScope = { ...scope, ...foreignIdentity };
            const fixture = yield* makeHarness(priceFamily, {
              commit: 'succeeded',
              operationalScope,
              ownerFound: true,
            });
            // Even an inconsistent owner receipt cannot turn another Principal/Tenant/Company's commit into ours.
            expect(
              yield* runLookup(fixture.harness.runtime, priceFamily, operationalScope).pipe(
                Effect.provideService(ActionRuntime, fixture.actionRuntime),
              ),
            ).toEqual({
              actionInvocationId,
              outcome: 'PRICE_ACTION_RESULT_UNAVAILABLE',
              retryable: true,
            });
            expect(fixture.queries).toHaveLength(2);
          }),
        ),
    );
  }
});

describe('receipt carrier declarations', () => {
  it('keeps receipt authority separate from Action execution and does not add record selectors or field grants', () => {
    for (const read of reads) {
      expect(read.descriptor.entrypoint.authorization.kind).toBe('protected');
      expect(read.descriptor.accessDeclaration).toMatchObject({
        kind: 'read',
        modes: ['run'],
        risk: 'sensitive',
        selectors: [],
      });
      expect(read.descriptor.legalEntityScope).toBe('required');
      expect(read.descriptor.permissionTarget).toBeUndefined();
    }
  });
});
