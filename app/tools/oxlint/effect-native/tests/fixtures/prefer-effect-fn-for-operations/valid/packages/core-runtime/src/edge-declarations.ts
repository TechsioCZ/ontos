import { Effect } from "effect";

export declare function loadContact(id: string): unknown;

export interface ContactPort {
	readonly find: (id: string) => unknown;
}

export abstract class BaseRepository {
	abstract find(id: string): unknown;

	protected abstract save(id: string, payload: unknown): unknown;
}

export declare class DeclaredRepository {
	find(id: string): unknown;
}

/** Generators are already the `Effect.fn` shape. */
export function* step(id: string) {
	yield* Effect.log(id);
}

export async function* stream(id: string) {
	yield id;
}
