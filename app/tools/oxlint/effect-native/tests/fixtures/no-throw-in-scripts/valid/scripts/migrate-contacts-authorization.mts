/** Effect-native script: every failure is a Schema.TaggedError; no throw statement anywhere. */
import { Effect, Exit, Layer, Schema } from "effect";
import process from "node:process";

class ModuleContractInvalid extends Schema.TaggedError<ModuleContractInvalid>()("ModuleContractInvalid", {
	label: Schema.String,
	cause: Schema.Unknown,
}) {}

class TopologyDuplicated extends Schema.TaggedError<TopologyDuplicated>()("TopologyDuplicated", {
	vertical: Schema.String,
}) {}

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const decodeContract = (label: string, value: unknown) =>
	Schema.decodeUnknownEffect(JsonObject)(value).pipe(
		Effect.mapError((cause) => new ModuleContractInvalid({ label, cause })),
	);

const validateTopology = Effect.fn("validateTopology")(function* (verticals: readonly string[]) {
	const seen = new Set<string>();
	for (const vertical of verticals) {
		if (seen.has(vertical)) return yield* new TopologyDuplicated({ vertical });
		seen.add(vertical);
	}
	return verticals;
});

const readUrl = (raw: string | undefined) =>
	raw === undefined
		? Effect.fail(new ModuleContractInvalid({ label: "ONTOS_DATABASE_URL", cause: "missing" }))
		: Effect.try({
				try: () => new URL(raw),
				catch: (cause) => new ModuleContractInvalid({ label: "ONTOS_DATABASE_URL", cause }),
			});

const MigrationLayer = Layer.empty;

const main = Effect.gen(function* () {
	const contract = yield* decodeContract("contract", { moduleId: "contacts" });
	const verticals = yield* validateTopology(["contacts", "identity"]);
	const url = yield* readUrl(process.env["ONTOS_DATABASE_URL"]);
	yield* Effect.logInfo("migration planned").pipe(
		Effect.annotateLogs({ host: url.host, moduleId: String(contract["moduleId"]), verticals: verticals.length }),
	);
});

// The audit's blessed pattern: one small process-exit adapter at the executable edge.
const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(Layer.orDie(MigrationLayer))));
process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
