import { Schema } from 'effect';
import { defineVerticalAction } from '@mvp/shared-contracts';

export const createDraftEntryActionInputSchema = Schema.Struct({
  description: Schema.String,
});

export const createDraftEntryActionOutputSchema = Schema.Struct({
  draftEntryId: Schema.String,
});

export const createDraftEntryAction = defineVerticalAction({
  displayName: 'Create accounting draft entry',
  id: 'accounting.core.createDraftEntry',
  inputSchema: createDraftEntryActionInputSchema,
  outputSchema: createDraftEntryActionOutputSchema,
});
