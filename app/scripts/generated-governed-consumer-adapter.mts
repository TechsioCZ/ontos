import type { createModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import type {
  ArrowFunctionExpression,
  CallExpression,
  ExportNamedDeclaration,
  Identifier,
  ImportDeclaration,
  Node,
} from '@babel/types';

/** The native providers a proven facade may reach: Effect, Schema and the randomness correlation source. */
const nativeNamespaces = ['Effect', 'Random', 'Schema'] as const;

export interface GovernedConsumerDeclaration {
  readonly expression: Node;
  readonly module: SourceModule;
}

interface AdapterProof {
  readonly graph: ReturnType<typeof createModuleGraph>;
  readonly isOwnerSource: (module: SourceModule) => boolean;
  /** Only the existing governed operation/enrollment proof may supply this schema. */
  readonly originalRequestSchema: (operation: GovernedConsumerDeclaration) => GovernedConsumerDeclaration | undefined;
  readonly selected: GovernedConsumerDeclaration;
}

interface AdapterContext extends AdapterProof {
  readonly module: SourceModule;
  readonly originals: Map<Node, GovernedConsumerDeclaration | undefined>;
}

interface AdapterTransform {
  readonly callback: ArrowFunctionExpression;
  readonly input: Node;
}

const sameDeclaration = (left: GovernedConsumerDeclaration | undefined, right: GovernedConsumerDeclaration): boolean =>
  left?.module.path === right.module.path && left.expression === right.expression;

const identifier = (node: Node | null | undefined, name: string): boolean =>
  node?.type === 'Identifier' && node.name === name;

const expressionArrow = (node: Node | null | undefined): ArrowFunctionExpression | undefined =>
  node?.type === 'ArrowFunctionExpression' && !node.async && node.body.type !== 'BlockStatement' ? node : undefined;

const blockArrow = (node: Node | null | undefined): ArrowFunctionExpression | undefined =>
  node?.type === 'ArrowFunctionExpression' && !node.async && node.body.type === 'BlockStatement' ? node : undefined;

const exactCall = (node: Node | null | undefined, count: number): CallExpression | undefined =>
  node?.type === 'CallExpression' && node.arguments.length === count ? node : undefined;

const namedParameters = (fn: ArrowFunctionExpression, count: number): readonly Identifier[] | undefined => {
  if (fn.params.length !== count) {
    return undefined;
  }
  const parameters: Identifier[] = [];
  for (const parameter of fn.params) {
    if (parameter.type !== 'Identifier') {
      return undefined;
    }
    parameters.push(parameter);
  }
  return parameters;
};

const requestSchema = (context: AdapterContext, operation: GovernedConsumerDeclaration) => {
  const { originalRequestSchema, originals } = context;
  if (!originals.has(operation.expression)) {
    originals.set(operation.expression, originalRequestSchema(operation));
  }
  return originals.get(operation.expression);
};

const resolve = (context: AdapterContext, node: Node | null | undefined): GovernedConsumerDeclaration | undefined => {
  if (node?.type !== 'Identifier' && node?.type !== 'MemberExpression') {
    return undefined;
  }
  const binding = context.graph.resolveReference(context.module, node);
  return binding?.kind === 'declaration' && context.isOwnerSource(binding.module) ? binding : undefined;
};

const native = (
  context: AdapterContext,
  node: Node,
  namespace: 'Effect' | 'Random' | 'Schema',
  member?: string,
): boolean => {
  const values = context.graph.evaluate(context.module, node);
  if (values.length !== 1) {
    return false;
  }
  const [value] = values;
  return (
    value?.kind === 'external' &&
    ((value.specifier === 'effect' && value.name === namespace && value.members.join('.') === (member ?? '')) ||
      (value.specifier === `effect/${namespace}` &&
        ((value.name === '*' && value.members.join('.') === (member ?? '')) ||
          (member !== undefined && value.name === member && value.members.length === 0))))
  );
};

const transform = (
  context: AdapterContext,
  fn: ArrowFunctionExpression,
  kind: 'flatMap' | 'map',
): AdapterTransform | undefined => {
  const pipeline = exactCall(fn.body, 1);
  if (
    pipeline === undefined ||
    pipeline.callee.type !== 'MemberExpression' ||
    pipeline.callee.computed ||
    !identifier(pipeline.callee.property, 'pipe')
  ) {
    return undefined;
  }
  const [stepNode] = pipeline.arguments;
  const step = exactCall(stepNode, 1);
  if (step === undefined || !native(context, step.callee, 'Effect', kind)) {
    return undefined;
  }
  const [callbackNode] = step.arguments;
  const callback = expressionArrow(callbackNode);
  return callback !== undefined && namedParameters(callback, 1) !== undefined
    ? { callback, input: pipeline.callee.object }
    : undefined;
};

const forwardingParameters = (fn: ArrowFunctionExpression) => {
  const [payload, rest] = fn.params;
  return fn.params.length === 2 &&
    payload?.type === 'Identifier' &&
    payload.optional !== true &&
    rest?.type === 'RestElement' &&
    rest.argument.type === 'Identifier'
    ? { payload, rest: rest.argument }
    : undefined;
};

const decodedSchema = (
  context: AdapterContext,
  input: Node,
  payload: string,
): GovernedConsumerDeclaration | undefined => {
  const invocation = exactCall(input, 1);
  if (invocation === undefined || !identifier(invocation.arguments[0], payload)) {
    return undefined;
  }
  const decode = exactCall(invocation.callee, 1);
  return decode !== undefined && native(context, decode.callee, 'Schema', 'decodeEffect')
    ? resolve(context, decode.arguments[0])
    : undefined;
};

const forwardedOperation = (
  context: AdapterContext,
  callback: ArrowFunctionExpression,
  rest: string,
): GovernedConsumerDeclaration | undefined => {
  const forwarded = exactCall(callback.body, 2);
  if (forwarded === undefined) {
    return undefined;
  }
  const [decoded] = callback.params;
  const [value, invocation] = forwarded.arguments;
  return decoded?.type === 'Identifier' &&
    identifier(value, decoded.name) &&
    invocation?.type === 'SpreadElement' &&
    identifier(invocation.argument, rest) &&
    decoded.name !== rest
    ? resolve(context, forwarded.callee)
    : undefined;
};

const decodeForward = (
  context: AdapterContext,
  fn: ArrowFunctionExpression,
): GovernedConsumerDeclaration | undefined => {
  const parameters = forwardingParameters(fn);
  const pipeline = transform(context, fn, 'flatMap');
  if (parameters === undefined || pipeline === undefined) {
    return undefined;
  }
  const schema = decodedSchema(context, pipeline.input, parameters.payload.name);
  const operation = forwardedOperation(context, pipeline.callback, parameters.rest.name);
  const expected = operation === undefined ? undefined : requestSchema(context, operation);
  return schema !== undefined && expected !== undefined && sameDeclaration(schema, expected) ? operation : undefined;
};

const purePayload = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const [view] = namedParameters(fn, 1) ?? [];
  const { body } = fn;
  if (
    view === undefined ||
    body.type !== 'ConditionalExpression' ||
    body.test.type !== 'BinaryExpression' ||
    body.test.operator !== '===' ||
    !identifier(body.test.left, view.name) ||
    !identifier(body.test.right, 'undefined') ||
    !context.graph.isUnboundReference(context.module, body.test.right) ||
    body.consequent.type !== 'ObjectExpression' ||
    body.consequent.properties.length !== 0 ||
    body.alternate.type !== 'ObjectExpression' ||
    body.alternate.properties.length !== 1
  ) {
    return false;
  }
  const [property] = body.alternate.properties;
  return (
    property?.type === 'ObjectProperty' &&
    !property.computed &&
    property.key.type === 'Identifier' &&
    identifier(property.value, view.name)
  );
};

