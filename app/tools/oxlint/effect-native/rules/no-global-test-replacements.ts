/**
 * effect-native/no-global-test-replacements
 *
 * A test that swaps the ambient `document`, `window`, `navigator` or `fetch` for a hand-built object
 * proves the code against a fabrication, not against the DOM or HTTP client it runs with, and leaks the
 * replacement into every test that shares the global. Adapted narrowly from Landmines'
 * `no-test-doubles` global-replacement checks: the code under test should receive its fetch through a
 * real seam (`FetchHttpClient.Fetch`, a Layer, a parameter) and its DOM from the test environment.
 *
 * What is detected, in test files only
 * - Assignment: `globalThis.fetch = …`, `window.document = …`, `global.navigator = …`, `fetch = …`.
 * - Descriptor writes on a global object: `Object.defineProperty(globalThis, "document", {…})`,
 *   `Reflect.defineProperty`, `Reflect.set`, `Object.defineProperties(globalThis, { fetch: … })` and
 *   `Object.assign(globalThis, { fetch })`.
 * - Framework stubs: `rs.stubGlobal("fetch", …)` (also `rstest`, `vi`, aliases and namespaces).
 * - Replacing spies: `rs.spyOn(globalThis, "fetch").mockResolvedValue(…)`, directly chained or through
 *   the variable that holds the spy.
 *
 * What is deliberately allowed
 * - Real DOM operations (`document.body.append(…)`, `document.title = …`, `window.dispatchEvent(…)`).
 * - Restoring the original: writing back a descriptor read with `Object.getOwnPropertyDescriptor` or a
 *   value read from the same global.
 * - Observation spies on globals (`rs.spyOn(globalThis, "fetch")` without a replacement method) and
 *   every spy or `mockImplementation` on an injected object, such as faithful scheduling instrumentation
 *   of an SDK adapter.
 * - Other globals (timers, `location`, `crypto`) and non-test files.
 *
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree, SourceCode } from '@oxlint/plugins';

import {
  isMockUtility,
  memberName,
  resolveVariable,
  staticKey,
} from '../../anti-slop/shared/test-framework-bindings.ts';
import { isTestFile, scopePath } from '../shared/paths.ts';

const replacedGlobals: ReadonlySet<string> = new Set(['document', 'fetch', 'navigator', 'window']);
const globalObjects: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);
const replacementMethods: ReadonlySet<string> = new Set([
  'mockImplementation',
  'mockImplementationOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
  'withImplementation',
]);
const builtinNamespaces: ReadonlySet<string> = new Set(['Object', 'Reflect']);
const descriptorReaders: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Reflect.getOwnPropertyDescriptor',
]);

function isUnshadowed(sourceCode: SourceCode, node: ESTree.Node, names: ReadonlySet<string>): boolean {
  if (node.type !== 'Identifier' || !names.has(node.name)) return false;
  const variable = resolveVariable(sourceCode, node);
  return variable === null || variable.defs.length === 0;
}

function isGlobalObject(sourceCode: SourceCode, node: ESTree.Node): boolean {
  return isUnshadowed(sourceCode, node, globalObjects);
}

/** `Object.defineProperty` and friends on the unshadowed `Object` / `Reflect` globals. */
function builtinCall(sourceCode: SourceCode, callee: ESTree.Node): string | null {
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null;
  const method = memberName(callee);
  if (method === null || !isUnshadowed(sourceCode, callee.object, builtinNamespaces)) return null;
  return `${callee.object.name}.${method}`;
}

function stringValue(node: ESTree.Node | undefined): string | null {
  return node === undefined || node.type === 'SpreadElement' ? null : staticKey(node, true);
}

/** `globalThis.fetch`, `window["document"]` or the bare global `fetch`: the replaced name, else null. */
function globalSlot(sourceCode: SourceCode, node: ESTree.Node): string | null {
  if (node.type === 'Identifier') return isUnshadowed(sourceCode, node, replacedGlobals) ? node.name : null;
  if (node.type !== 'MemberExpression' || !isGlobalObject(sourceCode, node.object)) return null;
  const name = memberName(node);
  return name !== null && replacedGlobals.has(name) ? name : null;
}

