// Siampark provoz — agenda `meters` (S04 média, měřidla a odečty).
// OWNED BY THE `meters` LANE (ops-meters). Keep exporting MetersStateSchema and emptyMetersState.
// Old JSONB rows must still decode: new fields are `Schema.optionalKey(...)` (or reseed: pnpm demo:seed:siampark-ops).
//
// Model: a meter (měřidlo) of one medium sits on a supply point (odběrné místo) of a Siampark property or unit.
// Readings (odečty) are cumulative register values. Consumption is ONLY ever derived from two consecutive valid
// readings of the same meter with the same unit of measure (S04-01); the first reading has no consumption (S04-02).
// Voided readings stay in the history (who/when/why) and are skipped by every calculation.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import {
  AuditFieldsSchema,
  FileIdSchema,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  opsIdOf,
} from './common.ts';

export const MeterIdSchema = opsIdOf('SiamparkMeterId');
export type MeterId = typeof MeterIdSchema.Type;
export const MeterReadingIdSchema = opsIdOf('SiamparkMeterReadingId');
export type MeterReadingId = typeof MeterReadingIdSchema.Type;

export const meterMedia = ['ELECTRICITY', 'WATER', 'GAS', 'HEAT', 'OTHER'] as const;
export const MeterMediumSchema = Schema.Literals(meterMedia);
export type MeterMedium = typeof MeterMediumSchema.Type;

export const MeterStatusSchema = Schema.Literals(['ACTIVE', 'RETIRED']);
export type MeterStatus = typeof MeterStatusSchema.Type;

/** Cumulative register value (non-negative, finite). */
export const MeterValueSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Snapshot of an uploaded photo (demo_siampark_ops.files), same shape as the documents lane's StoredFileRef. */
export const MeterPhotoSchema = Schema.Struct({
  id: FileIdSchema,
  mime: TextSchema(200),
  name: TextSchema(300),
  size: MinorAmountSchema,
});
export type MeterPhoto = typeof MeterPhotoSchema.Type;

export const MeterReadingVoidSchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  reason: TextSchema(500),
});

export const MeterReadingSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: MeterReadingIdSchema,
  /** Business date of the reading (Europe/Prague calendar date). */
  date: IsoDateSchema,
  value: MeterValueSchema,
  /** Unit of measure at the time of the reading (snapshot; consumption is only computed for equal units). */
  unit: TextSchema(16),
  /** Responsible person (odpovědná osoba) as typed; the authenticated author is `createdBy`. */
  readBy: Schema.optionalKey(TextSchema(120)),
  note: Schema.optionalKey(NoteSchema),
  /** Cost in CZK minor units for the period that ends with this reading (náklad za období). */
  costMinor: Schema.optionalKey(MinorAmountSchema),
  photo: Schema.optionalKey(MeterPhotoSchema),
  voided: Schema.optionalKey(MeterReadingVoidSchema),
});
export type MeterReading = typeof MeterReadingSchema.Type;

export const MeterSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: MeterIdSchema,
  serialNumber: TextSchema(64),
  medium: MeterMediumSchema,
  unit: TextSchema(16),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
  /** Odběrné místo (EAN / EIC / číslo odběrného místa). */
  supplyPoint: Schema.optionalKey(TextSchema(120)),
  /** Dodavatel média. */
  supplier: Schema.optionalKey(TextSchema(200)),
  /** Odběratel (e.g. tenant the medium is re-invoiced to). */
  consumer: Schema.optionalKey(TextSchema(200)),
  /** Smlouva s dodavatelem (number or name). */
  contract: Schema.optionalKey(TextSchema(200)),
  status: Schema.optionalKey(MeterStatusSchema),
  readings: Schema.optionalKey(Schema.Array(MeterReadingSchema)),
});
export type Meter = typeof MeterSchema.Type;

export const MetersStateSchema = Schema.Struct({
  meters: Schema.Array(MeterSchema),
});
export type MetersState = typeof MetersStateSchema.Type;
export type MetersStateEncoded = typeof MetersStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with MetersStateSchema. */
export const emptyMetersState: MetersStateEncoded = { meters: [] };

// ---------------------------------------------------------------------------------------------------------------
// Pure calculations shared by the reducer (validation) and the UI (history, anomalies, charts).
// ---------------------------------------------------------------------------------------------------------------

/** Relative increase of the daily consumption over the previous period that is flagged as an anomaly. */
export const ANOMALY_THRESHOLD = 0.3;

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
/** Whole days between two ISO dates (b - a). */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

export const isValidReading = (reading: MeterReading): boolean => reading.voided === undefined;

/** Valid readings sorted by date (oldest first). */
export const validReadingsOf = (meter: Pick<Meter, 'readings'>): readonly MeterReading[] =>
  [...(meter.readings ?? [])].filter(isValidReading).sort((left, right) => left.date.localeCompare(right.date));

export type ReadingRowStatus =
  /** First valid reading of the meter: no consumption can be stated (S04-02). */
  | 'first'
  /** Previous reading uses a different unit of measure: no difference is computed (S04 rule). */
  | 'unitChanged'
  | 'ok';

export interface ReadingRow {
  readonly reading: MeterReading;
  readonly previous: MeterReading | undefined;
  readonly status: ReadingRowStatus;
  /** value − previous.value, only when status is `ok`. */
  readonly consumption: number | undefined;
  readonly days: number | undefined;
  /** Consumption per day, only when status is `ok` and days > 0. */
  readonly dailyRate: number | undefined;
  /** Change of the daily rate against the previous `ok` period (0.45 = +45 %). */
  readonly change: number | undefined;
  readonly anomaly: boolean;
}

