import { defineScopedRoutine } from '@app/core-runtime';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { Effect, Match, Option, Schema } from 'effect';

import {
  SymmyEffectClaimSchema,
  SymmyExecutionJobSchema,
  SymmyJobExecutionProjectionSchema,
  SymmyPinnedEffectSchema,
  SymmyOwnerReceiptSchema,
  projectSymmyUnsupportedBranches,
} from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyEffectClaim,
  SymmyExecutionJob,
  SymmyExecutionOutcome,
  SymmyPinnedEffect,
  SymmyOwnerReceipt,
} from '../../shared/domain/symmy-job-execution.ts';

export class SymmyJobExecutionStoreError extends Schema.TaggedError<SymmyJobExecutionStoreError>()(
  'SymmyJobExecutionStoreError',
  { code: Schema.Literals(['unavailable', 'invalid_outcome']) },
) {}

const storeFailure = (code: SymmyJobExecutionStoreError['code'], cause?: unknown) => {
  const failure = new SymmyJobExecutionStoreError({ code });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};
const unavailable = (cause?: unknown) => storeFailure('unavailable', cause);

const routineBase = { ownerModuleKey: 'integration.symmy', schema: 'symmy_integration' } as const;
const readExecution = defineScopedRoutine({
  ...routineBase,
  name: 'read_symmy_job_execution',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({
    job: Schema.toEncoded(Schema.OptionFromNullOr(SymmyExecutionJobSchema)),
    state: Schema.Literals(['FOUND', 'MISSING', 'UNAVAILABLE']),
  }),
  routineKey: 'symmy-job.read-execution',
});
const claimEffect = defineScopedRoutine({
  ...routineBase,
  name: 'claim_symmy_job_effect',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.toEncoded(SymmyEffectClaimSchema),
  routineKey: 'symmy-job.claim-effect',
});
const changeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'integer' },
] as const;
const changed = Schema.Struct({ applied: Schema.Boolean });
const settleEffect = defineScopedRoutine({
  ...routineBase,
  name: 'settle_symmy_job_effect',
  parameters: [...changeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: changed,
  routineKey: 'symmy-job.settle-effect',
});
const markIndeterminate = defineScopedRoutine({
  ...routineBase,
  name: 'mark_symmy_job_effect_indeterminate',
  parameters: changeParameters,
  resultSchema: changed,
  routineKey: 'symmy-job.mark-indeterminate',
});
const markUnavailable = defineScopedRoutine({
  ...routineBase,
  name: 'mark_symmy_job_effect_unavailable',
  parameters: changeParameters,
  resultSchema: changed,
  routineKey: 'symmy-job.mark-unavailable',
});
const canExecute = defineScopedRoutine({
  ...routineBase,
  name: 'can_execute_symmy_job_effect',
  parameters: changeParameters,
  resultSchema: Schema.Struct({ allowed: Schema.Boolean }),
  routineKey: 'symmy-job.can-execute',
});
const markBlocked = defineScopedRoutine({
  ...routineBase,
  name: 'mark_symmy_job_effect_blocked',
  parameters: changeParameters,
  resultSchema: changed,
  routineKey: 'symmy-job.mark-blocked',
});
const recordInvocation = defineScopedRoutine({
  ...routineBase,
  name: 'record_symmy_owner_invocation',
  parameters: [...changeParameters, { source: 'input', type: 'uuid' }],
  resultSchema: changed,
  routineKey: 'symmy-job.record-owner-invocation',
});
const recordExecutor = defineScopedRoutine({
  ...routineBase,
  name: 'record_symmy_owner_executor',
  parameters: [...changeParameters, { source: 'input', type: 'uuid' }],
  resultSchema: changed,
  routineKey: 'symmy-job.record-owner-executor',
});
const recordResolved = defineScopedRoutine({
  ...routineBase,
  name: 'record_symmy_resolved_effect',
  parameters: [...changeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: changed,
  routineKey: 'symmy-job.record-resolved-effect',
});
const recordReceipt = defineScopedRoutine({
  ...routineBase,
  name: 'record_symmy_owner_receipt',
  parameters: [...changeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: changed,
  routineKey: 'symmy-job.record-owner-receipt',
});
const recordRequest = defineScopedRoutine({
  ...routineBase,
  name: 'record_symmy_owner_request',
  parameters: [...changeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: changed,
  routineKey: 'symmy-job.record-owner-request',
});

const accepted = (outcome: SymmyExecutionOutcome): boolean =>
  outcome.status === 'accepted_change' || outcome.status === 'accepted_no_change' || outcome.status === 'duplicate';

const projectionPhase = (job: SymmyExecutionJob, acceptedCount: number) => {
  if (job.effects.every(({ state }) => state === 'settled')) {
    if (
      acceptedCount ===
      job.effects.length + job.plan.items.reduce((count, item) => count + (item.unsupportedBranches?.length ?? 0), 0)
    ) {
      return 'completed_all';
    }
    return acceptedCount > 0 ? 'completed_partial' : 'completed_none';
  }
  if (job.effects.some(({ outcome, state }) => state === 'indeterminate' && Option.isNone(outcome))) {
    return 'indeterminate';
  }
  if (job.effects.some(({ state }) => state === 'blocked')) {
    return 'blocked';
  }
  return job.effects.every(({ state }) => state === 'planned') ? 'admitted' : 'running';
};

type SymmyJobExecutionProjection = typeof SymmyJobExecutionProjectionSchema.Type;

export const projectSymmyExecutionJob: (
  job: SymmyExecutionJob,
) => Effect.Effect<SymmyJobExecutionProjection, SymmyJobExecutionStoreError> = Effect.fn('SymmyJobExecution.project')(
  function* project(job: SymmyExecutionJob) {
    const states = new Map(job.effects.map((entry) => [entry.effect.ref.effectId, entry]));
    const effects = job.plan.items.flatMap((item) => item.effects);
    if (
      states.size !== effects.length ||
      effects.some((effect) => !states.has(effect.ref.effectId)) ||
      job.effects.some(({ outcome, state }) => {
        const result = Option.getOrUndefined(outcome);
        if (state === 'indeterminate') {
          return result !== undefined && result.status !== 'unavailable';
        }
        return (state === 'settled' || state === 'blocked') !== (result !== undefined);
      })
    ) {
      return yield* unavailable();
    }
    const outcomes = job.effects.flatMap(({ outcome }) => Option.toArray(outcome));
    const acceptedCount = outcomes.filter(accepted).length;
    const phase = projectionPhase(job, acceptedCount);
    const items = job.plan.items.map((item) => ({
      effects: [
        ...item.effects.map((effect) => {
          const state = states.get(effect.ref.effectId);
          return (
            (state === undefined ? undefined : Option.getOrUndefined(state.outcome)) ?? {
              effectId: effect.ref.effectId,
              owner: effect.ref.operation.moduleId,
              status: Match.value(state?.state).pipe(
                Match.when('planned', () => 'waiting' as const),
                Match.when('attempting', () => 'executing' as const),
                Match.orElse(() => 'indeterminate' as const),
              ),
            }
          );
        }),
        ...projectSymmyUnsupportedBranches(item),
      ],
      itemId: item.itemId,
    }));
    return yield* Schema.decodeUnknownEffect(SymmyJobExecutionProjectionSchema, { onExcessProperty: 'error' })({
      items,
      jobId: job.jobId,
      phase,
    }).pipe(Effect.mapError(unavailable));
  },
);

interface SymmyJobExecutionStore {
  readonly canExecute: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly claim: (
    jobId: string,
    effectId: string,
    claimToken: string,
  ) => Effect.Effect<SymmyEffectClaim, SymmyJobExecutionStoreError>;
  readonly load: (jobId: string) => Effect.Effect<Option.Option<SymmyExecutionJob>, SymmyJobExecutionStoreError>;
  readonly markBlocked: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly markIndeterminate: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    availability?: 'unavailable' | 'indeterminate',
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly recordExecutor: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    principalId: string,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly recordInvocation: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    invocationId: string,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly recordOwnerReceipt: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    receipt: SymmyOwnerReceipt,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly recordOwnerRequest: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    identity: { readonly authContextRef: string; readonly executorPrincipalId: string; readonly requestHash: string },
  ) => Effect.Effect<void, SymmyJobExecutionStoreError>;
  readonly recordResolvedEffect: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    effect: SymmyPinnedEffect,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
  readonly settle: (
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    outcome: SymmyExecutionOutcome,
  ) => Effect.Effect<boolean, SymmyJobExecutionStoreError>;
}

export const symmyJobExecutionStore = (transaction: ScopedRoutineInvoker): SymmyJobExecutionStore => ({
  canExecute: Effect.fn('SymmyJobExecution.canExecute')(function* canExecuteEffect(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
  ) {
    const [row] = yield* transaction
      .invoke(canExecute, [jobId, effectId, claimToken, version])
      .pipe(Effect.mapError(unavailable));
    return row?.allowed ?? false;
  }),
  claim: Effect.fn('SymmyJobExecution.claim')(function* claim(jobId: string, effectId: string, claimToken: string) {
    const [row] = yield* transaction
      .invoke(claimEffect, [jobId, effectId, claimToken])
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    return yield* Schema.decodeUnknownEffect(SymmyEffectClaimSchema)(row).pipe(Effect.mapError(unavailable));
  }),
  load: Effect.fn('SymmyJobExecution.load')(function* load(jobId: string) {
    const [row] = yield* transaction.invoke(readExecution, [jobId]).pipe(Effect.mapError(unavailable));
    if (row === undefined || row.state === 'UNAVAILABLE') {
      return yield* unavailable();
    }
    const decoded = yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(SymmyExecutionJobSchema))(row.job).pipe(
      Effect.mapError(unavailable),
    );
    return decoded;
  }),
  markBlocked: Effect.fn('SymmyJobExecution.markBlocked')(function* block(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
  ) {
    const [row] = yield* transaction
      .invoke(markBlocked, [jobId, effectId, claimToken, version])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  markIndeterminate: Effect.fn('SymmyJobExecution.markIndeterminate')(function* mark(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    availability?: 'unavailable' | 'indeterminate',
  ) {
    const [row] = yield* transaction
      .invoke(availability === 'unavailable' ? markUnavailable : markIndeterminate, [
        jobId,
        effectId,
        claimToken,
        version,
      ])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  recordExecutor: Effect.fn('SymmyJobExecution.recordExecutor')(function* recordOwnerExecutor(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    principalId: string,
  ) {
    const [row] = yield* transaction
      .invoke(recordExecutor, [jobId, effectId, claimToken, version, principalId])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  recordInvocation: Effect.fn('SymmyJobExecution.recordInvocation')(function* recordOwnerInvocation(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    invocationId: string,
  ) {
    const [row] = yield* transaction
      .invoke(recordInvocation, [jobId, effectId, claimToken, version, invocationId])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  recordOwnerReceipt: Effect.fn('SymmyJobExecution.recordOwnerReceipt')(function* recordOwnerReceipt(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    receipt: SymmyOwnerReceipt,
  ) {
    const encoded = yield* Schema.encodeEffect(SymmyOwnerReceiptSchema)(receipt).pipe(Effect.mapError(unavailable));
    const [row] = yield* transaction
      .invoke(recordReceipt, [jobId, effectId, claimToken, version, encoded])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  recordOwnerRequest: Effect.fn('SymmyJobExecution.recordOwnerRequest')(function* recordOwnerRequest(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    { authContextRef, executorPrincipalId, requestHash },
  ) {
    // Both pins share the worker's transaction. A failure in either routine rolls back the pair.
    const [executor] = yield* transaction
      .invoke(recordExecutor, [jobId, effectId, claimToken, version, executorPrincipalId])
      .pipe(Effect.mapError(unavailable));
    if (executor?.applied !== true) {
      return yield* unavailable();
    }
    const [request] = yield* transaction
      .invoke(recordRequest, [jobId, effectId, claimToken, version, { authContextRef, requestHash }])
      .pipe(Effect.mapError(unavailable));
    if (request?.applied !== true) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  }),
  recordResolvedEffect: Effect.fn('SymmyJobExecution.recordResolvedEffect')(function* recordResolvedEffect(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    effect: SymmyPinnedEffect,
  ) {
    const encoded = yield* Schema.encodeEffect(SymmyPinnedEffectSchema)(effect).pipe(Effect.mapError(unavailable));
    const [row] = yield* transaction
      .invoke(recordResolved, [jobId, effectId, claimToken, version, encoded])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
  settle: Effect.fn('SymmyJobExecution.settle')(function* settle(
    jobId: string,
    effectId: string,
    claimToken: string,
    version: number,
    outcome: SymmyExecutionOutcome,
  ) {
    const safeOutcome = yield* Schema.decodeUnknownEffect(SymmyEffectOutcomeSchema, { onExcessProperty: 'error' })(
      outcome,
    ).pipe(Effect.mapError((cause) => storeFailure('invalid_outcome', cause)));
    if (
      safeOutcome.status === 'unavailable' ||
      safeOutcome.status === 'indeterminate' ||
      safeOutcome.status === 'waiting' ||
      safeOutcome.status === 'executing'
    ) {
      return yield* new SymmyJobExecutionStoreError({ code: 'invalid_outcome' });
    }
    const [row] = yield* transaction
      .invoke(settleEffect, [jobId, effectId, claimToken, version, safeOutcome])
      .pipe(Effect.mapError(unavailable));
    return row?.applied ?? false;
  }),
});