const hasCorrelationInvocation = (operation: GovernedConsumerDeclaration): boolean => {
  const fn = expressionArrow(operation.expression);
  const [, invocation] = fn?.params ?? [];
  return (
    invocation?.type === 'RestElement' &&
    invocation.argument.type === 'ArrayPattern' &&
    invocation.argument.elements.length === 2 &&
    invocation.argument.elements[0]?.type === 'Identifier' &&
    invocation.argument.elements[1]?.type === 'AssignmentPattern'
  );
};

const hasPurePayloadInvocation = (context: AdapterContext, input: Node, view: string, correlation: string): boolean => {
  const invocation = exactCall(input, 2);
  if (invocation === undefined) {
    return false;
  }
  const [payloadNode, correlationNode] = invocation.arguments;
  const payload = exactCall(payloadNode, 1);
  if (payload === undefined || !identifier(payload.arguments[0], view) || !identifier(correlationNode, correlation)) {
    return false;
  }
  const payloadBuilder = resolve(context, payload.callee);
  const fn = expressionArrow(payloadBuilder?.expression);
  return payloadBuilder?.module.path === context.module.path && fn !== undefined && purePayload(context, fn);
};

const isCollectionProjection = (selector: ArrowFunctionExpression): boolean => {
  const [response] = selector.params;
  const { body } = selector;
  return (
    response?.type === 'Identifier' &&
    body.type === 'MemberExpression' &&
    !body.computed &&
    identifier(body.object, response.name) &&
    body.property.type === 'Identifier'
  );
};

