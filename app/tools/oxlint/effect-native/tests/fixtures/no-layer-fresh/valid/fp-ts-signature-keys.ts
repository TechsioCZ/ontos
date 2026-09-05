/**
 * False-positive repro (no-layer-fresh).
 *
 * When a file imports `fresh` directly from `effect/Layer`, the rule's `Identifier` visitor treats
 * TypeScript *type-member keys* named `fresh` as references to that import. An interface property
 * signature and a type-literal method signature are property names, not value references: neither
 * can defeat Layer memoization, so neither is audit finding A1.
 *
 * Currently reports twice (interface key, type-literal method key). Expected: zero reports.
 *
 * The visitor already skips `Property`, `PropertyDefinition` and `MethodDefinition` keys; the TS
 * signature key node types (`TSPropertySignature`, `TSMethodSignature`, …) are missing from that
 * skip list.
 */
// The direct member import is what arms the rule's `Identifier` visitor; it is otherwise unused.
import { fresh } from "effect/Layer";

export interface CacheState {
	/** A plain boolean field that happens to be called `fresh`. */
	fresh: boolean;
	readonly stale: boolean;
}

export type CacheApi = {
	fresh(): void;
};
