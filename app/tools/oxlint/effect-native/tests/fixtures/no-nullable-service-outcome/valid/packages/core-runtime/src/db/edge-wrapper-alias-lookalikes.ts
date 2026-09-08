import { Effect } from "effect";

export interface Row {
	readonly rowId: string;
}

export class RowError extends Error {}

/** An alias of a non-nullable wrapper is exactly the shape the audit asks for. */
type RowOutcome = Promise<Row>;
type RowEffect = Effect.Effect<Row, RowError>;

/** Absence in the *reference to the effect*, not in the outcome: not the A2/B5 finding. */
type MaybeRowEffect = Effect.Effect<Row, RowError> | undefined;

/** A same-file `Promise` shadow stays a shadow when reached through another alias. */
type Promise<T> = { readonly value: T };
type ShadowOutcome = Promise<Row | undefined>;

/** A locally declared `Effect` reached through an alias is still not `effect`'s `Effect`. */
interface LocalEffect<A, E> {
	readonly _A: A;
	readonly _E: E;
}
type LocalOutcome = LocalEffect<Row | undefined, never>;

/** Known limitation: a generic alias parameter is not substituted, so this must not report. */
type GenericOutcome<A> = globalThis.Promise<A | undefined>;

/** Beyond the default `aliasDepth` of 3 hops the wrapper alias is not followed either. */
type Hop1 = Hop2;
type Hop2 = Hop3;
type Hop3 = Hop4;
type Hop4 = globalThis.Promise<Row | undefined>;

/** A wrapper alias chain that cycles must terminate without a report. */
type LoopA = LoopB;
type LoopB = LoopA;

export interface RowPorts {
	readonly load: () => RowOutcome;
	readonly claim: () => RowEffect;
	readonly maybe: () => MaybeRowEffect;
	readonly shadowed: () => ShadowOutcome;
	readonly local: () => LocalOutcome;
	readonly generic: () => GenericOutcome<Row>;
	readonly deep: () => Hop1;
	readonly looping: () => LoopA;
}
