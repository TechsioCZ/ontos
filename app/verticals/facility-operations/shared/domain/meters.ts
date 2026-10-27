// Facility operations — agenda `meters` (S04 média, měřidla a odečty).
// OWNED BY THE `meters` LANE (ops-meters). Keep exporting MetersStateSchema and emptyMetersState.
// Old JSONB rows must still decode: new fields are `Schema.optionalKey(...)` (or reseed: pnpm demo:seed:facility-operations).
//
// Model: a meter (měřidlo) of one medium sits on a supply point (odběrné místo) of a Siampark property or unit.
// Readings (odečty) are cumulative register values. Consumption is ONLY ever derived from two consecutive valid
// readings of the same meter with the same unit of measure (S04-01); the first reading has no consumption (S04-02).
// Voided readings stay in the history (who/when/why) and are skipped by every calculation.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { DateTime, Option, Schema } from 'effect';
import {
  AuditFieldsSchema,
  FileIdSchema,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  OpsIdSchema,
} from './common.ts';

export const MeterIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityMeterId'));
export const MeterReadingIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityMeterReadingId'));

export const meterMedia = ['ELECTRICITY', 'WATER', 'GAS', 'HEAT', 'OTHER'] as const;
export const MeterMediumSchema = Schema.Literals(meterMedia);
export type MeterMedium = typeof MeterMediumSchema.Type;

export const MeterStatusSchema = Schema.Literals(['ACTIVE', 'RETIRED']);

/** Cumulative register value (non-negative, finite). */
export const MeterValueSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Snapshot of an uploaded photo (facility_operations.files), same shape as the documents lane's StoredFileRef. */
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
  note: Schema.optionalKey(NoteSchema),
  readBy: Schema.optionalKey(TextSchema(120)),
  /** Cost in CZK minor units for the period that ends with this reading (náklad za období). */
  costMinor: Schema.optionalKey(MinorAmountSchema),
  photo: Schema.optionalKey(MeterPhotoSchema),
  voided: Schema.optionalKey(MeterReadingVoidSchema),
});
export type MeterReading = typeof MeterReadingSchema.Type;

export const MeterSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: MeterIdSchema,
  location: Schema.optionalKey(PropertyRefSchema),
  medium: MeterMediumSchema,
  note: Schema.optionalKey(NoteSchema),
  serialNumber: TextSchema(64),
  unit: TextSchema(16),
  /** Odběrné místo (EAN / EIC / číslo odběrného místa). */
  supplyPoint: Schema.optionalKey(TextSchema(120)),
  /** Dodavatel média. */
  supplier: Schema.optionalKey(TextSchema(200)),
  /** Odběratel (e.g. tenant the medium is re-invoiced to). */
  consumer: Schema.optionalKey(TextSchema(200)),
  /** Smlouva s dodavatelem (number or name). */
  contract: Schema.optionalKey(TextSchema(200)),
  readings: Schema.optionalKey(Schema.Array(MeterReadingSchema)),
  status: Schema.optionalKey(MeterStatusSchema),
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
const dayNumber = (date: string): number =>
  Option.match(DateTime.make(`${date}T00:00:00Z`), {
    onNone: () => Number.NaN,
    onSome: (value) => Math.round(DateTime.toEpochMillis(value) / DAY_MS),
  });
/** Whole days between two ISO dates (b - a). */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

export type ReadingCalculation = Pick<MeterReading, 'date' | 'unit' | 'value' | 'voided'>;
interface ReadingSource<Reading extends ReadingCalculation> {
  readonly readings?: readonly Reading[];
}

export const isValidReading = (reading: Pick<MeterReading, 'voided'>): boolean => reading.voided === undefined;

/** Valid readings sorted by date (oldest first). */
export const validReadingsOf = <Reading extends ReadingCalculation = MeterReading>(
  meter: ReadingSource<Reading>,
): readonly Reading[] =>
  (meter.readings ?? []).filter(isValidReading).toSorted((left, right) => left.date.localeCompare(right.date));

