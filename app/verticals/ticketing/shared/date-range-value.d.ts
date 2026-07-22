import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const dateRangeValueSchema: Schema.Struct<{
  readonly endDate: Schema.String;
  readonly endTime: Schema.NullOr<Schema.String>;
  readonly startDate: Schema.String;
  readonly startTime: Schema.NullOr<Schema.String>;
}>;
export type DateRangeValue = typeof dateRangeValueSchema.Type;
export type DateRangeValidationCode =
  | 'missing_start'
  | 'missing_end'
  | 'invalid_start_date'
  | 'invalid_end_date'
  | 'equal_dates'
  | 'start_after_end'
  | 'incomplete_time_pair'
  | 'invalid_start_time'
  | 'invalid_end_time'
  | 'times_disabled';
export declare const validateDateRangeValue: (
  value: DateRangeValue,
  timeEnabled: boolean,
) => DateRangeValidationCode | null;
