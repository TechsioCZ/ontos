import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  VariantHistoryForbiddenProblemSchema,
  VariantHistoryRequestSchema,
  VariantHistoryResponseSchema,
} from '../../shared/apis/variant-history.ts';
import {
  PackageDefinitionHistoryForbiddenProblemSchema,
  PackageDefinitionHistoryRequestSchema,
  PackageDefinitionHistoryResponseSchema,
} from '../../shared/apis/package-definition-history.ts';
import {
  PackageOptionHistoryForbiddenProblemSchema,
  PackageOptionHistoryRequestSchema,
  PackageOptionHistoryResponseSchema,
} from '../../shared/apis/package-option-history.ts';
import { readVariantHistory, variantHistoryRead } from '../../src/api/variant-history.read.ts';
import {
  packageDefinitionHistoryRead,
  readPackageDefinitionHistory,
} from '../../src/api/package-definition-history.read.ts';
import { packageOptionHistoryRead, readPackageOptionHistory } from '../../src/api/package-option-history.read.ts';
import { PackagePersistenceUnavailable } from '../../src/persistence/package-persistence.ts';
import type { variantHistoryForScope } from '../../src/persistence/variant-persistence.ts';
import type { packageHistoryForScope } from '../../src/persistence/package-persistence.ts';
import type { packageOptionHistoryForScope } from '../../src/persistence/package-option-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';
const date = new Date('2026-09-16T12:00:00.000Z');
const absentText = (): string | null => null;
const absentRevision = (): number | null => null;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const packageRef = {
  moduleId: 'commerce.catalog',
  resourceId: definitionId,
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
};
const variantRequest = Schema.decodeUnknownSync(VariantHistoryRequestSchema)({
  reference: { resourceRef: variantRef, revision: 1 },
});
const contentRequest = Schema.decodeUnknownSync(PackageDefinitionHistoryRequestSchema)({
  reference: { resourceRef: packageRef, revision: 1 },
});
const roleRequest = Schema.decodeUnknownSync(PackageOptionHistoryRequestSchema)({
  reference: { resourceRef: packageRef, roleRevision: 2 },
});

const variantRow = {
  actingPrincipalId: productId,
  actionInvocationId: invocationId,
  changeKind: 'CREATED',
  combinationAxisRevision: absentRevision(),
  combinationKey: absentText(),
  evidenceRefs: ['evidence:variant-r1'],
  lifecycleState: 'WORK_IN_PROGRESS',
  productId,
  reason: 'Original form',
  recordedAt: date,
  revision: 1,
  tenantId,
  variantId,
};
const contentRow = {
  actingPrincipalId: productId,
  actionInvocationId: invocationId,
  amount: '6',
  changeKind: 'MATERIAL_CHANGE',
  configurationKey: absentText(),
  effectiveAt: date,
  evidenceRefs: ['evidence:content-r1'],
  lifecycleState: 'ACTIVE',
  lowerCount: absentText(),
  lowerPackageDefinitionId: absentText(),
  lowerRevision: absentRevision(),
  packageDefinitionId: definitionId,
  priorErrorExplanation: absentText(),
  productId,
  reason: 'Original six-pack',
  recordedAt: date,
  revision: 1,
  setCompositionResourceId: absentText(),
  setCompositionRevision: absentRevision(),
  tenantId,
  unitResourceId: productId,
  unitResourceType: 'commerce.catalog.unit',
  variantId,
};
const roleRow = {
  actingPrincipalId: productId,
  actionInvocationId: invocationId,
  contentRevision: 1,
  effectiveAt: date,
  evidenceRefs: ['evidence:role-r2'],
  independentlyRequested: true,
  looseUnitsSubstitutable: false,
  packageDefinitionId: definitionId,
  productId,
  recordedAt: date,
  revision: 2,
  state: 'RETIRED',
  tenantId,
  validationReason: 'Retired without changing historical content',
  variantId,
};

