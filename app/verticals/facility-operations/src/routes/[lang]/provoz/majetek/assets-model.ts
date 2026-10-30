// Pure view helpers of the assets page (S02/S03). Owned by ops-assets.
import { formatDate, formatDateTime, formatMoney } from '@app/admin-ui';
import { DateTime, Schema } from 'effect';
import type { TOptions } from 'i18next';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type {
  Asset,
  AssetsState,
  DepreciationPlan,
  DepreciationType,
  ServiceRecord,
} from '../../../../../shared/domain/assets.ts';
import { approvedTotal, currentServiceRecords, isActiveAsset } from '../../../../../shared/domain/assets.ts';

export type Translate = (key: string, options?: TOptions) => string;

const todayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
/** Real current business date (Europe/Prague) as `YYYY-MM-DD`. */
export const todayIsoDate = (): string => todayFormat.format(DateTime.toDateUtc(DateTime.nowUnsafe()));

export const addDays = (iso: string, days: number): string => {
  const base = DateTime.makeUnsafe(`${iso}T12:00:00Z`);
  return DateTime.formatIso(DateTime.add(base, { days })).slice(0, 10);
};

export const isoDateLabel = (iso: string | undefined): string => (iso === undefined ? '—' : formatDate(iso));
export const instantLabel = (value: DateTime.Utc): string => formatDateTime(DateTime.formatIso(value));
export const money = (minor: number | undefined, missing: string): string =>
  minor === undefined ? missing : formatMoney(minor);

/** Parses „120 000“, „120000,50“ or „1 200,5“ into haléře; undefined for empty, null for invalid. */
export const parseCzk = (raw: string): number | undefined | null => {
  const compact = raw
    .replaceAll(/[\s ]/gu, '')
    .replace(/[Kk][Čč]$/u, '')
    .replace(',', '.');
  if (compact === '') {
    return undefined;
  }
  if (!/^\d+(?:\.\d{1,2})?$/u.test(compact)) {
    return null;
  }
  return Math.round(Number(compact) * 100);
};

export const principalLabel = (ref: PrincipalRef, actor: PrincipalRef | undefined, you: string): string => {
  if (actor !== undefined && actor.tenantId === ref.tenantId && actor.principalId === ref.principalId) {
    return you;
  }
  return '';
};

export const DueStateSchema = Schema.Literals(['overdue', 'soon', 'planned']);
export type DueState = typeof DueStateSchema.Type;
export const dueState = (nextDueOn: string, today: string): DueState => {
  if (nextDueOn < today) {
    return 'overdue';
  }
  return nextDueOn <= addDays(today, 30) ? 'soon' : 'planned';
};
const dueBadgeVariants = { overdue: 'danger', planned: 'outline', soon: 'warning' } as const;
export const dueBadgeVariant = (state: DueState) => dueBadgeVariants[state];

/** Earliest current next-due date of an asset (newest record per kind+title). */
export const nextDueOf = (asset: Asset): ServiceRecord | undefined =>
  currentServiceRecords(asset)
    .filter((record) => record.nextDueOn !== undefined)
    .toSorted((left, right) => (left.nextDueOn ?? '').localeCompare(right.nextDueOn ?? ''))[0];

export const planOf = (asset: Asset, type: DepreciationType): DepreciationPlan | undefined =>
  (asset.depreciationPlans ?? []).find((plan) => plan.type === type);

/** Net value after approved amounts of one plan; undefined without a plan (shows „neuvedeno“). */
export const remainingOf = (asset: Asset, type: DepreciationType): number | undefined => {
  const plan = planOf(asset, type);
  return plan === undefined ? undefined : plan.baseMinor - approvedTotal(plan);
};

export interface PortfolioStats {
  readonly acquisitionTotal: number;
  readonly active: number;
  readonly currentTotal: number;
  readonly disposed: number;
  readonly missingValues: number;
  readonly openFollowUps: number;
  readonly overdue: number;
  readonly soon: number;
}

export const portfolioStats = (state: AssetsState, today: string): PortfolioStats => {
  const active = state.assets.filter(isActiveAsset);
  const dues = active.flatMap((asset) =>
    currentServiceRecords(asset).flatMap((record) => (record.nextDueOn === undefined ? [] : [record.nextDueOn])),
  );
  return {
    acquisitionTotal: active.reduce((sum, asset) => sum + (asset.acquisitionValueMinor ?? 0), 0),
    active: active.length,
    currentTotal: active.reduce((sum, asset) => sum + (asset.currentValueMinor ?? 0), 0),
    disposed: state.assets.length - active.length,
    missingValues: active.filter((asset) => asset.currentValueMinor === undefined).length,
    openFollowUps: (state.inventories ?? []).flatMap((inventory) =>
      inventory.items.filter((item) => item.followUp?.status === 'open'),
    ).length,
    overdue: dues.filter((due) => dueState(due, today) === 'overdue').length,
    soon: dues.filter((due) => dueState(due, today) === 'soon').length,
  };
};

/** URL of the property-portfolio screen for a property or unit reference. */
export const propertyHref = (language: string, id: string) =>
  `/${language}/nemovitosti?resourceId=${encodeURIComponent(id)}`;
