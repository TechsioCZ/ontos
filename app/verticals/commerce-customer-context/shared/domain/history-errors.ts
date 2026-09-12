import type { HistoryAccessDenied } from './history-access-denied-error.ts';
import type { HistoryOwnerUnavailable } from './history-owner-unavailable-error.ts';
import type { HistoryRecordNotFound } from './history-record-not-found-error.ts';

export { HistoryAccessDenied } from './history-access-denied-error.ts';
export { HistoryOwnerUnavailable } from './history-owner-unavailable-error.ts';
export { HistoryRecordNotFound } from './history-record-not-found-error.ts';

export type HistoryCompositionError = HistoryAccessDenied | HistoryOwnerUnavailable | HistoryRecordNotFound;
