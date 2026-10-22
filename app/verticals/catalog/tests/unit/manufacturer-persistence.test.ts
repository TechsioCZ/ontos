import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SetProductManufacturerPayloadSchema } from '../../shared/actions/manufacturer-mutations.ts';
import {
  ManufacturerPersistenceUnavailable,
  manufacturerPersistenceForScope,
} from '../../src/persistence/manufacturer-persistence.ts';
import { manufacturerRelationRevisions, manufacturerRelations, products } from '../../src/database/schema.ts';
import type { productVariants } from '../../src/database/schema.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const relationId = '33333333-3333-4333-8333-333333333333';
const subject = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const target = {
  kind: 'LEGAL_ENTITY',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:manufacturer-persistence-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'manufacturer-persistence-test',
};
const evidence = { actionInvocationId: '55555555-5555-4555-8555-555555555555', principalId };
const payload = {
  effectivePeriod: {},
  evidenceRefs: ['manufacturer-declaration'] as const,
  reason: 'Source declaration verified',
  relationId,
  subject,
  target,
};
const setPayload = Schema.decodeUnknownSync(SetProductManufacturerPayloadSchema)(payload);
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'requested-maker-id',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const partyPayload = Schema.decodeUnknownSync(SetProductManufacturerPayloadSchema)({
  ...payload,
  target: {
    kind: 'PARTY',
    partyRef,
  },
});
const query = <A>(rows: readonly A[]) => {
  const builder = {
    for: () => builder,
    limit: () => Effect.succeed(rows),
    orderBy: () => builder,
    pipe: () => Effect.succeed(rows),
    where: () => builder,
  };
  return builder;
};
const readonlyQuery = <A>(rows: readonly A[]) => {
  const builder = {
    for: () => {
      throw new Error('history must not acquire a row lock');
    },
    limit: () => Effect.succeed(rows),
    orderBy: () => builder,
    pipe: () => Effect.succeed(rows),
    where: () => builder,
  };
  return builder;
};
type TestTable =
  | typeof manufacturerRelations
  | typeof manufacturerRelationRevisions
  | typeof products
  | typeof productVariants;
