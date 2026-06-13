import { createDraftEntryActionId } from './create-draft-entry.action';
import type {
  CreateDraftEntryInput,
  CreateDraftEntryProbeResult,
} from './create-draft-entry.action';

export const createDraftEntryHandler = (
  input: CreateDraftEntryInput,
): CreateDraftEntryProbeResult => ({
  accepted: false,
  actionId: createDraftEntryActionId,
  canonicalRowsWritten: false,
  reason: 'stub-only',
  requestedByModuleId: input.sourceModuleId,
});
