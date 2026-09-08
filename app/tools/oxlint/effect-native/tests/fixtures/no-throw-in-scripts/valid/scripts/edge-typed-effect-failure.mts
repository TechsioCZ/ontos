import { Effect as E, Exit, Schema } from "effect";

export class ScriptStepFailed extends Schema.TaggedError<ScriptStepFailed>("ScriptStepFailed")("ScriptStepFailed", {
	reason: Schema.String,
}) {}

export const assertRole = (role: string) =>
	role === "" ? E.fail(new ScriptStepFailed({ reason: "role_required" })) : E.succeed(role);

const main = E.gen(function* () {
	const role = yield* assertRole(process.env["RUNTIME_ROLE"] ?? "");
	yield* E.logInfo(`runtime role ${role}`);
});

// The blessed single process-exit adapter at the executable edge.
const exit = await E.runPromiseExit(main);
process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