describe('Manufacturer persistence owner verification', () => {
  it.effect('stores only the owner-confirmed canonical opaque Party identity', () =>
    Effect.gen(function* testCanonicalPartyPersistence() {
      const writes: { table: TestTable; targetId: string | undefined }[] = [];
      const row = {
        actionInvocationId: evidence.actionInvocationId,
        createdAt: new Date('2026-09-17T00:00:00.000Z'),
        currentRevision: 1,
        disposition: 'CONFIRMED',
        effectiveFrom: null,
        effectiveTo: null,
        evidenceRefs: [...partyPayload.evidenceRefs],
        productId: subject.resourceId,
        reason: partyPayload.reason,
        relationId,
        targetId: 'canonical-maker-id',
        targetKind: 'PARTY',
        tenantId,
        updatedAt: new Date('2026-09-17T00:00:00.000Z'),
        variantId: null,
      };
      const transaction = {
        insert: (table: TestTable) => ({
          values: (value: { targetId?: string }) => {
            writes.push({ table, targetId: value.targetId });
            return { pipe: () => Effect.succeed([]), returning: () => query([row]) };
          },
        }),
        select: () => ({
          from: (table: TestTable) => query(table === products ? [{}] : []),
        }),
      };
      const resolver = {
        resolve: () =>
          Effect.succeed({
            canonicalTarget: { kind: 'PARTY' as const, partyRef: { ...partyRef, resourceId: 'canonical-maker-id' } },
            kind: 'PARTY' as const,
            ownerRevision: 3,
            requestedTarget: { kind: 'PARTY' as const, partyRef },
            state: 'ALIAS' as const,
          }),
      };
      // @ts-expect-error Minimal database double exercises only the persistence query surface.
      const service = manufacturerPersistenceForScope(transaction, scope);
      const outcome = yield* service.set({ ...evidence, payload: partyPayload }, yield* resolver.resolve());
      expect(outcome).toMatchObject({ relationId, revision: 1 });
      expect(writes).toEqual([
        { table: manufacturerRelations, targetId: 'canonical-maker-id' },
        { table: manufacturerRelationRevisions, targetId: 'canonical-maker-id' },
      ]);
    }),
  );

  it.effect('stores an active managed Legal Entity only with injected owner proof', () =>
    Effect.gen(function* testManagedLegalEntityPersistence() {
      const writes: { table: TestTable; targetId: string | undefined; targetKind: string | undefined }[] = [];
      const legalEntityTarget = setPayload.target;
      if (legalEntityTarget.kind !== 'LEGAL_ENTITY') {
        throw new Error('Expected Legal Entity fixture');
      }
      const row = {
        currentRevision: 1,
        disposition: 'CONFIRMED',
        effectiveFrom: null,
        effectiveTo: null,
        evidenceRefs: [...setPayload.evidenceRefs],
        productId: subject.resourceId,
        reason: setPayload.reason,
        relationId,
        targetId: legalEntityTarget.legalEntityRef.resourceId,
        targetKind: 'LEGAL_ENTITY',
        tenantId,
        variantId: null,
      };
      const transaction = {
        insert: (table: TestTable) => ({
          values: (value: { targetId?: string; targetKind?: string }) => {
            writes.push({ table, targetId: value.targetId, targetKind: value.targetKind });
            return { pipe: () => Effect.succeed([]), returning: () => query([row]) };
          },
        }),
        select: () => ({ from: (table: TestTable) => query(table === products ? [{}] : []) }),
      };
      const resolver = {
        resolve: () =>
          Effect.succeed({
            canonicalTarget: legalEntityTarget,
            kind: 'LEGAL_ENTITY' as const,
            lifecycleStatus: 'active' as const,
            requestedTarget: legalEntityTarget,
            state: 'CURRENT' as const,
          }),
      };
      // @ts-expect-error Minimal transaction double proves the scoped write shape.
      const service = manufacturerPersistenceForScope(transaction, scope);
      const outcome = yield* service.set({ ...evidence, payload: setPayload }, yield* resolver.resolve());
      expect(outcome).toMatchObject({ relationId, revision: 1 });
      expect(writes).toEqual([
        {
          table: manufacturerRelations,
          targetId: legalEntityTarget.legalEntityRef.resourceId,
          targetKind: 'LEGAL_ENTITY',
        },
        {
          table: manufacturerRelationRevisions,
          targetId: legalEntityTarget.legalEntityRef.resourceId,
          targetKind: 'LEGAL_ENTITY',
        },
      ]);
    }),
  );

  it.effect('rejects suspended managed Legal Entity before database access', () =>
    Effect.gen(function* testSuspendedManagedLegalEntity() {
      const { target: legalEntityTarget } = setPayload;
      if (legalEntityTarget.kind !== 'LEGAL_ENTITY') {
        throw new Error('Expected Legal Entity fixture');
      }
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: () => {
          throw new Error('must not query');
        },
      };
      const resolver = {
        resolve: () =>
          Effect.succeed({
            canonicalTarget: legalEntityTarget,
            kind: 'LEGAL_ENTITY' as const,
            lifecycleStatus: 'suspended' as const,
            requestedTarget: legalEntityTarget,
            state: 'SUSPENDED' as const,
          }),
      };
      // @ts-expect-error Incomplete transaction proves a rejected target never reaches storage.
      const service = manufacturerPersistenceForScope(transaction, scope);
      const outcome = yield* service.set({ ...evidence, payload: setPayload }, yield* resolver.resolve());
      expect(Schema.is(Schema.TaggedStruct('invalid_change', {}))(outcome)).toBe(true);
    }),
  );

  it.effect('reads exact history without row locks or a Current fallback', () =>
    Effect.gen(function* testLockFreeExactHistory() {
      const relation = { currentRevision: 1, productId: subject.resourceId, variantId: null };
      const revision = {
        disposition: 'CONFIRMED',
        effectiveFrom: null,
        effectiveTo: null,
        evidenceRefs: ['manufacturer-declaration'],
        reason: 'Source declaration verified',
        recordedAt: new Date('2026-09-17T00:00:00.000Z'),
        relationId,
        revision: 1,
        targetId: 'canonical-maker-id',
        targetKind: 'PARTY',
        tenantId,
      };
      const transaction = {
        select: () => ({
          from: (table: TestTable) =>
            table === manufacturerRelations ? readonlyQuery([relation]) : readonlyQuery([revision]),
        }),
      };
      // @ts-expect-error Minimal read-only transaction double exercises only the history query shape.
      const service = manufacturerPersistenceForScope(transaction, scope);
      const value = yield* service.history(relationId, subject);
      expect(Option.isSome(value)).toBe(true);
      if (Option.isSome(value)) {
        expect(value.value[0]?.target).toMatchObject({ kind: 'PARTY', partyRef: { resourceId: 'canonical-maker-id' } });
        expect(value.value[0]?.revision).toBe(1);
      }
      relation.currentRevision = 2;
      const failure = yield* Effect.flip(service.history(relationId, subject));
      expect(Schema.is(ManufacturerPersistenceUnavailable)(failure)).toBe(true);
    }),
  );
});
