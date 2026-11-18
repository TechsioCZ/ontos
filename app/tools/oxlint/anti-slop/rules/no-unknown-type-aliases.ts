import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import type { VisitorKeys } from "../shared/lexical-type-parameters.ts";

import { resolvedTypeMatches } from "../shared/type-alias-resolution.ts";

function resolvesToUnknown(type: ESTree.TSType, visitorKeys: VisitorKeys): boolean {
  return resolvedTypeMatches(type, visitorKeys, (resolved, matches) => {
    if (resolved.type === "TSUnknownKeyword") return true;
    if (resolved.type === "TSParenthesizedType") return matches(resolved.typeAnnotation);
    return resolved.type === "TSUnionType" && resolved.types.some(matches);
  });
}

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  createOnce(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (!resolvesToUnknown(node.typeAnnotation, context.sourceCode.visitorKeys)) return;
        context.report({
          node: node.id,
          messageId: "unknownAlias",
          data: { alias: node.id.name },
        });
      },
    };
  },
});