const projection = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const [correlation, view] = namedParameters(fn, 2) ?? [];
  if (correlation === undefined || correlation.optional === true || view === undefined) {
    return false;
  }
  const pipeline = transform(context, fn, 'map');
  const invocation = pipeline === undefined ? undefined : exactCall(pipeline.input, 2);
  if (pipeline === undefined || invocation === undefined) {
    return false;
  }
  const operation = resolve(context, invocation.callee);
  const operationArrow = expressionArrow(operation?.expression);
  if (operation?.module.path !== context.module.path || operationArrow === undefined) {
    return false;
  }
  const original = decodeForward(context, operationArrow);
  return (
    original !== undefined &&
    hasCorrelationInvocation(original) &&
    hasPurePayloadInvocation(context, pipeline.input, view.name, correlation.name) &&
    isCollectionProjection(pipeline.callback)
  );
};

/** A side-effect-free default value the module owner generated: literals, and closed literals-only collections. */
const pureDefault = (node: Node | null | undefined): boolean => {
  if (node?.type === 'ArrayExpression') {
    return node.elements.every(
      (element) => element !== null && element.type !== 'SpreadElement' && pureDefault(element),
    );
  }
  if (node?.type === 'ObjectExpression') {
    return node.properties.every(
      (property) => property.type === 'ObjectProperty' && !property.computed && pureDefault(property.value),
    );
  }
  return (
    node?.type === 'BooleanLiteral' ||
    node?.type === 'NullLiteral' ||
    node?.type === 'NumericLiteral' ||
    node?.type === 'StringLiteral'
  );
};

/** A forwarded parameter: a plain name, or a name with a pure owner-generated default. */
const forwardingParameter = (node: Node | null | undefined): Identifier | undefined => {
  if (node?.type === 'Identifier') {
    return node.optional === true ? undefined : node;
  }
  return node?.type === 'AssignmentPattern' &&
    node.left.type === 'Identifier' &&
    node.left.optional !== true &&
    pureDefault(node.right)
    ? node.left
    : undefined;
};

/**
 * The proven governed operation a facade forwards to: either the generated client operation itself, whose exact
 * request schema the existing enrollment proof supplies, or a same-module decode/forward operation over it.
 */
const governedOperation = (context: AdapterContext, callee: Node): GovernedConsumerDeclaration | undefined => {
  const operation = resolve(context, callee);
  if (operation === undefined) {
    return undefined;
  }
  if (requestSchema(context, operation) !== undefined) {
    return operation;
  }
  const arrow = expressionArrow(operation.expression);
  return operation.module.path === context.module.path && arrow !== undefined
    ? decodeForward(context, arrow)
    : undefined;
};

/** Only the public operation, whose invocation is the correlation and its options, never a credential slot. */
const governedPublicOperation = (context: AdapterContext, callee: Node): boolean => {
  const operation = governedOperation(context, callee);
  return operation !== undefined && hasCorrelationInvocation(operation);
};

/**
 * Prove a facade that forwards its payload and the whole invocation to a proven governed public operation:
 * `(payload, ...invocation) => operation(payload, ...invocation)`.
 */
