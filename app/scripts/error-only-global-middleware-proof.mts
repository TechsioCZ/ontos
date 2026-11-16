import { Schema } from 'effect';
import { Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingPattern,
  CallExpression,
  Expression,
  Function as AstFunction,
  MemberExpression,
  ParamPattern,
  Program,
  Span,
} from 'oxc-parser';

import type {
  ScopedCapturedValue,
  ScopedCapturedValueRequest,
  ScopedContextFactoryCandidate,
  ScopedContextFactoryRequest,
} from './scoped-context-factory-proof.mts';
import {
  bindingShadows,
  hasClosedNativeGlobalConstructor,
  hasClosedNativeObjectNamespace,
} from './scoped-proof-custody.mts';

type Implementation = ArrowFunctionExpression | AstFunction;
export interface ErrorOnlyGlobalMiddlewareRequest {
  readonly call: CallExpression;
  readonly file: string;
  readonly isNativeMethod: (file: string, expression: Expression, namespace: string, method: string) => boolean;
  readonly isServiceFreeSchema: (request: ScopedCapturedValueRequest) => boolean;
  readonly program: Program;
  readonly resolveCapturedValue: (request: ScopedCapturedValueRequest) => ScopedCapturedValue | undefined;
  readonly resolveDeclaredFunction: (request: ScopedContextFactoryRequest) => ScopedContextFactoryCandidate | undefined;
  readonly sources: ReadonlyMap<string, string>;
}
type Value =
  | { readonly kind: 'bad' | 'primitive' | 'issue' | 'formatter' | 'response' | 'string-function' }
  | { readonly element: Value; readonly kind: 'array' | 'set' }
  | { readonly fields: ReadonlyMap<string, Value>; readonly kind: 'record' }
  | { readonly expression: Expression; readonly file: string; readonly kind: 'schema' }
  | {
      readonly environment: ReadonlyMap<string, Value>;
      readonly file: string;
      readonly implementation: Implementation;
      readonly kind: 'function';
    }
  | { readonly kind: 'effect'; readonly result: Value };
const BAD: Value = { kind: 'bad' };
const PRIMITIVE: Value = { kind: 'primitive' };
const budget = 64;
const nodeBudget = 2048;
const sameSpan = (left: Span, right: Span): boolean => left.start === right.start && left.end === right.end;
const unwrap = (input: Expression): Expression => {
  let node = input;
  for (let hops = 0; hops < budget; hops += 1) {
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'TSInstantiationExpression' ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'ChainExpression' ||
      node.type === 'ParenthesizedExpression'
    ) {
      node = node.expression;
    } else {
      return node;
    }
  }
  return node;
};
const propertyName = (node: MemberExpression): string | undefined =>
  !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
const fnValue = (node: Expression | undefined): Implementation | undefined =>
  node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' ? node : undefined;
const returnedExpression = (fn: Implementation): Expression | undefined => {
  if (fn.async || fn.generator || fn.body === null) {
    return undefined;
  }
  if (fn.body.type !== 'BlockStatement') {
    return fn.body;
  }
  const [statement] = fn.body.body;
  return fn.body.body.length === 1 && statement?.type === 'ReturnStatement' && statement.argument !== null
    ? statement.argument
    : undefined;
};
const data = (value: Value, hops = 0): boolean => {
  if (hops >= budget) {
    return false;
  }
  if (value.kind === 'primitive') {
    return true;
  }
  if (value.kind === 'record') {
    return [...value.fields.values()].every((field) => data(field, hops + 1));
  }
  return (value.kind === 'array' || value.kind === 'set') && data(value.element, hops + 1);
};
const field = (value: Value, name: string): Value => (value.kind === 'record' ? (value.fields.get(name) ?? BAD) : BAD);
const errorData = (): Value => ({
  fields: new Map<string, Value>([
    ['cause', { fields: new Map<string, Value>([['issue', { kind: 'issue' }]]), kind: 'record' }],
    ['kind', PRIMITIVE],
  ]),
  kind: 'record',
});
const formattedIssues = (): Value => ({
  fields: new Map<string, Value>([
    [
      'issues',
      {
        element: { fields: new Map<string, Value>([['path', { element: PRIMITIVE, kind: 'array' }]]), kind: 'record' },
        kind: 'array',
      },
    ],
  ]),
  kind: 'record',
});
const globalsClosed = (program: Program): boolean => {
  let valid = hasClosedNativeGlobalConstructor(program, 'Set') && hasClosedNativeObjectNamespace(program);
  new Visitor({
    AssignmentExpression() {
      valid = false;
    },
    AwaitExpression() {
      valid = false;
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        valid = false;
      }
    },
    UpdateExpression() {
      valid = false;
    },
    YieldExpression() {
      valid = false;
    },
  }).visit(program);
  return valid;
};

