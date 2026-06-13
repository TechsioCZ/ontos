import { Schema } from '@modern-js/plugin-bff/effect-client';
import { defineVerticalAction } from '@mvp/shared-contracts';

export const createDraftEntryActionId = 'accounting.core.createDraftEntry';

export const accountingDraftEntryLineSchema = Schema.Struct({
  accountCode: Schema.String,
  amountMinor: Schema.Finite,
  memo: Schema.optional(Schema.String),
});

export const createDraftEntryInputSchema = Schema.Struct({
  currency: Schema.String,
  description: Schema.String,
  lines: Schema.Array(accountingDraftEntryLineSchema),
  propertyId: Schema.optional(Schema.String),
  sourceModuleId: Schema.String,
  tenantId: Schema.String,
});

export const createDraftEntryOutputSchema = Schema.Struct({
  accepted: Schema.Literal(false),
  actionId: Schema.Literal(createDraftEntryActionId),
  canonicalRowsWritten: Schema.Literal(false),
  reason: Schema.Literal('stub-only'),
  requestedByModuleId: Schema.String,
});

export interface CreateDraftEntryInput {
  readonly currency: string;
  readonly description: string;
  readonly lines: readonly {
    readonly accountCode: string;
    readonly amountMinor: number;
    readonly memo?: string;
  }[];
  readonly propertyId?: string;
  readonly sourceModuleId: string;
  readonly tenantId: string;
}

export interface CreateDraftEntryProbeResult {
  readonly accepted: false;
  readonly actionId: typeof createDraftEntryActionId;
  readonly canonicalRowsWritten: false;
  readonly reason: 'stub-only';
  readonly requestedByModuleId: string;
}

export const createDraftEntryAction = defineVerticalAction({
  auditProfile: 'standard',
  key: createDraftEntryActionId,
  label: 'Create draft accounting entry',
  requestSchema: createDraftEntryInputSchema,
  responseSchema: createDraftEntryOutputSchema,
  targetModuleId: 'accounting.core',
  writesCanonicalRows: false,
});
