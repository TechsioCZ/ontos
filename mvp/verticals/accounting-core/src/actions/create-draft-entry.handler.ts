import { createDraftEntryActionId } from './create-draft-entry.action.ts';
import type {
  CreateDraftEntryInput,
  CreateDraftEntryProbeResult,
} from './create-draft-entry.action.ts';

export const createDraftEntryHandler = (
  input: CreateDraftEntryInput,
): CreateDraftEntryProbeResult => ({
  accepted: false,
  actionId: createDraftEntryActionId,
  canonicalRowsWritten: false,
  reason: 'stub-only',
  requestedByModuleId: input.sourceModuleId,
});
