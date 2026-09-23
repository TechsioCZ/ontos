import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionRequestHashConflict,
  ActionRuntime,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapCreateVariantActionProblem } from '../../api/create-variant-action-problems.ts';
import { CreateVariantResultSchema } from '../../shared/actions/create-variant.ts';
import { variantPersistenceForScope } from '../../src/persistence/variant-persistence.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const result = Schema.decodeUnknownSync(CreateVariantResultSchema)({
  classification: {
    affectsOpenSelection: true,
    evidenceRefs: ['urn:evidence:create-variant'],
    kind: 'NEW_REALIZATION',
    newVariantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
    productRef,
    reason: 'A new atomic realization requires its own Variant',
  },
  variant: {
    lifecycle: 'WORK_IN_PROGRESS',
    productRef,
    variantId: '55555555-5555-4555-8555-555555555555',
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
});
const scope = {
  authContextRef: 'better-auth-session:variant-recovery-test',
  authMethod: 'session' as const,
  correlationId: 'variant-recovery-test',
  principalId,
  tenantId,
};
interface SnapshotRow {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly actionKey: string;
  readonly encodedResult: object;
  readonly schemaVersion: number;
  readonly tenantId: string;
}

const snapshotTransaction = (row: SnapshotRow, onRead: () => void) => {
  const limit = () => {
    onRead();
    return Effect.succeed([row]);
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit,
        }),
      }),
    }),
  };
};

describe('create Variant recovery response', () => {
  it.effect('returns the exact committed Variant snapshot only for the original principal and Action', () =>
    Effect.gen(function* recoverCommittedVariant() {
      const encodedResult = yield* Schema.encodeEffect(CreateVariantResultSchema)(result);
      const row = {
        actingPrincipalId: principalId,
        actionInvocationId: invocationId,
        actionKey: 'commerce.catalog.create-variant',
        encodedResult,
        schemaVersion: 2,
        tenantId,
      };
      let snapshotReads = 0;
      const transaction = snapshotTransaction(row, () => {
        snapshotReads += 1;
      });
      // @ts-expect-error Only the exercised snapshot read chain is mocked.
      const services = variantPersistenceForScope(transaction, scope);
      const runtime = {
        resolveActionCommit: () =>
          Effect.fail(
            new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
          ),
        runAction: () => Effect.die('No write may run during recovery'),
      };
      const recovered = yield* services
        .recoverCreateVariant(invocationId)
        .pipe(Effect.provideService(ActionRuntime, runtime));
      expect(recovered).toEqual({ result, status: 'committed' });
      expect(recovered).toMatchObject({ result: { classification: { kind: 'NEW_REALIZATION' } } });
      expect(snapshotReads).toBe(2);

      const otherPrincipal = variantPersistenceForScope(
        // @ts-expect-error Only the exercised snapshot read chain is mocked.
        snapshotTransaction({ ...row, actingPrincipalId: '77777777-7777-4777-8777-777777777777' }, () => {}),
        scope,
      );
      const hidden = yield* otherPrincipal
        .recoverCreateVariant(invocationId)
        .pipe(Effect.provideService(ActionRuntime, runtime));
      expect(hidden).toEqual({ status: 'absent' });
    }),
  );

  it.effect('recovers an explicit legacy v1 Variant result without manufacturing a classification', () =>
    Effect.gen(function* recoverLegacyVariant() {
      const { classification: _classification, ...legacyResult } = result;
      const encodedResult = yield* Schema.encodeEffect(CreateVariantResultSchema)(legacyResult);
      const row = {
        actingPrincipalId: principalId,
        actionInvocationId: invocationId,
        actionKey: 'commerce.catalog.create-variant',
        encodedResult,
        schemaVersion: 1,
        tenantId,
      };
      let snapshotReads = 0;
      const transaction = snapshotTransaction(row, () => {
        snapshotReads += 1;
      });
      // @ts-expect-error Only the exercised snapshot read chain is mocked.
      const services = variantPersistenceForScope(transaction, scope);
      const runtime = {
        resolveActionCommit: () =>
          Effect.fail(
            new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
          ),
        runAction: () => Effect.die('No write may run during recovery'),
      };
      const recovered = yield* services
        .recoverCreateVariant(invocationId)
        .pipe(Effect.provideService(ActionRuntime, runtime));
      expect(recovered).toEqual({ result: legacyResult, status: 'committed' });
      expect(snapshotReads).toBe(3);
    }),
  );

  it('directs an already committed invocation to immutable result recovery without retrying the command', () => {
    const problem = mapCreateVariantActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_VARIANT',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to the same authoritative recovery', () => {
    const problem = mapCreateVariantActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_VARIANT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload under the same identity a conflict, without offering recovery', () => {
    const problem = mapCreateVariantActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
