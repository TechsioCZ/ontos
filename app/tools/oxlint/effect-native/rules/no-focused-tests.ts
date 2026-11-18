/**
 * effect-native/no-focused-tests
 *
 * A focused registration (`.only`) silently skips every other test in its file, and in CI it turns
 * a full suite into a partial one that still reports green. Oxlint's built-in
 * `vitest/no-focused-tests` matches spellings of Vitest globals: it misses Rstest imports
 * (`@rstest/core`, `effect-rstest`), aliases (`import { it as register }`), namespace imports
 * and the Effect testers `it.effect.only`, `it.live.only` and `it.layer(L)(…, (it) => it.effect.only(…))`.
 *
 * What is detected
 * - Any `.only` member (also `["only"]`) reached from a test registration API through member and
 *   call steps: `it.only`, `describe.only`, `test.only.each(…)`, `it.effect.only`, `it.live.only`,
 *   `it.concurrent.only`, `runner.it.only` for `import * as runner`, `register.only` for
 *   `import { it as register }`, the `effect`/`live` exports of `effect-rstest`, and the `it` an
 *   `effect-rstest` layer hands its callback.
 * - Registration APIs are recognised by binding (see `anti-slop/shared/test-framework-bindings.ts`):
 *   imports from `vitest`, `@jest/globals`, `@rstest/core` and `effect-rstest`, or the unresolved
 *   `it` / `test` / `describe` globals.
 *
 * What is deliberately allowed
 * - Local values that shadow a test name (`const it = { only() {} }`) and unrelated `only` methods.
 * - Source text inside strings and templates, such as rule-tester fixtures.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree, SourceCode } from '@oxlint/plugins';

import { isTestRegistration, memberName } from '../../anti-slop/shared/test-framework-bindings.ts';

/** Walks from the object of `.only` back through member and call steps to a registration API. */
function reachesTestRegistration(sourceCode: SourceCode, start: ESTree.Node): boolean {
  let node = start;
  for (;;) {
    if (isTestRegistration(sourceCode, node)) return true;
    if (node.type === 'MemberExpression') node = node.object;
    else if (node.type === 'CallExpression') node = node.callee;
    else return false;
  }
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow focused tests (`.only`) on Rstest, effect-rstest, Vitest and Jest registrations, including aliases, namespaces and Effect testers.',
    },
    messages: {
      focused:
        'Remove `.only`: a focused test skips every other test in its file, so the suite passes without running them.',
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (memberName(node) !== 'only') return;
        if (reachesTestRegistration(context.sourceCode, node.object)) {
          context.report({ node: node.property, messageId: 'focused' });
        }
      },
    };
  },
});
