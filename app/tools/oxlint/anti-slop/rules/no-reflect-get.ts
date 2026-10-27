import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";
import { FUNCTION_TYPES } from "../../effect-native/shared/ast.ts";
import { isUnshadowedGlobal, lookupVariable } from "../../effect-native/shared/bindings.ts";

/** Bracket access changes a getter's receiver; a native Proxy must forward all three trap arguments. */
function isNativeProxyForwarding(context: Context, node: ESTree.CallExpression): boolean {
  if (node.arguments.length !== 3) return false;
  let owner: ESTree.Node | null = node.parent;
  while (owner !== null && !FUNCTION_TYPES.has(owner.type)) owner = owner.parent;
  if (
    owner === null ||
    (owner.type !== "ArrowFunctionExpression" && owner.type !== "FunctionExpression") ||
    owner.async || owner.generator || owner.params.length !== 3
  ) return false;
  const property = owner.parent;
  if (
    property?.type !== "Property" || property.value !== owner || property.kind !== "init" ||
    (property.computed
      ? property.key.type !== "Literal" || property.key.value !== "get"
      : property.key.type !== "Identifier" || property.key.name !== "get")
  ) return false;
  const handler = property.parent;
  const construction = handler?.parent;
  if (
    handler?.type !== "ObjectExpression" || construction?.type !== "NewExpression" ||
    construction.arguments.length !== 2 || construction.arguments[1] !== handler ||
    !isUnshadowedGlobal(context, construction.callee, "Proxy")
  ) return false;
  return owner.params.every((parameter, index) => {
    const argument = node.arguments[index];
    if (parameter.type !== "Identifier" || argument?.type !== "Identifier") return false;
    const variable = lookupVariable(context, parameter);
    return variable !== null && lookupVariable(context, argument) === variable &&
      !variable.references.some((reference) => reference.isWrite() && !reference.init);
  });
}

/** Ban arbitrary reflection, preserving receiver-correct native Proxy forwarding. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (
          isGlobalReflectMethodCall(context.sourceCode, node.callee, "get") &&
          !isNativeProxyForwarding(context, node)
        ) {
          context.report({ node, messageId: "reflectGet" });
        }
      },
    };
  },
});
