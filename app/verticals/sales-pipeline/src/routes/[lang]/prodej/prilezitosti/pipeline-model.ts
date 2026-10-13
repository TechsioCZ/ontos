import { DateTime, Option, Schema } from 'effect';
import type { EmployeeIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { OpportunityStageSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';

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

export const StageVariantSchema = Schema.Literals(['outline', 'info', 'warning', 'success', 'danger']);
export type StageVariant = typeof StageVariantSchema.Type;

/** Badge variant per stage, from `.agents/skills/ontos-dense-admin/references/status-vocabulary.md`. */
export const stageVariant = {
  LEAD: 'outline',
  LOST: 'danger',
  NEGOTIATION: 'warning',
  PROPOSAL: 'info',
  QUALIFIED: 'info',
  WON: 'success',
} as const satisfies Record<OpportunityStage, StageVariant>;

export const isOpportunityStage = Schema.is(OpportunityStageSchema);

/**
 * Employees for the owner column, the owner filter and the assignee picker.
 * Empty until `@app/workforce/clients/records` (listEmployees) is linked into this vertical;
 * until then an owner renders as its raw id.
 */
export interface EmployeeOption {
  readonly fullName: string;
  readonly id: EmployeeId;
}
export const employeeOptions = (): readonly EmployeeOption[] => [];

export const findEmployee = (value: string): EmployeeId | null =>
  employeeOptions().find((employee) => employee.id === value)?.id ?? null;

export const ownerLabel = (id: EmployeeId): string =>
  employeeOptions().find((employee) => employee.id === id)?.fullName ?? id;

/** Customer names come from party-registry, which is not linked yet: show the partyId. */
export const customerLabel = (partyId: string): string => partyId;

const locale = 'cs-CZ';
const pragueTimeZone = 'Europe/Prague';
const missing = '—';

const wholeCrowns = new Intl.NumberFormat(locale, { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
const exactCrowns = new Intl.NumberFormat(locale, {
  currency: 'CZK',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
});

/** Minor units (haléře) to crowns: `123400` → `1 234 Kč`, `123450` → `1 234,50 Kč`. */
export const formatMoney = (minor: number): string =>
  (minor % 100 === 0 ? wholeCrowns : exactCrowns).format(minor / 100);

const percentFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });

/** Takes a ratio: `0.256` → `25,6 %`. */
export const formatPercent = (ratio: number): string => percentFormat.format(ratio);

const countFormat = new Intl.NumberFormat(locale);
const pluralRules = new Intl.PluralRules(locale);

const opportunityNoun = (rule: string): string => {
  if (rule === 'one') {
    return 'příležitost';
  }
  return rule === 'few' ? 'příležitosti' : 'příležitostí';
};

/** `1 příležitost`, `3 příležitosti`, `12 příležitostí`. */
export const opportunityCount = (count: number): string =>
  `${countFormat.format(count)} ${opportunityNoun(pluralRules.select(count))}`;

const calendarDateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat(locale, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: pragueTimeZone,
});

/** Calendar days carry no zone, so they are formatted in UTC and never shift a day. */
export const formatCalendarDate = (day: string): string =>
  Option.match(DateTime.make(`${day}T00:00:00.000Z`), {
    onNone: () => missing,
    onSome: (value) => calendarDateFormat.format(DateTime.toEpochMillis(value)),
  });

export const formatDateTime = (value: DateTime.Utc): string => dateTimeFormat.format(DateTime.toEpochMillis(value));
