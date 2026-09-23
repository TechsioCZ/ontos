import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  assertSizeEquivalenceAction,
  AssertSizeEquivalencePayloadSchema,
  handleAssertSizeEquivalence,
} from '../../src/actions/assert-size-equivalence.action.ts';
import {
  handleReplaceProductSizes,
  ReplaceProductSizesPayloadSchema,
  replaceProductSizesAction,
} from '../../src/actions/replace-product-sizes.action.ts';
import { SizePersistenceConflict } from '../../src/persistence/size-usage-persistence.ts';
import type { SizeUsagePersistence } from '../../src/persistence/size-usage-persistence.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const ref = (resourceType: string, resourceId: string, tenant = tenantId) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId: tenant,
});
const productRef = ref('commerce.catalog.product', '33333333-3333-4333-8333-333333333333');
const sizeM = ref('commerce.catalog.controlled-attribute-value', '44444444-4444-4444-8444-444444444444');
const size42 = ref('commerce.catalog.controlled-attribute-value', '55555555-5555-4555-8555-555555555555');
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:size-actions:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'size-action-test',
};
const unexpected = () => Effect.die('Unexpected persistence call');
const context = (overrides: Partial<SizeUsagePersistence> = {}) => {
  const audits: unknown[] = [];
  const accesses: unknown[] = [];
  const handler: ActionHandlerContext<Readonly<Record<string, never>>, SizeUsagePersistence> = {
    actionInvocationId: '77777777-7777-4777-8777-777777777777',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: (value) =>
      Effect.sync(() => {
        audits.push(value);
      }),
    recordDataAccess: (value) =>
      Effect.sync(() => {
        accesses.push(value);
      }),
    scope,
    services: { assertEquivalence: unexpected, read: unexpected, replace: unexpected, ...overrides },
  };
  return { accesses, audits, handler };
};

