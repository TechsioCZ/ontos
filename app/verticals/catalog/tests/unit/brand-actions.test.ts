import type { ActionHandlerContext } from '@app/core-runtime';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  BrandMutationResultSchema,
  CreateBrandPayloadSchema,
  ProductBrandMutationResultSchema,
  ReactivateBrandPayloadSchema,
  RenameBrandPayloadSchema,
  RetireBrandPayloadSchema,
  SetProductBrandPayloadSchema,
} from '../../shared/actions/brand-mutations.ts';
import { createBrandAction, handleCreateBrand } from '../../src/actions/create-brand.action.ts';
import { handleReactivateBrand, reactivateBrandAction } from '../../src/actions/reactivate-brand.action.ts';
import { handleRenameBrand, renameBrandAction } from '../../src/actions/rename-brand.action.ts';
import { handleRetireBrand, retireBrandAction } from '../../src/actions/retire-brand.action.ts';
import { handleSetProductBrand, setProductBrandAction } from '../../src/actions/set-product-brand.action.ts';
import { BrandPersistenceUnavailable } from '../../src/persistence/brand-persistence.ts';
import type { BrandPersistence } from '../../src/persistence/brand-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const brandRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.brand',
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const evidence = { evidenceRefs: ['brand-evidence-2026'], reason: 'Current Brand assessment confirmed' };
const captureTransport = (key: string) => ({ correlationId: key, idempotencyKey: key });
const create = Schema.decodeUnknownSync(CreateBrandPayloadSchema)({ ...evidence, brandRef, name: 'Alfa Home' });
const rename = Schema.decodeUnknownSync(RenameBrandPayloadSchema)({
  ...evidence,
  brandRef,
  expectedRevision: 1,
  name: 'Alfa',
});
const retire = Schema.decodeUnknownSync(RetireBrandPayloadSchema)({ ...evidence, brandRef, expectedRevision: 2 });
const reactivate = Schema.decodeUnknownSync(ReactivateBrandPayloadSchema)({
  ...evidence,
  brandRef,
  expectedRevision: 3,
});
const assign = Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({
  ...evidence,
  assignment: { brandRef, kind: 'brand' },
  expectedRevision: 1,
  productRef,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:brand-actions:run:1',
    authMethod: 'system',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'brand-action-test',
};
const unavailable = () =>
  Effect.fail(new BrandPersistenceUnavailable({ code: 'brand_persistence_unavailable', reason: 'No basis' }));
const unexpected = () => Effect.die('Persistence should not run');
const context = (
  overrides: Partial<BrandPersistence> = {},
): ActionHandlerContext<Readonly<Record<string, never>>, BrandPersistence> => ({
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services: {
    create: unavailable,
    reactivate: unavailable,
    rename: unavailable,
    retire: unavailable,
    setProductBrand: unavailable,
    ...overrides,
  },
});
const renameContext = (overrides: Partial<BrandPersistence> = {}): Parameters<typeof handleRenameBrand>[1] => ({
  ...context(overrides),
  addDomainEvent: () => Effect.succeed(Object.create(null)),
});

describe('Brand governed Actions', () => {
  it.effect('rolls back every Brand Action when decoded-success capture fails', () =>
    Effect.gen(function* brandCaptureFailure() {
      const brandResult = Schema.decodeUnknownSync(BrandMutationResultSchema)({ brandRef, revision: 1 });
      const productBrandResult = Schema.decodeUnknownSync(ProductBrandMutationResultSchema)({
        assignment: assign.assignment,
        productRef,
        revision: 2,
      });
      const captured: string[] = [];
      const services = {
        captureResult: (actionInvocationId: string) =>
          Effect.gen(function* failCapture() {
            captured.push(actionInvocationId);
            return yield* new ActionTransactionError({
              code: 'action_transaction_failed',
              reason: 'Catalog result capture failed',
            });
          }),
        create: () => Effect.succeed({ _tag: 'applied' as const, result: brandResult }),
        reactivate: () => Effect.succeed({ _tag: 'applied' as const, result: brandResult }),
        rename: () => Effect.succeed({ _tag: 'applied' as const, result: brandResult }),
        retire: () => Effect.succeed({ _tag: 'applied' as const, result: brandResult }),
        setProductBrand: () => Effect.succeed({ _tag: 'applied' as const, result: productBrandResult }),
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createBrandAction, services),
          bindActionTestServices(renameBrandAction, services),
          bindActionTestServices(retireBrandAction, services),
          bindActionTestServices(reactivateBrandAction, services),
          bindActionTestServices(setProductBrandAction, services),
        ],
      });
      const principal = {
        authBindingId: '99999999-9999-4999-8999-999999999999',
        authContextRef: 'better-auth-session:brand-result-capture',
        authMethod: 'session' as const,
        principalId: scope.principalId,
        tenantId,
      };
      const failures = yield* Effect.all(
        [
          harness.runtime
            .runAction({
              payload: create,
              principal,
              registration: createBrandAction,
              transport: captureTransport('brand-create-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: rename,
              principal,
              registration: renameBrandAction,
              transport: captureTransport('brand-rename-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: retire,
              principal,
              registration: retireBrandAction,
              transport: captureTransport('brand-retire-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: reactivate,
              principal,
              registration: reactivateBrandAction,
              transport: captureTransport('brand-reactivate-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: assign,
              principal,
              registration: setProductBrandAction,
              transport: captureTransport('product-brand-capture'),
            })
            .pipe(Effect.flip),
        ],
        { concurrency: 1 },
      );
      expect(failures.map((failure) => failure.code)).toEqual(
        Array.from({ length: 5 }, () => 'action_transaction_failed'),
      );
      expect(captured).toHaveLength(5);
      expect(harness.snapshot().committed).toHaveLength(0);
    }),
  );
  it('requires explicit permission, tenant scope, and idempotency', () => {
    for (const action of [
      createBrandAction,
      renameBrandAction,
      retireBrandAction,
      reactivateBrandAction,
      setProductBrandAction,
    ]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it('keeps Brand identity independent of its name and requires CAS for later changes', () => {
    expect(rename.brandRef.resourceId).toBe(create.brandRef.resourceId);
    expect(() => Schema.decodeUnknownSync(RenameBrandPayloadSchema)({ ...evidence, brandRef, name: 'Alfa' })).toThrow();
    expect(() => Schema.decodeUnknownSync(RetireBrandPayloadSchema)({ ...evidence, brandRef })).toThrow();
    expect(() => Schema.decodeUnknownSync(ReactivateBrandPayloadSchema)({ ...evidence, brandRef })).toThrow();
    expect(() => Schema.decodeUnknownSync(CreateBrandPayloadSchema)({ ...create, name: '  ' })).toThrow();
  });

  it('distinguishes an existing Brand, unknown, and confirmed unbranded without pseudo-Brands', () => {
    for (const assignment of [{ brandRef, kind: 'brand' }, { kind: 'unknown' }, { kind: 'confirmed_unbranded' }]) {
      expect(Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({ ...assign, assignment }).assignment.kind).toBe(
        assignment.kind,
      );
    }
    expect(() =>
      Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({ ...assign, assignment: { kind: 'brand' } }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({ ...assign, evidenceRefs: [] })).toThrow();
    expect(
      Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({ ...assign, expectedRevision: 0 }).expectedRevision,
    ).toBe(0);
    expect(() => Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({ ...assign, expectedRevision: -1 })).toThrow();
  });

  it.effect('never reports mutation success without authoritative persistence', () =>
    Effect.gen(function* rejectUnavailablePersistence() {
      const errors = yield* Effect.all([
        handleCreateBrand(create, context()).pipe(Effect.flip),
        handleRenameBrand(rename, renameContext()).pipe(Effect.flip),
        handleRetireBrand(retire, context()).pipe(Effect.flip),
        handleReactivateBrand(reactivate, context()).pipe(Effect.flip),
        handleSetProductBrand(assign, context()).pipe(Effect.flip),
      ]);
      expect(errors.map((error) => error.code)).toEqual(Array.from({ length: 5 }, () => 'brand_unavailable'));
    }),
  );

  it.effect('emits the committed Brand rename and linked outbox once after persistence succeeds', () =>
    Effect.gen(function* committedBrandRename() {
      const emitted: unknown[] = [];
      const result = Schema.decodeUnknownSync(BrandMutationResultSchema)({ brandRef, revision: 2 });
      const actionContext: Parameters<typeof handleRenameBrand>[1] = {
        ...renameContext({ rename: () => Effect.succeed({ _tag: 'applied' as const, result }) }),
        addDomainEvent: (event) => {
          emitted.push(event);
          return Effect.succeed(Object.create(null));
        },
        addOutboxMessage: (event, message) => {
          emitted.push({ event, message });
          return Effect.void;
        },
      };
      expect(yield* handleRenameBrand(rename, actionContext)).toEqual(result);
      expect(emitted).toHaveLength(2);
      expect(emitted[0]).toMatchObject({
        eventType: 'commerce.catalog.brand-descriptive-changed.v1',
        payloadJson: { brandRef, name: 'Alfa', revision: 2, tenantId },
        subjectResourceId: brandRef.resourceId,
        subjectResourceType: brandRef.resourceType,
      });
      expect(emitted[1]).toMatchObject({
        message: {
          payloadJson: { brandRef, name: 'Alfa', revision: 2, tenantId },
          topic: 'commerce.catalog.brand-descriptive-changed.v1',
        },
      });
    }),
  );

  it.effect('emits nothing when the Brand rename is rejected as stale', () =>
    Effect.gen(function* rejectedBrandRename() {
      const emitted: unknown[] = [];
      const actionContext: Parameters<typeof handleRenameBrand>[1] = {
        ...renameContext({ rename: () => Effect.succeed({ _tag: 'stale' as const, actualRevision: 3 }) }),
        addDomainEvent: (event) => {
          emitted.push(event);
          return Effect.die('Rejected rename must not create an event');
        },
        addOutboxMessage: (event, message) => {
          emitted.push({ event, message });
          return Effect.die('Rejected rename must not enqueue an outbox message');
        },
      };
      const error = yield* handleRenameBrand(rename, actionContext).pipe(Effect.flip);
      expect(error.code).toBe('brand_stale');
      expect(emitted).toHaveLength(0);
    }),
  );

  it.effect('rejects foreign Tenant references before persistence', () =>
    Effect.gen(function* rejectForeignTenant() {
      const foreignBrand = Schema.decodeUnknownSync(CreateBrandPayloadSchema)({
        ...create,
        brandRef: { ...brandRef, tenantId: otherTenantId },
      });
      const foreignAssignment = Schema.decodeUnknownSync(SetProductBrandPayloadSchema)({
        ...assign,
        assignment: { brandRef: { ...brandRef, tenantId: otherTenantId }, kind: 'brand' },
      });
      const errors = yield* Effect.all([
        handleCreateBrand(foreignBrand, context({ create: unexpected })).pipe(Effect.flip),
        handleSetProductBrand(foreignAssignment, context({ setProductBrand: unexpected })).pipe(Effect.flip),
      ]);
      expect(errors.map((error) => error.code)).toEqual(['brand_invalid', 'brand_invalid']);
    }),
  );
});
