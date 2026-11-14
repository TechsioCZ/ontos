import { foldSearchText, formatMoney, formatNumber } from '@app/admin-ui';
import { Array as Arr, DateTime, Order, Option, Schema } from 'effect';
import type { ApplyCommandResult, BulkSkipReason } from '../../../../../shared/actions/apply-command.ts';
import { OpportunityLineSchema, isOpenStage, opportunityAmountMinor } from '../../../../../shared/model/opportunity.ts';
import type { Opportunity, OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import { OpportunityStageSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { EmployeeIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';

export type OpportunityStage = typeof OpportunityStageSchema.Type;
export type EmployeeId = typeof EmployeeIdSchema.Type;

/** Whole Kč for tables and KPI tiles: `109325550` haléřů → `1 093 256 Kč`. */
export const formatWholeKc = (minor: number): string => formatMoney(Math.round(minor / 100) * 100);

export const opportunityStages = [
  'LEAD',
  'QUALIFIED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const satisfies readonly OpportunityStage[];

export const isOpportunityStage = Schema.is(OpportunityStageSchema);

/** Terminal opportunities cannot reopen; mixed bulk selections keep closed records unchanged. */
export const permittedStageTransitions = (stages: readonly OpportunityStage[]): readonly OpportunityStage[] =>
  opportunityStages.filter((candidate) => stages.some((stage) => isOpenStage(stage) && candidate !== stage));

export const pipelineConflictKey = (code: string): string =>
  code === 'sales_pipeline_lifecycle_conflict'
    ? 'sales-pipeline.pages.records.errors.closed'
    : 'sales-pipeline.pages.records.errors.conflict';

/** Position of a stage in the sales order, so sorting follows the pipeline rather than the code names. */
export const stageRank = (stage: OpportunityStage): number => opportunityStages.indexOf(stage);

const pluralRules = new Intl.PluralRules('cs-CZ');

const opportunityNoun = (rule: string): string => {
  if (rule === 'one') {
    return 'příležitost';
  }
  return rule === 'few' ? 'příležitosti' : 'příležitostí';
};

/** `1 příležitost`, `3 příležitosti`, `12 příležitostí`. */
export const opportunityCount = (count: number): string =>
  `${formatNumber(count)} ${opportunityNoun(pluralRules.select(count))}`;

const newestFirst = Order.flip(Order.mapInput(DateTime.Order, (item: Opportunity) => item.createdAt));

/** Default list order: newest opportunities first. A column sort the user picks still overrides it. */
export const sortNewestFirst = (items: readonly Opportunity[]): Opportunity[] => Arr.sort(items, newestFirst);

/** Why requested ids were not changed. `other` covers single-record commands, which report no per-id reason. */
export interface SkipTally {
  readonly closed: number;
  readonly invalidTransition: number;
  readonly notFound: number;
  readonly other: number;
  readonly total: number;
}

/**
 * Counts the skipped ids of one command. Bulk updates list every requested id with its outcome and reason;
 * single-record commands only report the changed opportunity, so the difference counts as `other`.
 */
export const skipTally = (requested: number, result: ApplyCommandResult): SkipTally => {
  if (result.results === undefined) {
    const total = Math.max(0, requested - result.opportunities.length);
    return { closed: 0, invalidTransition: 0, notFound: 0, other: total, total };
  }
  const skipped = result.results.filter((item) => item.outcome === 'skipped');
  const withReason = (reason: BulkSkipReason) => skipped.filter((item) => item.reason === reason).length;
  return {
    closed: withReason('closed'),
    invalidTransition: withReason('invalid_transition'),
    notFound: withReason('not_found'),
    other: skipped.filter((item) => item.reason === undefined).length,
    total: skipped.length,
  };
};

/** Largest quantity one product line takes in the form; a bigger number is almost always a typing error. */
export const MAX_LINE_QUANTITY = 10_000;

/** A line quantity must be a whole number from 1 to `MAX_LINE_QUANTITY`. */
export const isValidQuantity = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= MAX_LINE_QUANTITY;

/** First value of a Combobox or Select selection, or `undefined` when nothing is selected. */
export const firstValue = (value: string | string[]): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Whether `text` contains `needle`, both compared through `foldSearchText`. `needle` must already be folded. */
export const containsFolded = (text: string, needle: string): boolean => foldSearchText(text).includes(needle);

/**
 * Items whose label contains the typed query, ignoring case and diacritics. An empty query, or the label of the
 * item already picked (the input shows it after a pick), keeps every item listed.
 */
export const filterItemsByQuery = <T extends { readonly label: string }>(
  items: readonly T[],
  query: string,
  chosenLabel?: string,
): T[] => {
  const needle = foldSearchText(query.trim());
  if (needle === '' || query === chosenLabel) {
    return [...items];
  }
  return items.filter((item) => containsFolded(item.label, needle));
};

/** Converts a manually priced rental/service line to the same snapshot used by catalog lines. */
export const manualOpportunityLine = (
  description: string,
  quantity: number,
  priceCzk: number,
  vatRate: OpportunityLine['vatRate'],
) => {
  const unitPriceMinor = Math.round(priceCzk * 100);
  if (
    !isValidQuantity(quantity) ||
    priceCzk < 0 ||
    !Number.isSafeInteger(unitPriceMinor) ||
    !Number.isSafeInteger(unitPriceMinor * quantity)
  ) {
    return Option.none<OpportunityLine>();
  }
  return Schema.decodeOption(OpportunityLineSchema)({ productName: description, quantity, unitPriceMinor, vatRate });
};

/** Reject imprecise line products and totals before an editable monetary value reaches a command. */
export const isSafeOpportunityAmount = (lines: readonly OpportunityLine[]): boolean =>
  lines.every((line) => Number.isSafeInteger(line.quantity * line.unitPriceMinor)) &&
  Number.isSafeInteger(opportunityAmountMinor(lines));
