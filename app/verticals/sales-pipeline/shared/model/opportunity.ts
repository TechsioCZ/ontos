import { CalendarDateWireSchema as CalendarDateSchema } from '@app/shared-contracts';
import { Schema } from 'effect';
import {
  EmployeeIdSchema,
  OpportunityIdSchema,
  OpportunityStageSchema,
  PartyIdSchema,
  ProductIdSchema,
} from '../outbox/sales-pipeline-opportunity-stage-changed-v1.ts';

export type OpportunityStage = typeof OpportunityStageSchema.Type;

/** Maximum product lines per opportunity; matches the outbox payload bound. */
export const MAX_OPPORTUNITY_LINES = 200;

export const OpportunityCurrencySchema = Schema.Literal('CZK');
export const OpportunityTitleSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const OpportunityNoteSchema = Schema.Trim.check(Schema.isMaxLength(2000));
const MinorUnitsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Probability of winning in whole percent. */
export const ProbabilitySchema = Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 }));
/** VAT rate in whole percent. */
export const VatRateSchema = Schema.Literals([0, 10, 12, 21]);

/**
 * Product line. `quantity` is a positive integer to stay compatible with the frozen outbox line
 * snapshot. `productId` is optional for free-text lines; the outbox producer requires it.
 */
export const OpportunityLineSchema = Schema.Struct({
  productId: Schema.optionalKey(ProductIdSchema),
  productName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  unitPriceMinor: MinorUnitsSchema,
  vatRate: VatRateSchema,
});
export type OpportunityLine = typeof OpportunityLineSchema.Type;
export const OpportunityLinesSchema = Schema.Array(OpportunityLineSchema).check(
  Schema.isMaxLength(MAX_OPPORTUNITY_LINES),
);

export const OpportunityStageHistoryEntrySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  stage: OpportunityStageSchema,
});

export const OpportunitySchema = Schema.Struct({
  amountMinor: MinorUnitsSchema,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  closedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  currency: OpportunityCurrencySchema,
  expectedCloseDate: CalendarDateSchema,
  id: OpportunityIdSchema,
  lines: OpportunityLinesSchema,
  note: Schema.optionalKey(OpportunityNoteSchema),
  ownerEmployeeId: Schema.optionalKey(EmployeeIdSchema),
  partyId: PartyIdSchema,
  probability: ProbabilitySchema,
  stage: OpportunityStageSchema,
  stageHistory: Schema.Array(OpportunityStageHistoryEntrySchema),
  title: OpportunityTitleSchema,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Opportunity = typeof OpportunitySchema.Type;

/** Default probability (whole percent) applied when a stage is set without an explicit probability. */
export const defaultProbabilityByStage = {
  LEAD: 10,
  LOST: 0,
  NEGOTIATION: 75,
  PROPOSAL: 50,
  QUALIFIED: 25,
  WON: 100,
} as const satisfies Readonly<Record<OpportunityStage, number>>;

export const isOpenStage = (stage: OpportunityStage) => stage !== 'WON' && stage !== 'LOST';

/** Opportunity amount: sum of quantity times unit price over all lines, excluding VAT. */
export const opportunityAmountMinor = (lines: readonly OpportunityLine[]) =>
  lines.reduce((total, line) => total + line.quantity * line.unitPriceMinor, 0);
