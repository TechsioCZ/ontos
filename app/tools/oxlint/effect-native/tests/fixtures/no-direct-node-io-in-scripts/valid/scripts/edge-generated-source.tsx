// A8: a scaffold that *emits* node:fs text depends on nothing; its own I/O goes through the service.
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";

const TEMPLATE = `import fs from "node:fs";
const { spawnSync } = require("node:child_process");
export const loaded = await import("node:fs/promises");
`;

export const emit = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.writeFileString("generated/module.ts", TEMPLATE);
});

export function Preview<T extends string>({ label }: { readonly label: T }): JSX.Element {
	return (
		<section data-module="node:fs">
			<code>import fs from &quot;node:fs&quot;</code>
			<span>{label satisfies string}</span>
		</section>
	);
}
