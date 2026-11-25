import { isDeepStrictEqual } from 'node:util';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionInvocationNotFound,
  ActionInvocationStateError,
  ActionRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogResultSnapshots } from '../../src/database/schema.ts';
import {
  recoverCatalogActionResult,
  recoverCatalogActionResultVersions,
} from '../../src/api/catalog-action-result-recovery.ts';
import { recoverChangeVariantResult } from '../../src/api/change-variant-recovery.read.ts';
import { ConfirmVariantCombinationResultSchema } from '../../shared/actions/confirm-variant-combination.ts';
import { SetProductUnitTargetDivisibilityResultSchema } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { DecideProductTypeUnnecessaryResultSchema } from '../../shared/actions/decide-product-type-unnecessary.ts';
import { ConfirmVariantCombinationRecoveryResponseSchema } from '../../shared/apis/confirm-variant-combination-recovery.ts';
import { SetProductUnitTargetDivisibilityRecoveryResponseSchema } from '../../shared/apis/set-product-unit-target-divisibility-recovery.ts';
import { DecideProductTypeUnnecessaryRecoveryResponseSchema } from '../../shared/apis/decide-product-type-unnecessary-recovery.ts';
import { confirmVariantCombinationRecoveryRead } from '../../src/api/confirm-variant-combination-recovery.read.ts';
import { setProductUnitTargetDivisibilityRecoveryRead } from '../../src/api/set-product-unit-target-divisibility-recovery.read.ts';
import { decideProductTypeUnnecessaryRecoveryRead } from '../../src/api/decide-product-type-unnecessary-recovery.read.ts';
import { BindInitialVariantSourceResultSchema } from '../../shared/actions/bind-initial-variant-source.ts';
import { catalogInitialVariantSourceRecoveryForScope } from '../../src/persistence/catalog-source-correlation.ts';
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
const scopedTransaction = (fixture: ReturnType<typeof transaction>): Parameters<typeof recoverCatalogActionResult>[0] =>
  // @ts-expect-error Focused mock implements only the snapshot select chain.
  fixture.tx;
const recover = (
  tx: ReturnType<typeof transaction>,
  service: ActionRuntimeService,
  expected = identity,
  decoder = codec,
) =>
  recoverCatalogActionResult(scopedTransaction(tx), scope, expected, decoder).pipe(
    Effect.provideService(ActionRuntime, service),
  );

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
      expect(tx.reads).toBe(1);
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

  it.effect('rejects non-object and non-JSON stored results before invoking the owner decoder', () =>
    Effect.gen(function* corruptJsonBoundary() {
      let decodes = 0;
      const decoder = {
        decode: (value: object) => {
          decodes += 1;
          return codec.decode(value);
        },
      };
      for (const encodedResult of [
        null,
        [],
        [{ productId: 'original' }],
        'corrupt',
        42,
        true,
        ...[undefined, Number.NaN, [Number.POSITIVE_INFINITY], () => 'not JSON'].map((invalid) => ({
          invalid,
          productId: 'original',
        })),
      ]) {
        const tx = transaction(snapshot({ encodedResult }));
        const result = yield* recover(
          tx,
          runtime(() => Effect.fail(committed)),
          identity,
          decoder,
        );
        expect(result).toEqual({ status: 'unavailable' });
      }
      expect(decodes).toBe(0);
    }),
  );

  it.effect('retains concrete JSON object receipts, including valid nested JSON values', () =>
    Effect.gen(function* validJsonBoundary() {
      const encodedResult = {
        productId: 'original',
        storageMetadata: { values: [null, true, false, 0, 'text', { revision: 1 }] },
      };
      const before = JSON.stringify(encodedResult);
      expect(
        yield* recover(
          transaction(snapshot({ encodedResult })),
          runtime(() => Effect.fail(committed)),
        ),
      ).toEqual({ result: { productId: 'original' }, status: 'committed' });
      expect(JSON.stringify(encodedResult)).toBe(before);
    }),
  );

  it.effect('infers the concrete initial Variant binding result through the decoder-only recovery factory', () =>
    Effect.gen(function* bindingResultInference() {
      const original = {
        changed: true,
        originalCreateInvocationId: identity.actionInvocationId,
        productId: productRef.resourceId,
        variantId: variantRef.resourceId,
      };
      const tx = transaction(
        snapshot({ actionKey: 'commerce.catalog.bind-initial-variant-source', encodedResult: original }),
      );
      const service = catalogInitialVariantSourceRecoveryForScope(scopedTransaction(tx), scope);
      const outcome = yield* service.recover(identity.actionInvocationId).pipe(
        Effect.provideService(
          ActionRuntime,
          runtime(() => Effect.fail(committed)),
        ),
      );
      const encoded = yield* Match.value(outcome).pipe(
        Match.when({ status: 'committed' }, ({ result }) =>
          Schema.encodeEffect(BindInitialVariantSourceResultSchema)(result),
        ),
        Match.orElse(() => Effect.die('Expected the committed binding receipt')),
      );
      expect(encoded).toEqual(original);
      expect(tx.reads).toBe(1);
    }),
  );
});