/** History rows of the valid readings (oldest first) with truthful consumption and anomaly flags. */
export const readingRows = (meter: Pick<Meter, 'readings'>): readonly ReadingRow[] => {
  const readings = validReadingsOf(meter);
  const rows: ReadingRow[] = [];
  let previousRate: number | undefined;
  readings.forEach((reading, index) => {
    const previous = index === 0 ? undefined : readings[index - 1];
    if (previous === undefined) {
      rows.push({ anomaly: false, change: undefined, consumption: undefined, dailyRate: undefined, days: undefined, previous, reading, status: 'first' });
      previousRate = undefined;
      return;
    }
    if (previous.unit !== reading.unit) {
      rows.push({ anomaly: false, change: undefined, consumption: undefined, dailyRate: undefined, days: undefined, previous, reading, status: 'unitChanged' });
      previousRate = undefined;
      return;
    }
    const consumption = Math.round((reading.value - previous.value) * 1000) / 1000;
    const days = daysBetween(previous.date, reading.date);
    const dailyRate = days > 0 ? consumption / days : undefined;
    const change =
      dailyRate !== undefined && previousRate !== undefined && previousRate > 0 ? dailyRate / previousRate - 1 : undefined;
    rows.push({
      anomaly: change !== undefined && change > ANOMALY_THRESHOLD,
      change,
      consumption,
      dailyRate,
      days,
      previous,
      reading,
      status: 'ok',
    });
    previousRate = dailyRate;
  });
  return rows;
};

export type ReadingProblem = 'future' | 'duplicateDate' | 'lowerThanPrevious' | 'higherThanNext' | 'retired';

/**
 * Validates a new reading against the meter's valid history. Used by the reducer (authoritative) and by the form
 * (to explain the exact problem before submitting). A lower value than the previous reading is refused: a meter
 * exchange is recorded as a new meter, never as an invented negative consumption.
 */
export const readingProblem = (
  meter: Pick<Meter, 'readings' | 'status' | 'unit'>,
  draft: { readonly date: string; readonly value: number },
  today: string,
): ReadingProblem | undefined => {
  if (meter.status === 'RETIRED') {
    return 'retired';
  }
  if (draft.date > today) {
    return 'future';
  }
  const readings = validReadingsOf(meter);
  if (readings.some((reading) => reading.date === draft.date)) {
    return 'duplicateDate';
  }
  // Only readings in the meter's current unit are comparable (a unit change starts a new comparable series).
  const comparable = readings.filter((reading) => reading.unit === meter.unit);
  const previous = comparable.filter((reading) => reading.date < draft.date).at(-1);
  if (previous !== undefined && draft.value < previous.value) {
    return 'lowerThanPrevious';
  }
  const next = comparable.find((reading) => reading.date > draft.date);
  if (next !== undefined && draft.value > next.value) {
    return 'higherThanNext';
  }
  return undefined;
};

/** Latest history row of a meter (the last valid reading with its consumption), if any. */
export const latestRow = (meter: Pick<Meter, 'readings'>): ReadingRow | undefined => readingRows(meter).at(-1);

/** How long (days after its closing reading) an anomalous period stays highlighted on the meter list. */
export const ANOMALY_WINDOW_DAYS = 62;

/** The latest anomalous period closed within the highlight window before `today`, if any. */
export const recentAnomalyRow = (meter: Pick<Meter, 'readings'>, today: string): ReadingRow | undefined =>
  readingRows(meter)
    .filter((row) => row.anomaly && daysBetween(row.reading.date, today) <= ANOMALY_WINDOW_DAYS)
    .at(-1);

/** `YYYY-MM` of an ISO date. */
export const monthOf = (date: string): string => date.slice(0, 7);

export interface MonthlyPoint {
  readonly month: string;
  readonly medium: MeterMedium;
  readonly unit: string;
  readonly consumption: number;
  /** Sum of known costs; `undefined` when no period of that month carries a cost. */
  readonly costMinor: number | undefined;
  /** Number of periods whose cost is missing (shown as „bez dat“, never as 0). */
  readonly periodsWithoutCost: number;
  readonly anomaly: boolean;
}

/**
 * Monthly consumption per medium+unit for a set of meters. Each `ok` period is attributed to the month of the reading
 * that closes it. Media/units are never summed together.
 */
export const monthlySeries = (meters: readonly Meter[]): readonly MonthlyPoint[] => {
  const buckets = new Map<string, { -readonly [K in keyof MonthlyPoint]: MonthlyPoint[K] }>();
  for (const meter of meters) {
    for (const row of readingRows(meter)) {
      if (row.status !== 'ok' || row.consumption === undefined) {
        continue;
      }
      const month = monthOf(row.reading.date);
      const key = `${month}|${meter.medium}|${row.reading.unit}`;
      const bucket = buckets.get(key) ?? {
        anomaly: false,
        consumption: 0,
        costMinor: undefined,
        medium: meter.medium,
        month,
        periodsWithoutCost: 0,
        unit: row.reading.unit,
      };
      bucket.consumption = Math.round((bucket.consumption + row.consumption) * 1000) / 1000;
      if (row.reading.costMinor === undefined) {
        bucket.periodsWithoutCost += 1;
      } else {
        bucket.costMinor = (bucket.costMinor ?? 0) + row.reading.costMinor;
      }
      bucket.anomaly = bucket.anomaly || row.anomaly;
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].sort(
    (left, right) => left.month.localeCompare(right.month) || left.medium.localeCompare(right.medium),
  );
};
