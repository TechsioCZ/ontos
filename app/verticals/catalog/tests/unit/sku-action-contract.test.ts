import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { AssignSkuPayloadSchema } from '../../shared/actions/assign-sku.ts';
import { RenameSkuPayloadSchema } from '../../shared/actions/rename-sku.ts';
import { CorrectSkuPayloadSchema } from '../../shared/actions/correct-sku.ts';
import { assignSkuAction } from '../../src/actions/assign-sku.action.ts';
import { renameSkuAction } from '../../src/actions/rename-sku.action.ts';
import { correctSkuAction } from '../../src/actions/correct-sku.action.ts';
import { SkuActionConflict, SkuActionErrorSchema, SkuActionStale } from '../../src/actions/sku-action-support.ts';
import { SkuActionInvalid } from '../../src/actions/sku-action-invalid.ts';
import { SkuActionNotFound } from '../../src/actions/sku-action-not-found.ts';
import { SkuPersistenceUnavailable } from '../../src/persistence/sku-persistence.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import { mapAssignSkuActionProblem } from '../../api/assign-sku-action-problems.ts';
import { mapCorrectSkuActionProblem } from '../../api/correct-sku-action-problems.ts';
import { mapRenameSkuActionProblem } from '../../api/rename-sku-action-problems.ts';

/* oxlint-disable sonarjs/no-nested-functions -- The typed transaction mock mirrors the snapshot persistence chain for the Action hook. owner: Catalog #478; remove with shared transaction fixture. expires: 2027-03-31. */

const tenantId = '11111111-1111-4111-8111-111111111111';
const variantId = '22222222-2222-4222-8222-222222222222';
const target = { kind: 'VARIANT', tenantId, variantId } as const;
const base = { code: ' DRZ-10 ', evidenceRefs: ['doc:1'], reason: 'Confirmed catalog record', target };