const variantServices = (row: Option.Option<typeof variantRow>) =>
  ({
    getRevision: (_id: string, _revision: number) => Effect.succeed(row),
  }) satisfies ReturnType<typeof variantHistoryForScope>;
const contentServices = (row: Option.Option<typeof contentRow>) =>
  ({
    getContentRevision: (_id: string, _revision: number) => Effect.succeed(row),
  }) satisfies ReturnType<typeof packageHistoryForScope>;
const roleServices = (row: Option.Option<typeof roleRow>) =>
  ({
    getRoleRevision: (_id: string, _revision: number) => Effect.succeed(row),
  }) satisfies ReturnType<typeof packageOptionHistoryForScope>;

describe('exact Catalog form history reads', () => {
  it.effect('returns retained Variant R1 rather than Current R2 and round-trips its provenance', () =>
    Effect.gen(function* returnsVariantHistory() {
      const response = yield* readVariantHistory(variantRequest, tenantId, variantServices(Option.some(variantRow)));
      expect(response.result).toMatchObject({
        changeKind: 'CREATED',
        evidenceRefs: ['evidence:variant-r1'],
        historical: true,
        lifecycle: 'WORK_IN_PROGRESS',
      });
      expect(response.result.reference).toEqual(variantRequest.reference);
      expect(Schema.encodeSync(VariantHistoryResponseSchema)(response.result)).toMatchObject({
        combinationAxisRevision: null,
        combinationKey: null,
        recordedAt: date.toISOString(),
      });
    }),
  );

  it.effect('returns pinned Package content R1, including lower and Set references, not changed Current content', () =>
    Effect.gen(function* returnsPackageContentHistory() {
      const response = yield* readPackageDefinitionHistory(
        contentRequest,
        tenantId,
        contentServices(Option.some(contentRow)),
      );
      expect(response.result).toMatchObject({
        amount: '6',
        evidenceRefs: ['evidence:content-r1'],
        historical: true,
        lowerRevision: Option.none(),
        setCompositionRevision: Option.none(),
      });
      expect(response.result.reference).toEqual(contentRequest.reference);
      expect(Schema.encodeSync(PackageDefinitionHistoryResponseSchema)(response.result)).toMatchObject({
        configurationKey: null,
        lowerCount: null,
        lowerPackageDefinitionId: null,
        lowerRevision: null,
        priorErrorExplanation: null,
        setCompositionResourceId: null,
        setCompositionRevision: null,
      });
    }),
  );

  it.effect('retains populated optional history values on the wire', () =>
    Effect.gen(function* preservesPopulatedOptionals() {
      const variant = yield* readVariantHistory(
        variantRequest,
        tenantId,
        variantServices(Option.some({ ...variantRow, combinationAxisRevision: 2, combinationKey: 'size=large' })),
      );
      expect(Schema.encodeSync(VariantHistoryResponseSchema)(variant.result)).toMatchObject({
        combinationAxisRevision: 2,
        combinationKey: 'size=large',
      });
      const content = yield* readPackageDefinitionHistory(
        contentRequest,
        tenantId,
        contentServices(
          Option.some({
            ...contentRow,
            configurationKey: 'color=red',
            lowerCount: '6',
            lowerPackageDefinitionId: definitionId,
            lowerRevision: 2,
            priorErrorExplanation: 'Corrected count',
            setCompositionResourceId: variantId,
            setCompositionRevision: 3,
          }),
        ),
      );
      expect(Schema.encodeSync(PackageDefinitionHistoryResponseSchema)(content.result)).toMatchObject({
        configurationKey: 'color=red',
        lowerCount: '6',
        lowerPackageDefinitionId: definitionId,
        lowerRevision: 2,
        priorErrorExplanation: 'Corrected count',
        setCompositionResourceId: variantId,
        setCompositionRevision: 3,
      });
    }),
  );

  it.effect('looks up Option role revision independently of its pinned content revision', () =>
    Effect.gen(function* readsOptionRoleRevision() {
      let queriedRevision = 0;
      const services = {
        getRoleRevision: (_id: string, revision: number) => {
          queriedRevision = revision;
          return Effect.succeed(Option.some(roleRow));
        },
      } satisfies ReturnType<typeof packageOptionHistoryForScope>;
      const response = yield* readPackageOptionHistory(roleRequest, tenantId, services);
      expect(queriedRevision).toBe(2);
      expect(response.result).toMatchObject({
        contentRevision: 1,
        evidenceRefs: ['evidence:role-r2'],
        state: 'RETIRED',
      });
      expect(response.result.reference).toEqual(roleRequest.reference);
      expect(() => Schema.encodeSync(PackageOptionHistoryResponseSchema)(response.result)).not.toThrow();
    }),
  );

  it.effect('denies foreign Tenant before querying and returns the same not-found type for absent revisions', () =>
    Effect.gen(function* deniesForeignTenant() {
      const foreign = yield* readVariantHistory(
        variantRequest,
        foreignTenantId,
        variantServices(Option.some(variantRow)),
      ).pipe(Effect.flip);
      const missing = yield* readVariantHistory(variantRequest, tenantId, variantServices(Option.none())).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
      expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
      expect(foreign.reason).toBe(missing.reason);
    }),
  );

  it.effect('maps missing Package content or Option role to not found, not a Current fallback', () =>
    Effect.gen(function* rejectsMissingRevisions() {
      const missingContent = yield* readPackageDefinitionHistory(
        contentRequest,
        tenantId,
        contentServices(Option.none()),
      ).pipe(Effect.flip);
      const missingRole = yield* readPackageOptionHistory(roleRequest, tenantId, roleServices(Option.none())).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(missingContent)).toBe(true);
      expect(Schema.is(ReadHandlerNotFound)(missingRole)).toBe(true);
    }),
  );

  it.effect('fails closed when retained evidence storage is unavailable', () =>
    Effect.gen(function* failsClosedOnStorageError() {
      const unavailableServices = {
        getContentRevision: () =>
          Effect.fail(
            new PackagePersistenceUnavailable({
              code: 'package_persistence_unavailable',
              reason: 'private database detail',
            }),
          ),
      } satisfies ReturnType<typeof packageHistoryForScope>;
      const failure = yield* readPackageDefinitionHistory(contentRequest, tenantId, unavailableServices).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('private database detail');
    }),
  );
});