const unitRef = {
  ...productRef,
  resourceId: '00000000-0000-4000-8000-000000000012',
  resourceType: 'commerce.catalog.product-unit',
};
type RecoveryTransaction = Parameters<typeof recoverCatalogActionResult>[0];
interface ReceiptCase {
  readonly actionKey: string;
  readonly current: Schema.ConstraintDecoder<unknown>;
  readonly original: object;
  readonly recover: (tx: RecoveryTransaction) => Effect.Effect<unknown, unknown, ActionRuntime>;
  readonly response: Schema.ConstraintCodec<unknown, unknown>;
}
const receiptCases: readonly ReceiptCase[] = [
  {
    actionKey: 'commerce.catalog.confirm-variant-combination',
    current: ConfirmVariantCombinationResultSchema,
    original: {
      combinationAxisRevision: 1,
      combinationKey: 'a'.repeat(64),
      variant: { ...changeVariantResult.variant, lifecycle: 'ACTIVE' },
    },
    recover: (tx: RecoveryTransaction) =>
      getReadServiceFactory(confirmVariantCombinationRecoveryRead)(tx, scope, 'a'.repeat(64)).pipe(
        Effect.flatMap((services) => services.recover(identity.actionInvocationId)),
      ),
    response: ConfirmVariantCombinationRecoveryResponseSchema,
  },
  {
    actionKey: 'commerce.catalog.set-product-unit-target-divisibility',
    current: SetProductUnitTargetDivisibilityResultSchema,
    original: { ruleRevision: { revision: 1, rounding: 'UP', step: '1', unit: unitRef }, unit: unitRef },
    recover: (tx: RecoveryTransaction) =>
      getReadServiceFactory(setProductUnitTargetDivisibilityRecoveryRead)(tx, scope, 'a'.repeat(64)).pipe(
        Effect.flatMap((services) => services.recover(identity.actionInvocationId)),
      ),
    response: SetProductUnitTargetDivisibilityRecoveryResponseSchema,
  },
  {
    actionKey: 'commerce.catalog.decide-product-type-unnecessary',
    current: DecideProductTypeUnnecessaryResultSchema,
    original: { decisionRevision: 1, decisionState: 'CONFIRMED', productRef },
    recover: (tx: RecoveryTransaction) =>
      getReadServiceFactory(decideProductTypeUnnecessaryRecoveryRead)(tx, scope, 'a'.repeat(64)).pipe(
        Effect.flatMap((services) => services.recover(identity.actionInvocationId)),
      ),
    response: DecideProductTypeUnnecessaryRecoveryResponseSchema,
  },
];

