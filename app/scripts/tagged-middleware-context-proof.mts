import { Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  Function as AstFunction,
  MemberExpression,
  Program,
  Span,
} from 'oxc-parser';

import type {
  ScopedCapturedValue,
  ScopedCapturedValueRequest,
  ScopedContextFactoryCandidate,
  ScopedContextFactoryRequest,
} from './scoped-context-factory-proof.mts';

type Implementation = ArrowFunctionExpression | AstFunction;
export interface TaggedMiddlewareContextRequest {
  readonly call: CallExpression;
  readonly file: string;
  readonly implementation: Expression;
  readonly isNativeMethod: (file: string, expression: Expression, namespace: string, method: string) => boolean;
  readonly isServiceFreeSchema: (request: ScopedCapturedValueRequest) => boolean;
  readonly kind: 'handler-transform' | 'schema-error-transform';
  readonly program: Program;
  readonly resolveCapturedValue: (request: ScopedCapturedValueRequest) => ScopedCapturedValue | undefined;
  readonly resolveDataObjectMethod: (request: ScopedContextFactoryRequest) => ScopedContextFactoryCandidate | undefined;
  readonly resolveDeclaredFunction: (request: ScopedContextFactoryRequest) => ScopedContextFactoryCandidate | undefined;
  readonly sources: ReadonlyMap<string, string>;
}
type DataValue =
  | { readonly kind: 'bad' | 'primitive' | 'problem' }
  | { readonly fields: ReadonlyMap<string, DataValue>; readonly kind: 'record' }
  | { readonly kind: 'callable'; readonly reference: FunctionReference };
