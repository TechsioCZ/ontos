import { Schema } from 'effect';
import { HistoryOwnerModuleIdSchema } from './history-contracts.ts';

export class HistoryOwnerUnavailable extends Schema.TaggedError<HistoryOwnerUnavailable>()(
  'HistoryOwnerUnavailable',
  { ownerModuleId: HistoryOwnerModuleIdSchema },
) {}
