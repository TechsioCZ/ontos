/** Aliased named imports and aliased submodule namespaces are still `effect`. */
import { DateTime as DT, Duration as D } from "effect";
import * as Instant from "effect/DateTime";

export const millisOf = (value: DT.Utc): number => DT.getTime(value);
export const lease: D.Duration = D.minutes(5);
export const partsOf = (value: Instant.Utc): Instant.Parts => Instant.toParts(value);
export const alsoMillis = (value: Instant.Utc): number => Instant.getTime(value);