const forwardedRead = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const [payloadNode, restNode] = fn.params;
  const payload = forwardingParameter(payloadNode);
  if (payload === undefined || restNode?.type !== 'RestElement' || restNode.argument.type !== 'Identifier') {
    return false;
  }
  const rest = restNode.argument;
  const forwarded = fn.params.length === 2 ? exactCall(fn.body, 2) : undefined;
  if (forwarded === undefined || payload.name === rest.name) {
    return false;
  }
  const [value, invocation] = forwarded.arguments;
  return (
    identifier(value, payload.name) &&
    invocation?.type === 'SpreadElement' &&
    identifier(invocation.argument, rest.name) &&
    governedPublicOperation(context, forwarded.callee)
  );
};

/** A pure, never-computed member-access chain over a bound name of at least `minimum` levels. */
const memberProjection = (node: Node | null | undefined, name: string, minimum: number): boolean => {
  let current = node;
  let depth = 0;
  while (current?.type === 'MemberExpression') {
    if (current.computed || current.property.type !== 'Identifier') {
      return false;
    }
    depth += 1;
    current = current.object;
  }
  return depth >= minimum && identifier(current, name);
};

/** A pure member-access chain over the response: `response.state.invoices` (two or more levels, never computed). */
const nestedProjection = (selector: ArrowFunctionExpression): boolean => {
  const [response] = namedParameters(selector, 1) ?? [];
  return response !== undefined && memberProjection(selector.body, response.name, 2);
};

/**
 * Prove a facade that forwards its three pure arguments to a proven governed public operation and returns one
 * nested collection of its response:
 * `(payload, correlation, options) => operation(payload, correlation, options).pipe(Effect.map((response) => …))`.
 */
const forwardedProjection = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const pipeline = fn.params.length === 3 ? transform(context, fn, 'map') : undefined;
  if (pipeline === undefined) {
    return false;
  }
  const [payloadNode, correlationNode, optionsNode] = fn.params;
  const payload = forwardingParameter(payloadNode);
  const correlation = forwardingParameter(correlationNode);
  const options = forwardingParameter(optionsNode);
  if (
    payload === undefined ||
    correlation === undefined ||
    options === undefined ||
    payload.name === correlation.name ||
    payload.name === options.name ||
    correlation.name === options.name
  ) {
    return false;
  }
  const invocation = exactCall(pipeline.input, 3);
  if (invocation === undefined) {
    return false;
  }
  const [forwardedPayload, forwardedCorrelation, forwardedOptions] = invocation.arguments;
  return (
    identifier(forwardedPayload, payload.name) &&
    identifier(forwardedCorrelation, correlation.name) &&
    identifier(forwardedOptions, options.name) &&
    governedPublicOperation(context, invocation.callee) &&
    nestedProjection(pipeline.callback)
  );
};

/** A pure label over the bound correlation values and literals, e.g. `` `work-tasks:list:${first}:${second}` ``. */
const correlationLabel = (node: Node | null | undefined, bound: ReadonlySet<string>): boolean => {
  if (node?.type === 'Identifier') {
    return bound.has(node.name);
  }
  if (node?.type === 'TemplateLiteral') {
    return node.expressions.every((expression) => expression.type === 'Identifier' && bound.has(expression.name));
  }
  return node?.type === 'NumericLiteral' || node?.type === 'StringLiteral';
};

interface CorrelationPipeline {
  readonly arity: number;
  readonly bound: ReadonlySet<string>;
  readonly label: Node;
  readonly source: Node;
}

/** The `Effect.map` label and its bound names from a correlation pipeline `source.pipe(Effect.map(callback))`. */
const correlationPipeline = (context: AdapterContext, expression: Node): CorrelationPipeline | undefined => {
  const pipeline = exactCall(expression, 1);
  if (
    pipeline === undefined ||
    pipeline.callee.type !== 'MemberExpression' ||
    pipeline.callee.computed ||
    !identifier(pipeline.callee.property, 'pipe')
  ) {
    return undefined;
  }
  const step = exactCall(pipeline.arguments[0], 1);
  if (step === undefined || !native(context, step.callee, 'Effect', 'map')) {
    return undefined;
  }
  const callback = expressionArrow(step.arguments[0]);
  const [parameter] = callback?.params ?? [];
  if (callback === undefined || callback.params.length !== 1 || parameter?.type !== 'ArrayPattern') {
    return undefined;
  }
  const bound = new Set<string>();
  for (const element of parameter.elements) {
    if (element?.type !== 'Identifier') {
      return undefined;
    }
    bound.add(element.name);
  }
  return { arity: parameter.elements.length, bound, label: callback.body, source: pipeline.callee.object };
};

