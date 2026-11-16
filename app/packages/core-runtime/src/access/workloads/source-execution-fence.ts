import { sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { defineScopedRoutine } from '../../db/scoped-routine.ts';
import { readVerifiedGatewayWorkload } from '../../auth/system-principal-context-provenance.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { OperationContextUnavailable } from '../../operations/errors.ts';
import { isLiveScopedOperationTransaction, readScopedActionInvocationId } from '../enforcement/workload-admission.ts';

const unavailable = (cause?: unknown) => {
  const error = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The original admission execution fence is unavailable or cancelled',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause });
  }
  return error;
};
const ownerModuleKey = 'core.shell';
const routine = (name: string) =>
  defineScopedRoutine({
    name,
    ownerModuleKey,
    parameters: [
      { source: 'tenantId', type: 'uuid' },
      { source: 'input', type: 'uuid' },
    ] as const,
    resultSchema: Schema.Struct({ allowed: Schema.Boolean }),
    routineKey: `core.source-execution.${name.replaceAll('_', '-')}`,
    schema: 'trust',
  });
const openRoutine = routine('open_source_execution_fence');
const openGatedRoutine = defineScopedRoutine({
  name: 'open_source_execution_fence',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({ allowed: Schema.Boolean }),
  routineKey: 'core.source-execution.open-gated-fence',
  schema: 'trust',
});
const cancelRoutine = routine('cancel_source_execution_fence');
const lockRoutine = defineScopedRoutine({
  name: 'lock_source_execution_fence',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({ lock_source_execution_fence: Schema.Boolean }),
  routineKey: 'core.source-execution.require-open',
  schema: 'trust',
});
type ScopedSourceExecutionFenceWitness = Pick<ScopedTransactionExecutor, 'invoke'>;
const uuid = Schema.String.check(Schema.isUUID());
const snapshotRoutine = defineScopedRoutine({
  name: 'read_source_execution_fence',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    action_key: Schema.NonEmptyString,
    admission_invocation_id: uuid,
    fence_state: Schema.Literals(['open', 'cancelled']),
    legal_entity_id: Schema.toEncoded(Schema.OptionFromNullOr(uuid)),
    original_principal_id: uuid,
  }),
  routineKey: 'core.source-execution.read-snapshot',
  schema: 'trust',
});

export interface SourceExecutionFenceFact {
  readonly actionKey: string;
  readonly admissionInvocationId: string;
  readonly legalEntityId: Option.Option<string>;
  readonly originalPrincipalId: string;
  readonly state: 'open' | 'cancelled';
}

/** A nonlocking snapshot of a succeeded admission in the exact live operation's Tenant/Legal Entity. It grants no execution authority. */
export const readScopedSourceExecutionFence = Effect.fn('SourceExecutionFence.readSnapshot')(
  function* readScopedSourceExecutionFence(
    transaction: ScopedSourceExecutionFenceWitness,
    originalAdmissionInvocationId: string,
  ) {
    if (!isLiveScopedOperationTransaction(transaction) || !Schema.is(uuid)(originalAdmissionInvocationId)) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .invoke(snapshotRoutine, [originalAdmissionInvocationId])
      .pipe(Effect.mapError(unavailable));
    if (!isLiveScopedOperationTransaction(transaction) || rows.length > 1) {
      return yield* unavailable();
    }
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): SourceExecutionFenceFact =>
      Object.freeze({
        actionKey: row.action_key,
        admissionInvocationId: row.admission_invocation_id,
        legalEntityId: row.legal_entity_id === null ? Option.none() : Option.some(row.legal_entity_id),
        originalPrincipalId: row.original_principal_id,
        state: row.fence_state,
      }),
    );
  },
);

/** Factual current-open check within the exact live owner Read/Action transaction; the SHARE lock lasts through commit. */
export const requireScopedSourceExecutionFenceOpen = Effect.fn('SourceExecutionFence.requireOpen')(
  function* requireScopedSourceExecutionFenceOpen(
    transaction: ScopedSourceExecutionFenceWitness,
    originalAdmissionInvocationId: string,
  ) {
    if (
      !isLiveScopedOperationTransaction(transaction) ||
      !Schema.is(Schema.String.check(Schema.isUUID()))(originalAdmissionInvocationId)
    ) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .invoke(lockRoutine, [originalAdmissionInvocationId])
      .pipe(Effect.mapError(unavailable));
    if (rows.length !== 1 || rows[0]?.lock_source_execution_fence !== true) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

/** Must join the live native admission Action transaction and can only open that exact invocation. */
export const openScopedSourceExecutionFence = Effect.fn('SourceExecutionFence.open')(
  function* openScopedSourceExecutionFence(
    transaction: ScopedTransactionExecutor,
    originalAdmissionInvocationId: string,
    gate?: { readonly gateId: string; readonly mappingVersion: string; readonly revision: string },
  ) {
    if (
      readScopedActionInvocationId(transaction) !== originalAdmissionInvocationId ||
      !Schema.is(Schema.String.check(Schema.isUUID()))(originalAdmissionInvocationId)
    ) {
      return yield* unavailable();
    }
    const rows = yield* (
      gate === undefined
        ? transaction.invoke(openRoutine, [originalAdmissionInvocationId])
        : transaction.invoke(openGatedRoutine, [
            originalAdmissionInvocationId,
            gate.gateId,
            gate.revision,
            gate.mappingVersion,
          ])
    ).pipe(Effect.mapError(unavailable));
    if (rows.length !== 1 || rows[0]?.allowed !== true) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

/** Cancels before source purge, waiting for all owner transactions already holding the fence. */
export const cancelScopedSourceExecutionFence = Effect.fn('SourceExecutionFence.cancel')(
  function* cancelScopedSourceExecutionFence(
    transaction: ScopedTransactionExecutor,
    originalAdmissionInvocationId: string,
  ) {
    if (
      readScopedActionInvocationId(transaction) === undefined ||
      !Schema.is(Schema.String.check(Schema.isUUID()))(originalAdmissionInvocationId)
    ) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .invoke(cancelRoutine, [originalAdmissionInvocationId])
      .pipe(Effect.mapError(unavailable));
    if (rows.length !== 1 || rows[0]?.allowed !== true) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

/** Core-private: SHARE is held by the native owner transaction until commit, including handler work. */
export const lockRegisteredSourceExecutionFence = Effect.fn('SourceExecutionFence.lock')(
  function* lockRegisteredSourceExecutionFence(transaction: Pick<CoreTransaction, 'execute'>, scope: OperationalScope) {
    const workload = readVerifiedGatewayWorkload(scope);
    if (workload === undefined || workload.recovery !== undefined) {
      return yield* Effect.void;
    }
    const rows = yield* transaction
      .execute<{ readonly allowed: boolean }>(
        sql`select trust.lock_source_execution_fence(${scope.tenantId}::uuid, ${workload.admissionInvocationId}::uuid) as allowed`,
        'objects',
      )
      .pipe(Effect.mapError(unavailable));
    if (rows.length !== 1 || rows[0]?.allowed !== true) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);
