/** A date-shaped member name read off an `effect` namespace binding is never a hand-rolled Date call. */
import * as DateTime from "effect/DateTime";
import { Schema } from "effect";

export const encoded = (value: DateTime.Utc): string => Schema.encodeSync(Schema.DateTimeUtc)(value);
export const partsOf = (value: DateTime.Utc): DateTime.Parts => DateTime.toParts(value);
export const millisOf = (value: DateTime.Utc): number => DateTime.getTime(value);
