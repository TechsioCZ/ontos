import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";

export const readReport = (target: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(target);
	});

export function Report({ contents }: { readonly contents: string }): JSX.Element {
	return <pre>{contents}</pre>;
}
