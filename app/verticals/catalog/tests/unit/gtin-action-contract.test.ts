import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import { mapConfirmGtinActionProblem } from '../../api/confirm-gtin-action-problems.ts';
import { mapCorrectGtinActionProblem } from '../../api/correct-gtin-action-problems.ts';
import { mapMarkGtinUnresolvedActionProblem } from '../../api/mark-gtin-unresolved-action-problems.ts';
import { mapRetireGtinActionProblem } from '../../api/retire-gtin-action-problems.ts';
import { ConfirmGtinPayloadSchema } from '../../shared/actions/confirm-gtin.ts';
import { CorrectGtinPayloadSchema } from '../../shared/actions/correct-gtin.ts';
import { MarkGtinUnresolvedPayloadSchema } from '../../shared/actions/mark-gtin-unresolved.ts';
import { RetireGtinPayloadSchema } from '../../shared/actions/retire-gtin.ts';
import { confirmGtinAction } from '../../src/actions/confirm-gtin.action.ts';
import { correctGtinAction } from '../../src/actions/correct-gtin.action.ts';
import { markGtinUnresolvedAction } from '../../src/actions/mark-gtin-unresolved.action.ts';
import { retireGtinAction } from '../../src/actions/retire-gtin.action.ts';
import { GtinActionInvalid, GtinActionStale } from '../../src/actions/gtin-action-support.ts';
import { GtinPersistenceUnavailable } from '../../src/persistence/gtin-persistence.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';

/* oxlint-disable sonarjs/no-nested-functions -- The typed transaction mock mirrors the snapshot persistence chain for the Action hook. owner: Catalog #478; remove with shared transaction fixture. expires: 2027-03-31. */

const tenantId = '11111111-1111-4111-8111-111111111111';
const variantId = '22222222-2222-4222-8222-222222222222';
const packageDefinitionId = '33333333-3333-4333-8333-333333333333';
const target = { kind: 'VARIANT', tenantId, variantId } as const;
const packageTarget = { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId } as const;
const base = {
  attributionEvidenceRef: 'supplier:gtin-proof',
  code: '4006381333931',
  effectiveAt: '2026-09-17T10:00:00Z',
  reason: 'Verified trade item attribution',
  target,
};

