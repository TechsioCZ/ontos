import type { createModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { traverseFast } from '@babel/types';
import type { ArrowFunctionExpression, Node } from '@babel/types';

type Graph = ReturnType<typeof createModuleGraph>;

const named = (node: Node | null | undefined, name: string): boolean =>
  node?.type === 'Identifier' && node.name === name;

const nativeCall = (graph: Graph, module: SourceModule, node: Node, namespace: string, member: string): boolean => {
  const values = graph.evaluate(module, node);
  return (
    values.length > 0 &&
    values.every(
      (value) =>
        value.kind === 'external' &&
        ((value.specifier === 'effect' && value.name === namespace && value.members.join('.') === member) ||
          (value.specifier === `effect/${namespace}` &&
            ((value.name === member && value.members.length === 0) ||
              (value.name === '*' && value.members.join('.') === member)))),
    )
  );
};

const singleParameter = (node: Node | null | undefined): ArrowFunctionExpression | undefined =>
  node?.type === 'ArrowFunctionExpression' &&
  !node.async &&
  node.params.length === 1 &&
  node.params[0]?.type === 'Identifier'
    ? node
    : undefined;

const midnightInput = (node: Node | null | undefined, input: string): boolean =>
  node?.type === 'TemplateLiteral' &&
  node.expressions.length === 1 &&
  named(node.expressions[0], input) &&
  node.quasis.length === 2 &&
  node.quasis[0]?.value.cooked === '' &&
  node.quasis[1]?.value.cooked === 'T00:00:00.000Z';

const sameInput = (value: Node | null | undefined, input: Node): boolean =>
  input.type === 'Identifier'
    ? named(value, input.name)
    : input.type === 'MemberExpression' &&
      value?.type === 'MemberExpression' &&
      !input.computed &&
      !value.computed &&
      input.object.type === 'Identifier' &&
      named(value.object, input.object.name) &&
      input.property.type === 'Identifier' &&
      named(value.property, input.property.name);

const datePrefix = (graph: Graph, module: SourceModule, node: Node, input: Node): boolean => {
  if (
    node.type !== 'CallExpression' ||
    node.arguments.length !== 2 ||
    node.arguments[0]?.type !== 'NumericLiteral' ||
    node.arguments[0].value !== 0 ||
    node.arguments[1]?.type !== 'NumericLiteral' ||
    node.arguments[1].value !== 10 ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    !named(node.callee.property, 'slice')
  ) {
    return false;
  }
  const format = node.callee.object;
  if (
    format.type !== 'CallExpression' ||
    format.arguments.length !== 1 ||
    !nativeCall(graph, module, format.callee, 'DateTime', 'formatIso')
  ) {
    return false;
  }
  return sameInput(format.arguments[0], input);
};

const temporalTransform = (graph: Graph, module: SourceModule, node: Node): boolean => {
  const fn = singleParameter(node);
  const [input] = fn?.params ?? [];
  if (fn === undefined || input?.type !== 'Identifier') {
    return false;
  }
  return (
    datePrefix(graph, module, fn.body, input) ||
    (fn.body.type === 'CallExpression' &&
      fn.body.arguments.length === 1 &&
      midnightInput(fn.body.arguments[0], input.name) &&
      nativeCall(graph, module, fn.body.callee, 'DateTime', 'makeUnsafe'))
  );
};

const hasDateLengthGuard = (guard: Node | undefined, input: string): boolean =>
  guard?.type === 'IfStatement' &&
  guard.alternate === null &&
  guard.test.type === 'BinaryExpression' &&
  guard.test.operator === '!==' &&
  guard.test.left.type === 'MemberExpression' &&
  !guard.test.left.computed &&
  named(guard.test.left.object, input) &&
  named(guard.test.left.property, 'length') &&
  guard.test.right.type === 'NumericLiteral' &&
  guard.test.right.value === 10 &&
  guard.consequent.type === 'BlockStatement' &&
  guard.consequent.body.length === 1 &&
  guard.consequent.body[0]?.type === 'ReturnStatement' &&
  guard.consequent.body[0].argument?.type === 'BooleanLiteral' &&
  !guard.consequent.body[0].argument.value;

const parsedCalendarInput = (
  graph: Graph,
  module: SourceModule,
  declaration: Node | undefined,
  input: string,
): string | undefined => {
  if (
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    declaration.declarations.length !== 1
  ) {
    return undefined;
  }
  const [parsed] = declaration.declarations;
  return parsed?.id.type === 'Identifier' &&
    parsed.init?.type === 'CallExpression' &&
    parsed.init.arguments.length === 1 &&
    midnightInput(parsed.init.arguments[0], input) &&
    nativeCall(graph, module, parsed.init.callee, 'DateTime', 'make')
    ? parsed.id.name
    : undefined;
};

const hasDateRoundTrip = (
  graph: Graph,
  module: SourceModule,
  comparison: Node,
  parsed: string,
  input: string,
): boolean => {
  if (
    comparison.type !== 'BinaryExpression' ||
    comparison.operator !== '===' ||
    !named(comparison.right, input) ||
    comparison.left.type !== 'CallExpression'
  ) {
    return false;
  }
  const format = comparison.left.callee.type === 'MemberExpression' ? comparison.left.callee.object : undefined;
  const value = format?.type === 'CallExpression' ? format.arguments[0] : undefined;
  return (
    value?.type === 'MemberExpression' &&
    !value.computed &&
    named(value.object, parsed) &&
    named(value.property, 'value') &&
    datePrefix(graph, module, comparison.left, value)
  );
};

const hasCalendarValidation = (
  graph: Graph,
  module: SourceModule,
  result: Node | undefined,
  parsed: string,
  input: string,
): boolean => {
  if (
    result?.type !== 'ReturnStatement' ||
    result.argument?.type !== 'LogicalExpression' ||
    result.argument.operator !== '&&'
  ) {
    return false;
  }
  const { left, right } = result.argument;
  return (
    left.type === 'CallExpression' &&
    left.arguments.length === 1 &&
    named(left.arguments[0], parsed) &&
    nativeCall(graph, module, left.callee, 'Option', 'isSome') &&
    hasDateRoundTrip(graph, module, right, parsed, input)
  );
};

const calendarFilter = (graph: Graph, module: SourceModule, node: Node): boolean => {
  const fn = singleParameter(node);
  const [input] = fn?.params ?? [];
  if (
    fn === undefined ||
    input?.type !== 'Identifier' ||
    fn.body.type !== 'BlockStatement' ||
    fn.body.body.length !== 3
  ) {
    return false;
  }
  const [guard, declaration, result] = fn.body.body;
  const parsed = parsedCalendarInput(graph, module, declaration, input.name);
  return (
    hasDateLengthGuard(guard, input.name) &&
    parsed !== undefined &&
    hasCalendarValidation(graph, module, result, parsed, input.name)
  );
};

/** Closed date-only parsing/formatting callbacks, never an arbitrary transformation callback. */
export const closedCalendarSchemaNodes = (graph: Graph, module: SourceModule): ReadonlySet<Node> => {
  const closed = new Set<Node>();
  traverseFast(module.file, (node) => {
    if (node.type !== 'CallExpression' || node.arguments.length !== 1) {
      return;
    }
    const [argument] = node.arguments;
    const filter =
      argument !== undefined &&
      nativeCall(graph, module, node.callee, 'Schema', 'makeFilter') &&
      calendarFilter(graph, module, argument);
    const transform =
      argument?.type === 'ObjectExpression' &&
      argument.properties.length === 2 &&
      new Set(
        argument.properties.map((property) =>
          property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier'
            ? property.key.name
            : '',
        ),
      ).size === 2 &&
      argument.properties.every(
        (property) =>
          property.type === 'ObjectProperty' &&
          !property.computed &&
          property.key.type === 'Identifier' &&
          ['decode', 'encode'].includes(property.key.name) &&
          temporalTransform(graph, module, property.value),
      ) &&
      nativeCall(graph, module, node.callee, 'SchemaTransformation', 'transform');
    if (filter || transform) {
      traverseFast(node, (child) => {
        closed.add(child);
      });
    }
  });
  return closed;
};