/** The native randomness source of a correlation effect: `Effect.all` over `Random.nextInt` and a pure options value. */
const randomSource = (context: AdapterContext, node: Node, arity: number): boolean => {
  const call = exactCall(node, 2);
  if (call === undefined || !native(context, call.callee, 'Effect', 'all')) {
    return false;
  }
  const [elements, options] = call.arguments;
  return (
    arity > 0 &&
    elements?.type === 'ArrayExpression' &&
    elements.elements.length === arity &&
    pureDefault(options) &&
    elements.elements.every(
      (element) =>
        element !== null && element.type !== 'SpreadElement' && native(context, element, 'Random', 'nextInt'),
    )
  );
};

/**
 * Prove native correlation generation: `Effect.all` over native `Random.nextInt` values mapped to a pure label.
 * Nothing else, and no I/O, can reach this expression.
 */
const isCorrelationEffect = (context: AdapterContext, expression: Node): boolean => {
  const pipeline = correlationPipeline(context, expression);
  return (
    pipeline !== undefined &&
    randomSource(context, pipeline.source, pipeline.arity) &&
    correlationLabel(pipeline.label, pipeline.bound)
  );
};

/** The same proof for a module-local correlation helper the facade refers to by name. */
const resolvedCorrelationEffect = (context: AdapterContext, node: Node): boolean => {
  const declaration = resolve(context, node);
  return declaration?.module.path === context.module.path && isCorrelationEffect(context, declaration.expression);
};

/**
 * Prove a facade that generates its own correlation from native randomness and forwards one pure payload and that
 * correlation to a proven governed public operation: `(payload = pure) => correlation.pipe(Effect.flatMap(…))`.
 */
const randomForwardedRead = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const [payloadNode] = fn.params;
  const payload = forwardingParameter(payloadNode);
  if (fn.params.length !== 1 || payload === undefined) {
    return false;
  }
  const pipeline = transform(context, fn, 'flatMap');
  if (pipeline === undefined) {
    return false;
  }
  const [correlation] = namedParameters(pipeline.callback, 1) ?? [];
  if (correlation === undefined || correlation.optional === true) {
    return false;
  }
  const invocation = exactCall(pipeline.callback.body, 2);
  if (invocation === undefined) {
    return false;
  }
  const [forwardedPayload, forwardedCorrelation] = invocation.arguments;
  return (
    identifier(forwardedPayload, payload.name) &&
    identifier(forwardedCorrelation, correlation.name) &&
    governedPublicOperation(context, invocation.callee) &&
    resolvedCorrelationEffect(context, pipeline.input)
  );
};

interface YieldBinding {
  readonly argument: Node;
  readonly name: string;
}

/** `const <name> = yield* <expression>` — the single delegated yield binding of a correlation generator. */
const yieldBinding = (statement: Node | undefined): YieldBinding | undefined => {
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1) {
    return undefined;
  }
  const [declarator] = statement.declarations;
  const init = declarator?.init;
  if (declarator?.id.type !== 'Identifier' || init?.type !== 'YieldExpression' || !init.delegate) {
    return undefined;
  }
  const { argument } = init;
  return argument === null || argument === undefined ? undefined : { argument, name: declarator.id.name };
};

/** The statements of an `Effect.fn('name')(function* () { … })` generator factory. */
const namedGeneratorStatements = (context: AdapterContext, expression: Node): readonly Node[] | undefined => {
  const factory = exactCall(expression, 1);
  if (factory === undefined) {
    return undefined;
  }
  const named = exactCall(factory.callee, 1);
  if (
    named === undefined ||
    !native(context, named.callee, 'Effect', 'fn') ||
    named.arguments[0]?.type !== 'StringLiteral'
  ) {
    return undefined;
  }
  const [generator] = factory.arguments;
  return generator?.type === 'FunctionExpression' &&
    generator.generator &&
    !generator.async &&
    generator.params.length === 0 &&
    generator.body.type === 'BlockStatement'
    ? generator.body.body
    : undefined;
};

