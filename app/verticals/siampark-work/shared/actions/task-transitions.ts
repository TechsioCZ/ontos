import type { TaskState } from '../apis/records.ts';

/**
 * Legal Task state changes. The server enforces this table and the UI reads it, so the page offers only
 * transitions the server accepts. A task with no legal target is closed (DONE or CANCELLED).
 */
export const legalTransitions = {
  CANCELLED: [],
  DONE: [],
  IN_PROGRESS: ['WAITING', 'DONE', 'CANCELLED'],
  NEW: ['IN_PROGRESS', 'CANCELLED'],
  WAITING: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
} as const satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

const targetsOf = (from: TaskState): readonly TaskState[] => legalTransitions[from];

export const canTransition = (from: TaskState, to: TaskState) => targetsOf(from).includes(to);

export const isClosedTaskState = (state: TaskState) => targetsOf(state).length === 0;
