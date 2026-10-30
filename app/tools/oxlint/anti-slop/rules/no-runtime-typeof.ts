import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { genericJsonCanonicalizerProof } from "../../shared/generic-json-canonicalizer.ts";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Disallow domain guessing; proved generic JSON normalization can branch on JSON value kinds. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		const canonicalJson = genericJsonCanonicalizerProof(context);
		return {
			UnaryExpression(node) {
				if (canonicalJson.isCanonicalTraversal(node)) return;
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					(!allowInTypeGuards || !isInsideTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
