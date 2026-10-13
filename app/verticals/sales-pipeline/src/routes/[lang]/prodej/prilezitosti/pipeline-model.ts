import { formatNumber } from '@app/admin-ui';
import { Array as Arr, DateTime, Order, Schema } from 'effect';
import type { ApplyCommandResult, BulkSkipReason } from '../../../../../shared/actions/apply-command.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { OpportunityStageSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { EmployeeIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';

export type OpportunityStage = typeof OpportunityStageSchema.Type;
export type EmployeeId = typeof EmployeeIdSchema.Type;

export const opportunityStages = [
  'LEAD',
  'QUALIFIED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const satisfies readonly OpportunityStage[];

export const isOpportunityStage = Schema.is(OpportunityStageSchema);

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

/** First value of a Combobox or Select selection, or `undefined` when nothing is selected. */
export const firstValue = (value: string | string[]): string | undefined => (Array.isArray(value) ? value[0] : value);
