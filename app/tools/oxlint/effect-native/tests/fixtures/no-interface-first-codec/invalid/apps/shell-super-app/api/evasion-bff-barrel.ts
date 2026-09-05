// expect-count: 3
import * as BFF from "@modern-js/plugin-bff/effect-edge";
import { Schema as S } from "@modern-js/plugin-bff/effect-client";

export interface GovernedRead {
	readonly id: string;
}
export interface GovernedWrite {
	readonly id: string;
}
export interface GovernedCursor {
	readonly at: string;
}

// aliased named import from the BFF client barrel (how 31 of the real hits reach Schema).
export const governedReadSchema: S.Codec<GovernedRead> = S.Struct({ id: S.String });

// whole-barrel namespace import from the BFF edge barrel.
export const governedWriteSchema: BFF.Schema.Codec<GovernedWrite> = BFF.Schema.Struct({
	id: BFF.Schema.String,
});

// `satisfies` through the same barrel.
export const governedCursorSchema = BFF.Schema.Struct({
	at: BFF.Schema.String,
}) satisfies BFF.Schema.Codec<GovernedCursor>;
