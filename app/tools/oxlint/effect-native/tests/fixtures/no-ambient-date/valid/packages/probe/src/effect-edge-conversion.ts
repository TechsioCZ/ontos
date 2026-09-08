/** Converting units at an `effect` namespace call is the Effect-native edge, not hand arithmetic. */
import { Clock, DateTime, Duration, Effect } from "effect";

export const skewed = (nowEpochSeconds: number, clockSkewSeconds: number): DateTime.Utc =>
	DateTime.makeUnsafe(nowEpochSeconds * 1000 - clockSkewSeconds * 1000);

export const leaseOf = (leaseSeconds: number): Duration.Duration => Duration.millis(leaseSeconds * 1000);

/** Already Clock-backed: the ms -> seconds conversion at the JWT edge is not a hand-rolled Duration. */
export const nowSeconds = Clock.currentTimeMillis.pipe(
	Effect.map((milliseconds) => Math.floor(milliseconds / 1000)),
);
