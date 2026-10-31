// Task references are display snapshots from the public governed work read, never an unscoped database join.
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { SubjectRef } from '../../shared/domain/documents.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export type TaskOptionsState =
  | { readonly status: 'loading' }
  | { readonly error: Effect.Error<ReturnType<typeof executeWorkRecords>>; readonly status: 'failed' }
  | { readonly options: readonly SubjectRef[]; readonly status: 'ready' };

/** The work gateway filters this list to the current principal and legal entity. */
export const useTaskOptions = (): TaskOptionsState => {
  const [state, setState] = useState<TaskOptionsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executeWorkRecords({}, 'facility-operations.document-task-options').pipe(
        Effect.match({
          onFailure: (error): TaskOptionsState => ({ error, status: 'failed' }),
          onSuccess: (response): TaskOptionsState => ({
            options: response.items.map((task) => ({ id: task.ref.resourceId, kind: 'task', label: task.title })),
            status: 'ready',
          }),
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};
