// Presentation helpers of the meters page (ops-meters lane). Pure functions over the decoded agenda state.
import { formatNumber, formatPercent } from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { PropertyRef } from '../../../../../../shared/domain/common.ts';
import { latestRow, readingRows } from '../../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium } from '../../../../../../shared/domain/meters.ts';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export const mediumVariant: Readonly<Record<MeterMedium, 'warning' | 'info' | 'danger' | 'success' | 'outline'>> = {
  ELECTRICITY: 'warning',
  GAS: 'danger',
  HEAT: 'success',
  OTHER: 'outline',
  WATER: 'info',
};

export const defaultUnitOf: Readonly<Record<MeterMedium, string>> = {
  ELECTRICITY: 'kWh',
  GAS: 'm³',
  HEAT: 'GJ',
  OTHER: '',
  WATER: 'm³',
};

/** `1234.5` + `kWh` → `1 234,5 kWh`. */
export const formatQuantity = (value: number, unit: string): string => `${formatNumber(value)} ${unit}`.trim();

/** Daily rate rounded to a readable precision. */
export const formatRate = (value: number, unit: string): string =>
  formatQuantity(Math.round(value * (value >= 10 ? 10 : 1000)) / (value >= 10 ? 10 : 1000), unit);

/** `0.43` → `+43 %`. */
export const formatChange = (change: number): string => `${change >= 0 ? '+' : ''}${formatPercent(change)}`;

const siamparkPersona: Readonly<Record<string, string>> = {
  '72000000-0000-4000-8000-000000000021': 'management',
  '72000000-0000-4000-8000-000000000022': 'operations',
  '72000000-0000-4000-8000-000000000023': 'finance',
  '72000000-0000-4000-8000-000000000024': 'external',
};

/** Display name of an author principal (demo personas are known; anyone else is „jiný uživatel“). */
export const personLabel = (t: Translate, principal: PrincipalRef, actor: PrincipalRef | undefined): string => {
  if (actor !== undefined && actor.principalId === principal.principalId) {
    return t('siampark-ops.meters.people.you');
  }
  const persona = siamparkPersona[principal.principalId];
  return t(`siampark-ops.meters.people.${persona ?? 'other'}`);
};

/** Property label part of a location (`Rezidence Parková`), used to group units under their property. */
export const propertyNameOf = (location: PropertyRef | undefined): string | undefined => {
  if (location === undefined) {
    return undefined;
  }
  if (location.kind === 'unit') {
    return location.label.split(' › ')[0]?.trim();
  }
  return location.label.replace(/\s*\([^)]*\)\s*$/u, '').trim();
};

export interface PlaceOption {
  readonly value: string;
  readonly label: string;
  readonly kind: 'site' | 'property' | 'unit';
}

export const SITE = 'site';

/** Places present on the meters: the whole site, each property, then each unit (sorted by label). */
export const placeOptions = (meters: readonly Meter[], siteLabel: string): readonly PlaceOption[] => {
  const properties = new Map<string, string>();
  const units = new Map<string, string>();
  for (const meter of meters) {
    const name = propertyNameOf(meter.location);
    if (name !== undefined && name !== '') {
      properties.set(`property:${name}`, name);
    }
    if (meter.location?.kind === 'unit') {
      units.set(`unit:${meter.location.id}`, meter.location.label);
    }
  }
  const sorted = (entries: Map<string, string>, kind: PlaceOption['kind']) =>
    [...entries.entries()]
      .map(([value, label]): PlaceOption => ({ kind, label, value }))
      .sort((left, right) => left.label.localeCompare(right.label, 'cs'));
  return [{ kind: 'site', label: siteLabel, value: SITE }, ...sorted(properties, 'property'), ...sorted(units, 'unit')];
};

/** Meters belonging to a place option value. */
export const metersAt = (meters: readonly Meter[], place: string): readonly Meter[] => {
  if (place === SITE) {
    return meters;
  }
  if (place.startsWith('property:')) {
    const name = place.slice('property:'.length);
    return meters.filter((meter) => propertyNameOf(meter.location) === name);
  }
  const unitId = place.slice('unit:'.length);
  return meters.filter((meter) => meter.location?.kind === 'unit' && meter.location.id === unitId);
};

export const isAnomalous = (meter: Meter): boolean => latestRow(meter)?.anomaly === true;

/** Free-text search haystack of a meter. */
export const meterSearchText = (meter: Meter, t: Translate): string =>
  [
    meter.serialNumber,
    meter.supplyPoint,
    meter.supplier,
    meter.consumer,
    meter.contract,
    meter.location?.label,
    t(`siampark-ops.meters.medium.${meter.medium}`),
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');

/** Consumption of the last N `ok` periods (oldest first) for the inline trend. */
export const trendOf = (meter: Meter, count = 6) =>
  readingRows(meter)
    .filter((row) => row.status === 'ok' && row.dailyRate !== undefined)
    .slice(-count)
    .map((row) => ({ anomaly: row.anomaly, rate: row.dailyRate ?? 0 }));

/** `2026-09` → `zář 2026` style short month label in the page language. */
export const monthLabel = (month: string, language: string): string =>
  new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'cs-CZ', { month: 'short', timeZone: 'UTC', year: 'numeric' }).format(
    Date.parse(`${month}-01T00:00:00Z`),
  );

/** `2026-09` → `září 2026` long month label. */
export const monthLongLabel = (month: string, language: string): string =>
  new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'cs-CZ', { month: 'long', timeZone: 'UTC', year: 'numeric' }).format(
    Date.parse(`${month}-01T00:00:00Z`),
  );
