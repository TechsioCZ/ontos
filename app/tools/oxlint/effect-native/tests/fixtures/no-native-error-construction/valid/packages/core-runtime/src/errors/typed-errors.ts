// The Effect-native target of A4/A5: Schema-owned tagged failures, typed defects, exhaustive Match.
// Aliased root imports and `effect/*` submodule namespace imports must never collide with the rule.
import { Cause, Effect as E, Match, Schema } from "effect";
import * as SchemaNs from "effect/Schema";
import * as Data from "effect/Data";

export class CustomerNotFound extends Schema.TaggedError<CustomerNotFound>()("CustomerNotFound", {
	customerId: Schema.String,
}) {}

export class PersistenceUnavailable extends SchemaNs.TaggedError<PersistenceUnavailable>()(
	"PersistenceUnavailable",
	{ sqlState: SchemaNs.String },
) {}

export class InternalInvariant extends Data.TaggedError("InternalInvariant")<{
	readonly reason: string;
}> {}

export const findCustomer = (customerId: string) => E.fail(new CustomerNotFound({ customerId }));

export const invariant = (reason: string) => E.die(new InternalInvariant({ reason }));

export const asDefect = (reason: string) => E.failCause(Cause.die(reason));

export const handled = findCustomer("c1").pipe(
	E.catchTag("CustomerNotFound", (failure) => E.succeed(failure.customerId)),
);

export const statusFor = (failure: CustomerNotFound | PersistenceUnavailable): number =>
	Match.value(failure).pipe(
		Match.tag("CustomerNotFound", () => 404),
		Match.tag("PersistenceUnavailable", () => 503),
		Match.exhaustive,
	);
