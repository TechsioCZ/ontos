import type { Context, ESTree } from '@oxlint/plugins';

import { nearestFunction, parentOf, unwrapNode as unwrap } from '../effect-native/shared/ast.ts';
import { isUnshadowedGlobal, resolveVariable } from '../effect-native/shared/bindings.ts';

type Identifier = Extract<ESTree.Node, { type: 'Identifier' }>;
type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

const runtimeFunction = (node: ESTree.Node): node is RuntimeFunction =>
  node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression';

/** A lexical proof of the generic JSON snapshot algorithm, not a name/path exception.
 * Arrays retain order, fresh object entries are sorted by key, values recurse and scalars
 * pass through. Native JSON encoding then owns undefined omission and array nulls. No
 * entity key, mutation of an input, arbitrary helper or additional statement is accepted.
 */
export function genericJsonCanonicalizerProof(context: Context) {
  const cache = new WeakMap<RuntimeFunction, boolean>();
  const sameBinding = (left: ESTree.Node, right: ESTree.Node): boolean => {
    const a = unwrap(left),
      b = unwrap(right);
    if (a.type !== 'Identifier' || b.type !== 'Identifier') return false;
    const binding = resolveVariable(context, a.name, a);
    return binding !== null && binding === resolveVariable(context, b.name, b);
  };
  const global = (node: ESTree.Node, name: string): boolean => {
    const inner = unwrap(node);
    return inner.type === 'Identifier' && isUnshadowedGlobal(context, inner, name, true);
  };
  const method = (node: ESTree.Node, name: string): ESTree.MemberExpression | null => {
    const member = unwrap(node);
    if (member.type !== 'MemberExpression' || member.computed || member.property.type !== 'Identifier') return null;
    return member.property.name === name ? member : null;
  };
  const call = (node: ESTree.Node, name: string, count: number): ESTree.CallExpression | null => {
    const expression = unwrap(node);
    return expression.type === 'CallExpression' &&
      expression.arguments.length === count &&
      method(expression.callee, name)
      ? expression
      : null;
  };
  const globalCall = (node: ESTree.Node, host: string, name: string): ESTree.CallExpression | null => {
    const expression = call(node, name, 1);
    const member = expression === null ? null : method(expression.callee, name);
    return member !== null && global(member.object, host) ? expression : null;
  };
  const returned = (node: ESTree.Node): ESTree.Node | null => {
    const body = unwrap(node);
    if (body.type !== 'BlockStatement') return body.type === 'ReturnStatement' ? body.argument : body;
    return body.body.length === 1 && body.body[0]?.type === 'ReturnStatement' ? body.body[0].argument : null;
  };
  const functionId = (fn: RuntimeFunction): Identifier | null => {
    if (fn.type !== 'ArrowFunctionExpression' && fn.id !== null) return fn.id;
    const owner = parentOf(fn);
    return owner?.type === 'VariableDeclarator' && owner.id.type === 'Identifier' ? owner.id : null;
  };
  const resolvedFunction = (input: ESTree.Node): RuntimeFunction | null => {
    const node = unwrap(input);
    if (runtimeFunction(node)) return !node.async && !node.generator ? node : null;
    if (node.type !== 'Identifier') return null;
    const binding = resolveVariable(context, node.name, node);
    if (binding === null || binding.defs.length !== 1 || binding.references.some((ref) => ref.isWrite() && !ref.init))
      return null;
    const definition = binding.defs[0]!.node;
    if (definition.type === 'FunctionDeclaration')
      return !definition.async && !definition.generator ? definition : null;
    if (definition.type !== 'VariableDeclarator' || definition.init === null) return null;
    const initializer = unwrap(definition.init);
    return runtimeFunction(initializer) && !initializer.async && !initializer.generator ? initializer : null;
  };
  const pairParameter = (fn: RuntimeFunction, index: number, entry: number, length: number): Identifier | null => {
    const parameter = fn.params[index];
    if (parameter?.type !== 'ArrayPattern' || parameter.elements.length !== length) return null;
    const binding = parameter.elements[entry];
    return binding?.type === 'Identifier' ? binding : null;
  };
  const recursiveValue = (node: ESTree.Node, fn: RuntimeFunction, value: ESTree.Node): boolean => {
    const expression = unwrap(node),
      id = functionId(fn);
    return (
      expression.type === 'CallExpression' &&
      expression.arguments.length === 1 &&
      id !== null &&
      sameBinding(expression.callee, id) &&
      sameBinding(expression.arguments[0]!, value)
    );
  };
  const objectGuard = (node: ESTree.Node, value: ESTree.Node): boolean => {
    const condition = unwrap(node);
    if (condition.type !== 'LogicalExpression' || condition.operator !== '&&') return false;
    const arms = [unwrap(condition.left), unwrap(condition.right)];
    return (
      arms.some(
        (arm) =>
          arm.type === 'BinaryExpression' &&
          arm.operator === '!==' &&
          sameBinding(arm.left, value) &&
          arm.right.type === 'Literal' &&
          arm.right.value === null,
      ) &&
      arms.some(
        (arm) =>
          arm.type === 'BinaryExpression' &&
          arm.operator === '===' &&
          arm.left.type === 'UnaryExpression' &&
          arm.left.operator === 'typeof' &&
          sameBinding(arm.left.argument, value) &&
          arm.right.type === 'Literal' &&
          arm.right.value === 'object',
      )
    );
  };
  const sortedEntries = (input: ESTree.Node, value: ESTree.Node): boolean => {
    const sorted = call(input, 'sort', 1) ?? call(input, 'toSorted', 1);
    if (sorted === null) return false;
    const sorter = resolvedFunction(sorted.arguments[0]!);
    if (sorter === null || sorter.params.length !== 2 || sorter.body === null) return false;
    const a = pairParameter(sorter, 0, 0, 1),
      b = pairParameter(sorter, 1, 0, 1),
      comparison = returned(sorter.body);
    if (a === null || b === null || comparison === null) return false;
    const compare = call(comparison, 'localeCompare', 1);
    if (
      compare === null ||
      !sameBinding(method(compare.callee, 'localeCompare')!.object, a) ||
      !sameBinding(compare.arguments[0]!, b)
    )
      return false;
    const source = unwrap((method(sorted.callee, 'sort') ?? method(sorted.callee, 'toSorted'))!.object);
    const filtered = call(source, 'filter', 1);
    let entries = source;
    if (filtered !== null) {
      const filter = resolvedFunction(filtered.arguments[0]!);
      if (filter === null || filter.params.length !== 1 || filter.body === null) return false;
      const entry = pairParameter(filter, 0, 1, 2),
        condition = returned(filter.body);
      if (
        entry === null ||
        condition === null ||
        condition.type !== 'BinaryExpression' ||
        condition.operator !== '!==' ||
        !sameBinding(condition.left, entry) ||
        !global(condition.right, 'undefined')
      )
        return false;
      if (filter.params[0]?.type !== 'ArrayPattern' || filter.params[0].elements[0] !== null) return false;
      entries = unwrap(method(filtered.callee, 'filter')!.object);
    }
    const enumeration = globalCall(entries, 'Object', 'entries');
    return enumeration !== null && sameBinding(enumeration.arguments[0]!, value);
  };
  const canonicalObject = (input: ESTree.Node, fn: RuntimeFunction, value: ESTree.Node): boolean => {
    const from = globalCall(input, 'Object', 'fromEntries');
    if (from === null) return false;
    const mapped = call(from.arguments[0]!, 'map', 1);
    if (mapped === null || !sortedEntries(method(mapped.callee, 'map')!.object, value)) return false;
    const mapper = resolvedFunction(mapped.arguments[0]!);
    if (mapper === null || mapper.params.length !== 1 || mapper.body === null) return false;
    const key = pairParameter(mapper, 0, 0, 2),
      entry = pairParameter(mapper, 0, 1, 2),
      pair = returned(mapper.body);
    if (key === null || entry === null || pair?.type !== 'ArrayExpression' || pair.elements.length !== 2) return false;
    const [first, second] = pair.elements;
    return (
      first !== null &&
      first !== undefined &&
      second !== null &&
      second !== undefined &&
      sameBinding(first, key) &&
      recursiveValue(second, fn, entry)
    );
  };
  const isCanonicalizer = (input: ESTree.Node): boolean => {
    const fn = resolvedFunction(input);
    if (fn === null) return false;
    const cached = cache.get(fn);
    if (cached !== undefined) return cached;
    cache.set(fn, false);
    const value = fn.params[0],
      id = functionId(fn);
    if (
      fn.async ||
      fn.generator ||
      fn.params.length !== 1 ||
      value?.type !== 'Identifier' ||
      id === null ||
      fn.body?.type !== 'BlockStatement'
    )
      return false;
    const [array, object, scalar, extra] = fn.body.body;
    if (
      extra !== undefined ||
      array?.type !== 'IfStatement' ||
      object?.type !== 'IfStatement' ||
      scalar?.type !== 'ReturnStatement' ||
      array.alternate !== null ||
      object.alternate !== null ||
      scalar.argument === null ||
      !sameBinding(scalar.argument, value)
    )
      return false;
    const guard = globalCall(array.test, 'Array', 'isArray'),
      mappedValue = returned(array.consequent),
      objectValue = returned(object.consequent);
    if (guard === null || !sameBinding(guard.arguments[0]!, value) || mappedValue === null || objectValue === null)
      return false;
    const mapped = call(mappedValue, 'map', 1);
    const valid =
      mapped !== null &&
      sameBinding(method(mapped.callee, 'map')!.object, value) &&
      sameBinding(mapped.arguments[0]!, id) &&
      objectGuard(object.test, value) &&
      canonicalObject(objectValue, fn, value);
    cache.set(fn, valid);
    return valid;
  };
  const isComparison = (input: ESTree.Node): boolean => {
    const fn = resolvedFunction(input);
    if (
      fn === null ||
      fn.async ||
      fn.generator ||
      fn.body === null ||
      fn.params.length !== 2 ||
      fn.params.some((param) => param.type !== 'Identifier')
    )
      return false;
    const expression = returned(fn.body);
    if (expression?.type !== 'BinaryExpression' || !['===', '!=='].includes(expression.operator)) return false;
    const left = globalCall(expression.left, 'JSON', 'stringify'),
      right = globalCall(expression.right, 'JSON', 'stringify');
    if (left === null || right === null) return false;
    const a = unwrap(left.arguments[0]!),
      b = unwrap(right.arguments[0]!);
    if (
      a.type !== 'CallExpression' ||
      b.type !== 'CallExpression' ||
      a.arguments.length !== 1 ||
      b.arguments.length !== 1
    )
      return false;
    const canonical = resolvedFunction(a.callee);
    return (
      canonical !== null &&
      canonical === resolvedFunction(b.callee) &&
      isCanonicalizer(canonical) &&
      sameBinding(a.arguments[0]!, fn.params[0]!) &&
      sameBinding(b.arguments[0]!, fn.params[1]!)
    );
  };
  return {
    isCanonicalizer,
    isComparison,
    isBoundary: (node: ESTree.Node): boolean => isCanonicalizer(node) || isComparison(node),
    isCanonicalStringify: (node: ESTree.Node): boolean => {
      const fn = nearestFunction(node);
      return fn !== null && isComparison(fn);
    },
    isCanonicalTraversal: (node: ESTree.Node): boolean => {
      const fn = nearestFunction(node);
      return fn !== null && isCanonicalizer(fn);
    },
  };
}