describe('governed SKU Action contracts', () => {
  it('requires exact target, evidence, and revision intent', () => {
    expect(Schema.decodeUnknownSync(AssignSkuPayloadSchema)({ ...base, expectedRevision: 0 }).target).toEqual(target);
    expect(() => Schema.decodeUnknownSync(AssignSkuPayloadSchema)({ ...base, expectedRevision: 1 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssignSkuPayloadSchema)({ ...base, evidenceRefs: [], expectedRevision: 0 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssignSkuPayloadSchema)({
        ...base,
        expectedRevision: 0,
        target: { ...target, variantId: 'bad' },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(RenameSkuPayloadSchema)({ ...base, expectedRevision: 1, oldCode: 'D-10' }).oldCode,
    ).toBe('D-10');
    expect(() =>
      Schema.decodeUnknownSync(RenameSkuPayloadSchema)({ ...base, expectedRevision: 0, oldCode: 'D-10' }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CorrectSkuPayloadSchema)({ ...base, expectedRevision: 1, previousTarget: target })
        .previousTarget,
    ).toEqual(target);
    expect(() => Schema.decodeUnknownSync(CorrectSkuPayloadSchema)({ ...base, expectedRevision: 1 })).toThrow();
  });

  it('keeps public operations explicit, permissioned, and idempotent', () => {
    for (const action of [assignSkuAction, renameSkuAction, correctSkuAction]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
    expect(assignSkuAction.descriptor.actionKey).toBe('commerce.catalog.assign-sku');
    expect(renameSkuAction.descriptor.actionKey).toBe('commerce.catalog.rename-sku');
    expect(correctSkuAction.descriptor.actionKey).toBe('commerce.catalog.correct-sku');
    expect(correctSkuAction.descriptor.actionKey).not.toBe(assignSkuAction.descriptor.actionKey);
    expect(correctSkuAction.descriptor.actionKey).not.toBe(renameSkuAction.descriptor.actionKey);
    expect(catalogPublicOperationContracts['commerce.catalog.correct-sku']).toMatchObject({
      permission: 'commerce.catalog.correct-sku',
      permissionKind: 'action_execution',
      scope: 'tenant',
    });
    const grantsWithoutCorrection = new Set<string>(
      catalogAuthorityBundles.PRODUCT_EDITOR.filter((permission) => permission !== 'commerce.catalog.correct-sku'),
    );
    expect(grantsWithoutCorrection.has('commerce.catalog.assign-sku')).toBe(true);
    expect(grantsWithoutCorrection.has('commerce.catalog.rename-sku')).toBe(true);
    expect(grantsWithoutCorrection.has('commerce.catalog.correct-sku')).toBe(false);
  });

  it.effect('captures each decoded SKU success under its exact Action identity', () =>
    Effect.gen(function* capturesSkuResults() {
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:sku-snapshot-test:run:1',
          authMethod: 'system',
          principalId: '00000000-0000-4000-8000-000000000002',
          tenantId,
        }),
        correlationId: 'sku-snapshot-test',
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
      for (const action of [assignSkuAction, renameSkuAction, correctSkuAction] as const) {
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
        { actionKey: 'commerce.catalog.assign-sku', encodedResult: { revision: 2 }, schemaVersion: 1 },
        { actionKey: 'commerce.catalog.rename-sku', encodedResult: { revision: 2 }, schemaVersion: 1 },
        { actionKey: 'commerce.catalog.correct-sku', encodedResult: { revision: 2 }, schemaVersion: 1 },
      ]);
    }),
  );

  it.effect('fails the decoded-success hook when snapshot persistence fails', () =>
    Effect.gen(function* rejectsFailedCapture() {
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:sku-snapshot-test:run:2',
          authMethod: 'system',
          principalId: '00000000-0000-4000-8000-000000000002',
          tenantId,
        }),
        correlationId: 'sku-snapshot-failure',
      };
      const transaction = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('database unavailable')) }),
          }),
        }),
      };
      // @ts-expect-error The focused mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(assignSkuAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(assignSkuAction);
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

  it('retains exact correction attribution and permits a same-target display-code intent', () => {
    const correctedTarget = {
      kind: 'PACKAGE_OPTION',
      packageDefinitionId: '33333333-3333-4333-8333-333333333333',
      tenantId,
    } as const;
    expect(
      Schema.decodeUnknownSync(CorrectSkuPayloadSchema)({
        ...base,
        code: 'DRZ-10',
        expectedRevision: 2,
        previousTarget: target,
        target: correctedTarget,
      }).previousTarget,
    ).toEqual(target);
    expect(
      Schema.decodeUnknownSync(CorrectSkuPayloadSchema)({
        ...base,
        code: 'drz-10',
        expectedRevision: 2,
        previousTarget: target,
      }).target,
    ).toEqual(target);
    expect(() =>
      Schema.decodeUnknownSync(CorrectSkuPayloadSchema)({
        ...base,
        evidenceRefs: [],
        expectedRevision: 2,
        previousTarget: target,
      }),
    ).toThrow();
  });

  it('declares every expected persistence and domain failure as a typed Action error', () => {
    const failures = [
      new SkuActionConflict({ code: 'sku_action_conflict', reason: 'retained' }),
      new SkuActionStale({ actualRevision: 2, code: 'sku_action_stale' }),
      new SkuActionInvalid({ code: 'sku_action_invalid', reason: 'invalid' }),
      new SkuActionNotFound({ code: 'sku_action_not_found', reason: 'missing' }),
      new SkuPersistenceUnavailable({ code: 'sku_persistence_unavailable', reason: 'unavailable' }),
    ];
    for (const failure of failures) {
      expect(Schema.is(SkuActionErrorSchema)(failure)).toBe(true);
    }
  });

  it('preserves the complete SKU HTTP outcome matrix for assign, correct, and rename', () => {
    const mappers = [mapAssignSkuActionProblem, mapCorrectSkuActionProblem, mapRenameSkuActionProblem] as const;
    for (const mapProblem of mappers) {
      const conflict = mapProblem(new SkuActionConflict({ code: 'sku_action_conflict', reason: 'retained' }));
      const stale = mapProblem(new SkuActionStale({ actualRevision: 2, code: 'sku_action_stale' }));
      const missing = mapProblem(new SkuActionNotFound({ code: 'sku_action_not_found', reason: 'missing' }));
      const invalid = mapProblem(new SkuActionInvalid({ code: 'sku_action_invalid', reason: 'retired' }));
      const unavailable = mapProblem(
        new SkuPersistenceUnavailable({ code: 'sku_persistence_unavailable', reason: 'contradictory Current proof' }),
      );
      expect(conflict.status).toBe(409);
      expect(stale.status).toBe(409);
      expect(missing.status).toBe(404);
      expect(invalid.status).toBe(422);
      expect('retryable' in missing).toBe(false);
      expect('retryable' in invalid).toBe(false);
      expect(unavailable).toMatchObject({ retryable: true, status: 503 });
    }
  });
});
