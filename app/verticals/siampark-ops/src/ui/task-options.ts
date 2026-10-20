// Task references are display snapshots from the public governed work read, never an unscoped database join.
import { executeRecords as executeWorkRecords } from '@app/siampark-work/clients/records';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { SubjectRef } from '../../shared/domain/documents.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export type TaskOptionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly options: readonly SubjectRef[] };

/** The work gateway filters this list to the current principal and legal entity. */
export const useTaskOptions = (): TaskOptionsState => {
  const [state, setState] = useState<TaskOptionsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executeWorkRecords({}, 'siampark-ops.document-task-options').pipe(
        Effect.match({
          onFailure: (): TaskOptionsState => ({ status: 'failed' }),
          onSuccess: (response): TaskOptionsState => ({
            status: 'ready',
            options: response.items.map((task) => ({ kind: 'task', id: task.ref.resourceId, label: task.title })),
          }),
        }),
        Effect.map((next) => {
          if (alive) setState(next);
        }),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};