/**
 * Prove an `Effect.fn` generator facade that binds one native `Random` correlation, forwards one pure payload and
 * that correlation to a proven governed public operation, and returns one collection of its response.
 */
const generatorForwardedRead = (context: AdapterContext, expression: Node): boolean => {
  const statements = namedGeneratorStatements(context, expression);
  if (statements === undefined || statements.length !== 3) {
    return false;
  }
  const [correlationStatement, readStatement, returnStatement] = statements;
  const correlation = yieldBinding(correlationStatement);
  const read = yieldBinding(readStatement);
  if (correlation === undefined || read === undefined || correlation.name === read.name) {
    return false;
  }
  if (!native(context, correlation.argument, 'Random', 'nextInt')) {
    return false;
  }
  const invocation = exactCall(read.argument, 2);
  if (invocation === undefined) {
    return false;
  }
  const [payload, forwardedCorrelation] = invocation.arguments;
  return (
    pureDefault(payload) &&
    correlationLabel(forwardedCorrelation, new Set([correlation.name])) &&
    governedPublicOperation(context, invocation.callee) &&
    returnStatement?.type === 'ReturnStatement' &&
    memberProjection(returnStatement.argument, read.name, 1)
  );
};

/** The name of a block body's leading `const <name> = <pure value>` options binding. */
const pureOptionsBinding = (statement: Node | undefined): string | undefined => {
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1) {
    return undefined;
  }
  const [declarator] = statement.declarations;
  return declarator?.id.type === 'Identifier' && pureDefault(declarator.init) ? declarator.id.name : undefined;
};

/**
 * Prove a block-bodied facade that binds one pure options value and forwards its payload, correlation and that
 * options to a proven governed public operation: `(payload, correlation) => { const options = pure; return … }`.
 */
const freshForwardedRead = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const [payloadNode, correlationNode] = fn.params;
  const payload = forwardingParameter(payloadNode);
  const correlation = forwardingParameter(correlationNode);
  if (
    fn.params.length !== 2 ||
    payload === undefined ||
    correlation === undefined ||
    payload.name === correlation.name ||
    fn.body.type !== 'BlockStatement' ||
    fn.body.body.length !== 2
  ) {
    return false;
  }
  const [optionsStatement, returnStatement] = fn.body.body;
  const options = pureOptionsBinding(optionsStatement);
  if (
    options === undefined ||
    options === payload.name ||
    options === correlation.name ||
    returnStatement?.type !== 'ReturnStatement'
  ) {
    return false;
  }
  const invocation = exactCall(returnStatement.argument, 3);
  if (invocation === undefined) {
    return false;
  }
  const [forwardedPayload, forwardedCorrelation, forwardedOptions] = invocation.arguments;
  return (
    identifier(forwardedPayload, payload.name) &&
    identifier(forwardedCorrelation, correlation.name) &&
    identifier(forwardedOptions, options) &&
    governedPublicOperation(context, invocation.callee)
  );
};

/**
 * Prove a module export that republishes proven governed client operations from their generated client module:
 * `export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts'`. Every specifier must
 * resolve to a declaration the existing enrollment proof accepts, never a blanket export of the module.
 */
const reExportsGovernedOperations = (context: AdapterContext, statement: ExportNamedDeclaration): boolean => {
  if (statement.declaration !== null || statement.source === null) {
    return false;
  }
  if (statement.exportKind === 'type') {
    return true;
  }
  return (
    statement.specifiers.length > 0 &&
    statement.specifiers.every((specifier) => {
      if (specifier.type !== 'ExportSpecifier') {
        return false;
      }
      const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
      const binding = context.graph.resolve(context.module, name, 'export');
      if (binding?.kind !== 'declaration' || !context.isOwnerSource(binding.module)) {
        return false;
      }
      return requestSchema(context, binding) !== undefined;
    })
  );
};

/** The closed forms an expression-bodied facade may take. */
const arrowFacade = (context: AdapterContext, arrow: ArrowFunctionExpression): boolean =>
  decodeForward(context, arrow) !== undefined ||
  projection(context, arrow) ||
  forwardedRead(context, arrow) ||
  forwardedProjection(context, arrow) ||
  randomForwardedRead(context, arrow) ||
  freshForwardedRead(context, arrow);

