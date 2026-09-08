// expect-count: 4
// Evasion: the same hand-rolled temporal regexes, spelled the other four ways they actually get
// written. The shape is what matters, not the character class used to spell a digit.
import { Schema } from 'effect';

// 1 digits written out one at a time, with redundantly escaped separators (legacy, non-unicode)
export const SpelledOutDateSchema = Schema.String.check(Schema.isPattern(/^\d\d\d\d\-\d\d\-\d\d$/));

// 2 a repeated group instead of a quantified atom
export const GroupedDateSchema = Schema.String.check(Schema.isPattern(/^(?:\d){4}-(?:\d){2}-(?:\d){2}$/u));

// 3 a source assembled from a template literal and an in-file constant
const DATE_PART = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
export const AssembledDateSchema = Schema.String.check(Schema.isPattern(new RegExp(`^${DATE_PART}$`, 'u')));

// 4 the "date or time separator" spelling of an ISO timestamp
export const LooseInstantSchema = Schema.String.check(
  Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}Z?$/u),
);
