// expect-count: 2
// Evasion: the hand-rolled temporal codecs are spelled with `[0-9]` instead of `\d`, which is the
// most common way these regexes are actually written.
import { Schema } from 'effect';

// 1 the leap-year date-only codec
export const ProbeDateOnlySchema = Schema.String.check(Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u));

// 2 the regex-validated ISO timestamp codec
export const ProbeIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u),
);
