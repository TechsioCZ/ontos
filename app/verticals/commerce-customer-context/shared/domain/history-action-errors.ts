import { Schema } from 'effect';
import { HistoryActionUnavailable } from './history-action-unavailable.ts';
import { RepeatOrderConflict } from './repeat-order-conflict.ts';
import { RepeatOrderNoRepeatableLines } from './repeat-order-no-repeatable-lines.ts';

export { HistoryActionUnavailable } from './history-action-unavailable.ts';
export { RepeatOrderConflict } from './repeat-order-conflict.ts';
export { RepeatOrderNoRepeatableLines } from './repeat-order-no-repeatable-lines.ts';

export const RepeatOrderActionErrorSchema = Schema.Union([
  HistoryActionUnavailable,
  RepeatOrderConflict,
  RepeatOrderNoRepeatableLines,
]);
