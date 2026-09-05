import { Schema } from "effect";
import { suspend } from "effect/Schema";

export interface TreeNode {
	readonly label: string;
	readonly children: ReadonlyArray<TreeNode>;
}

// D-tier allowance (`allowSuspend`): a recursive schema genuinely cannot be inferred, so the
// annotation is load-bearing rather than a second authority.
export const TreeNodeSchema: Schema.Codec<TreeNode> = Schema.Struct({
	label: Schema.String,
	children: Schema.Array(Schema.suspend(() => TreeNodeSchema)),
});

export interface Comment {
	readonly body: string;
	readonly replies: ReadonlyArray<Comment>;
}

// Same allowance via a direct member import of `suspend`.
export const CommentSchema: Schema.Codec<Comment> = Schema.Struct({
	body: Schema.String,
	replies: Schema.Array(suspend(() => CommentSchema)),
});
