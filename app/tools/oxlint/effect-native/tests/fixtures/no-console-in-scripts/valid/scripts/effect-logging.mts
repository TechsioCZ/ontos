// The Effect-native replacement: annotated Effect.log*, and the effect Console service.
import { Console, Effect } from "effect";

export const verifyRole = (role: string) =>
	Effect.gen(function* () {
		yield* Effect.logInfo("Verified least-privilege PostgreSQL role").pipe(Effect.annotateLogs({ role }));
		yield* Effect.logWarning("role drift detected").pipe(Effect.annotateLogs({ role }));
		yield* Effect.logError("bootstrap failed").pipe(Effect.annotateLogs({ role }));
		yield* Console.log(`report for ${role}`);
		yield* Console.error("scaffold failed");
	});