describe('governed Size Actions', () => {
  it.effect('captures each decoded success in the supplied transaction with its declared identity', () =>
    Effect.gen(function* capturesSizeResults() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = {
        insert: (table: typeof catalogResultSnapshots) => {
          expect(table).toBe(catalogResultSnapshots);
          return {
            values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
              onConflictDoNothing: () => ({
                // oxlint-disable-next-line sonarjs/no-nested-functions -- Drizzle mock requires this fluent callback; remove-when: snapshot tests use a shared transaction fixture.
                returning: () => {
                  rows.push(row);
                  return Effect.succeed([row]);
                },
              }),
            }),
          };
        },
      };
      // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
      const assertionServices = yield* getActionServiceFactory(assertSizeEquivalenceAction)(transaction, scope);
      const assertionHook = getActionDecodedSuccessHook(assertSizeEquivalenceAction);
      expect(assertionHook).toBeDefined();
      if (assertionHook !== undefined) {
        yield* assertionHook({
          actionInvocationId: '77777777-7777-4777-8777-777777777777',
          result: { assertionId: '88888888-8888-4888-8888-888888888888' },
          scope,
          services: assertionServices,
        });
      }
      // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
      const replacementServices = yield* getActionServiceFactory(replaceProductSizesAction)(transaction, scope);
      const replacementHook = getActionDecodedSuccessHook(replaceProductSizesAction);
      expect(replacementHook).toBeDefined();
      if (replacementHook !== undefined) {
        yield* replacementHook({
          actionInvocationId: '77777777-7777-4777-8777-777777777777',
          result: { revision: 3 },
          scope,
          services: replacementServices,
        });
      }
      expect(
        rows.map((row) => ({
          actionKey: row.actionKey,
          encodedResult: row.encodedResult,
          schemaVersion: row.schemaVersion,
        })),
      ).toEqual([
        {
          actionKey: 'commerce.catalog.assert-size-equivalence',
          encodedResult: { assertionId: '88888888-8888-4888-8888-888888888888' },
          schemaVersion: 1,
        },
        { actionKey: 'commerce.catalog.replace-product-sizes', encodedResult: { revision: 3 }, schemaVersion: 1 },
      ]);
    }),
  );

  it.effect('fails the decoded-success hook when snapshot storage fails', () =>
    Effect.gen(function* rejectsSnapshotFailure() {
      const transaction = {
        insert: () => ({
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Drizzle mock requires this fluent callback; remove-when: snapshot tests use a shared transaction fixture.
          values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('unavailable')) }) }),
        }),
      };
      // @ts-expect-error Focused transaction mock implements only the failing snapshot insert chain.
      const assertionServices = yield* getActionServiceFactory(assertSizeEquivalenceAction)(transaction, scope);
      const assertionHook = getActionDecodedSuccessHook(assertSizeEquivalenceAction);
      expect(assertionHook).toBeDefined();
      if (assertionHook !== undefined) {
        const failure = yield* Effect.flip(
          assertionHook({
            actionInvocationId: '77777777-7777-4777-8777-777777777777',
            result: { assertionId: '88888888-8888-4888-8888-888888888888' },
            scope,
            services: assertionServices,
          }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
      // @ts-expect-error Focused transaction mock implements only the failing snapshot insert chain.
      const replacementServices = yield* getActionServiceFactory(replaceProductSizesAction)(transaction, scope);
      const replacementHook = getActionDecodedSuccessHook(replaceProductSizesAction);
      expect(replacementHook).toBeDefined();
      if (replacementHook !== undefined) {
        const failure = yield* Effect.flip(
          replacementHook({
            actionInvocationId: '77777777-7777-4777-8777-777777777777',
            result: { revision: 3 },
            scope,
            services: replacementServices,
          }),
        );
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );
  it.effect('preserves local order and revision CAS with trusted actor and evidence', () =>
    Effect.gen(function* replaceSizes() {
      const payload = Schema.decodeUnknownSync(ReplaceProductSizesPayloadSchema)({
        evidenceRefs: ['catalog-range-2026'],
        expectedRevision: 2,
        list: { orderedSizeRefs: [size42, sizeM], productRef },
        reason: 'Product range confirmed',
      });
      const { accesses, audits, handler } = context({
        replace: (input) =>
          Effect.sync(() => {
            expect(input.actionInvocationId).toBe(handler.actionInvocationId);
            expect(input.principalId).toBe(scope.principalId);
            expect(input.expectedRevision).toBe(2);
            expect(input.list.orderedSizeRefs.map((item) => item.resourceId)).toEqual([
              size42.resourceId,
              sizeM.resourceId,
            ]);
            return 3;
          }),
      });
      expect(yield* handleReplaceProductSizes(payload, handler)).toEqual({ revision: 3 });
      expect(audits).toEqual([{ evidenceRefs: ['catalog-range-2026'], reason: 'Product range confirmed' }]);
      expect(accesses).toHaveLength(1);
    }),
  );

  it.effect('passes only evidenced scoped assertions through persistence', () =>
    Effect.gen(function* assertEquivalence() {
      const payload = Schema.decodeUnknownSync(AssertSizeEquivalencePayloadSchema)({
        assertion: {
          evidence: 'manufacturer-chart-2026',
          leftSizeRef: sizeM,
          rightSizeRef: size42,
          scope: 'Line A, 2026',
        },
        reason: 'Manufacturer chart reviewed',
      });
      const { audits, handler } = context({
        assertEquivalence: (input) =>
          Effect.sync(() => {
            expect(input.actionInvocationId).toBe(handler.actionInvocationId);
            expect(input.principalId).toBe(scope.principalId);
            expect(input.assertion.scope).toBe('Line A, 2026');
            return '88888888-8888-4888-8888-888888888888';
          }),
      });
      expect(yield* handleAssertSizeEquivalence(payload, handler)).toEqual({
        assertionId: '88888888-8888-4888-8888-888888888888',
      });
      expect(audits).toEqual([{ evidenceRefs: ['manufacturer-chart-2026'], reason: 'Manufacturer chart reviewed' }]);
    }),
  );

  it.effect('rejects cross-tenant references before persistence and preserves typed CAS failures', () =>
    Effect.gen(function* rejectInvalidSizes() {
      const foreign = Schema.decodeUnknownSync(ReplaceProductSizesPayloadSchema)({
        evidenceRefs: [],
        expectedRevision: 0,
        list: {
          orderedSizeRefs: [],
          productRef: ref('commerce.catalog.product', productRef.resourceId, otherTenantId),
        },
        reason: 'Range reviewed',
      });
      const invalid = yield* handleReplaceProductSizes(foreign, context().handler).pipe(Effect.flip);
      expect(invalid).toMatchObject({ conflict: 'INVALID_INPUT' });
      const valid = Schema.decodeUnknownSync(ReplaceProductSizesPayloadSchema)({
        evidenceRefs: [],
        expectedRevision: 1,
        list: { orderedSizeRefs: [sizeM], productRef },
        reason: 'Range reviewed',
      });
      const stale = yield* handleReplaceProductSizes(
        valid,
        context({
          replace: () =>
            Effect.fail(
              new SizePersistenceConflict({
                code: 'size_persistence_conflict',
                conflict: 'REVISION',
                reason: 'Changed',
              }),
            ),
        }).handler,
      ).pipe(Effect.flip);
      expect(stale).toMatchObject({ conflict: 'REVISION' });
    }),
  );

  it('requires explicit evidence, scoped equivalence, and protected idempotent entrypoints', () => {
    expect(() =>
      Schema.decodeUnknownSync(AssertSizeEquivalencePayloadSchema)({
        assertion: { evidence: '', leftSizeRef: sizeM, rightSizeRef: size42, scope: '' },
        reason: 'Reviewed',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ReplaceProductSizesPayloadSchema)({
        evidenceRefs: [],
        expectedRevision: 0,
        list: { orderedSizeRefs: [sizeM, sizeM], productRef },
        reason: 'Reviewed',
      }),
    ).toThrow();
    for (const action of [replaceProductSizesAction, assertSizeEquivalenceAction]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
    }
  });
});
