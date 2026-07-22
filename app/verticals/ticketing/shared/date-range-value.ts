import { Schema } from '@modern-js/plugin-bff/effect-client';
import { isCanonicalCalendarDate } from './date-value.ts';

export const dateRangeValueSchema = Schema.Struct({
  endDate: Schema.String,
  endTime: Schema.NullOr(Schema.String),
  startDate: Schema.String,
  startTime: Schema.NullOr(Schema.String),
});

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

const isWallClockTime = (value: string): boolean => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);

export const validateDateRangeValue = (
  value: DateRangeValue,
  timeEnabled: boolean,
): DateRangeValidationCode | null => {
  if (value.startDate.length === 0) {
    return 'missing_start';
  }
  if (value.endDate.length === 0) {
    return 'missing_end';
  }
  if (!isCanonicalCalendarDate(value.startDate)) {
    return 'invalid_start_date';
  }
  if (!isCanonicalCalendarDate(value.endDate)) {
    return 'invalid_end_date';
  }
  if (value.startDate === value.endDate) {
    return 'equal_dates';
  }
  if (value.startDate > value.endDate) {
    return 'start_after_end';
  }
  if ((value.startTime === null) !== (value.endTime === null)) {
    return 'incomplete_time_pair';
  }
  if (value.startTime !== null && !isWallClockTime(value.startTime)) {
    return 'invalid_start_time';
  }
  if (value.endTime !== null && !isWallClockTime(value.endTime)) {
    return 'invalid_end_time';
  }
  if (!timeEnabled && value.startTime !== null) {
    return 'times_disabled';
  }
  return null;
};