interface FunctionReference {
  readonly candidate?: ScopedContextFactoryCandidate;
  readonly file: string;
  readonly implementation: Implementation;
  readonly program: Program;
}
const BAD: DataValue = { kind: 'bad' };
const PRIMITIVE: DataValue = { kind: 'primitive' };
const limit = 64;
const nodeBudget = 2048;
const inside = (node: Span, scope: Span): boolean => scope.start <= node.start && node.end <= scope.end;
const sameSpan = (left: Span, right: Span): boolean => left.start === right.start && left.end === right.end;
const unwrap = (input: Expression): Expression => {
  let node = input;
  for (let hops = 0; hops < limit; hops += 1) {
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'TSInstantiationExpression' ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'ParenthesizedExpression' ||
      node.type === 'ChainExpression'
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
const functionExpression = (input: Expression): Implementation | undefined => {
  const node = unwrap(input);
  return (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    !node.async &&
    !node.generator
    ? node
    : undefined;
};
const functionResult = (fn: Implementation): Expression | undefined => {
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
const firstParameter = (fn: Implementation): string | undefined => {
  const [parameter] = fn.params;
  return parameter?.type === 'Identifier' ? parameter.name : undefined;
};
const cleanFunction = (reference: FunctionReference): boolean => {
  let clean = true;
  new Visitor({
    AssignmentExpression(node) {
      if (inside(node, reference.implementation)) {
        clean = false;
      }
    },
    AwaitExpression(node) {
      if (inside(node, reference.implementation)) {
        clean = false;
      }
    },
    ThisExpression(node) {
      if (inside(node, reference.implementation)) {
        clean = false;
      }
    },
    UnaryExpression(node) {
      if (node.operator === 'delete' && inside(node, reference.implementation)) {
        clean = false;
      }
    },
    UpdateExpression(node) {
      if (inside(node, reference.implementation)) {
        clean = false;
      }
    },
    YieldExpression(node) {
      if (inside(node, reference.implementation)) {
        clean = false;
      }
    },
  }).visit(reference.program);
  return clean;
};
const scalarData = (value: DataValue, hops = 0): boolean => {
  if (hops >= limit) {
    return false;
  }
  return (
    value.kind === 'primitive' ||
    (value.kind === 'record' && [...value.fields.values()].every((field) => scalarData(field, hops + 1)))
  );
};

const unsupportedStatus = (input: Expression, response: string): boolean => {
  const test = unwrap(input);
  return (
    test.type === 'BinaryExpression' &&
    test.operator === '===' &&
    test.left.type === 'MemberExpression' &&
    !test.left.computed &&
    !test.left.optional &&
    propertyName(test.left) === 'status' &&
    test.left.object.type === 'Identifier' &&
    test.left.object.name === response &&
    test.right.type === 'Literal' &&
    test.right.value === 415
  );
};
const originalPipe = (input: Expression | undefined, incoming: string | undefined): CallExpression | undefined => {
  const body = input === undefined ? undefined : unwrap(input);
  const callee = body?.type === 'CallExpression' ? unwrap(body.callee) : undefined;
  return incoming !== undefined &&
    body?.type === 'CallExpression' &&
    !body.optional &&
    body.arguments.length === 2 &&
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    propertyName(callee) === 'pipe' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === incoming
    ? body
    : undefined;
};
const operationArgument = (call: CallExpression | undefined, index: number): Expression | undefined => {
  const argument = call?.arguments.at(index);
  return argument?.type === 'SpreadElement' ? undefined : argument;
};
class TaggedContextProof {
  readonly active = new Set<string>();
  readonly request: TaggedMiddlewareContextRequest;
  readonly programs = new Map<string, Program>();
  steps = 0;
  constructor(request: TaggedMiddlewareContextRequest) {
    this.request = request;
    this.programs.set(request.file, request.program);
  }
  program(file: string): Program | undefined {
    const cached = this.programs.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = this.request.sources.get(file);
    if (source === undefined) {
      return undefined;
    }
    const parsed = parseSync(file, source);
    if (parsed.errors.length !== 0) {
      return undefined;
    }
    this.programs.set(file, parsed.program);
    return parsed.program;
  }
  native(file: string, input: Expression, namespace: string, method: string): boolean {
    return this.request.isNativeMethod(file, unwrap(input), namespace, method);
  }
  function(file: string, input: Expression): FunctionReference | undefined {
    const literal = functionExpression(input);
    if (literal !== undefined) {
      const program = this.program(file);
      return program === undefined ? undefined : { file, implementation: literal, program };
    }
    const node = unwrap(input);
    const candidate =
      node.type === 'Identifier'
        ? this.request.resolveDeclaredFunction({ callee: node, file })
        : this.request.resolveDataObjectMethod({ callee: node, file });
    const initializer =
      node.type === 'Identifier' ? this.request.resolveCapturedValue({ expression: node, file }) : undefined;
    if (
      node.type === 'Identifier' &&
      (initializer === undefined ||
        candidate === undefined ||
        initializer.file !== candidate.file ||
        !sameSpan(unwrap(initializer.expression), candidate.implementation))
    ) {
      return undefined;
    }
    return candidate !== undefined &&
      this.request.sources.has(candidate.file) &&
      !candidate.implementation.async &&
      !candidate.implementation.generator
      ? { candidate, file: candidate.file, implementation: candidate.implementation, program: candidate.program }
      : undefined;
  }
  environment(
    reference: FunctionReference,
    args: readonly DataValue[],
    hops: number,
  ): Map<string, DataValue> | undefined {
    if (reference.implementation.params.length !== args.length || !cleanFunction(reference)) {
      return undefined;
    }
    const environment = new Map<string, DataValue>();
    for (const [name, value] of reference.candidate?.capturedBindings ?? []) {
      const captured = this.data(value.file, value.expression, new Map(), hops + 1);
      if (captured.kind === 'bad') {
        return undefined;
      }
      environment.set(name, captured);
    }
    if ((reference.candidate?.capturedParameters.size ?? 0) !== 0) {
      return undefined;
    }
    for (const [index, parameter] of reference.implementation.params.entries()) {
      const argument = args.at(index);
      if (parameter.type !== 'Identifier' || argument === undefined) {
        return undefined;
      }
      environment.set(parameter.name, argument);
    }
    return environment;
  }
  invokeData(reference: FunctionReference, args: readonly DataValue[], hops: number): DataValue {
    const body = functionResult(reference.implementation);
    const key = `${reference.file}:${reference.implementation.start}:${reference.implementation.end}`;
    if (hops >= limit || body === undefined || this.active.has(key)) {
      return BAD;
    }
    const environment = this.environment(reference, args, hops + 1);
    if (environment === undefined) {
      return BAD;
    }
    this.active.add(key);
    const value = this.data(reference.file, body, environment, hops + 1);
    this.active.delete(key);
    return value;
  }
  record(file: string, node: Expression, environment: ReadonlyMap<string, DataValue>, hops: number): DataValue {
    if (node.type !== 'ObjectExpression') {
      return BAD;
    }
    const fields = new Map<string, DataValue>();
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
      const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      if (
        !Schema.is(Schema.String)(name) ||
        fields.has(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name)
      ) {
        return BAD;
      }
      const value = this.data(file, property.value, environment, hops + 1);
      if (!scalarData(value)) {
        return BAD;
      }
      fields.set(name, value);
    }
    return { fields, kind: 'record' };
  }
  callData(file: string, call: CallExpression, environment: ReadonlyMap<string, DataValue>, hops: number): DataValue {
    if (call.optional || call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return BAD;
    }
    const callee = unwrap(call.callee);
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      propertyName(callee) === 'make' &&
      this.request.isServiceFreeSchema({ expression: callee.object, file })
    ) {
      const [argument] = call.arguments;
      return call.arguments.length === 1 &&
        argument !== undefined &&
        argument.type !== 'SpreadElement' &&
        scalarData(this.data(file, argument, environment, hops + 1))
        ? { kind: 'problem' }
        : BAD;
    }
    const reference = this.callable(file, callee, environment);
    const args = call.arguments.map((argument) =>
      argument.type === 'SpreadElement' ? BAD : this.data(file, argument, environment, hops + 1),
    );
    return reference !== undefined && args.every((argument) => scalarData(argument))
      ? this.invokeData(reference, args, hops + 1)
      : BAD;
  }
  callable(
    file: string,
    callee: Expression,
    environment: ReadonlyMap<string, DataValue>,
  ): FunctionReference | undefined {
    const bound = callee.type === 'Identifier' ? environment.get(callee.name) : undefined;
    if (bound === undefined) {
      return this.function(file, callee);
    }
    return bound.kind === 'callable' ? bound.reference : undefined;
  }
  capturedData(file: string, node: Expression, environment: ReadonlyMap<string, DataValue>, hops: number): DataValue {
    if (node.type !== 'Identifier') {
      return BAD;
    }
    const bound = environment.get(node.name);
    if (bound !== undefined) {
      return bound;
    }
    const value = this.request.resolveCapturedValue({ expression: node, file });
    return value !== undefined && value.parameter === undefined && !sameSpan(value.expression, node)
      ? this.data(value.file, value.expression, new Map(), hops + 1)
      : BAD;
  }
  data(file: string, input: Expression, environment: ReadonlyMap<string, DataValue>, hops = 0): DataValue {
    this.steps += 1;
    if (hops >= limit || this.steps > nodeBudget || !this.request.sources.has(file)) {
      return BAD;
    }
    const node = unwrap(input);
    if (functionExpression(node) !== undefined) {
      const reference = this.function(file, node);
      return reference === undefined ? BAD : { kind: 'callable', reference };
    }
    if (node.type === 'Literal') {
      return PRIMITIVE;
    }
    if (node.type === 'Identifier') {
      return this.capturedData(file, node, environment, hops + 1);
    }
    if (node.type === 'ObjectExpression') {
      return this.record(file, node, environment, hops + 1);
    }
    if (node.type === 'CallExpression') {
      return this.callData(file, node, environment, hops + 1);
    }
    if (node.type === 'TemplateLiteral') {
      return node.expressions.every(
        (expression) => this.data(file, expression, environment, hops + 1).kind === 'primitive',
      )
        ? PRIMITIVE
        : BAD;
    }
    if (node.type !== 'MemberExpression' || node.computed || node.optional) {
      return BAD;
    }
    const receiver = this.data(file, node.object, environment, hops + 1);
    return receiver.kind === 'record' ? (receiver.fields.get(propertyName(node) ?? '') ?? BAD) : BAD;
  }
  failure(file: string, input: Expression, environment: ReadonlyMap<string, DataValue>): boolean {
    const call = unwrap(input);
    const [problem] = call.type === 'CallExpression' ? call.arguments : [];
    return (
      call.type === 'CallExpression' &&
      !call.optional &&
      call.arguments.length === 1 &&
      this.native(file, call.callee, 'Effect', 'fail') &&
      problem !== undefined &&
      problem.type !== 'SpreadElement' &&
      this.data(file, problem, environment).kind === 'problem'
    );
  }
  failCallback(input: Expression): boolean {
    const reference = this.function(this.request.file, input);
    const body = reference === undefined ? undefined : functionResult(reference.implementation);
    if (reference === undefined || body === undefined || reference.implementation.params.length > 1) {
      return false;
    }
    const args: DataValue[] = reference.implementation.params.map(() => BAD);
    const environment = this.environment(reference, args, 0);
    return environment !== undefined && this.failure(reference.file, body, environment);
  }
  predicate(input: Expression): boolean {
    const reference = this.function(this.request.file, input);
    if (reference === undefined || !cleanFunction(reference) || reference.implementation.params.length !== 1) {
      return false;
    }
    const parameter = firstParameter(reference.implementation);
    const call = functionResult(reference.implementation);
    const [argument] = call?.type === 'CallExpression' ? call.arguments : [];
    return (
      parameter !== undefined &&
      call?.type === 'CallExpression' &&
      !call.optional &&
      call.arguments.length === 1 &&
      this.native(reference.file, call.callee, 'HttpApiError', 'HttpApiSchemaError.is') &&
      argument?.type === 'Identifier' &&
      argument.name === parameter
    );
  }
  operation(
    file: string,
    input: Expression | undefined,
    method: string,
    argumentsCount: number,
  ): CallExpression | undefined {
    const node = input === undefined ? undefined : unwrap(input);
    return node?.type === 'CallExpression' &&
      !node.optional &&
      node.arguments.length === argumentsCount &&
      this.native(file, node.callee, 'Effect', method)
      ? node
      : undefined;
  }
  sameResponse(file: string, input: Expression, response: string): boolean {
    const success = this.operation(file, input, 'succeed', 1);
    const [returned] = success?.arguments ?? [];
    return success !== undefined && returned?.type === 'Identifier' && returned.name === response;
  }
  rewrite(input: Expression): boolean {
    const reference = this.function(this.request.file, input);
    if (reference === undefined || reference.implementation.params.length !== 1 || !cleanFunction(reference)) {
      return false;
    }
    const response = firstParameter(reference.implementation);
    const body = functionResult(reference.implementation);
    if (response === undefined || body?.type !== 'ConditionalExpression') {
      return false;
    }
    const environment = this.environment(reference, [BAD], 0);
    return (
      environment !== undefined &&
      unsupportedStatus(body.test, response) &&
      this.failure(reference.file, body.consequent, environment) &&
      this.sameResponse(reference.file, body.alternate, response)
    );
  }
  handler(input: Expression): boolean {
    const reference = this.function(this.request.file, input);
    if (
      reference === undefined ||
      !cleanFunction(reference) ||
      reference.implementation.params.length < 1 ||
      reference.implementation.params.length > 2 ||
      reference.implementation.params.some((parameter) => parameter.type !== 'Identifier')
    ) {
      return false;
    }
    const body = originalPipe(functionResult(reference.implementation), firstParameter(reference.implementation));
    const rewriteCall = this.operation(reference.file, operationArgument(body, 0), 'flatMap', 1);
    const catchCall = this.operation(reference.file, operationArgument(body, 1), 'catchIf', 2);
    const rewrite = operationArgument(rewriteCall, 0);
    const predicate = operationArgument(catchCall, 0);
    const failure = operationArgument(catchCall, 1);
    return (
      rewrite !== undefined &&
      predicate !== undefined &&
      failure !== undefined &&
      this.rewrite(rewrite) &&
      this.predicate(predicate) &&
      this.failCallback(failure)
    );
  }
}
/** Proves the actual tagged callback's body; the caller still proves the mounted middleware tag and its keys. */
export const provesTaggedMiddlewareContext = (request: TaggedMiddlewareContextRequest): boolean => {
  const expected =
    request.kind === 'schema-error-transform'
      ? ['HttpApiMiddleware', 'layerSchemaErrorTransform']
      : ['Layer', 'succeed'];
  const [namespace, method] = expected;
  const [, implementation] = request.call.arguments;
  if (
    !request.sources.has(request.file) ||
    request.call.optional ||
    request.call.arguments.length !== 2 ||
    namespace === undefined ||
    method === undefined ||
    !request.isNativeMethod(request.file, request.call.callee, namespace, method) ||
    implementation === undefined ||
    implementation.type === 'SpreadElement' ||
    !sameSpan(implementation, request.implementation)
  ) {
    return false;
  }
  const proof = new TaggedContextProof(request);
  return request.kind === 'schema-error-transform'
    ? proof.failCallback(request.implementation)
    : proof.handler(request.implementation);
};