it('rejects invented revision IDs and ambiguous Option content-only references at the public boundary', () => {
  for (const [schema, reference] of [
    [VariantHistoryRequestSchema, { ...variantRequest.reference, revisionId: invocationId }],
    [PackageDefinitionHistoryRequestSchema, { ...contentRequest.reference, revisionId: invocationId }],
    [PackageOptionHistoryRequestSchema, { ...roleRequest.reference, revisionId: invocationId }],
  ] as const) {
    expect(() => Schema.decodeUnknownSync(schema)({ reference })).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(PackageOptionHistoryRequestSchema)({
      reference: { resourceRef: packageRef, revision: 1 },
    }),
  ).toThrow();
});

it('keeps all three historical endpoints behind current context permission and a sanitized 403', () => {
  for (const [read, schema] of [
    [variantHistoryRead, VariantHistoryForbiddenProblemSchema],
    [packageDefinitionHistoryRead, PackageDefinitionHistoryForbiddenProblemSchema],
    [packageOptionHistoryRead, PackageOptionHistoryForbiddenProblemSchema],
  ] as const) {
    expect(read.descriptor.entrypoint.access).toBe('historical_read');
    expect(read.descriptor.entrypoint.authorization.kind).toBe('context_permission');
    const denial = schema.make({
      detail: 'The principal is not permitted to perform this read.',
      status: 403,
      title: 'Read forbidden',
      type: 'https://ontos.dev/problems/read-forbidden',
    });
    expect(Schema.encodeSync(schema)(denial)).toMatchObject({ status: 403 });
    expect(JSON.stringify(denial)).not.toContain(tenantId);
  }
});