class ErrorResponseProof {
  readonly request: ErrorOnlyGlobalMiddlewareRequest;
  readonly active = new Set<string>();
  steps = 0;
  constructor(request: ErrorOnlyGlobalMiddlewareRequest) {
    this.request = request;
  }
  native(file: string, expression: Expression, namespace: string, method: string): boolean {
    return this.request.isNativeMethod(file, unwrap(expression), namespace, method);
  }
  bind(
    pattern: BindingPattern | ParamPattern,
    value: Value,
    environment: Map<string, Value>,
    file: string,
    hops: number,
  ): boolean {
    if (hops >= budget || value.kind === 'bad') {
      return false;
    }
    if (pattern.type === 'Identifier') {
      environment.set(pattern.name, value);
      return true;
    }
    if (pattern.type === 'AssignmentPattern') {
      const fallback = this.value(file, pattern.right, environment, hops + 1);
      return data(fallback) && this.bind(pattern.left, value, environment, file, hops + 1);
    }
    if (pattern.type !== 'ObjectPattern' || value.kind !== 'record') {
      return false;
    }
    return pattern.properties.every(
      (property) =>
        property.type === 'Property' &&
        !property.computed &&
        property.key.type === 'Identifier' &&
        this.bind(property.value, field(value, property.key.name), environment, file, hops + 1),
    );
  }
  invoke(
    file: string,
    fn: Implementation,
    args: readonly Value[],
    parent: ReadonlyMap<string, Value>,
    hops: number,
  ): Value {
    if (hops >= budget || fn.params.length !== args.length) {
      return BAD;
    }
    const expression = returnedExpression(fn);
    const key = `${file}:${fn.start}:${fn.end}`;
    if (expression === undefined || this.active.has(key)) {
      return BAD;
    }
    const environment = new Map(parent);
    for (const [index, param] of fn.params.entries()) {
      const argument = args.at(index);
      if (argument === undefined || !this.bind(param, argument, environment, file, hops + 1)) {
        return BAD;
      }
    }
    this.active.add(key);
    const result = this.value(file, expression, environment, hops + 1);
    this.active.delete(key);
    return result;
  }
  identifier(file: string, expression: Expression, environment: ReadonlyMap<string, Value>, hops: number): Value {
    if (expression.type !== 'Identifier') {
      return BAD;
    }
    const bound = environment.get(expression.name);
    if (bound !== undefined) {
      return bound;
    }
    if (expression.name === 'String' && !bindingShadows(this.request.program, 'String')) {
      return { kind: 'string-function' };
    }
    if (this.request.isServiceFreeSchema({ expression, file })) {
      return { expression, file, kind: 'schema' };
    }
    const captured = this.request.resolveCapturedValue({ expression, file });
    if (
      captured === undefined ||
      captured.parameter !== undefined ||
      captured.file !== this.request.file ||
      sameSpan(captured.expression, expression)
    ) {
      return BAD;
    }
    return this.value(captured.file, captured.expression, new Map(), hops + 1);
  }
  object(file: string, node: Expression, environment: ReadonlyMap<string, Value>, hops: number): Value {
    if (node.type !== 'ObjectExpression') {
      return BAD;
    }
    const fields = new Map<string, Value>();
    for (const property of node.properties) {
      if (
        property.type !== 'Property' ||
        property.computed ||
        property.method ||
        property.kind !== 'init' ||
        (property.key.type !== 'Identifier' && property.key.type !== 'Literal')
      ) {
        return BAD;
      }
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      if (!Schema.is(Schema.String)(key) || fields.has(key)) {
        return BAD;
      }
      const value = this.value(file, property.value, environment, hops + 1);
      if (!data(value)) {
        return BAD;
      }
      fields.set(key, value);
    }
    return { fields, kind: 'record' };
  }
  array(file: string, node: Expression, environment: ReadonlyMap<string, Value>, hops: number): Value {
    if (node.type !== 'ArrayExpression') {
      return BAD;
    }
    for (const element of node.elements) {
      if (element === null) {
        return BAD;
      }
      const value = this.value(
        file,
        element.type === 'SpreadElement' ? element.argument : element,
        environment,
        hops + 1,
      );
      if (!data(value) || (element.type === 'SpreadElement' && value.kind !== 'set' && value.kind !== 'array')) {
        return BAD;
      }
    }
    return { element: PRIMITIVE, kind: 'array' };
  }
  schemaEncoding(
    file: string,
    call: CallExpression,
    environment: ReadonlyMap<string, Value>,
    hops: number,
  ): Value | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== 'CallExpression' || !this.native(file, callee.callee, 'Schema', 'encodeEffect')) {
      return undefined;
    }
    const [schema] = callee.arguments;
    const [payload] = call.arguments;
    if (
      callee.optional ||
      callee.arguments.length !== 1 ||
      schema === undefined ||
      schema.type === 'SpreadElement' ||
      call.arguments.length !== 1 ||
      payload === undefined ||
      payload.type === 'SpreadElement'
    ) {
      return BAD;
    }
    const schemaValue = this.value(file, schema, environment, hops + 1);
    const body = this.value(file, payload, environment, hops + 1);
    return schemaValue.kind === 'schema' && data(body) ? { kind: 'effect', result: body } : BAD;
  }
  pipe(file: string, call: CallExpression, environment: ReadonlyMap<string, Value>, hops: number): Value | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || propertyName(callee) !== 'pipe') {
      return undefined;
    }
    let current = this.value(file, callee.object, environment, hops + 1);
    if (current.kind !== 'effect') {
      return BAD;
    }
    for (const argument of call.arguments) {
      if (argument.type === 'SpreadElement') {
        return BAD;
      }
      if (this.native(file, argument, 'Effect', 'orDie')) {
        continue;
      }
      const transform = unwrap(argument);
      const [callback] = transform.type === 'CallExpression' ? transform.arguments : [];
      const fn = callback === undefined || callback.type === 'SpreadElement' ? undefined : fnValue(callback);
      if (
        transform.type !== 'CallExpression' ||
        transform.optional ||
        transform.arguments.length !== 1 ||
        !this.native(file, transform.callee, 'Effect', 'map') ||
        fn === undefined
      ) {
        return BAD;
      }
      const mapped = this.invoke(file, fn, [current.result], environment, hops + 1);
      if (mapped.kind === 'bad') {
        return BAD;
      }
      current = { kind: 'effect', result: mapped };
    }
    return current;
  }
  nativeCall(file: string, call: CallExpression, args: readonly Value[]): Value | undefined {
    if (this.native(file, call.callee, 'SchemaIssue', 'makeFormatterStandardSchemaV1')) {
      return args.length === 0 ? { kind: 'formatter' } : BAD;
    }
    if (this.native(file, call.callee, 'HttpServerResponse', 'jsonUnsafe')) {
      return args.length === 2 && args.every((value) => data(value)) ? { kind: 'response' } : BAD;
    }
    return undefined;
  }
  arrayCall(receiver: Value, name: string | undefined, args: readonly Value[], hops: number): Value | undefined {
    if (receiver.kind !== 'array') {
      return undefined;
    }
    if (name === 'join') {
      return args.length === 1 && args.at(0)?.kind === 'primitive' ? PRIMITIVE : BAD;
    }
    if (name !== 'map' || args.length !== 1) {
      return BAD;
    }
    const [mapper] = args;
    if (mapper?.kind === 'string-function') {
      return { element: PRIMITIVE, kind: 'array' };
    }
    const mapped =
      mapper?.kind === 'function'
        ? this.invoke(mapper.file, mapper.implementation, [receiver.element], mapper.environment, hops + 1)
        : BAD;
    return data(mapped) ? { element: mapped, kind: 'array' } : BAD;
  }
  memberCall(
    file: string,
    call: CallExpression,
    args: readonly Value[],
    environment: ReadonlyMap<string, Value>,
    hops: number,
  ): Value | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) {
      return undefined;
    }
    const receiver = this.value(file, callee.object, environment, hops + 1);
    const name = propertyName(callee);
    if (receiver.kind === 'schema' && name === 'make') {
      return args.length === 1 && data(args.at(0) ?? BAD) ? args.at(0) : BAD;
    }
    if (receiver.kind === 'primitive' && name === 'toLowerCase') {
      return args.length === 0 ? PRIMITIVE : BAD;
    }
    return this.arrayCall(receiver, name, args, hops);
  }
  call(file: string, call: CallExpression, environment: ReadonlyMap<string, Value>, hops: number): Value {
    if (call.optional || call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return BAD;
    }
    const encoding = this.schemaEncoding(file, call, environment, hops + 1);
    if (encoding !== undefined) {
      return encoding;
    }
    const pipe = this.pipe(file, call, environment, hops + 1);
    if (pipe !== undefined) {
      return pipe;
    }
    const args = call.arguments.map((argument) =>
      argument.type === 'SpreadElement' ? BAD : this.value(file, argument, environment, hops + 1),
    );
    if (args.some((argument) => argument.kind === 'bad')) {
      return BAD;
    }
    const native = this.nativeCall(file, call, args);
    if (native !== undefined) {
      return native;
    }
    const member = this.memberCall(file, call, args, environment, hops + 1);
    if (member !== undefined) {
      return member;
    }
    const callee = this.value(file, call.callee, environment, hops + 1);
    if (callee.kind === 'formatter') {
      return args.length === 1 && args.at(0)?.kind === 'issue' ? formattedIssues() : BAD;
    }
    const candidate = this.request.resolveDeclaredFunction({ callee: call.callee, file });
    return candidate?.file === this.request.file && candidate.capturedParameters.size === 0
      ? this.invoke(candidate.file, candidate.implementation, args, new Map(), hops + 1)
      : BAD;
  }
  nativeSet(file: string, node: Expression, environment: ReadonlyMap<string, Value>, hops: number): Value {
    if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Set' &&
      !bindingShadows(this.request.program, 'Set') &&
      node.arguments.length === 1
    ) {
      const [iterable] = node.arguments;
      const value =
        iterable === undefined || iterable.type === 'SpreadElement'
          ? BAD
          : this.value(file, iterable, environment, hops + 1);
      return value.kind === 'array' ? { element: value.element, kind: 'set' } : BAD;
    }
    return BAD;
  }
  value(file: string, input: Expression, environment: ReadonlyMap<string, Value>, hops = 0): Value {
    this.steps += 1;
    if (hops >= budget || this.steps > nodeBudget || file !== this.request.file) {
      return BAD;
    }
    const node = unwrap(input);
    if (node.type === 'Literal') {
      return PRIMITIVE;
    }
    if (node.type === 'Identifier') {
      return this.identifier(file, node, environment, hops + 1);
    }
    if (node.type === 'ObjectExpression') {
      return this.object(file, node, environment, hops + 1);
    }
    if (node.type === 'ArrayExpression') {
      return this.array(file, node, environment, hops + 1);
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      return { environment, file, implementation: node, kind: 'function' };
    }
    if (node.type === 'TemplateLiteral') {
      return node.expressions.every(
        (expression) => this.value(file, expression, environment, hops + 1).kind === 'primitive',
      )
        ? PRIMITIVE
        : BAD;
    }
    if (node.type === 'CallExpression') {
      return this.call(file, node, environment, hops + 1);
    }
    if (node.type === 'MemberExpression') {
      return !node.computed && !node.optional
        ? field(this.value(file, node.object, environment, hops + 1), propertyName(node) ?? '')
        : BAD;
    }
    return this.nativeSet(file, node, environment, hops);
  }
}
const globalOption = (input: Expression | undefined): boolean => {
  const node = input === undefined ? undefined : unwrap(input);
  const [property] = node?.type === 'ObjectExpression' ? node.properties : [];
  return (
    node?.type === 'ObjectExpression' &&
    node.properties.length === 1 &&
    property?.type === 'Property' &&
    !property.computed &&
    !property.method &&
    property.kind === 'init' &&
    property.key.type === 'Identifier' &&
    property.key.name === 'global' &&
    property.value.type === 'Literal' &&
    property.value.value === true
  );
};
const namedParameter = (fn: Implementation): string | undefined => {
  const [parameter] = fn.params;
  return fn.params.length === 1 && parameter?.type === 'Identifier' ? parameter.name : undefined;
};
const directArgument = (call: CallExpression, name: string): boolean => {
  const [argument] = call.arguments;
  return call.arguments.length === 1 && argument?.type === 'Identifier' && argument.name === name;
};
const schemaErrorTest = (proof: ErrorResponseProof, input: Expression, defect: string): boolean => {
  const test = unwrap(input);
  return (
    test.type === 'CallExpression' &&
    !test.optional &&
    proof.native(proof.request.file, test.callee, 'HttpApiError', 'HttpApiSchemaError.is') &&
    directArgument(test, defect)
  );
};
const excludedKind = (proof: ErrorResponseProof, input: Expression, defect: string): boolean => {
  const has = unwrap(input);
  const callee = has.type === 'CallExpression' ? unwrap(has.callee) : undefined;
  const [kind] = has.type === 'CallExpression' ? has.arguments : [];
  if (
    has.type !== 'CallExpression' ||
    has.optional ||
    has.arguments.length !== 1 ||
    callee?.type !== 'MemberExpression' ||
    callee.computed ||
    callee.optional ||
    propertyName(callee) !== 'has' ||
    kind?.type !== 'MemberExpression' ||
    kind.computed ||
    kind.optional ||
    propertyName(kind) !== 'kind' ||
    kind.object.type !== 'Identifier' ||
    kind.object.name !== defect
  ) {
    return false;
  }
  return proof.value(proof.request.file, callee.object, new Map()).kind === 'set';
};
const guardPreservesContext = (proof: ErrorResponseProof, input: Expression, defect: string): boolean => {
  const guard = unwrap(input);
  if (guard.type !== 'LogicalExpression' || guard.operator !== '&&' || !schemaErrorTest(proof, guard.left, defect)) {
    return false;
  }
  const excluded = unwrap(guard.right);
  return (
    excluded.type === 'UnaryExpression' && excluded.operator === '!' && excludedKind(proof, excluded.argument, defect)
  );
};
const handlerPreservesContext = (proof: ErrorResponseProof, handler: Implementation): boolean => {
  const defect = namedParameter(handler);
  const body = returnedExpression(handler);
  if (
    defect === undefined ||
    body?.type !== 'ConditionalExpression' ||
    !guardPreservesContext(proof, body.test, defect)
  ) {
    return false;
  }
  const otherwise = unwrap(body.alternate);
  if (
    otherwise.type !== 'CallExpression' ||
    otherwise.optional ||
    !proof.native(proof.request.file, otherwise.callee, 'Effect', 'die') ||
    !directArgument(otherwise, defect)
  ) {
    return false;
  }
  const response = proof.value(proof.request.file, body.consequent, new Map([[defect, errorData()]]));
  return response.kind === 'effect' && response.result.kind === 'response';
};
const initializationClosed = (proof: ErrorResponseProof): boolean => {
  let exports = 0;
  for (const statement of proof.request.program.body) {
    if (
      statement.type === 'ImportDeclaration' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSTypeAliasDeclaration'
    ) {
      continue;
    }
    const exported = statement.type === 'ExportNamedDeclaration';
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
      return false;
    }
    for (const binding of declaration.declarations) {
      if (binding.id.type !== 'Identifier' || binding.init === null) {
        return false;
      }
      if (sameSpan(unwrap(binding.init), proof.request.call)) {
        if (!exported) {
          return false;
        }
        exports += 1;
      } else {
        if (exported) {
          return false;
        }
        const value = proof.value(proof.request.file, binding.init, new Map());
        if (value.kind === 'bad') {
          return false;
        }
      }
    }
  }
  return exports === 1;
};
const originalEffectHandler = (proof: ErrorResponseProof): Implementation | undefined => {
  const [callback, options] = proof.request.call.arguments;
  const fn = callback === undefined || callback.type === 'SpreadElement' ? undefined : fnValue(callback);
  if (fn === undefined || options === undefined || options.type === 'SpreadElement' || !globalOption(options)) {
    return undefined;
  }
  const incoming = namedParameter(fn);
  const body = returnedExpression(fn);
  const [original, callbackHandler] = body?.type === 'CallExpression' ? body.arguments : [];
  const handler =
    callbackHandler === undefined || callbackHandler.type === 'SpreadElement' ? undefined : fnValue(callbackHandler);
  return incoming !== undefined &&
    body?.type === 'CallExpression' &&
    !body.optional &&
    body.arguments.length === 2 &&
    proof.native(proof.request.file, body.callee, 'Effect', 'catchDefect') &&
    original?.type === 'Identifier' &&
    original.name === incoming
    ? handler
    : undefined;
};
/** Native global registration is context-neutral only when the original request Effect is preserved verbatim. */
export const provesErrorOnlyGlobalMiddleware = (request: ErrorOnlyGlobalMiddlewareRequest): boolean => {
  if (
    !request.sources.has(request.file) ||
    !globalsClosed(request.program) ||
    request.call.optional ||
    request.call.arguments.length !== 2
  ) {
    return false;
  }
  const proof = new ErrorResponseProof(request);
  if (!proof.native(request.file, request.call.callee, 'HttpRouter', 'middleware')) {
    return false;
  }
  const handler = originalEffectHandler(proof);
  return handler !== undefined && handlerPreservesContext(proof, handler) && initializationClosed(proof);
};