/** The closed forms a published governed facade may take; pure helpers and correlation effects are not among them. */
const isGovernedFacade = (context: AdapterContext, expression: Node): boolean => {
  const arrow = expressionArrow(expression);
  if (arrow !== undefined) {
    return arrowFacade(context, arrow);
  }
  const block = blockArrow(expression);
  return (block !== undefined && freshForwardedRead(context, block)) || generatorForwardedRead(context, expression);
};

/** Every runtime declaration must be a closed form: a proven facade, a pure helper, or a correlation effect. */
const isAdmissibleDeclaration = (context: AdapterContext, init: Node): boolean => {
  const arrow = expressionArrow(init);
  if (arrow !== undefined) {
    return purePayload(context, arrow) || arrowFacade(context, arrow);
  }
  const block = blockArrow(init);
  return (
    (block !== undefined && freshForwardedRead(context, block)) ||
    generatorForwardedRead(context, init) ||
    isCorrelationEffect(context, init)
  );
};

interface AdapterDeclarations {
  readonly imports: Node[];
  readonly schemas: GovernedConsumerDeclaration[];
  /** The initializer expression of every admissible runtime declaration, in source order. */
  readonly selected: Set<Node>;
}

const inspectImport = (
  context: AdapterContext,
  statement: ImportDeclaration,
  declarations: AdapterDeclarations,
): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }
  if (statement.specifiers.length === 0 || (statement.attributes?.length ?? 0) > 0) {
    return false;
  }
  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type') {
      declarations.imports.push(specifier.local);
      const binding = resolve(context, specifier.local);
      const schema = binding === undefined ? undefined : requestSchema(context, binding);
      if (schema !== undefined) {
        declarations.schemas.push(schema);
      }
    }
  }
  return true;
};

const inspectDeclaration = (context: AdapterContext, statement: Node, declarations: AdapterDeclarations): boolean => {
  if (statement.type === 'ImportDeclaration') {
    return inspectImport(context, statement, declarations);
  }
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  if (declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration') {
    return true;
  }
  if (statement.type === 'ExportNamedDeclaration' && declaration === null && statement.source !== null) {
    return reExportsGovernedOperations(context, statement);
  }
  if (
    statement.type === 'ExportNamedDeclaration' &&
    declaration === null &&
    statement.source === null &&
    statement.specifiers.every(
      (specifier) =>
        specifier.type === 'ExportSpecifier' &&
        context.graph.resolve(
          context.module,
          specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value,
          'local',
        )?.kind === 'declaration',
    )
  ) {
    return true;
  }
  return (
    declaration?.type === 'VariableDeclaration' &&
    declaration.kind === 'const' &&
    declaration.declarations.every((variable) => {
      const { init } = variable;
      if (
        variable.id.type !== 'Identifier' ||
        init === null ||
        init === undefined ||
        !isAdmissibleDeclaration(context, init)
      ) {
        return false;
      }
      declarations.selected.add(init);
      return true;
    })
  );
};

/**
 * Prove exact decode/forward, pure-default forwarding, collection projection, native-random correlation and
 * `Effect.fn` generator forwarding, plus governed-operation republication value flow. Every runtime declaration must
 * be one of these closed forms, not merely reach a native SDK.
 */
export const hasGeneratedGovernedConsumerAdapter = (proof: AdapterProof): boolean => {
  const { module } = proof.selected;
  const { expression } = proof.selected;
  if (!proof.isOwnerSource(module) || module.mutations.length !== 0) {
    return false;
  }
  const context: AdapterContext = { ...proof, module, originals: new Map() };
  const declarations: AdapterDeclarations = { imports: [], schemas: [], selected: new Set() };
  return (
    module.file.program.body.every((statement) => inspectDeclaration(context, statement, declarations)) &&
    declarations.selected.has(expression) &&
    isGovernedFacade(context, expression) &&
    declarations.imports.every((node) => {
      if (nativeNamespaces.some((namespace) => native(context, node, namespace))) {
        return true;
      }
      const binding = resolve(context, node);
      return (
        binding !== undefined &&
        (requestSchema(context, binding) !== undefined ||
          declarations.schemas.some((schema) => sameDeclaration(binding, schema)))
      );
    })
  );
};
