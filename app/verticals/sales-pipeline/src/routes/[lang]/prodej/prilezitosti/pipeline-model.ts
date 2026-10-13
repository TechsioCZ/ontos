import { formatNumber } from '@app/admin-ui';
import { Schema } from 'effect';
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

/** First value of a Combobox or Select selection, or `undefined` when nothing is selected. */
export const firstValue = (value: string | string[]): string | undefined => (Array.isArray(value) ? value[0] : value);
