import { Effect } from "effect";

export interface Row {
	readonly rowId: string;
}

export class RowError extends Error {}

/** Absence in the *reference to* the effect, or in the error channel, is not the A2/B5 finding. */
export interface Ports {
	readonly maybeLoad: (() => Promise<Row>) | undefined;
	readonly maybeRun: (() => Effect.Effect<Row, RowError>) | null;
	readonly errorChannel: () => Effect.Effect<Row, RowError | undefined>;
	readonly withContext: () => Effect.Effect<Row, RowError, Row | undefined>;
	readonly bare: () => Promise<Row>;
}

/** Not a return type position: variable annotations are left alone. */
export const pendingRow: Promise<Row | undefined> | undefined = undefined;

export type MaybeRow = Row | undefined;
export const maybeRow: MaybeRow = undefined;
