import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import type { VisitorKeys } from "../shared/lexical-type-parameters.ts";

import { resolvedTypeMatches } from "../shared/type-alias-resolution.ts";

import {
  parameterAnnotation,
  type Parameter,
  type ParameterOwner,
} from "../shared/function-parameters.ts";

/** The parameter's local binding, without its annotation or default value. */
function parameterName(parameter: Parameter | ESTree.BindingPattern, sourceCode: SourceCode): string {
  if (parameter.type === "TSParameterProperty") return parameterName(parameter.parameter, sourceCode);
  if (parameter.type === "AssignmentPattern") return parameterName(parameter.left, sourceCode);
  if (parameter.type === "RestElement") return parameterName(parameter.argument, sourceCode);
  if (parameter.type === "Identifier") return parameter.name;
  const annotation = parameter.typeAnnotation;
  const text = sourceCode.getText(parameter);
  return annotation === null || annotation === undefined
    ? text
    : text.slice(0, annotation.start - parameter.start).trimEnd();
}

function resolvesToObject(type: ESTree.TSType, visitorKeys: VisitorKeys): boolean {
  return resolvedTypeMatches(type, visitorKeys, (resolved, matches) => {
    if (resolved.type === "TSObjectKeyword") return true;
    if (resolved.type === "TSParenthesizedType") return matches(resolved.typeAnnotation);
    return resolved.type === "TSUnionType" && resolved.types.some(matches);
  });
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!resolvesToObject(annotation.typeAnnotation, context.sourceCode.visitorKeys)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(parameter, context.sourceCode) },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
