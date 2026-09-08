import { Effect, Exit } from "effect";

const element = <span>ok</span>;
const program = Effect.succeed(element);

// Non-run promise chains are none of this rule's business.
const readManifest = async (): Promise<string> => "manifest";
await readManifest().then((manifest) => {
	console.log(manifest);
});

const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
	onFailure: () => {
		process.exitCode = 1;
	},
	onSuccess: () => {
		process.exitCode = 0;
	},
});
