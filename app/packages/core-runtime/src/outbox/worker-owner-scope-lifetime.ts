import { Effect, Option } from 'effect';

import { ScopedRoutineInvocationError } from '../db/scoped-routine-error.ts';
import type { ScopedRoutineInvoker } from '../db/scoped-routine.ts';
import { OutboxWorkerCompletionPublicationError } from './completion-publication-error.ts';
import type { OutboxWorkerCompletionPublisher } from './completion-publication.ts';

export interface LifetimeBoundOutboxWorkerOwnerCapabilities {
  readonly close: () => void;
  readonly completionPublisher: OutboxWorkerCompletionPublisher;
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
  return Object.freeze({
    close: () => {
      active = false;
    },
    completionPublisher: Object.freeze({ publish }),
    routineInvoker: Object.freeze({ invoke }),
  });
};
