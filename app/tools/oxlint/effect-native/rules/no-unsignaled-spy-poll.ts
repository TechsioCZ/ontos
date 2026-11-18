/**
 * effect-native/no-unsignaled-spy-poll
 *
 * Polling a spy until it has been called races a deadline instead of awaiting the event that records
 * the call: under CPU load the poll times out, and a longer timeout only hides that. Adapted from
 * Landmines' `no-unsignaled-poll`, narrowed to proofs that the polled value is spy state so that DOM and
 * data polling stay valid.
 *
 * What is detected
 * - A Testing Library `waitFor` (named, aliased or namespace import from `@testing-library/*`) or a
 *   framework `rs.waitFor` / `rs.waitUntil` (also `rstest`, `vi`) whose callback asserts spy state:
 *   `expect(spy).toHaveBeenCalled*()`, `toHaveReturned*`, `toHaveResolved*` (also under `.not`), or any
 *   expression that reads a recorder such as `spy.mock.calls`. A block callback is reported when any of
 *   its top-level statements polls spy state.
 * - `expect.poll(() => spy.mock.calls.length)` and `expect.poll(() => spy).toHaveBeenCalled()`.
 * - `expect` is recognised by binding: a framework import (any alias or namespace) or the global.
 *
 * What is deliberately allowed
 * - Polling the DOM or data: `waitFor(() => expect(screen.getByText("Saved")).toBeTruthy())`, and
 *   `toHaveLength` on anything that is not a spy recorder.
 * - Local functions named `waitFor`, including Effect helpers.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree, SourceCode } from '@oxlint/plugins';

import {
  isFrameworkExport,
  isMockUtility,
  memberName,
  resolveVariable,
} from '../../anti-slop/shared/test-framework-bindings.ts';

const testingLibrary = /^@testing-library\/[a-z-]+$/u;
const spyMatcher =
  /^(?:toHaveBeenCalled|toHaveBeenCalledOnce|toHaveBeenCalledTimes|toHaveBeenCalledWith|toHaveBeenCalledExactlyOnceWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toHaveReturned|toHaveReturnedTimes|toHaveReturnedWith|toHaveLastReturnedWith|toHaveNthReturnedWith|toHaveResolved|toHaveResolvedTimes|toHaveResolvedWith|toHaveLastResolvedWith|toHaveNthResolvedWith)$/u;
const recorderFields: ReadonlySet<string> = new Set([
  'calls',
  'contexts',
  'instances',
  'invocationCallOrder',
  'lastCall',
  'results',
  'settledResults',
]);
const frameworkPolls: ReadonlySet<string> = new Set(['waitFor', 'waitUntil']);
const assertionModifiers: ReadonlySet<string> = new Set(['not', 'rejects', 'resolves']);

/** How a local binds Testing Library: its `waitFor` export (any alias), a namespace import, or neither. */
function testingLibraryBinding(sourceCode: SourceCode, local: ESTree.Node): 'namespace' | 'waitFor' | null {
  for (const definition of resolveVariable(sourceCode, local)?.defs ?? []) {
    const declaration = definition.parent;
    if (definition.type !== 'ImportBinding' || declaration?.type !== 'ImportDeclaration') continue;
    if (!testingLibrary.test(declaration.source.value)) continue;
    const specifier = definition.node;
    if (specifier.type === 'ImportNamespaceSpecifier') return 'namespace';
    if (specifier.type !== 'ImportSpecifier') continue;
    const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
    if (imported === 'waitFor') return 'waitFor';
  }
  return null;
}

/** `waitFor` from Testing Library, or `rs.waitFor` / `rs.waitUntil` from the test framework. */
function isPollCall(sourceCode: SourceCode, callee: ESTree.Node): boolean {
  if (callee.type === 'Identifier') return testingLibraryBinding(sourceCode, callee) === 'waitFor';
  if (callee.type !== 'MemberExpression') return false;
  const name = memberName(callee);
  if (name !== null && frameworkPolls.has(name) && isMockUtility(sourceCode, callee.object)) return true;
  return name === 'waitFor' && testingLibraryBinding(sourceCode, callee.object) === 'namespace';
}