/** First readings and unit changes have no comparable consumption. */
export const ReadingRowStatusSchema = Schema.Literals(['first', 'unitChanged', 'ok']);
export type ReadingRowStatus = typeof ReadingRowStatusSchema.Type;

export interface ReadingRow<Reading extends ReadingCalculation = MeterReading> {
  readonly anomaly: boolean;
  /** Change of the daily rate against the previous `ok` period (0.45 = +45 %). */
  readonly change: number | undefined;
  /** value − previous.value, only when status is `ok`. */
  readonly consumption: number | undefined;
  /** Consumption per day, only when status is `ok` and days > 0. */
  readonly dailyRate: number | undefined;
  readonly days: number | undefined;
  readonly previous: Reading | undefined;
  readonly reading: Reading;
  readonly status: ReadingRowStatus;
}

/** History rows of the valid readings (oldest first) with truthful consumption and anomaly flags. */
export const readingRows = <Reading extends ReadingCalculation = MeterReading>(
  meter: ReadingSource<Reading>,
): readonly ReadingRow<Reading>[] => {
  const readings = validReadingsOf(meter);
  const rows: ReadingRow<Reading>[] = [];
  let previousRate: number | undefined;
  for (const [index, reading] of readings.entries()) {
    const previous = index === 0 ? undefined : readings[index - 1];
    let status: ReadingRowStatus = 'ok';
    let consumption: number | undefined;
    let days: number | undefined;
    let dailyRate: number | undefined;
    let change: number | undefined;
    if (previous === undefined) {
      status = 'first';
    } else if (previous.unit === reading.unit) {
      consumption = Math.round((reading.value - previous.value) * 1000) / 1000;
      days = daysBetween(previous.date, reading.date);
      dailyRate = days > 0 ? consumption / days : undefined;
      change =
        dailyRate !== undefined && previousRate !== undefined && previousRate > 0
          ? dailyRate / previousRate - 1
          : undefined;
    } else {
      status = 'unitChanged';
    }
    rows.push({
      anomaly: change !== undefined && change > ANOMALY_THRESHOLD,
      change,
      consumption,
      dailyRate,
      days,
      previous,
      reading,
      status,
    });
    previousRate = dailyRate;
  }
  return rows;
};

export const ReadingProblemSchema = Schema.Literals([
  'future',
  'duplicateDate',
  'lowerThanPrevious',
  'higherThanNext',
  'retired',
]);
export type ReadingProblem = typeof ReadingProblemSchema.Type;

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
  const previous = comparable.findLast((reading) => reading.date < draft.date);
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
  readingRows(meter).findLast((row) => row.anomaly && daysBetween(row.reading.date, today) <= ANOMALY_WINDOW_DAYS);

/** `YYYY-MM` of an ISO date. */
export const monthOf = (date: string): string => date.slice(0, 7);

export interface MonthlyPoint {
  readonly anomaly: boolean;
  readonly consumption: number;
  /** Sum of known costs; `undefined` when no period of that month carries a cost. */
  readonly costMinor: number | undefined;
  readonly medium: MeterMedium;
  readonly month: string;
  /** Number of periods whose cost is missing (shown as „bez dat“, never as 0). */
  readonly periodsWithoutCost: number;
  readonly unit: string;
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
      const { costMinor } = row.reading;
      const key = `${month}|${meter.medium}|${row.reading.unit}`;
      const previousBucket = buckets.get(key);
      const bucket = previousBucket ?? {
        anomaly: false,
        consumption: 0,
        costMinor,
        medium: meter.medium,
        month,
        periodsWithoutCost: 0,
        unit: row.reading.unit,
      };
      bucket.consumption = Math.round((bucket.consumption + row.consumption) * 1000) / 1000;
      if (costMinor === undefined) {
        bucket.periodsWithoutCost += 1;
      } else {
        bucket.costMinor = (previousBucket?.costMinor ?? 0) + costMinor;
      }
      bucket.anomaly ||= row.anomaly;
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].toSorted(
    (left, right) => left.month.localeCompare(right.month) || left.medium.localeCompare(right.medium),
  );
};
