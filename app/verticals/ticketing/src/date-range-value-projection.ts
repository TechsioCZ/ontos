import type { DateRangeValue } from '../shared/date-range-value.ts';

export interface NullableDateRangeFields {
  readonly endDate: string | null;
  readonly endTime: string | null;
  readonly startDate: string | null;
  readonly startTime: string | null;
}

export const dateRangeValueFromNullableFields = (
  fields: NullableDateRangeFields,
): DateRangeValue | null =>
  fields.startDate === null || fields.endDate === null
    ? null
    : {
        endDate: fields.endDate,
        endTime: fields.endTime,
        startDate: fields.startDate,
        startTime: fields.startTime,
      };