/** A value saved from the original slot, so writing it back restores rather than fabricates. */
function mutatesMember(reference: ESTree.Node): boolean {
  let node = reference;
  while (node.parent?.type === 'MemberExpression' && node.parent.object === node) node = node.parent;
  if (node === reference) return false;
  const parent = node.parent;
  return (
    (parent?.type === 'AssignmentExpression' && parent.left === node) ||
    (parent?.type === 'UpdateExpression' && parent.argument === node) ||
    (parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === node)
  );
}

function savedOriginalKind(
  sourceCode: SourceCode,
  value: ESTree.Node | undefined,
  name: string,
): 'value' | 'descriptor' | null {
  if (value?.type !== 'Identifier') return null;
  const variable = resolveVariable(sourceCode, value);
  const definition = variable?.defs[0];
  if (definition?.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') return null;
  if (
    variable?.references.some(
      (reference) => (!reference.init && reference.isWrite()) || mutatesMember(reference.identifier),
    )
  ) {
    return null;
  }
  const init = definition.node.init;
  if (init === null || init === undefined) return null;
  if (init.type === 'CallExpression') {
    const reader = builtinCall(sourceCode, init.callee);
    const [target, key] = init.arguments;
    const descriptor =
      reader !== null &&
      descriptorReaders.has(reader) &&
      target !== undefined &&
      target.type !== 'SpreadElement' &&
      isGlobalObject(sourceCode, target) &&
      stringValue(key) === name;
    return descriptor ? 'descriptor' : null;
  }
  return globalSlot(sourceCode, init) === name ? 'value' : null;
}

function isSavedOriginal(sourceCode: SourceCode, value: ESTree.Node | undefined, name: string): boolean {
  return savedOriginalKind(sourceCode, value, name) === 'value';
}

function restoresDescriptor(sourceCode: SourceCode, value: ESTree.Node | undefined, name: string): boolean {
  if (savedOriginalKind(sourceCode, value, name) === 'descriptor') return true;
  if (value?.type !== 'ObjectExpression') return false;
  let originalValue = false;
  for (const property of value.properties) {
    if (property.type !== 'Property' || property.kind !== 'init') return false;
    const key = staticKey(property.key, property.computed);
    if (key === null || key === 'get' || key === 'set') return false;
    if (key === 'value') {
      if (originalValue || !isSavedOriginal(sourceCode, property.value, name)) return false;
      originalValue = true;
    }
  }
  return originalValue;
}

function objectKeys(node: ESTree.Node | undefined): readonly { readonly key: string; readonly value: ESTree.Node }[] {
  if (node?.type !== 'ObjectExpression') return [];
  return node.properties.flatMap((property) => {
    if (property.type !== 'Property') return [];
    const key = staticKey(property.key, property.computed);
    return key === null ? [] : [{ key, value: property.value }];
  });
}

/** Names a builtin descriptor or assignment call writes onto a global object. */
function builtinReplacements(sourceCode: SourceCode, node: ESTree.CallExpression): readonly string[] {
  const builtin = builtinCall(sourceCode, node.callee);
  const [target, key, value] = node.arguments;
  if (builtin === null || target === undefined || target.type === 'SpreadElement') return [];
  if (!isGlobalObject(sourceCode, target)) return [];
  switch (builtin) {
    case 'Object.defineProperty':
    case 'Reflect.defineProperty': {
      const name = stringValue(key);
      return name !== null && replacedGlobals.has(name) && !restoresDescriptor(sourceCode, value, name) ? [name] : [];
    }
    case 'Reflect.set': {
      const name = stringValue(key);
      return name !== null && replacedGlobals.has(name) && !isSavedOriginal(sourceCode, value, name) ? [name] : [];
    }
    case 'Object.defineProperties':
      return objectKeys(key)
        .filter((entry) => replacedGlobals.has(entry.key) && !restoresDescriptor(sourceCode, entry.value, entry.key))
        .map((entry) => entry.key);
    case 'Object.assign':
      return node.arguments
        .slice(1)
        .flatMap((source) => objectKeys(source))
        .filter((entry) => replacedGlobals.has(entry.key) && !isSavedOriginal(sourceCode, entry.value, entry.key))
        .map((entry) => entry.key);
    default:
      return [];
  }
}

/** `rs.stubGlobal("fetch", …)` → `fetch`. */
function stubbedGlobal(sourceCode: SourceCode, node: ESTree.CallExpression): string | null {
  const { callee } = node;
  if (callee.type !== 'MemberExpression' || memberName(callee) !== 'stubGlobal') return null;
  if (!isMockUtility(sourceCode, callee.object)) return null;
  const name = stringValue(node.arguments[0]);
  return name !== null && replacedGlobals.has(name) && !isSavedOriginal(sourceCode, node.arguments[1], name)
    ? name
    : null;
}

/** `rs.spyOn(globalThis, "fetch")` → `fetch`. */
function spiedGlobal(sourceCode: SourceCode, node: ESTree.CallExpression): string | null {
  const { callee } = node;
  if (callee.type !== 'MemberExpression' || memberName(callee) !== 'spyOn') return null;
  if (!isMockUtility(sourceCode, callee.object)) return null;
  const [target, key] = node.arguments;
  if (target === undefined || target.type === 'SpreadElement' || !isGlobalObject(sourceCode, target)) return null;
  const name = stringValue(key);
  return name !== null && replacedGlobals.has(name) ? name : null;
}

/** `<spy>.mockResolvedValue(…)`: the member call that turns an observation spy into a replacement. */
function replacesThrough(node: ESTree.Node): boolean {
  const member = node.parent;
  return (
    member?.type === 'MemberExpression' &&
    member.object === node &&
    replacementMethods.has(memberName(member) ?? '') &&
    member.parent?.type === 'CallExpression' &&
    member.parent.callee === member
  );
}

/** The spy is replaced directly (`spyOn(…).mockX(…)`) or through the `const` that holds it. */
function spyIsReplaced(sourceCode: SourceCode, spy: ESTree.CallExpression): boolean {
  if (replacesThrough(spy)) return true;
  const declarator = spy.parent;
  if (declarator?.type !== 'VariableDeclarator' || declarator.init !== spy || declarator.id.type !== 'Identifier') {
    return false;
  }
  const variable = resolveVariable(sourceCode, declarator.id);
  return variable?.references.some((reference) => replacesThrough(reference.identifier)) ?? false;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow tests that replace the global document, window, navigator or fetch with fabricated stand-ins.',
    },
    messages: {
      replacement:
        'This test replaces the global `{{name}}` with a fabricated stand-in. Hand the code under test its dependency through a real seam (FetchHttpClient.Fetch, a Layer or a parameter) or run it in a real DOM test environment.',
    },
  },
  create(context) {
    if (!isTestFile(scopePath(context.filename))) return {};
    const { sourceCode } = context;
    const report = (node: ESTree.Node, name: string): void => {
      context.report({ node, messageId: 'replacement', data: { name } });
    };
    return {
      AssignmentExpression(node) {
        const name = globalSlot(sourceCode, node.left);
        if (name !== null && !isSavedOriginal(sourceCode, node.right, name)) report(node, name);
      },
      CallExpression(node) {
        for (const name of builtinReplacements(sourceCode, node)) report(node, name);
        const stubbed = stubbedGlobal(sourceCode, node);
        if (stubbed !== null) report(node, stubbed);
        const spied = spiedGlobal(sourceCode, node);
        if (spied !== null && spyIsReplaced(sourceCode, node)) report(node, spied);
      },
    };
  },
});
