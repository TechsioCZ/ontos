import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isMockUtility, memberName } from "../shared/test-framework-bindings.ts";

/** Module registry replacement across Vitest (`vi`), Jest (`jest`) and Rstest (`rs` / `rstest`). */
const moduleMockMethods: ReadonlySet<string> = new Set([
  "createMockFromModule",
  "doMock",
  "doMockRequire",
  "enableAutomock",
  "genMockFromModule",
  "importMock",
  "mock",
  "mockRequire",
  "requireMock",
  "setMock",
  "unstable_mockModule",
]);

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Node): boolean {
  if (callee.type !== "MemberExpression") return false;
  const method = memberName(callee);
  return method !== null && moduleMockMethods.has(method) && isMockUtility(sourceCode, callee.object);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest, Jest and Rstest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
