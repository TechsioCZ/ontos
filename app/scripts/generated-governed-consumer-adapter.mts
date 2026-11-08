import type { createModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { isFunction, traverseFast } from '@babel/types';
import type {
  ArrowFunctionExpression,
  CallExpression,
  ExportNamedDeclaration,
  Identifier,
  ImportDeclaration,
  Node,
  VariableDeclarator,
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

/** A payload position built only from the facade's own parameters and closed literals. */
const payloadParameter = (node: Node, parameters: ReadonlySet<string>, used: Set<string>): boolean => {
  if (node.type === 'Identifier') {
    if (!parameters.has(node.name)) {
      return false;
    }
    used.add(node.name);
    return true;
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.every(
      (element) => element !== null && element.type !== 'SpreadElement' && payloadParameter(element, parameters, used),
    );
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.every(
      (property) =>
        property.type === 'ObjectProperty' && !property.computed && payloadParameter(property.value, parameters, used),
    );
  }
  return pureDefault(node);
};

/**
 * A reader payload built from the facade's own parameters and closed literals, using every parameter:
 * `{ subjectKind: kind, tagId }`. A declared input the payload never reaches would be a payload substitution, so
 * every parameter must appear in the payload.
 */
const parameterPayload = (node: Node | null | undefined, parameters: ReadonlySet<string>): boolean => {
  if (node === null || node === undefined || (node.type !== 'ObjectExpression' && node.type !== 'ArrayExpression')) {
    return false;
  }
  const used = new Set<string>();
  return payloadParameter(node, parameters, used) && [...parameters].every((name) => used.has(name));
};

/** `response.rows.map((row) => row.subject.id)`: one pure member chain mapped by a pure member chain. */
const mappedProjection = (node: Node | null | undefined, name: string): boolean => {
  if (
    node?.type !== 'CallExpression' ||
    node.arguments.length !== 1 ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    !identifier(node.callee.property, 'map') ||
    !memberProjection(node.callee.object, name, 1)
  ) {
    return false;
  }
  const selector = expressionArrow(node.arguments[0]);
  if (selector === undefined) {
    return false;
  }
  const [element] = namedParameters(selector, 1) ?? [];
  return element !== undefined && memberProjection(selector.body, element.name, 1);
};

/** A pure response projection: one member chain, or one `.map` of a member chain by a member chain. */
const readProjection = (selector: ArrowFunctionExpression): boolean => {
  const [response] = namedParameters(selector, 1) ?? [];
  return (
    response !== undefined &&
    (memberProjection(selector.body, response.name, 1) || mappedProjection(selector.body, response.name))
  );
};

interface CorrelationReadPipeline {
  readonly correlation: Node;
  readonly projection: ArrowFunctionExpression | undefined;
  readonly read: ArrowFunctionExpression;
}

/** The `Effect.flatMap` read and optional `Effect.map` projection of one correlation pipeline body. */
const correlationReadPipeline = (context: AdapterContext, body: Node): CorrelationReadPipeline | undefined => {
  if (
    body.type !== 'CallExpression' ||
    body.callee.type !== 'MemberExpression' ||
    body.callee.computed ||
    !identifier(body.callee.property, 'pipe') ||
    (body.arguments.length !== 1 && body.arguments.length !== 2)
  ) {
    return undefined;
  }
  const [readStep, projectionStep] = body.arguments;
  const read = exactCall(readStep, 1);
  if (read === undefined || !native(context, read.callee, 'Effect', 'flatMap')) {
    return undefined;
  }
  const readCallback = expressionArrow(read.arguments[0]);
  if (readCallback === undefined) {
    return undefined;
  }
  let projected: ArrowFunctionExpression | undefined;
  if (projectionStep !== undefined) {
    const step = exactCall(projectionStep, 1);
    if (step === undefined || !native(context, step.callee, 'Effect', 'map')) {
      return undefined;
    }
    projected = expressionArrow(step.arguments[0]);
    if (projected === undefined) {
      return undefined;
    }
  }
  return { correlation: body.callee.object, projection: projected, read: readCallback };
};

/**
 * Prove a facade that generates its own native correlation and reads one collection: it builds its payload from its
 * own parameters and closed literals, forwards that payload and the correlation to a proven governed public
 * operation, and optionally projects one collection of the response with a pure member access.
 * `(kind, tagId) => freshCorrelation.pipe(Effect.flatMap((id) => executeRecords({ subjectKind: kind, tagId }, id)))`.
 */
const correlationReadBody = (context: AdapterContext, body: Node, parameters: ReadonlySet<string>): boolean => {
  const pipeline = correlationReadPipeline(context, body);
  if (pipeline === undefined || !resolvedCorrelationEffect(context, pipeline.correlation)) {
    return false;
  }
  const [correlation] = namedParameters(pipeline.read, 1) ?? [];
  if (correlation === undefined || correlation.optional === true || parameters.has(correlation.name)) {
    return false;
  }
  const invocation = exactCall(pipeline.read.body, 2);
  if (invocation === undefined) {
    return false;
  }
  const [payload, forwardedCorrelation] = invocation.arguments;
  return (
    identifier(forwardedCorrelation, correlation.name) &&
    parameterPayload(payload, parameters) &&
    governedPublicOperation(context, invocation.callee) &&
    (pipeline.projection === undefined || readProjection(pipeline.projection))
  );
};

const correlationRead = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  const parameters = new Set<string>();
  for (const parameter of fn.params) {
    const bound = forwardingParameter(parameter);
    if (bound === undefined || parameters.has(bound.name)) {
      return false;
    }
    parameters.add(bound.name);
  }
  return correlationReadBody(context, fn.body, parameters);
};

/** The same proven body published as a value, with no facade parameters: `freshCorrelation.pipe(Effect.flatMap(…))`. */
const correlationReadValue = (context: AdapterContext, expression: Node): boolean =>
  correlationReadBody(context, expression, new Set());

/** Native collection, set and string methods a pure computation may call on one of its own values. */
const pureNativeMethods = new Set([
  'add',
  'at',
  'concat',
  'every',
  'filter',
  'flatMap',
  'has',
  'includes',
  'indexOf',
  'join',
  'map',
  'pop',
  'push',
  'slice',
  'some',
  'splice',
  'split',
  'trim',
]);
const pureNativeOperators = new Set(['!==', '===', '<', '<=', '>', '>=', '+', '-']);
const pureNativeLogical = new Set(['&&', '||', '??']);
const pureNativeUnary = new Set(['!', '-', '+']);
const pureNativeLiteralTypes = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral']);

/**
 * A closed, side-effect-free native computation over the module's own values: literals, template literals, member
 * reads, native collection/set/string methods, `new Set(…)` and pure same-module values. It can read only its own
 * parameters, local `const` bindings and pure same-module values, and it can never read an import, call an enrolled
 * operation, or reach the network, the clock or any ambient binding.
 */
type PureNativeCheck = (
  context: AdapterContext,
  node: Node | null | undefined,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
) => boolean;

/** The statement check a pure routine uses for the statements of its own body. */
type PureNativeStatement = (
  context: AdapterContext,
  node: Node,
  bindings: Set<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
) => boolean;

/** A same-module value a pure computation may read; anything imported, private or impure is refused. */
const pureNativeModuleValue = (
  context: AdapterContext,
  node: Node,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  const binding = context.graph.resolveReference(context.module, node);
  return (
    binding?.kind === 'declaration' &&
    binding.module.path === context.module.path &&
    !visited.has(binding.expression) &&
    check(context, binding.expression, new Set(), visited)
  );
};

/** A pure name: a bound local, the `undefined` primitive, or a pure same-module value. */
const pureNativeName = (
  context: AdapterContext,
  node: Identifier,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  if (bindings.has(node.name)) {
    return true;
  }
  if (node.name === 'undefined' && context.graph.isUnboundReference(context.module, node)) {
    return true;
  }
  return pureNativeModuleValue(context, node, visited, check);
};

/** Every call argument is a pure expression; a spread argument is never one. */
const pureNativeArguments = (
  context: AdapterContext,
  args: CallExpression['arguments'],
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean =>
  args.every((argument) => (argument.type === 'SpreadElement' ? false : check(context, argument, bindings, visited)));

const mutatingNativeMethods = new Set(['add', 'pop', 'push', 'splice']);

const enclosingNativeRoutine = (context: AdapterContext, node: Node): Node | undefined => {
  const { end, start } = node;
  if (start === null || start === undefined || end === null || end === undefined) {
    return undefined;
  }
  let owner: Node | undefined;
  let smallest = Number.POSITIVE_INFINITY;
  traverseFast(context.module.file, (candidate) => {
    if (
      !isFunction(candidate) ||
      candidate.start === null ||
      candidate.start === undefined ||
      candidate.end === null ||
      candidate.end === undefined
    ) {
      return;
    }
    const width = candidate.end - candidate.start;
    if (candidate.start <= start && candidate.end >= end && width < smallest) {
      owner = candidate;
      smallest = width;
    }
  });
  return owner;
};

// Mutating methods are local algorithms only when the collection is allocated
// by this very invocation, never a caller parameter or captured module value.
const hasInvocationOwnedCollection = (context: AdapterContext, receiver: Node, call: CallExpression): boolean => {
  if (receiver.type !== 'Identifier') {
    return false;
  }
  const binding = context.graph.resolveReference(context.module, receiver);
  if (
    binding?.kind !== 'declaration' ||
    binding.module.path !== context.module.path ||
    (binding.expression.type !== 'ArrayExpression' &&
      !(
        binding.expression.type === 'NewExpression' &&
        binding.expression.callee.type === 'Identifier' &&
        binding.expression.callee.name === 'Set' &&
        context.graph.isUnboundReference(context.module, binding.expression.callee)
      ))
  ) {
    return false;
  }
  let allocated = false;
  traverseFast(context.module.file, (node) => {
    if (
      node.type === 'VariableDeclaration' &&
      node.kind === 'const' &&
      node.declarations.some(
        (declaration) => declaration.id.type === 'Identifier' && declaration.init === binding.expression,
      )
    ) {
      allocated = true;
    }
  });
  const owner = enclosingNativeRoutine(context, binding.expression);
  return allocated && owner !== undefined && owner === enclosingNativeRoutine(context, call);
};

/** A native method call on one of the routine's own values, or a call to a pure same-module routine. */
const pureNativeCall = (
  context: AdapterContext,
  node: CallExpression,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  const { callee } = node;
  if (callee.type === 'Identifier') {
    const binding = context.graph.resolveReference(context.module, callee);
    return (
      binding?.kind === 'declaration' &&
      binding.module.path === context.module.path &&
      binding.expression.type === 'ArrowFunctionExpression' &&
      !visited.has(binding.expression) &&
      check(context, binding.expression, new Set(), visited) &&
      pureNativeArguments(context, node.arguments, bindings, visited, check)
    );
  }
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    pureNativeMethods.has(callee.property.name) &&
    (!mutatingNativeMethods.has(callee.property.name) || hasInvocationOwnedCollection(context, callee.object, node)) &&
    check(context, callee.object, bindings, visited) &&
    pureNativeArguments(context, node.arguments, bindings, visited, check)
  );
};

/** Aggregate literals, `new Set(…)` and native calls: the composite pure native forms. */
const pureNativeComposite = (
  context: AdapterContext,
  node: Node,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  if (node.type === 'ArrayExpression') {
    return node.elements.every((element) => {
      if (element === null) {
        return false;
      }
      return element.type === 'SpreadElement'
        ? check(context, element.argument, bindings, visited)
        : check(context, element, bindings, visited);
    });
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.every(
      (property) =>
        property.type === 'ObjectProperty' && !property.computed && check(context, property.value, bindings, visited),
    );
  }
  if (node.type === 'NewExpression') {
    return (
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Set' &&
      context.graph.isUnboundReference(context.module, node.callee) &&
      pureNativeArguments(context, node.arguments, bindings, visited, check)
    );
  }
  return node.type === 'CallExpression' && pureNativeCall(context, node, bindings, visited, check);
};

/** Native unary, binary and logical operators over pure operands. */
const pureNativeOperator = (
  context: AdapterContext,
  node: Node,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  if (node.type === 'UnaryExpression') {
    return pureNativeUnary.has(node.operator) && check(context, node.argument, bindings, visited);
  }
  if (node.type !== 'BinaryExpression' && node.type !== 'LogicalExpression') {
    return false;
  }
  const operators = node.type === 'BinaryExpression' ? pureNativeOperators : pureNativeLogical;
  return (
    operators.has(node.operator) &&
    check(context, node.left, bindings, visited) &&
    check(context, node.right, bindings, visited)
  );
};

/** One `const` binding of a pure value; the bound name then joins the routine's readable names. */
const pureNativeBinding = (
  context: AdapterContext,
  declaration: VariableDeclarator,
  bindings: Set<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  const { init } = declaration;
  if (declaration.id.type !== 'Identifier' || init === null || init === undefined) {
    return false;
  }
  if (!check(context, init, bindings, visited)) {
    return false;
  }
  bindings.add(declaration.id.name);
  return true;
};

/** A pure `if`: a pure test and pure branches. */
const pureNativeIf = (
  context: AdapterContext,
  node: Extract<Node, { readonly type: 'IfStatement' }>,
  bindings: Set<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
  statement: PureNativeStatement,
): boolean =>
  check(context, node.test, bindings, visited) &&
  statement(context, node.consequent, bindings, visited, check) &&
  (node.alternate === null || node.alternate === undefined
    ? true
    : statement(context, node.alternate, bindings, visited, check));

/** A pure `for…of` over a pure iterable: the loop variable joins the body's readable names. */
const pureNativeForOf = (
  context: AdapterContext,
  node: Extract<Node, { readonly type: 'ForOfStatement' }>,
  bindings: Set<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
  statement: PureNativeStatement,
): boolean => {
  const [declaration] = node.left.type === 'VariableDeclaration' ? node.left.declarations : [];
  if (declaration === undefined || declaration.id.type !== 'Identifier' || declaration.init !== null) {
    return false;
  }
  if (!check(context, node.right, bindings, visited)) {
    return false;
  }
  const inner = new Set([...bindings, declaration.id.name]);
  return statement(context, node.body, inner, visited, check);
};

/**
 * The statements a pure routine may contain: `const` bindings of pure values, pure `if`/`for…of`, pure expression
 * statements, blocks and returns. No assignment, update or `var` — the module-wide no-mutation guard already forbids
 * the first two, and none of them can reach an effect.
 */
const pureNativeStatement = (
  context: AdapterContext,
  node: Node,
  bindings: Set<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  if (node.type === 'VariableDeclaration') {
    return (
      node.kind === 'const' &&
      node.declarations.every((declaration) => pureNativeBinding(context, declaration, bindings, visited, check))
    );
  }
  if (node.type === 'ExpressionStatement') {
    return check(context, node.expression, bindings, visited);
  }
  if (node.type === 'BlockStatement') {
    return node.body.every((statement) => pureNativeStatement(context, statement, bindings, visited, check));
  }
  if (node.type === 'IfStatement') {
    return pureNativeIf(context, node, bindings, visited, check, pureNativeStatement);
  }
  if (node.type === 'ForOfStatement') {
    return pureNativeForOf(context, node, bindings, visited, check, pureNativeStatement);
  }
  return (
    node.type === 'ReturnStatement' &&
    (node.argument === null || node.argument === undefined || check(context, node.argument, bindings, visited))
  );
};

/** A pure routine: plain parameters and a body of pure native statements. */
const pureNativeRoutine = (
  context: AdapterContext,
  fn: ArrowFunctionExpression,
  outer: ReadonlySet<string>,
  visited: Set<Node>,
  check: PureNativeCheck,
): boolean => {
  if (visited.has(fn)) {
    return false;
  }
  visited.add(fn);
  const bindings = new Set(outer);
  let valid = true;
  for (const parameter of fn.params) {
    if (parameter.type !== 'Identifier' || bindings.has(parameter.name)) {
      valid = false;
      break;
    }
    bindings.add(parameter.name);
  }
  if (valid) {
    valid =
      fn.body.type === 'BlockStatement'
        ? fn.body.body.every((statement) => pureNativeStatement(context, statement, bindings, visited, check))
        : check(context, fn.body, bindings, visited);
  }
  visited.delete(fn);
  return valid;
};

const pureNativeExpression = (
  context: AdapterContext,
  node: Node | null | undefined,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
): boolean => {
  if (node === null || node === undefined) {
    return false;
  }
  if (pureNativeLiteralTypes.has(node.type)) {
    return true;
  }
  if (node.type === 'Identifier') {
    return pureNativeName(context, node, bindings, visited, pureNativeExpression);
  }
  if (node.type === 'TemplateLiteral') {
    return node.expressions.every((expression) => pureNativeExpression(context, expression, bindings, visited));
  }
  if (node.type === 'MemberExpression') {
    return (
      !node.computed &&
      node.property.type === 'Identifier' &&
      pureNativeExpression(context, node.object, bindings, visited)
    );
  }
  if (node.type === 'ArrowFunctionExpression') {
    return pureNativeRoutine(context, node, bindings, visited, pureNativeExpression);
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return pureNativeExpression(context, node.expression, bindings, visited);
  }
  if (node.type === 'UnaryExpression' || node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    return pureNativeOperator(context, node, bindings, visited, pureNativeExpression);
  }
  return pureNativeComposite(context, node, bindings, visited, pureNativeExpression);
};

interface ChunkedReadSteps {
  readonly projection?: ArrowFunctionExpression;
  readonly reads: Node;
}

/** The `Effect.forEach` read and the optional `Effect.map` projection of one chunked-read pipeline. */
const chunkedReadSteps = (context: AdapterContext, node: Node): ChunkedReadSteps | undefined => {
  const piped = exactCall(node, 1);
  if (
    piped === undefined ||
    piped.callee.type !== 'MemberExpression' ||
    piped.callee.computed ||
    !identifier(piped.callee.property, 'pipe')
  ) {
    return { reads: node };
  }
  const mapped = exactCall(piped.arguments[0], 1);
  if (mapped === undefined || !native(context, mapped.callee, 'Effect', 'map')) {
    return undefined;
  }
  const projected = expressionArrow(mapped.arguments[0]);
  return projected === undefined ? undefined : { projection: projected, reads: piped.callee.object };
};

/** `Effect.forEach(<pure chunks>, <enrolled chunk reader>, <pure options>)[.pipe(Effect.map(<pure projection>))]`. */
const scopedChunkedReadPipeline = (
  context: AdapterContext,
  node: Node,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
): boolean => {
  const steps = chunkedReadSteps(context, node);
  if (steps === undefined) {
    return false;
  }
  const forEach = exactCall(steps.reads, 3);
  if (forEach === undefined || !native(context, forEach.callee, 'Effect', 'forEach')) {
    return false;
  }
  const [chunks, reader, options] = forEach.arguments;
  if (
    chunks === undefined ||
    options === undefined ||
    !pureNativeExpression(context, chunks, bindings, visited) ||
    !pureNativeExpression(context, options, bindings, visited)
  ) {
    return false;
  }
  const chunkReader = expressionArrow(reader);
  if (chunkReader === undefined || !correlationRead(context, chunkReader)) {
    return false;
  }
  if (steps.projection === undefined) {
    return true;
  }
  const [pages] = namedParameters(steps.projection, 1) ?? [];
  if (pages === undefined || pages.optional === true || bindings.has(pages.name)) {
    return false;
  }
  return pureNativeExpression(context, steps.projection.body, new Set([...bindings, pages.name]), visited);
};

/** `<pure test> ? Effect.succeed(<pure>) : <chunked read>`, or the chunked read on its own. */
const scopedChunkedReadReturn = (
  context: AdapterContext,
  node: Node,
  bindings: ReadonlySet<string>,
  visited: Set<Node>,
): boolean => {
  if (node.type !== 'ConditionalExpression') {
    return scopedChunkedReadPipeline(context, node, bindings, visited);
  }
  const succeeded = exactCall(node.consequent, 1);
  return (
    pureNativeExpression(context, node.test, bindings, visited) &&
    succeeded !== undefined &&
    native(context, succeeded.callee, 'Effect', 'succeed') &&
    pureNativeExpression(context, succeeded.arguments[0], bindings, visited) &&
    scopedChunkedReadPipeline(context, node.alternate, bindings, visited)
  );
};

/**
 * Prove a scoped chunked read: a facade that binds pure local state over its parameters, then reads the requested
 * chunks through one enrolled governed operation per chunk — each with a fresh native correlation — and returns a
 * pure projection of the pages. The local state and the projection reach no import, no module binding and no effect.
 */
const scopedChunkedRead = (context: AdapterContext, fn: ArrowFunctionExpression): boolean => {
  if (fn.body.type !== 'BlockStatement') {
    return false;
  }
  const visited = new Set<Node>();
  const bindings = new Set<string>();
  for (const parameter of fn.params) {
    if (parameter.type !== 'Identifier' || bindings.has(parameter.name)) {
      return false;
    }
    bindings.add(parameter.name);
  }
  const statements = fn.body.body;
  const returned = statements.at(-1);
  if (returned?.type !== 'ReturnStatement' || returned.argument === null || returned.argument === undefined) {
    return false;
  }
  for (const statement of statements.slice(0, -1)) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
      return false;
    }
    for (const declaration of statement.declarations) {
      if (!pureNativeBinding(context, declaration, bindings, visited, pureNativeExpression)) {
        return false;
      }
    }
  }
  return scopedChunkedReadReturn(context, returned.argument, bindings, visited);
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
  correlationRead(context, arrow) ||
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
  return (
    (block !== undefined && (freshForwardedRead(context, block) || scopedChunkedRead(context, block))) ||
    generatorForwardedRead(context, expression) ||
    correlationReadValue(context, expression)
  );
};

/** Every runtime declaration must be a closed form: a proven facade, a pure helper, or a correlation effect. */
const isAdmissibleDeclaration = (context: AdapterContext, init: Node): boolean => {
  const arrow = expressionArrow(init);
  if (arrow !== undefined) {
    return (
      purePayload(context, arrow) ||
      arrowFacade(context, arrow) ||
      pureNativeRoutine(context, arrow, new Set(), new Set(), pureNativeExpression)
    );
  }
  const block = blockArrow(init);
  return (
    (block !== undefined &&
      (freshForwardedRead(context, block) ||
        scopedChunkedRead(context, block) ||
        pureNativeRoutine(context, block, new Set(), new Set(), pureNativeExpression))) ||
    generatorForwardedRead(context, init) ||
    isCorrelationEffect(context, init) ||
    correlationReadValue(context, init) ||
    pureNativeExpression(context, init, new Set(), new Set())
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
 * Prove exact decode/forward, pure-default forwarding, collection projection, native-random correlation (including
 * the parameter payload form and the scoped chunked read), `Effect.fn` generator forwarding, plus governed-operation
 * republication value flow. Every runtime declaration must be one of these closed forms, or a pure native helper that
 * reaches no import, module binding or effect — not merely a declaration that reaches a native SDK.
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
