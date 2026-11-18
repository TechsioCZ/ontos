import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import type { VisitorKeys } from "../shared/lexical-type-parameters.ts";

import { resolvedTypeMatches, typeBinding } from "../shared/type-alias-resolution.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

const promiseNames: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

/** The awaited value type of a reference to the global `Promise` or `PromiseLike`. */
function globalPromiseValue(type: ESTree.TSType, visitorKeys: VisitorKeys): ESTree.TSType | null {
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  const name = type.typeName.name;
  if (!promiseNames.has(name) || typeBinding(name, type, visitorKeys).kind !== "global") return null;
  return type.typeArguments?.params[0] ?? null;
}

function resolvesToUnknown(type: ESTree.TSType, visitorKeys: VisitorKeys): boolean {
  return resolvedTypeMatches(type, visitorKeys, (resolved, matches) => {
    if (resolved.type === "TSUnknownKeyword") return true;
    if (resolved.type === "TSParenthesizedType") return matches(resolved.typeAnnotation);
    if (resolved.type === "TSUnionType") return resolved.types.some(matches);
    const value = globalPromiseValue(resolved, visitorKeys);
    return value !== null && matches(value);
  });
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation, context.sourceCode.visitorKeys)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