/** `spy.mock.calls` and the other recorder fields, anywhere in a value outside nested functions. */
function readsRecorder(node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  switch (node.type) {
    case 'MemberExpression':
      if (recorderFields.has(memberName(node) ?? '') && memberName(node.object) === 'mock') return true;
      return readsRecorder(node.object) || (node.computed && readsRecorder(node.property));
    case 'CallExpression':
      return readsRecorder(node.callee) || node.arguments.some((argument) => readsRecorder(argument));
    case 'ChainExpression':
      return readsRecorder(node.expression);
    case 'AwaitExpression':
    case 'SpreadElement':
    case 'UnaryExpression':
      return readsRecorder(node.argument);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return readsRecorder(node.left) || readsRecorder(node.right);
    case 'ConditionalExpression':
      return readsRecorder(node.test) || readsRecorder(node.consequent) || readsRecorder(node.alternate);
    case 'ArrayExpression':
      return node.elements.some((element) => readsRecorder(element));
    default:
      return false;
  }
}

/** `expect(subject)[.not|.resolves|.rejects].matcher(…)` → `{ subject, matcher }`. */
function assertion(
  sourceCode: SourceCode,
  node: ESTree.Node,
): { readonly subject: ESTree.Node | undefined; readonly matcher: string } | null {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return null;
  const matcher = memberName(node.callee);
  let target: ESTree.Node = node.callee.object;
  while (target.type === 'MemberExpression' && assertionModifiers.has(memberName(target) ?? '')) target = target.object;
  if (matcher === null || target.type !== 'CallExpression' || !isFrameworkExport(sourceCode, target.callee, 'expect')) {
    return null;
  }
  return { subject: target.arguments[0], matcher };
}

function pollsSpy(sourceCode: SourceCode, value: ESTree.Node): boolean {
  const unwrapped = value.type === 'AwaitExpression' ? value.argument : value;
  const asserted = assertion(sourceCode, unwrapped);
  if (asserted !== null) return spyMatcher.test(asserted.matcher) || readsRecorder(asserted.subject);
  return readsRecorder(unwrapped);
}

/** The values a poll callback produces: its expression body, or each top-level statement of its block. */
function polledValues(callback: ESTree.Node | undefined): readonly ESTree.Node[] {
  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') return [];
  const { body } = callback;
  if (body === null || body === undefined) return [];
  if (body.type !== 'BlockStatement') return [body];
  return body.body.flatMap((statement) => {
    if (statement.type === 'ExpressionStatement') return [statement.expression];
    if (statement.type === 'ReturnStatement' && statement.argument !== null && statement.argument !== undefined) {
      return [statement.argument];
    }
    return [];
  });
}

/** `expect.poll(cb)[.not].toHaveBeenCalled*()`: the matcher applied to the poll result. */
function pollMatcher(poll: ESTree.CallExpression): string | null {
  const first = poll.parent;
  if (first?.type !== 'MemberExpression' || first.object !== poll) return null;
  if (memberName(first) !== 'not') return memberName(first);
  const second = first.parent;
  return second?.type === 'MemberExpression' && second.object === first ? memberName(second) : null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow waitFor and expect.poll on spy state, which race a deadline instead of awaiting a signal.',
    },
    messages: {
      poll: 'Await a signal instead of polling a spy: resolve a Deferred or Promise.withResolvers() from the callback the spy records, then await it, or await the operation’s own completion. A deadline-bound poll on spy state fails under CPU load, and a longer timeout only hides that.',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const { sourceCode } = context;
        const { callee } = node;
        const isExpectPoll =
          callee.type === 'MemberExpression' &&
          memberName(callee) === 'poll' &&
          isFrameworkExport(sourceCode, callee.object, 'expect');
        if (!isExpectPoll && !isPollCall(sourceCode, callee)) return;
        const values = polledValues(node.arguments[0]);
        const polled = isExpectPoll
          ? values.some((value) => readsRecorder(value)) || spyMatcher.test(pollMatcher(node) ?? '')
          : values.some((value) => pollsSpy(sourceCode, value));
        if (polled) context.report({ node, messageId: 'poll' });
      },
    };
  },
});
