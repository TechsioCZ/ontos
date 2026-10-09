import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionInvocationNotFound,
  ActionInvocationStateError,
  ActionRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogResultSnapshots } from '../../src/database/schema.ts';
import {
  recoverCatalogActionResult,
  recoverCatalogActionResultVersions,
} from '../../src/api/catalog-action-result-recovery.ts';
import { recoverChangeVariantResult } from '../../src/api/change-variant-recovery.read.ts';
/* oxlint-disable anti-slop/no-object-parameters, sonarjs/no-nested-functions -- Typed codec and scoped transaction mock require these shapes. owner: Catalog #478; expires: 2027-03-31. */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const identity = {
  actionInvocationId: '00000000-0000-4000-8000-000000000003',
  actionKey: 'commerce.catalog.create-product',
  schemaVersion: 1,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:recovery-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'recovery-test',
};
const codec = {
  decode: (value: object) =>
    Schema.decodeUnknownEffect(Schema.Struct({ productId: Schema.String.pipe(Schema.brand('ProductId')) }))(value),
  encode: (value: { readonly productId: string }) => Effect.succeed(value),
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000010',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000011',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const changeVariantResult = {
  decision: {
    classification: 'EVIDENCED_RECORD_CORRECTION',
    evidenceRefs: ['drawing'],
    reason: 'Correct wrong record',
    variantRef,
  },
  variant: {
    lifecycle: 'WORK_IN_PROGRESS',
    productRef,
    variantId: variantRef.resourceId,
    variantRef,
  },
} as const;

const committed = new ActionAlreadyCommitted({
  code: 'action_already_committed',
  invocationId: identity.actionInvocationId,
  reason: 'committed',
});
const runtime = (resolution: ActionRuntimeService['resolveActionCommit']): ActionRuntimeService => ({
  resolveActionCommit: resolution,
  runAction: () => Effect.die('unused'),
});
const transaction = (row?: typeof catalogResultSnapshots.$inferSelect) => {
  let reads = 0;
  const tx = {
    select: () => ({
      from: (table: typeof catalogResultSnapshots) => {
        expect(table).toBe(catalogResultSnapshots);
        return {
          where: () => ({
            limit: () => {
              reads += 1;
              return Effect.succeed(row ? [row] : []);
            },
          }),
        };
      },
    }),
  };
  return {
    get reads() {
      return reads;
    },
    tx,
  };
};
const snapshot = (overrides: Partial<typeof catalogResultSnapshots.$inferSelect> = {}) => ({
  actingPrincipalId: principalId,
  actionInvocationId: identity.actionInvocationId,
  actionKey: identity.actionKey,
  encodedResult: { productId: 'original' },
  recordedAt: new Date('2026-09-17T10:00:00.000Z'),
  schemaVersion: 1,
  tenantId,
  ...overrides,
});
const recover = (tx: ReturnType<typeof transaction>, service: ActionRuntimeService, expected = identity) =>
  recoverCatalogActionResult(
    // @ts-expect-error Focused mock implements only the snapshot select chain.
    tx.tx,
    scope,
    expected,
    codec,
  ).pipe(Effect.provideService(ActionRuntime, service));

describe('Catalog Action result recovery', () => {
  it.effect('uses the current snapshot version and only falls back when it is unavailable', () =>
    Effect.gen(function* versionedRecovery() {
      const currentCalls: number[] = [];
      const current = yield* recoverCatalogActionResultVersions([3, 2, 1], (schemaVersion) => {
        currentCalls.push(schemaVersion);
        return Effect.succeed({ result: { productId: 'current' }, status: 'committed' } as const);
      });
      expect(current).toEqual({ result: { productId: 'current' }, status: 'committed' });
      expect(currentCalls).toEqual([3]);

      const legacyCalls: number[] = [];
      const legacy = yield* recoverCatalogActionResultVersions([3, 2, 1], (schemaVersion) => {
        legacyCalls.push(schemaVersion);
        return Effect.succeed(
          schemaVersion === 2
            ? ({ result: { productId: 'legacy' }, status: 'committed' } as const)
            : ({ status: 'unavailable' } as const),
        );
      });
      expect(legacy).toEqual({ result: { productId: 'legacy' }, status: 'committed' });
      expect(legacyCalls).toEqual([3, 2]);
    }),
  );

  it.effect('recovers the exact Change Variant decision from current and legacy snapshots', () =>
    Effect.gen(function* versionedChangeVariantRecovery() {
      const service = runtime(() => Effect.fail(committed));
      const recovered = yield* Effect.forEach([2, 1], (schemaVersion) => {
        const tx = transaction(
          snapshot({
            actionKey: 'commerce.catalog.change-variant',
            encodedResult: changeVariantResult,
            schemaVersion,
          }),
        );
        return recoverChangeVariantResult(
          // @ts-expect-error Focused mock implements only the snapshot select chain.
          tx.tx,
          scope,
          identity.actionInvocationId,
        ).pipe(Effect.provideService(ActionRuntime, service));
      });
      expect(recovered).toEqual([
        { result: changeVariantResult, status: 'committed' },
        { result: changeVariantResult, status: 'committed' },
      ]);
    }),
  );

  it.effect('rejects malformed identity before resolving a Core invocation or reading owner data', () =>
    Effect.gen(function* malformedIdentity() {
      const tx = transaction(snapshot());
      let resolutions = 0;
      const service = runtime(() => {
        resolutions += 1;
        return Effect.fail(committed);
      });
      expect(yield* recover(tx, service, { ...identity, actionKey: ' commerce.catalog.create-product' })).toEqual({
        status: 'absent',
      });
      expect(resolutions).toBe(0);
      expect(tx.reads).toBe(0);
    }),
  );
  it.effect('decodes the original snapshot only after Core confirms the commit', () =>
    Effect.gen(function* committedResult() {
      const tx = transaction(snapshot());
      expect(
        yield* recover(
          tx,
          runtime(() => Effect.fail(committed)),
        ),
      ).toEqual({ result: { productId: 'original' }, status: 'committed' });
      expect(tx.reads).toBe(2);
    }),
  );

  it.effect('keeps open, rejected, absent, and indeterminate Core outcomes distinct without reading owner data', () =>
    Effect.gen(function* unresolvedResults() {
      const cases = [
        [Effect.succeed({ _tag: 'ActionCommitOpen' as const, invocationId: identity.actionInvocationId }), 'open'],
        [
          Effect.fail(new ActionInvocationStateError({ code: 'action_invocation_state_invalid', reason: 'rejected' })),
          'rejected',
        ],
        [
          Effect.fail(new ActionInvocationNotFound({ code: 'action_invocation_not_found', reason: 'absent' })),
          'absent',
        ],
        [
          Effect.fail(
            new ActionCommitIndeterminate({
              code: 'action_commit_indeterminate',
              invocationId: identity.actionInvocationId,
              reason: 'unknown',
            }),
          ),
          'indeterminate',
        ],
      ] as const;
      for (const [resolution, tag] of cases) {
        const tx = transaction(snapshot());
        expect(
          (yield* recover(
            tx,
            // @ts-expect-error The focused table intentionally combines each Core outcome member.
            runtime(() => resolution),
          )).status,
        ).toBe(tag);
        expect(tx.reads).toBe(0);
      }
    }),
  );

  it.effect(
    'does not disclose wrong action or principal; missing and corrupt committed snapshots remain unavailable',
    () =>
      Effect.gen(function* safeAbsence() {
        const service = runtime(() => Effect.fail(committed));
        expect(yield* recover(transaction(snapshot({ actionKey: 'commerce.catalog.other' })), service)).toEqual({
          status: 'absent',
        });
        expect(
          yield* recover(transaction(snapshot({ actingPrincipalId: '00000000-0000-4000-8000-000000000099' })), service),
        ).toEqual({ status: 'absent' });
        expect(yield* recover(transaction(), service)).toEqual({ status: 'unavailable' });
        expect(yield* recover(transaction(snapshot({ encodedResult: { wrong: true } })), service)).toEqual({
          status: 'unavailable',
        });
      }),
  );
});
