// expect-count: 2
// Evasion probe: `import * as Eff from "effect/Effect"` (submodule namespace) and an aliased direct
// member import (`import { fnUntraced as untraced }`) as the generator wrapper.
import * as Eff from "effect/Effect";
import { fnUntraced as untraced } from "effect/Effect";

declare const outbox: { readonly pendingRows: (limit: number) => unknown };
declare const projections: { readonly snapshotFor: (id: string) => unknown };

export const viaNamespace = Eff.fnUntraced(function* () {
	const pending = yield* outbox.pendingRows(10);
	const snapshot = yield* projections.snapshotFor("a");
	return { pending, snapshot };
});

export const viaDirectMember = untraced(function* () {
	const pending = yield* outbox.pendingRows(10);
	const snapshot = yield* projections.snapshotFor("a");
	return { pending, snapshot };
});