describe('governed GTIN Action contracts', () => {
  it.effect('captures each decoded GTIN success under its exact Action identity', () =>
    Effect.gen(function* capturesGtinResults() {
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:gtin-snapshot-test:run:1',
          authMethod: 'system',
          principalId: '00000000-0000-4000-8000-000000000002',
          tenantId,
        }),
        correlationId: 'gtin-snapshot-test',
      };
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = {
        insert: (table: typeof catalogResultSnapshots) => {
          expect(table).toBe(catalogResultSnapshots);
          return {
            values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
              onConflictDoNothing: () => ({
                returning: () => {
                  rows.push(row);
                  return Effect.succeed([row]);
                },
              }),
            }),
          };
        },
      };
      const invocationId = '00000000-0000-4000-8000-000000000003';
      for (const action of [
        confirmGtinAction,
        correctGtinAction,
        markGtinUnresolvedAction,
        retireGtinAction,
      ] as const) {
        // @ts-expect-error A union of distinct payload schemas cannot satisfy one registration generic.
        const services = yield* getActionServiceFactory(action)(transaction, scope);
        // @ts-expect-error A union of distinct payload schemas cannot satisfy one registration generic.
        const hook = getActionDecodedSuccessHook(action);
        expect(hook).toBeDefined();
        if (hook !== undefined) {
          yield* hook({ actionInvocationId: invocationId, result: { revision: 2 }, scope, services });
        }
      }
      expect(
        rows.map(({ actionKey, encodedResult, schemaVersion }) => ({ actionKey, encodedResult, schemaVersion })),
      ).toEqual([
        { actionKey: 'commerce.catalog.confirm-gtin', encodedResult: { revision: 2 }, schemaVersion: 1 },
        { actionKey: 'commerce.catalog.correct-gtin', encodedResult: { revision: 2 }, schemaVersion: 1 },
        { actionKey: 'commerce.catalog.mark-gtin-unresolved', encodedResult: { revision: 2 }, schemaVersion: 1 },
        { actionKey: 'commerce.catalog.retire-gtin', encodedResult: { revision: 2 }, schemaVersion: 1 },
      ]);
    }),
  );

  it.effect('fails decoded GTIN success when snapshot persistence fails', () =>
    Effect.gen(function* rejectsFailedCapture() {
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:gtin-snapshot-test:run:2',
          authMethod: 'system',
          principalId: '00000000-0000-4000-8000-000000000002',
          tenantId,
        }),
        correlationId: 'gtin-snapshot-failure',
      };
      const transaction = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('database unavailable')) }),
          }),
        }),
      };
      // @ts-expect-error The focused mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(confirmGtinAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(confirmGtinAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const error = yield* Effect.flip(
          hook({
            actionInvocationId: '00000000-0000-4000-8000-000000000004',
            result: { revision: 1 },
            scope,
            services,
          }),
        );
        expect(Schema.is(ActionTransactionError)(error)).toBe(true);
      }
    }),
  );
  it('requires code format, exact target, evidence and revision intent', () => {
    expect(Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({ ...base, expectedRevision: 0 }).target).toEqual(target);
    expect(
      Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({ ...base, expectedRevision: 0, target: packageTarget })
        .target,
    ).toEqual(packageTarget);
    expect(() =>
      Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({ ...base, code: '40063813339', expectedRevision: 0 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({ ...base, attributionEvidenceRef: '', expectedRevision: 0 }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({ ...base, expectedRevision: 1 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConfirmGtinPayloadSchema)({
        ...base,
        expectedRevision: 0,
        target: { ...target, variantId: 'bad' },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CorrectGtinPayloadSchema)({
        ...base,
        expectedRevision: 1,
        previousTarget: target,
        supersededEvidenceRef: 'old:proof',
      }).previousTarget,
    ).toEqual(target);
    expect(() =>
      Schema.decodeUnknownSync(CorrectGtinPayloadSchema)({
        ...base,
        expectedRevision: 0,
        previousTarget: target,
        supersededEvidenceRef: 'old:proof',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CorrectGtinPayloadSchema)({
        ...base,
        expectedRevision: 1,
        supersededEvidenceRef: 'old:proof',
      }),
    ).toThrow();
  });

  it('publishes explicit permission and required idempotency for both writes', () => {
    for (const action of [confirmGtinAction, correctGtinAction, markGtinUnresolvedAction, retireGtinAction]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it('requires exact prior target, revision, and superseded evidence for lifecycle changes', () => {
    const lifecycle = {
      ...base,
      expectedRevision: 1,
      previousTarget: target,
      supersededEvidenceRef: 'supplier:earlier-proof',
    };
    for (const schema of [MarkGtinUnresolvedPayloadSchema, RetireGtinPayloadSchema]) {
      expect(Schema.decodeUnknownSync(schema)(lifecycle).previousTarget).toEqual(target);
      expect(() => Schema.decodeUnknownSync(schema)({ ...lifecycle, expectedRevision: 0 })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ ...lifecycle, supersededEvidenceRef: '' })).toThrow();
      expect(() => Schema.decodeUnknownSync(schema)({ ...lifecycle, previousTarget: null })).toThrow();
    }
  });

  it('maps stale, semantic-invalid and unavailable outcomes to typed problems', () => {
    const stale = mapCorrectGtinActionProblem(new GtinActionStale({ actualRevision: 2, code: 'gtin_action_stale' }));
    const invalid = mapConfirmGtinActionProblem(
      new GtinActionInvalid({ code: 'gtin_action_invalid', reason: 'Unverified target' }),
    );
    const unavailable = mapConfirmGtinActionProblem(
      new GtinPersistenceUnavailable({ code: 'gtin_persistence_unavailable', reason: 'Unavailable' }),
    );
    expect(stale.status).toBe(409);
    expect(invalid.status).toBe(422);
    expect(unavailable.status).toBe(503);
    expect(
      mapMarkGtinUnresolvedActionProblem(new GtinActionStale({ actualRevision: 2, code: 'gtin_action_stale' })).status,
    ).toBe(409);
    expect(
      mapRetireGtinActionProblem(new GtinActionInvalid({ code: 'gtin_action_invalid', reason: 'Unverified target' }))
        .status,
    ).toBe(422);
  });
});