for (const receiptCase of receiptCases) {
  const recoverReceipt = (
    row: typeof catalogResultSnapshots.$inferSelect,
    service = runtime(() => Effect.fail(committed)),
  ) => {
    const tx = transaction(row);
    return receiptCase
      .recover(
        // @ts-expect-error The focused transaction only reads immutable owner snapshots.
        tx.tx,
      )
      .pipe(Effect.provideService(ActionRuntime, service));
  };
  const row = (encodedResult: object) => snapshot({ actionKey: receiptCase.actionKey, encodedResult });

  describe(`${receiptCase.actionKey} owner recovery receipt`, () => {
    it.effect('returns the exact historical receipt without inventing execution or revision proof', () =>
      Effect.gen(function* historicalReceipt() {
        const stored = row(receiptCase.original);
        const before = JSON.stringify(stored);
        const expected = { _tag: 'HistoricalReceipt', executionProof: 'NOT_RECORDED', original: receiptCase.original };
        expect(yield* recoverReceipt(stored)).toEqual({ result: expected, status: 'committed' });
        expect(isDeepStrictEqual(Schema.decodeUnknownSync(receiptCase.response)(expected), expected)).toBe(true);
        expect(isDeepStrictEqual(Schema.encodeUnknownSync(receiptCase.response)(expected), expected)).toBe(true);
        expect(Object.hasOwn(expected.original, 'changed')).toBe(false);
        expect(Object.hasOwn(expected.original, 'variantRevision')).toBe(false);
        expect(JSON.stringify(stored)).toBe(before);
        if (receiptCase.actionKey === 'commerce.catalog.confirm-variant-combination') {
          const original = { ...receiptCase.original, variantRevision: 7 };
          expect(yield* recoverReceipt(row(original))).toEqual({
            result: { _tag: 'HistoricalReceipt', executionProof: 'NOT_RECORDED', original },
            status: 'committed',
          });
        }
      }),
    );

    it.effect('wraps strict current results with their exact true or false disposition', () =>
      Effect.gen(function* currentReceipts() {
        expect(() => Schema.decodeUnknownSync(receiptCase.current)(receiptCase.original)).toThrow();
        for (const changed of [true, false]) {
          const result = { ...receiptCase.original, changed };
          const expected = { _tag: 'CurrentReceipt', result };
          expect(yield* recoverReceipt(row(result))).toEqual({ result: expected, status: 'committed' });
          expect(isDeepStrictEqual(Schema.decodeUnknownSync(receiptCase.response)(expected), expected)).toBe(true);
          expect(() =>
            Schema.decodeUnknownSync(receiptCase.response)({
              _tag: 'HistoricalReceipt',
              executionProof: 'NOT_RECORDED',
              original: result,
            }),
          ).toThrow();
          expect(() =>
            Schema.decodeUnknownSync(receiptCase.response)({ _tag: 'CurrentReceipt', result: receiptCase.original }),
          ).toThrow();
        }
      }),
    );

    it.effect('never treats a present malformed changed field as a historical receipt', () =>
      Effect.gen(function* corruptDisposition() {
        expect(yield* recoverReceipt(row({}))).toEqual({ status: 'unavailable' });
        expect(yield* recoverReceipt(row({ ...receiptCase.original, unexpected: 'must not be stripped' }))).toEqual({
          status: 'unavailable',
        });
        for (const changed of [undefined, null, 'false', 0, {}]) {
          const corrupt = { ...receiptCase.original, changed };
          expect(yield* recoverReceipt(row(corrupt))).toEqual({ status: 'unavailable' });
          expect(() =>
            Schema.decodeUnknownSync(receiptCase.response)({
              _tag: 'HistoricalReceipt',
              executionProof: 'NOT_RECORDED',
              original: corrupt,
            }),
          ).toThrow();
        }
      }),
    );

    it.effect('retains principal, action, snapshot identity, and Core commit proof boundaries', () =>
      Effect.gen(function* receiptAuthority() {
        const original = row(receiptCase.original);
        expect(
          yield* recoverReceipt({ ...original, actingPrincipalId: '00000000-0000-4000-8000-000000000099' }),
        ).toEqual({ status: 'absent' });
        expect(yield* recoverReceipt({ ...original, actionKey: 'commerce.catalog.other' })).toEqual({
          status: 'absent',
        });
        expect(yield* recoverReceipt({ ...original, tenantId: '00000000-0000-4000-8000-000000000099' })).toEqual({
          status: 'unavailable',
        });
        expect(
          yield* recoverReceipt({ ...original, actionInvocationId: '00000000-0000-4000-8000-000000000099' }),
        ).toEqual({ status: 'unavailable' });
        expect(yield* recoverReceipt({ ...original, schemaVersion: 2 })).toEqual({ status: 'unavailable' });

        expect(
          yield* recoverReceipt(
            original,
            runtime(() =>
              Effect.fail(new ActionInvocationNotFound({ code: 'action_invocation_not_found', reason: 'absent' })),
            ),
          ),
        ).toEqual({ status: 'absent' });
      }),
    );
  });
}
