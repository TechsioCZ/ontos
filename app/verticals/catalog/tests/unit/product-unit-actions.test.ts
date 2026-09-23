import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { CreateProductUnitPayloadSchema } from '../../shared/actions/create-product-unit.ts';
import type { CreateProductUnitResult } from '../../shared/actions/create-product-unit.ts';
import { RetireProductUnitPayloadSchema } from '../../shared/actions/retire-product-unit.ts';
import type { RetireProductUnitResult } from '../../shared/actions/retire-product-unit.ts';
import { ReviseProductUnitPayloadSchema } from '../../shared/actions/revise-product-unit.ts';
import type { ReviseProductUnitResult } from '../../shared/actions/revise-product-unit.ts';
import { SetProductUnitTargetDivisibilityPayloadSchema } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import type { SetProductUnitTargetDivisibilityResult } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { createProductUnitAction, handleCreateProductUnit } from '../../src/actions/create-product-unit.action.ts';
import { handleRetireProductUnit, retireProductUnitAction } from '../../src/actions/retire-product-unit.action.ts';
import { handleReviseProductUnit, reviseProductUnitAction } from '../../src/actions/revise-product-unit.action.ts';
import {
  handleSetProductUnitTargetDivisibility,
  setProductUnitTargetDivisibilityAction,
} from '../../src/actions/set-product-unit-target-divisibility.action.ts';
import { ProductUnitPersistenceUnavailable } from '../../src/persistence/product-unit-persistence.ts';
import type { ProductUnitPersistence } from '../../src/persistence/product-unit-persistence.ts';
import type { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-unit-revised-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const common = { evidenceRefs: ['unit-evidence-2026'], reason: 'Unit rule confirmed' };
const rule = { rounding: 'UP', step: '0.01' };
const create = Schema.decodeUnknownSync(CreateProductUnitPayloadSchema)({
  ...common,
  code: 'm',
  label: 'metre',
  rule,
  unitRef,
});
const revise = Schema.decodeUnknownSync(ReviseProductUnitPayloadSchema)({
  ...common,
  expectedCurrent: { revision: 1, unit: unitRef },
  rule,
});
const retire = Schema.decodeUnknownSync(RetireProductUnitPayloadSchema)({
  ...common,
  expectedCurrent: { revision: 1, unit: unitRef },
});
const divisibility = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
  ...common,
  divisible: true,
  expectedSources: {
    product: {
      resourceRef: {
        moduleId: 'commerce.catalog',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.catalog.product',
        tenantId,
      },
      revision: 2,
    },
    variant: {
      resourceRef: {
        moduleId: 'commerce.catalog',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
      revision: 3,
    },
  },
  target: {
    targetId: '44444444-4444-4444-8444-444444444444',
    targetType: 'commerce.catalog.variant',
    tenantId,
    unit: unitRef,
  },
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:unit-actions:run:1',
    authMethod: 'system',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'unit-action-test',
};
const unavailable = () =>
  Effect.fail(
    new ProductUnitPersistenceUnavailable({ code: 'product_unit_persistence_unavailable', reason: 'No basis' }),
  );
const unexpected = () => Effect.die('Persistence should not run');
type ProductUnitRevisedDomainEvents = Readonly<
  Record<'commerce.catalog.product-unit-revised.v1', typeof OutboxPayloadSchema>
>;
const context = <DomainEvents extends DomainEventContractMap = Readonly<Record<string, never>>>(
  overrides: Partial<ProductUnitPersistence> = {},
): ActionHandlerContext<DomainEvents, ProductUnitPersistence> => ({
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services: {
    create: unavailable,
    retire: unavailable,
    revise: unavailable,
    setTargetDivisibility: unavailable,
    ...overrides,
  },
});

describe('Product Unit governed Actions', () => {
  it.effect('captures decoded success once and rolls back when capture fails', () =>
    Effect.gen(function* captureUnitResult() {
      const captured: unknown[] = [];
      const services = {
        ...context().services,
        captureResult: (id: string, result: CreateProductUnitResult) =>
          Effect.sync(() => {
            captured.push({ id, result });
          }),
        create: () =>
          Effect.succeed({
            _tag: 'created' as const,
            ruleRevision: { revision: 1, ...create.rule, unit: create.unitRef },
            unit: create.unitRef,
          }),
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [bindActionTestServices(createProductUnitAction, services)],
      });
      const request = {
        payload: create,
        principal: {
          authBindingId: '99999999-9999-4999-8999-999999999999',
          authContextRef: 'better-auth-session:unit-capture',
          authMethod: 'session' as const,
          principalId: scope.principalId,
          tenantId,
        },
        registration: createProductUnitAction,
        transport: { correlationId: 'unit-capture', idempotencyKey: 'unit-capture-once' },
      };
      const result = yield* harness.runtime.runAction(request);
      expect(captured).toEqual([{ id: expect.any(String), result }]);
      expect(harness.snapshot().committed).toHaveLength(1);
      yield* harness.runtime.runAction(request).pipe(Effect.flip);
      expect(captured).toHaveLength(1);

      const failed = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createProductUnitAction, {
            ...services,
            captureResult: () =>
              Effect.fail(
                new ActionTransactionError({
                  code: 'action_transaction_failed',
                  reason: 'Catalog result capture failed',
                }),
              ),
          }),
        ],
      });
      const error = yield* failed.runtime.runAction(request).pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'action_transaction_failed' });
      expect(failed.snapshot().committed).toHaveLength(0);
    }),
  );
  it('exports all four direct result types for owner API contracts', () => {
    const result = {
      ruleRevision: { revision: 1, rounding: 'UP' as const, step: '0.01', unit: unitRef },
      unit: unitRef,
    };
    const createResult: CreateProductUnitResult = Schema.decodeUnknownSync(
      createProductUnitAction.descriptor.resultSchema,
    )(result);
    const reviseResult: ReviseProductUnitResult = createResult;
    const retireResult: RetireProductUnitResult = reviseResult;
    const divisibilityResult: SetProductUnitTargetDivisibilityResult = retireResult;
    expect(divisibilityResult.ruleRevision.revision).toBe(1);
  });
  it('requires tenant-scoped, idempotent, explicitly authorized writes', () => {
    for (const action of [
      createProductUnitAction,
      reviseProductUnitAction,
      retireProductUnitAction,
      setProductUnitTargetDivisibilityAction,
    ]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it('requires exact positive steps, explicit rounding, and pinned Current for updates', () => {
    expect(create.rule.step).toBe('0.01');
    expect(() =>
      Schema.decodeUnknownSync(CreateProductUnitPayloadSchema)({ ...create, rule: { step: '0.01' } }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateProductUnitPayloadSchema)({ ...create, rule: { ...rule, step: '0' } }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ReviseProductUnitPayloadSchema)({ ...common, rule })).toThrow();
    expect(() => Schema.decodeUnknownSync(RetireProductUnitPayloadSchema)({ ...common })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        ...divisibility,
        target: { ...divisibility.target, targetId: '' },
      }),
    ).toThrow();
    const { expectedSources: _expectedSources, ...withoutExpectedSources } = divisibility;
    expect(() =>
      Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        ...withoutExpectedSources,
      }),
    ).toThrow();
  });

  it.effect('never reports mutation success without authoritative persistence', () =>
    Effect.gen(function* unavailableWrites() {
      const errors = yield* Effect.all([
        handleCreateProductUnit(create, context()).pipe(Effect.flip),
        handleReviseProductUnit(revise, context<ProductUnitRevisedDomainEvents>()).pipe(Effect.flip),
        handleRetireProductUnit(retire, context()).pipe(Effect.flip),
        handleSetProductUnitTargetDivisibility(divisibility, context()).pipe(Effect.flip),
      ]);
      expect(errors.map((error) => error.code)).toEqual([
        'product_unit_unavailable',
        'product_unit_unavailable',
        'product_unit_unavailable',
        'product_unit_unavailable',
      ]);
    }),
  );

  it.effect('rejects foreign Tenant references before persistence', () =>
    Effect.gen(function* rejectForeignTenant() {
      const foreign = Schema.decodeUnknownSync(CreateProductUnitPayloadSchema)({
        ...create,
        unitRef: { ...unitRef, tenantId: otherTenantId },
      });
      const foreignTarget = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        ...divisibility,
        target: { ...divisibility.target, tenantId: otherTenantId },
      });
      const error = yield* handleCreateProductUnit(foreign, context({ create: unexpected })).pipe(Effect.flip);
      const targetError = yield* handleSetProductUnitTargetDivisibility(
        foreignTarget,
        context({ setTargetDivisibility: unexpected }),
      ).pipe(Effect.flip);
      expect(error.code).toBe('product_unit_invalid');
      expect(targetError.code).toBe('product_unit_invalid');
    }),
  );
});
