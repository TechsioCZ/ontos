// expect-count: 3
import { Effect } from "effect";

export interface OutboxRow {
	readonly rowId: string;
}

export class RowError extends Error {}

type MaybeRowInner = OutboxRow | undefined;
type MaybeRow = MaybeRowInner;
type HopOne = HopTwo;
type HopTwo = OutboxRow | null;
type Parenthesised = (OutboxRow | undefined);

export interface RowPorts {
	readonly load: () => Promise<MaybeRow>;
	readonly claim: () => Effect.Effect<HopOne, RowError>;
	readonly peek: () => Promise<Parenthesised>;
}
