import { accessDecisionUnavailable } from '../access/decision/errors.ts';
import type { OriginalActionInvocationReader } from '../access/workloads/original-action-invocation.ts';
import { Effect, Option } from 'effect';

import { ScopedRoutineInvocationError } from '../db/scoped-routine-error.ts';
import type { ScopedRoutineInvoker } from '../db/scoped-routine.ts';
import { OutboxWorkerCompletionPublicationError } from './completion-publication-error.ts';
import type { OutboxWorkerCompletionPublisher } from './completion-publication.ts';
import { OutboxWorkerTenantScopeError } from './tenant-scope-error.ts';
import type { WorkerWorkloadPrincipalEligibility } from './workload-principal-eligibility.ts';

export interface LifetimeBoundOutboxWorkerOwnerCapabilities {
  readonly close: () => void;
  readonly completionPublisher: OutboxWorkerCompletionPublisher;
  readonly readOriginalActionInvocation: OriginalActionInvocationReader;
  readonly readWorkloadPrincipalEligibility: WorkerWorkloadPrincipalEligibility;
  readonly routineInvoker: ScopedRoutineInvoker;
}

const inactiveRoutineError = (routine: Parameters<ScopedRoutineInvoker['invoke']>[0]) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_scope_missing',
    constraint: Option.none(),
    ownerModuleKey: routine.ownerModuleKey,
    postgresCode: Option.none(),
    reason: 'The verified worker owner scope lifetime has ended',
    routineKey: routine.routineKey,
  });

const inactiveCompletionError = () =>
  new OutboxWorkerCompletionPublicationError({
    code: 'outbox_worker_completion_invalid',
    reason: 'The verified worker owner scope lifetime has ended',
    retryable: false,
  });

export const lifetimeBoundOutboxWorkerOwnerCapabilities = (
  routineInvoker: ScopedRoutineInvoker,
  completionPublisher: OutboxWorkerCompletionPublisher,
  readWorkloadPrincipalEligibility?: WorkerWorkloadPrincipalEligibility,
  readOriginalActionInvocation?: OriginalActionInvocationReader,
): LifetimeBoundOutboxWorkerOwnerCapabilities => {
  let active = true;
  const invoke: ScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.suspend(() =>
      active ? routineInvoker.invoke(routine, values) : Effect.fail(inactiveRoutineError(routine)),
    );
  const publish: OutboxWorkerCompletionPublisher['publish'] = (definition, input) =>
    Effect.suspend(() =>
      active ? completionPublisher.publish(definition, input) : Effect.fail(inactiveCompletionError()),
    );
  const readEligibility: WorkerWorkloadPrincipalEligibility = (input) =>
    Effect.suspend(() =>
      active && readWorkloadPrincipalEligibility !== undefined
        ? readWorkloadPrincipalEligibility(input)
        : Effect.fail(
            new OutboxWorkerTenantScopeError({
              code: 'outbox_worker_tenant_scope_context_invalid',
              reason: 'The verified worker identity reader is unavailable or its scope lifetime has ended',
              retryable: false,
            }),
          ),
    );
  const readOriginal: OriginalActionInvocationReader = (input) =>
    Effect.suspend(() =>
      active && readOriginalActionInvocation !== undefined
        ? readOriginalActionInvocation(input)
        : Effect.fail(
            accessDecisionUnavailable(
              'The verified worker receipt reader is unavailable or its scope lifetime has ended',
            ),
          ),
    );
  return Object.freeze({
    close: () => {
      active = false;
    },
    completionPublisher: Object.freeze({ publish }),
    readOriginalActionInvocation: readOriginal,
    readWorkloadPrincipalEligibility: readEligibility,
    routineInvoker: Object.freeze({ invoke }),
  });
};
