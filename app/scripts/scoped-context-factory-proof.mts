import {
  Crypto as NativeCrypto,
  Logger as NativeLogger,
  Tracer as NativeTracer,
  References as NativeReferences,
  Schema,
} from 'effect';
import { SqlClient as NativeSqlClient } from 'effect/sql';
import { Reactivity as NativeReactivity } from 'effect/reactivity';
import { FetchHttpClient as NativeFetchHttpClient, HttpClient as NativeHttpClient } from 'effect/http';
import { PgClient as NativePgClient } from '@effect/sql-pg';
import type { Path } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingIdentifier,
  BindingPattern,
  CallExpression,
  Expression,
  IdentifierReference,
  Function as FunctionNode,
  ParamPattern,
  Program,
  Span,
} from 'oxc-parser';

import {
  hasClosedNativeArrayIteratorCustody,
  hasClosedNativeObjectIntrinsicCustody,
  hasClosedNativeStringConstructorCustody,
  hasClosedNativeObjectPrototypeKeyCustody,
  provesDefaultStructEquivalenceSchemaExport,
  provesServiceFreeSchemaExport,
} from '../tools/oxlint/anti-slop/effect/rules/data-factory-proof.ts';
import {
  describeNativeSqlDatabase,
  describeNativeSqlTransaction,
  describeNativeSqlExecute,
  describeNativeSqlTextSelection,
  isCoreDatabaseGuardModule,
} from './native-sql-success-proof.mts';
import type {
  NativeSqlSourceReference,
  NativeSqlProofEnvironment,
  NativeSqlImportEdge,
  NativeSqlDatabaseDescriptor,
  NativeSqlTransactionDescriptor,
} from './native-sql-success-proof.mts';
import { hasClosedNativePgDecoderRegistryCustody } from './pg-decoder-custody-proof.mts';
import type { PgDecoderImportEdge } from './pg-decoder-custody-proof.mts';

import { provesTaggedMiddlewareContext } from './tagged-middleware-context-proof.mts';
import { provesErrorOnlyGlobalMiddleware } from './error-only-global-middleware-proof.mts';
import { hasClosedNativeObjectNamespace } from './scoped-proof-custody.mts';

export interface NativeSqlRuntimeProofEnvironment {
  readonly imports: ReadonlyMap<string, ReadonlyMap<string, PgDecoderImportEdge>>;
}

type Implementation = FunctionNode | ArrowFunctionExpression;
type ObjectProperty = Extract<Expression, { type: 'ObjectExpression' }>['properties'][number];
interface Binding {
  readonly field?: { readonly expression: Expression; readonly key: string };
  readonly init?: Expression;
  readonly kind: string;
  readonly name: string;
  readonly node: Span;
  readonly origin?: { readonly imported: string; readonly source: string };
  readonly parameter?: { readonly fn: Implementation; readonly index: number };
  readonly projection?: { readonly expression: Expression; readonly index: number };
  readonly scope: Span;
}
interface Module {
  readonly bindings: Binding[];
  readonly calls: CallExpression[];
  readonly escapes: Expression[];
  readonly exports: Map<string, string | NonNullable<Binding['origin']>>;
  readonly file: string;
  readonly functions: Implementation[];
  nativeEscapes: boolean;
  readonly program: Program;
  readonly writes: Span[];
}
interface Reference {
  readonly captures: Captures;
  readonly eagerProducer?: Reference;
  readonly elements?: readonly Reference[];
  readonly expression: Expression;
  readonly invocation?: { readonly call: CallExpression; readonly module: Module };
  readonly module: Module;
  readonly success?: true;
}
type RetainedConfigRoot = Reference | false | undefined;
const NativeEffectCallRoleSchema = Schema.Literals(['callable', 'effect', 'pipeable', 'unknown']);
type NativeEffectCallRole = typeof NativeEffectCallRoleSchema.Type;
const nativeEffectCallArities = new Map<
  string,
  { readonly effect: readonly number[]; readonly pipeable: readonly number[] }
>([
  ['all', { effect: [1, 2], pipeable: [] }],
  ['andThen', { effect: [2], pipeable: [1] }],
  ['as', { effect: [2], pipeable: [1] }],
  ['asVoid', { effect: [1], pipeable: [] }],
  ['async', { effect: [1], pipeable: [] }],
  ['catch', { effect: [2], pipeable: [1] }],
  ['catchIf', { effect: [3], pipeable: [2] }],
  ['catchTag', { effect: [3], pipeable: [2] }],
  ['catchTags', { effect: [2], pipeable: [1] }],
  ['context', { effect: [0], pipeable: [] }],
  ['ensuring', { effect: [2], pipeable: [1] }],
  ['fail', { effect: [1], pipeable: [] }],
  ['failCause', { effect: [1], pipeable: [] }],
  ['flatMap', { effect: [2], pipeable: [1] }],
  ['gen', { effect: [1, 2], pipeable: [] }],
  ['map', { effect: [2], pipeable: [1] }],
  ['mapError', { effect: [2], pipeable: [1] }],
  ['match', { effect: [2], pipeable: [1] }],
  ['matchEffect', { effect: [2], pipeable: [1] }],
  ['onExit', { effect: [2], pipeable: [1] }],
  ['promise', { effect: [1], pipeable: [] }],
  ['provideService', { effect: [3], pipeable: [2] }],
  ['service', { effect: [1], pipeable: [] }],
  ['serviceOption', { effect: [1, 2], pipeable: [] }],
  ['sleep', { effect: [1], pipeable: [] }],
  ['succeed', { effect: [1], pipeable: [] }],
  ['suspend', { effect: [1], pipeable: [] }],
  ['sync', { effect: [1], pipeable: [] }],
  ['tap', { effect: [2], pipeable: [1] }],
  ['tapCause', { effect: [2], pipeable: [1] }],
  ['tapError', { effect: [2], pipeable: [1] }],
  ['try', { effect: [1], pipeable: [] }],
  ['tryPromise', { effect: [1], pipeable: [] }],
  ['yieldNow', { effect: [0, 1], pipeable: [] }],
  ['zip', { effect: [2], pipeable: [1] }],
]);
type EffectReadWork = (
  | { readonly expression: Expression; readonly kind: 'expression' }
  | { readonly implementation: Implementation; readonly kind: 'function' }
) & { readonly captures?: Captures; readonly depth: number; readonly module: Module; readonly requiresEffect: boolean };
interface ContextSnapshotProof {
  readonly expression: Expression;
  readonly module: Module;
  valid: boolean;
}
interface ProjectionOrigin {
  readonly bindings: readonly { readonly binding: Binding; readonly module: Module }[];
  readonly handoffs: ReadonlySet<Span>;
  readonly reference: Reference;
}
interface EffectReadFacts {
  readonly facts: WeakMap<object, Map<string, boolean>>;
  readonly size: number;
}
interface CallerCandidateFact {
  readonly exportedNames: ReadonlySet<string>;
  readonly file: string;
  readonly files: readonly (readonly [string, string])[];
  readonly methodName: string | undefined;
  readonly program: Program;
  readonly revision: number;
  readonly wantedSymbols: ReadonlySet<string>;
}
interface CallerInventoryQuery {
  mutation: number;
  revision: number;
}
interface ProducerSchemaFact {
  readonly exported: string;
  readonly filename: string;
  readonly ownerPath: string;
  readonly snapshot: ReadonlyMap<string, string>;
  readonly source: string;
}
interface ComparatorReadScope {
  readonly captures: Captures;
  readonly module: Module;
  readonly read: Span;
}
interface ComparatorMethodFrame {
  readonly captures: Captures;
  readonly fn: Implementation;
  readonly layer?: Reference;
  readonly module: Module;
  readonly name: string;
  readonly tag: Binding;
}
interface CanonicalImportFact {
  readonly program: Program;
  readonly revision: number;
  readonly symbol: { readonly binding: Binding; readonly module: Module };
}
interface TaggedCallbackFact {
  readonly cohort: ReadonlySet<Module>;
  readonly environment: string;
  readonly kind: string;
  readonly program: Program;
}
interface LayerCandidate {
  readonly call: CallExpression;
  readonly frame: Reference;
  readonly module: Module;
  readonly program: Expression;
}
interface NativeSqlReceiverProof {
  readonly database: NativeSqlDatabaseDescriptor;
  readonly reference: Reference;
  readonly transaction?: NativeSqlTransactionDescriptor;
}
interface NativeSqlProofScope {
  readonly environment: NativeSqlProofEnvironment;
  readonly root: Module;
}
interface NativeSqlResolution {
  readonly frames: Reference[];
  readonly proofs: {
    readonly binding: Binding;
    readonly provider: LayerCandidate;
    readonly reference: Reference;
    readonly tag: Expression;
  }[];
  readonly root: Module;
}

type Captures = ReadonlyMap<Binding, Reference>;
interface NativeTagIdentity {
  readonly binding?: Binding;
  readonly key: string;
}
interface ObjectValue {
  readonly authority?: Binding;
  readonly captures: Captures;
  readonly expression: Expression;
  readonly module: Module;
}
interface ConsumerBodySource {
  readonly captures: Captures;
  readonly fn: Implementation;
  readonly module: Module;
}
interface ConsumerSourceObservation {
  value?: ConsumerBodySource;
}
type ConsumerSourceObserver = (source: ConsumerBodySource) => void;
interface RecordBorrower {
  readonly argument: (
    module: Module,
    binding: Binding,
    suffix: string,
    seen: Set<string>,
    call: CallExpression,
    index: number,
  ) => boolean;
  readonly references: (module: Module, binding: Binding, suffix: string) => boolean;
}
type RecordValues = (reference: Reference) => readonly ObjectValue[] | undefined;

interface ConsumerCallableSource {
  readonly acquisition: Expression;
  readonly call: CallExpression;
  readonly caller: Module;
  readonly callerCaptures: Captures;
  readonly captures: Captures;
  readonly fn: Implementation;
  readonly module: Module;
  readonly provider: LayerCandidate;
  readonly tag: Binding;
}
export interface ScopedCapturedParameter {
  readonly binding: Span;
  readonly file: string;
  readonly implementation: Implementation;
  readonly index: number;
}
export interface ScopedCapturedValueRequest {
  readonly expression: Expression;
  readonly file: string;
}
export interface ScopedCapturedValue {
  readonly expression: Expression;
  readonly file: string;
  readonly frames: readonly ScopedCapturedValueRequest[];
  readonly parameter?: ScopedCapturedParameter;
}
export interface ScopedContextFactoryCandidate {
  /** Actual lexical captured inputs, never a declaration that their values are safe. */
  readonly capturedBindings: ReadonlyMap<string, { readonly expression: Expression; readonly file: string }>;
  readonly capturedParameters: ReadonlyMap<string, ScopedCapturedParameter>;
  readonly file: string;
  readonly implementation: Implementation;
  readonly program: Program;
}
export interface ScopedContextFactoryRequest {
  readonly at?: number;
  readonly callee: Expression;
  readonly file: string;
}
const budget = 64;
const comparatorRequestKeys = [
  'authenticationNamespaceId',
  'providerSubjectId',
  'subjectType',
  'enrollmentAttemptId',
  'nonce',
  'sessionRef',
  'tenantId',
];
const inside = (node: Span, scope: Span): boolean => scope.start <= node.start && node.end <= scope.end;
const unwrap = (input: Expression): Expression => {
  let node = input;
  for (let index = 0; index < budget; index += 1) {
    if (
      node.type === 'ChainExpression' ||
      node.type === 'ParenthesizedExpression' ||
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'TSInstantiationExpression'
    ) {
      node = node.expression;
    } else {
      return node;
    }
  }
  return node;
};
const names = (pattern: BindingPattern | ParamPattern): readonly BindingIdentifier[] => {
  if (pattern.type === 'Identifier') {
    return [pattern];
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      names(property.type === 'RestElement' ? property.argument : property.value),
    );
  }
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap((element) => (element === null ? [] : names(element)));
  }
  if (pattern.type === 'AssignmentPattern') {
    return names(pattern.left);
  }
  return pattern.type === 'RestElement' ? names(pattern.argument) : [];
};
const propertyName = (node: Expression): string | undefined =>
  node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined;
const nativeContextModule = 'effect/Context';
const nativeHttpApiModule = 'effect/http-api';
const nativeEffectEdge = '@modern-js/bff-effect/effect-edge';
const nativeEffectClient = '@modern-js/bff-effect/effect-client';
const nativeRuntimeOther = 'other-native';
const nativeModule = (source: string): boolean =>
  [
    'effect',
    'effect/Effect',
    'effect/Layer',
    nativeContextModule,
    'effect/Crypto',
    'effect/Schema',
    'effect/SchemaIssue',
    'effect/Logger',
    'effect/Tracer',
    'effect/References',
    nativeHttpApiModule,
    'effect/http',
    'effect/http/HttpClient',
    'effect/http/FetchHttpClient',
    'effect/reactivity',
    'effect/reactivity/Reactivity',
    '@effect/sql-pg',
    '@effect/sql-pg/PgClient',
    nativeEffectEdge,
    nativeEffectClient,
  ].includes(source);
const inheritedObjectNames = new Set([
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
]);
const ownDataFields = (input: Expression): ReadonlyMap<string, Expression> | undefined => {
  const node = unwrap(input);
  if (node.type !== 'ObjectExpression') {
    return undefined;
  }
  const fields = new Map<string, Expression>();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
      return undefined;
    }
    let key: string | undefined;
    if (property.key.type === 'Identifier') {
      key = property.key.name;
    } else if (property.key.type === 'Literal' && Schema.is(Schema.String)(property.key.value)) {
      key = property.key.value;
    }
    if (key === undefined || key === '__proto__' || fields.has(key)) {
      return undefined;
    }
    fields.set(key, property.value);
  }
  return fields;
};
const nativeMember = (
  input: Expression,
): { readonly identifier: IdentifierReference; readonly method: string } | undefined => {
  let node = unwrap(input);
  const parts: string[] = [];
  for (let hops = 0; hops < budget; hops += 1) {
    if (node.type === 'Identifier') {
      return { identifier: node, method: parts.join('.') };
    }
    if (node.type !== 'MemberExpression' || node.optional || node.computed || node.property.type !== 'Identifier') {
      return undefined;
    }
    parts.unshift(node.property.name);
    node = unwrap(node.object);
  }
  return undefined;
};
const functionValue = (input: Expression): Implementation | undefined => {
  const node = unwrap(input);
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' ? node : undefined;
};
const parseModule = (file: string, source: string): Module | undefined => {
  const parsed = parseSync(file, source, { sourceType: 'module' });
  if (parsed.errors.length !== 0) {
    return undefined;
  }
  const module: Module = {
    bindings: [],
    calls: [],
    escapes: [],
    exports: new Map(),
    file,
    functions: [],
    nativeEscapes: false,
    program: parsed.program,
    writes: [],
  };
  const scopes: Span[] = [module.program];
  const kinds = new Map<Span, string>();
  const scope = (): Span => scopes.at(-1) ?? module.program;
  const variableScope = (kind: string | undefined): Span => {
    if (kind !== 'var') {
      return scope();
    }
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const candidate = scopes[index];
      if (
        candidate !== undefined &&
        (candidate === module.program || module.functions.some((fn) => fn === candidate))
      ) {
        return candidate;
      }
    }
    return module.program;
  };

  const enter = (node: Implementation): void => {
    module.functions.push(node);
    if (node.type === 'FunctionDeclaration' && node.id !== null) {
      module.bindings.push({ init: node, kind: 'function', name: node.id.name, node: node.id, scope: scope() });
    }
    scopes.push(node);
    if (node.type === 'FunctionExpression' && node.id !== null) {
      module.bindings.push({ init: node, kind: 'function', name: node.id.name, node: node.id, scope: node });
    }
    for (const [index, parameter] of node.params.entries()) {
      for (const name of names(parameter)) {
        module.bindings.push({
          kind: 'parameter',
          name: name.name,
          node: name,
          parameter: { fn: node, index },
          scope: node,
        });
      }
    }
  };
  new Visitor({
    ArrowFunctionExpression: enter,
    'ArrowFunctionExpression:exit': () => {
      scopes.pop();
    },
    AssignmentExpression(node) {
      module.writes.push(node.left);
      module.escapes.push(node.right);
    },
    BlockStatement(node) {
      scopes.push(node);
    },
    'BlockStatement:exit'() {
      scopes.pop();
    },
    CallExpression(node) {
      module.calls.push(node);
    },
    CatchClause(node) {
      if (node.param !== null && node.param !== undefined) {
        for (const name of names(node.param)) {
          module.bindings.push({ kind: 'catch', name: name.name, node: name, scope: node });
        }
      }
    },
    ClassDeclaration(node) {
      if (node.id !== null) {
        module.bindings.push({ kind: 'class', name: node.id.name, node: node.id, scope: scope() });
      }
    },
    ClassExpression(node) {
      if (node.id !== null) {
        module.bindings.push({ kind: 'class', name: node.id.name, node: node.id, scope: node });
      }
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== 'type' && nativeModule(node.source.value)) {
        module.nativeEscapes = true;
      }
    },
    ExportNamedDeclaration(node) {
      if (node.exportKind === 'type') {
        return;
      }
      if (
        node.source !== null &&
        node.specifiers.some((specifier) => specifier.exportKind !== 'type') &&
        nativeModule(node.source.value)
      ) {
        module.nativeEscapes = true;
      }
      if (node.declaration?.type === 'VariableDeclaration') {
        for (const declaration of node.declaration.declarations) {
          for (const name of names(declaration.id)) {
            module.exports.set(name.name, name.name);
          }
        }
      } else if (
        (node.declaration?.type === 'FunctionDeclaration' || node.declaration?.type === 'ClassDeclaration') &&
        node.declaration.id !== null
      ) {
        module.exports.set(node.declaration.id.name, node.declaration.id.name);
      }
      for (const specifier of node.specifiers) {
        if (
          specifier.exportKind !== 'type' &&
          specifier.exported.type === 'Identifier' &&
          specifier.local.type === 'Identifier'
        ) {
          module.exports.set(
            specifier.exported.name,
            node.source === null ? specifier.local.name : { imported: specifier.local.name, source: node.source.value },
          );
        }
      }
    },
    FunctionDeclaration: enter,
    'FunctionDeclaration:exit': () => {
      scopes.pop();
    },
    FunctionExpression: enter,
    'FunctionExpression:exit': () => {
      scopes.pop();
    },
    ImportDeclaration(node) {
      if (node.importKind === 'type') {
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          module.bindings.push({
            kind: 'import',
            name: specifier.local.name,
            node: specifier.local,
            origin: { imported: '*', source: node.source.value },
            scope: module.program,
          });
        } else if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          specifier.imported.type === 'Identifier'
        ) {
          module.bindings.push({
            kind: 'import',
            name: specifier.local.name,
            node: specifier.local,
            origin: { imported: specifier.imported.name, source: node.source.value },
            scope: module.program,
          });
        }
      }
    },
    ImportExpression(node) {
      if (
        node.source.type !== 'Literal' ||
        !Schema.is(Schema.String)(node.source.value) ||
        nativeModule(node.source.value)
      ) {
        module.nativeEscapes = true;
      }
    },
    NewExpression(node) {
      for (const argument of node.arguments) {
        module.escapes.push(argument.type === 'SpreadElement' ? argument.argument : argument);
      }
    },
    PropertyDefinition(node) {
      if (node.value !== null) {
        module.escapes.push(node.value);
      }
    },
    TaggedTemplateExpression(node) {
      module.escapes.push(...node.quasi.expressions);
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        module.writes.push(node.argument);
      }
    },
    UpdateExpression(node) {
      module.writes.push(node.argument);
    },
    VariableDeclaration(node) {
      for (const declaration of node.declarations) {
        kinds.set(declaration, node.kind);
      }
    },
    VariableDeclarator(node) {
      for (const name of names(node.id)) {
        const binding: Binding & {
          field?: { expression: Expression; key: string };
          init?: Expression;
          projection?: { expression: Expression; index: number };
        } = {
          kind: kinds.get(node) ?? 'unknown',
          name: name.name,
          node: name,
          scope: variableScope(kinds.get(node)),
        };
        if (node.id.type === 'Identifier' && node.init !== null) {
          binding.init = node.init;
        }
        if (node.id.type === 'ArrayPattern' && node.init !== null) {
          const index = node.id.elements.findIndex(
            (element) => element !== null && names(element).some((value) => value.start === name.start),
          );
          if (index !== -1) {
            binding.projection = { expression: node.init, index };
          }
        }
        if (node.id.type === 'ObjectPattern' && node.init !== null) {
          for (const property of node.id.properties) {
            if (
              property.type === 'Property' &&
              !property.computed &&
              property.key.type === 'Identifier' &&
              names(property.value).some((value) => value.start === name.start)
            ) {
              binding.field = { expression: node.init, key: property.key.name };
            }
          }
        }
        module.bindings.push(binding);
      }
    },
  }).visit(module.program);
  for (const binding of module.bindings) {
    Object.freeze(binding);
  }
  Object.freeze(module.bindings);
  return module;
};
interface BindingSyntaxFacts {
  readonly byName: ReadonlyMap<string, readonly Binding[]>;
  readonly initialized: readonly Binding[];
  readonly origins: readonly Binding[];
}
const bindingSyntaxFacts = new WeakMap<Program, WeakMap<readonly Binding[], BindingSyntaxFacts>>();
const bindingSyntax = (module: Module): BindingSyntaxFacts => {
  let arrays = bindingSyntaxFacts.get(module.program);
  if (arrays === undefined) {
    arrays = new WeakMap();
    bindingSyntaxFacts.set(module.program, arrays);
  }
  const known = arrays.get(module.bindings);
  if (known !== undefined) {
    return known;
  }
  const byName = new Map<string, Binding[]>();
  for (const binding of module.bindings) {
    const named = byName.get(binding.name) ?? [];
    named.push(binding);
    byName.set(binding.name, named);
  }
  const facts = {
    byName,
    initialized: module.bindings.filter((binding) => binding.init !== undefined),
    origins: module.bindings.filter((binding) => binding.origin !== undefined),
  };
  arrays.set(module.bindings, facts);
  return facts;
};
const bindingAt = (module: Module, name: string, at: Span): Binding | undefined => {
  const bindings = (bindingSyntax(module).byName.get(name) ?? []).filter((binding) => inside(at, binding.scope));
  bindings.sort((left, right) => left.scope.end - left.scope.start - (right.scope.end - right.scope.start));
  const [binding, next] = bindings;
  return binding !== undefined && (next === undefined || binding.scope !== next.scope) ? binding : undefined;
};
const writeIdentifierFacts = new WeakMap<Program, ReadonlyMap<Span, readonly (Span & { readonly name: string })[]>>();
const writeIdentifiers = (module: Module, write: Span): readonly (Span & { readonly name: string })[] | undefined => {
  let facts = writeIdentifierFacts.get(module.program);
  if (facts === undefined) {
    const collected = new Map<Span, (Span & { readonly name: string })[]>(module.writes.map((value) => [value, []]));
    new Visitor({
      Identifier(node) {
        for (const [span, references] of collected) {
          if (inside(node, span)) {
            references.push(node);
          }
        }
      },
    }).visit(module.program);
    facts = collected;
    writeIdentifierFacts.set(module.program, facts);
  }
  return facts.get(write);
};
const uncachedStable = (module: Module, binding: Binding): boolean =>
  binding.kind !== 'let' &&
  binding.kind !== 'var' &&
  binding.kind !== 'unknown' &&
  !module.writes.some((write) => {
    const references = writeIdentifiers(module, write);
    return (
      references === undefined ||
      references.some((node) => node.name === binding.name && bindingAt(module, node.name, node) === binding)
    );
  });
const stabilityCache = new WeakMap<Binding, boolean>();
const stable = (module: Module, binding: Binding): boolean => {
  const cached = stabilityCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  stabilityCache.set(binding, false);
  const aliases = module.bindings.filter((candidate) => {
    const input = candidate.init === undefined ? undefined : unwrap(candidate.init);
    return candidate !== binding && input?.type === 'Identifier' && bindingAt(module, input.name, input) === binding;
  });
  const result = uncachedStable(module, binding) && aliases.every((alias) => stable(module, alias));
  stabilityCache.set(binding, result);
  return result;
};

const rootedAtBinding = (module: Module, input: Expression, binding: Binding): boolean => {
  let node = unwrap(input);
  for (let index = 0; index < budget; index += 1) {
    if (node.type === 'Identifier') {
      return bindingAt(module, node.name, node) === binding;
    }
    if (node.type !== 'MemberExpression') {
      return false;
    }
    node = unwrap(node.object);
  }
  return false;
};
const fixedTagMember = (module: Module, input: Expression, binding: Binding): boolean => {
  const node = unwrap(input);
  return (
    node.type === 'MemberExpression' &&
    rootedAtBinding(module, node.object, binding) &&
    [
      'Crypto',
      'PgClient',
      'Reactivity',
      'RequestInit',
      'HttpClient',
      'CurrentLoggers',
      'Tracer',
      'ParentSpan',
      'CurrentStackFrame',
      'MinimumLogLevel',
    ].includes(propertyName(node) ?? '')
  );
};
const readonlyNativeTagSlot = (namespace: string, method: string, arity: number, index: number): boolean => {
  if (namespace === 'Context' && method === 'omit') {
    return arity > 0 && index < arity;
  }
  const fixed = new Map([
    [
      'Layer.effect',
      new Map([
        [1, [0]],
        [2, [0, 1]],
      ]),
    ],
    [
      'Layer.succeed',
      new Map([
        [1, [0]],
        [2, [0]],
      ]),
    ],
    [
      'Effect.provideService',
      new Map([
        [2, [0]],
        [3, [1]],
      ]),
    ],
    ['Effect.serviceOption', new Map([[1, [0]]])],
    ['Effect.service', new Map([[1, [0]]])],
    [
      'Effect.all',
      new Map([
        [1, [0]],
        [2, [0]],
      ]),
    ],
    ['Context.make', new Map([[2, [0]]])],
    [
      'Context.add',
      new Map([
        [2, [0]],
        [3, [1]],
      ]),
    ],
    [
      'Context.get',
      new Map([
        [1, [0]],
        [2, [1]],
      ]),
    ],
    [
      'Context.getOrUndefined',
      new Map([
        [1, [0]],
        [2, [1]],
      ]),
    ],
    ['HttpApiMiddleware.layerSchemaErrorTransform', new Map([[2, [0]]])],
  ]);
  return fixed.get(`${namespace}.${method}`)?.get(arity)?.includes(index) === true;
};
const nativeReadonlyTagArgument = (
  module: Module,
  call: CallExpression,
  index: number,
  closedNamespace: (module: Module, binding: Binding) => boolean,
): boolean => {
  const member = nativeMember(call.callee);
  const binding = member === undefined ? undefined : bindingAt(module, member.identifier.name, member.identifier);
  const origin = binding?.origin;
  if (
    member === undefined ||
    origin === undefined ||
    binding === undefined ||
    !nativeModule(origin.source) ||
    !stable(module, binding)
  ) {
    return false;
  }
  return (
    readonlyNativeTagSlot(origin.imported, member.method, call.arguments.length, index) &&
    closedNamespace(module, binding)
  );
};
const namespaceCache = new WeakMap<Binding, boolean>();
const namespaceClosed = (module: Module, binding: Binding): boolean => {
  const cached = namespaceCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  namespaceCache.set(binding, false);
  const uses: Span[] = [binding.node];
  const types: Span[] = [];
  const ignored = new Set<number>();
  let forbidden = false;
  const fixedReferences: Span[] = [];
  const readonlyValues: Span[] = [];
  new Visitor({
    CallExpression(node) {
      for (const [index, argument] of node.arguments.entries()) {
        if (argument.type !== 'SpreadElement' && nativeReadonlyTagArgument(module, node, index, namespaceClosed)) {
          readonlyValues.push(argument);
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        types.push(node);
      }
    },
    ImportDeclaration(node) {
      types.push(node);
    },
    MemberExpression(node) {
      if (fixedTagMember(module, node, binding)) {
        fixedReferences.push(node);
      }
      readonlyValues.push(node.object);
      if (
        rootedAtBinding(module, node.object, binding) &&
        (node.computed || inheritedObjectNames.has(propertyName(node) ?? ''))
      ) {
        forbidden = true;
      }
      uses.push(node.object);
      if (!node.computed) {
        ignored.add(node.property.start);
      }
    },
    Property(node) {
      if (!node.computed && !node.shorthand) {
        ignored.add(node.key.start);
      }
    },
    ReturnStatement(node) {
      if (node.argument !== null && fixedTagMember(module, node.argument, binding)) {
        forbidden = true;
      }
    },
    TSTypeAnnotation(node) {
      types.push(node);
    },
    TSTypeQuery(node) {
      types.push(node);
    },
    TSTypeReference(node) {
      types.push(node);
    },
    VariableDeclarator(node) {
      if (node.init !== null && fixedTagMember(module, node.init, binding)) {
        const alias = node.id.type === 'Identifier' ? bindingAt(module, node.id.name, node.id) : undefined;
        if (alias === undefined || !namespaceClosed(module, alias)) {
          forbidden = true;
        } else {
          readonlyValues.push(node.init);
        }
      }
    },
    YieldExpression(node) {
      if (node.argument !== null) {
        readonlyValues.push(node.argument);
      }
    },
  }).visit(module.program);
  let closed =
    !forbidden &&
    fixedReferences.every((reference) =>
      readonlyValues.some((value) => reference.start === value.start && reference.end === value.end),
    );
  new Visitor({
    Identifier(node) {
      if (
        node.name === binding.name &&
        bindingAt(module, node.name, node) === binding &&
        !ignored.has(node.start) &&
        !types.some((type) => inside(node, type)) &&
        !uses.some((use) => use.start === node.start && use.end === node.end)
      ) {
        closed = false;
      }
    },
  }).visit(module.program);
  namespaceCache.set(binding, closed);
  return closed;
};
const objectIntrinsicCache = new WeakMap<Module, boolean>();
const objectIntrinsicClosed = (module: Module): boolean => {
  const cached = objectIntrinsicCache.get(module);
  if (cached !== undefined) {
    return cached;
  }
  const closed = hasClosedNativeObjectNamespace(module.program);
  objectIntrinsicCache.set(module, closed);
  return closed;
};

const directCallSyntaxFacts = new WeakMap<Program, WeakMap<Binding, boolean>>();
const directCallsOnly = (module: Module, binding: Binding): boolean => {
  let facts = directCallSyntaxFacts.get(module.program);
  if (facts === undefined) {
    facts = new WeakMap();
    directCallSyntaxFacts.set(module.program, facts);
  }
  const known = facts.get(binding);
  if (known !== undefined) {
    return known;
  }
  const ignored: Span[] = [binding.node];
  const keys = new Set<number>();
  const callees = new Set<number>();
  new Visitor({
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier') {
        callees.add(callee.start);
      }
    },
    ImportDeclaration(node) {
      ignored.push(node);
    },
    MemberExpression(node) {
      if (!node.computed) {
        keys.add(node.property.start);
      }
    },
    Property(node) {
      if (!node.computed && !node.shorthand) {
        keys.add(node.key.start);
      }
    },
    TSTypeAnnotation(node) {
      ignored.push(node);
    },
    TSTypeQuery(node) {
      ignored.push(node);
    },
    TSTypeReference(node) {
      ignored.push(node);
    },
  }).visit(module.program);
  let closed = true;
  new Visitor({
    Identifier(node) {
      if (
        node.name === binding.name &&
        bindingAt(module, node.name, node) === binding &&
        !ignored.some((span) => inside(node, span)) &&
        !keys.has(node.start) &&
        !callees.has(node.start)
      ) {
        closed = false;
      }
    },
  }).visit(module.program);
  facts.set(binding, closed);
  return closed;
};
const localReturnExpressions = (module: Module, fn: Implementation): readonly Expression[] | undefined => {
  if (fn.body?.type !== 'BlockStatement') {
    return fn.body === null ? undefined : [fn.body];
  }
  const last = fn.body.body.at(-1);
  if (last?.type !== 'ReturnStatement') {
    return undefined;
  }
  const nested = module.functions.filter((value) => value !== fn && inside(value, fn));
  const values: Expression[] = [];
  let valid = true;
  new Visitor({
    ReturnStatement(node) {
      if (inside(node, fn) && !nested.some((value) => inside(node, value))) {
        if (node.argument === null) {
          valid = false;
        } else {
          values.push(node.argument);
        }
      }
    },
  }).visit(module.program);
  return valid && values.length > 0 ? values : undefined;
};
const nativeConstructorObjectCache = new WeakMap<Module, boolean>();
const nativeConstructorObjectsClosed = (module: Module): boolean => {
  const cached = nativeConstructorObjectCache.get(module);
  if (cached !== undefined) {
    return cached;
  }
  const closed = hasClosedNativeObjectIntrinsicCustody(module.program, ['setPrototypeOf', 'create', 'defineProperty']);
  nativeConstructorObjectCache.set(module, closed);
  return closed;
};
const directReturn = (fn: Implementation, program: Program): Expression | undefined => {
  if (fn.body?.type !== 'BlockStatement') {
    return fn.body ?? undefined;
  }
  const returns: Span[] = [];
  const nested: Span[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node !== fn && inside(node, fn)) {
        nested.push(node);
      }
    },
    FunctionDeclaration(node) {
      if (node !== fn && inside(node, fn)) {
        nested.push(node);
      }
    },
    FunctionExpression(node) {
      if (node !== fn && inside(node, fn)) {
        nested.push(node);
      }
    },
    ReturnStatement(node) {
      if (inside(node, fn)) {
        returns.push(node);
      }
    },
  }).visit(program);
  const local = returns.filter((node) => !nested.some((scope) => inside(node, scope)));
  const last = fn.body.body.at(-1);
  return local.length === 1 && last?.type === 'ReturnStatement' && local[0] === last
    ? (last.argument ?? undefined)
    : undefined;
};

class FactoryResolver {
  readonly modules = new Map<string, Module>();
  readonly parsedCandidates = new Map<string, Module>();
  readonly sources: ReadonlyMap<string, string>;
  readonly root: string;
  readonly path: Path.Path;
  readonly packageExports: ReadonlyMap<string, string>;
  readonly conditionalPackageExports: ReadonlyMap<string, readonly string[]>;
  readonly relativeContractSources: ReadonlyMap<string, string>;
  readonly contractSources: ReadonlyMap<string, string>;
  currentFixedOutputs = new Set<string>();
  readonly layerFrames = new WeakMap<CallExpression, Map<string, Reference>>();
  contextSnapshotProofs: Map<string, ContextSnapshotProof> | undefined;
  readonly tagCustodyCache = new WeakMap<Binding, { readonly closed: boolean; readonly size: number }>();
  readonly tagKeys = new WeakMap<Binding, string>();
  readonly cohortCache = new Map<string, { readonly closed: boolean; readonly size: number }>();
  readonly providerCache = new Map<Binding, Map<Module, readonly ObjectValue[] | undefined>>();
  readonly producerSchemaFacts = new WeakMap<Binding, ProducerSchemaFact>();
  readonly comparatorPrototypeFacts = new WeakSet<Program>();
  readonly activeComparatorCalls = new Set<CallExpression>();
  readonly activeObjectCustody = new WeakMap<Binding, Set<string>>();
  readonly consumerSourceCalls = new Map<CallExpression, ConsumerCallableSource>();
  readonly activeConsumerBodies = new Set<Implementation>();
  readonly consumerKeyScopes = new Set<Binding>();
  readonly activeConsumerKeyCustody = new Set<Binding>();
  consumerSourceProofUsed = false;
  readonly consumerSourceSnapshot: ReadonlyMap<string, string>;
  readonly consumerExportSnapshot: ReadonlyMap<string, string>;
  readonly consumerConditionalSnapshot: ReadonlyMap<string, readonly string[]>;
  readonly consumerContractSnapshot: ReadonlyMap<string, string>;
  readonly comparatorDecoderBuilders = new WeakMap<
    CallExpression,
    { readonly root: Module; readonly schema: Binding; readonly source: string }
  >();
  readonly effectReadFacts = new WeakMap<Span, EffectReadFacts>();
  readonly closedLayerFacts = new WeakMap<Expression, number>();
  static readonly functionReturnFacts = new WeakMap<Program, WeakMap<Implementation, readonly Expression[]>>();
  readonly arrayIteratorFacts = new WeakMap<Program, boolean>();
  readonly stringConstructorFacts = new WeakMap<Program, boolean>();
  readonly callerCandidateFacts = new WeakMap<Implementation, readonly CallerCandidateFact[]>();
  readonly canonicalImportFacts = new WeakMap<Module, WeakMap<Binding, Map<string, CanonicalImportFact>>>();
  structuralSources = new Map<string, string>();
  structuralPackageExports = new Map<string, string>();
  structuralConditionalExports = new Map<string, readonly string[]>();
  structuralContracts = new Map<string, string>();
  structuralRelativeContracts = new Map<string, string>();
  structuralRuntime = new Set<Module>();
  structuralCandidates = new Set<Module>();
  structuralRevision = 0;
  moduleMutationRevision = 0;
  readonly taggedCallbackFacts = new WeakMap<CallExpression, readonly TaggedCallbackFact[]>();
  acquisitionProvider:
    | { readonly binding: Binding; readonly provider: LayerCandidate; readonly root: Module }
    | undefined;
  readonly nativeSqlRuntimeProof: NativeSqlRuntimeProofEnvironment | undefined;
  nativeSqlContext: { readonly environment: NativeSqlProofEnvironment; readonly root: Module } | undefined;
  constructor(
    sources: ReadonlyMap<string, string>,
    root: string,
    path: Path.Path,
    packageExports: ReadonlyMap<string, string>,
    conditionalPackageExports: ReadonlyMap<string, readonly string[]> = new Map(),
    contractSources: ReadonlyMap<string, string> = sources,
    nativeSqlRuntimeProof?: NativeSqlRuntimeProofEnvironment,
  ) {
    this.sources = sources;
    this.nativeSqlRuntimeProof = nativeSqlRuntimeProof;
    this.root = root;
    this.path = path;
    this.packageExports = packageExports;
    this.conditionalPackageExports = conditionalPackageExports;
    this.contractSources = contractSources;
    this.consumerSourceSnapshot = new Map(sources);
    this.consumerExportSnapshot = new Map(packageExports);
    this.consumerConditionalSnapshot = new Map(
      [...conditionalPackageExports].map(([name, files]) => [name, [...files]]),
    );
    this.consumerContractSnapshot = new Map(contractSources);
    this.relativeContractSources = new Map(
      [...contractSources].map(([file, text]) => [path.relative(root, file).split(path.sep).join('/'), text]),
    );
  }
  runtimeProofModules(): readonly {
    readonly bindings: readonly Binding[];
    readonly file: string;
    readonly program: Program;
  }[] {
    return [...this.modules.values()].map(({ bindings, file, program }) => ({ bindings, file, program }));
  }
  module(file: string): Module | undefined {
    const cached = this.modules.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = this.sources.get(file);
    if (source === undefined || /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?tsx?$/u.test(file)) {
      return undefined;
    }
    const parsed = parseModule(file, source);
    if (parsed !== undefined) {
      this.modules.set(file, parsed);
      this.moduleMutationRevision += 1;
      for (const statement of parsed.program.body) {
        if (
          statement.type === 'ImportDeclaration' &&
          statement.importKind !== 'type' &&
          (statement.specifiers.length === 0 ||
            statement.specifiers.some(
              (specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type',
            ))
        ) {
          this.dependency(parsed, statement.source.value);
        }
        if (
          statement.type === 'ExportNamedDeclaration' &&
          statement.exportKind !== 'type' &&
          statement.source !== null &&
          statement.specifiers.some((specifier) => specifier.exportKind !== 'type')
        ) {
          this.dependency(parsed, statement.source.value);
        }
        if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
          this.dependency(parsed, statement.source.value);
        }
      }
    }
    return parsed;
  }
  dependency(module: Module, specifier: string): Module | undefined {
    const file = this.dependencyFile(module, specifier);
    return file === undefined ? undefined : this.module(file);
  }
  dependencyFile(module: Module, specifier: string): string | undefined {
    const exact = this.packageExports.get(specifier);
    if (exact !== undefined) {
      return exact;
    }
    if (!specifier.startsWith('.')) {
      return undefined;
    }
    const base = this.path.resolve(this.path.dirname(module.file), specifier);
    return [base, `${base}.ts`, `${base}.mts`, this.path.join(base, 'index.ts')].find((file) => this.sources.has(file));
  }
  candidateModule(file: string): Module | undefined {
    if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?tsx?$/u.test(file)) {
      return undefined;
    }
    const active = this.modules.get(file) ?? this.parsedCandidates.get(file);
    if (active !== undefined) {
      return active;
    }
    const source = this.sources.get(file);
    const parsed = source === undefined ? undefined : parseModule(file, source);
    if (parsed !== undefined) {
      this.parsedCandidates.set(file, parsed);
      this.moduleMutationRevision += 1;
    }
    return parsed;
  }
  candidateDependency(module: Module, specifier: string): Module | undefined {
    const file = this.dependencyFile(module, specifier);
    return file === undefined ? undefined : this.candidateModule(file);
  }
  symbol(module: Module, node: Expression): { readonly binding: Binding; readonly module: Module } | undefined {
    const value = unwrap(node);
    if (value.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(module, value.name, value);
    if (binding === undefined || !stable(module, binding)) {
      return undefined;
    }
    if (binding.origin === undefined) {
      return { binding, module };
    }
    const target = this.dependency(module, binding.origin.source);
    return target === undefined ? undefined : this.exportedSymbol(target, binding.origin.imported, new Set());
  }
  exportedSymbol(
    module: Module,
    name: string,
    seen: Set<string>,
    inventory = false,
  ): { readonly binding: Binding; readonly module: Module } | undefined {
    const key = `${module.file}:${name}`;
    if (seen.has(key) || seen.size >= budget) {
      return undefined;
    }
    const next = new Set(seen).add(key);
    const exported = module.exports.get(name);
    if (exported === undefined) {
      return undefined;
    }
    if (!Schema.is(Schema.String)(exported)) {
      const target = inventory
        ? this.candidateDependency(module, exported.source)
        : this.dependency(module, exported.source);
      return target === undefined ? undefined : this.exportedSymbol(target, exported.imported, next, inventory);
    }
    const binding = bindingAt(module, exported, module.program);
    if (binding === undefined || !stable(module, binding)) {
      return undefined;
    }
    if (binding.origin !== undefined) {
      const target = inventory
        ? this.candidateDependency(module, binding.origin.source)
        : this.dependency(module, binding.origin.source);
      return target === undefined ? undefined : this.exportedSymbol(target, binding.origin.imported, next, inventory);
    }
    return { binding, module };
  }

  native(module: Module, node: Expression, namespace: string, method: string): boolean {
    const value = nativeMember(node);
    if (value === undefined || value.method !== method) {
      return false;
    }
    const binding = bindingAt(module, value.identifier.name, value.identifier);
    if (binding?.origin === undefined) {
      return false;
    }
    const origin = this.nativeBindingOrigin(module, binding.origin);
    return (
      origin?.imported === namespace &&
      FactoryResolver.nativeSource(origin.source, namespace) &&
      stable(module, binding) &&
      namespaceClosed(module, binding) &&
      this.nativeCohort(namespace)
    );
  }
  nativeBindingOrigin(
    module: Module,
    origin: NonNullable<Binding['origin']>,
    seen = new Set<string>(),
  ): Binding['origin'] {
    if (nativeModule(origin.source)) {
      return origin;
    }
    const edge = this.nativeSqlRuntimeProof?.imports.get(module.file)?.get(origin.source);
    if (edge?.kind !== 'module') {
      return undefined;
    }
    const target = this.modules.get(edge.file);
    const key = `${edge.file}:${origin.imported}`;
    if (target === undefined || seen.has(key) || seen.size >= budget) {
      return undefined;
    }
    const exported = target.exports.get(origin.imported);
    if (exported === undefined || Schema.is(Schema.String)(exported)) {
      return undefined;
    }
    if (
      exported.source === nativeEffectClient &&
      this.nativeSqlRuntimeProof?.imports.get(target.file)?.get(exported.source)?.kind !== nativeRuntimeOther
    ) {
      return undefined;
    }
    return this.nativeBindingOrigin(target, exported, new Set(seen).add(key));
  }
  canonicalSdkReexportsClosed(module: Module): boolean {
    if (!module.nativeEscapes) {
      return true;
    }
    let closed = true;
    new Visitor({
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && nativeModule(node.source.value)) {
          closed = false;
        }
      },
      ExportNamedDeclaration: (node) => {
        if (node.exportKind === 'type' || node.source === null || !nativeModule(node.source.value)) {
          return;
        }
        if (
          node.source.value !== nativeEffectClient ||
          this.nativeSqlRuntimeProof?.imports.get(module.file)?.get(node.source.value)?.kind !== nativeRuntimeOther ||
          !node.specifiers.every(
            (specifier) =>
              specifier.exportKind === 'type' ||
              (specifier.local.type === 'Identifier' && ['Effect', 'runEffectRequest'].includes(specifier.local.name)),
          )
        ) {
          closed = false;
        }
      },
      ImportExpression(node) {
        if (
          node.source.type !== 'Literal' ||
          !Schema.is(Schema.String)(node.source.value) ||
          nativeModule(node.source.value)
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  static nativeSource(source: string, namespace: string): boolean {
    if (source === 'effect') {
      return [
        'Effect',
        'Layer',
        'Context',
        'Config',
        'ConfigProvider',
        'Data',
        'Crypto',
        'Logger',
        'Tracer',
        'References',
        'Schema',
        'SchemaIssue',
      ].includes(namespace);
    }
    const namespaces = new Map([
      [nativeEffectClient, ['Effect', 'Layer', 'Schema', 'HttpApi', 'HttpApiGroup', 'HttpApiEndpoint']],
      ['effect/reactivity', ['Reactivity']],
      ['effect/http', ['FetchHttpClient', 'HttpClient', 'HttpRouter', 'HttpServerResponse']],
      ['@effect/sql-pg', ['PgClient']],
      [
        nativeHttpApiModule,
        ['HttpApi', 'HttpApiGroup', 'HttpApiEndpoint', 'HttpApiBuilder', 'HttpApiMiddleware', 'HttpApiError'],
      ],
      [
        nativeEffectEdge,
        [
          'Effect',
          'Layer',
          'Context',
          'Crypto',
          'HttpApi',
          'HttpApiGroup',
          'HttpApiEndpoint',
          'HttpApiBuilder',
          'HttpApiMiddleware',
          'HttpApiError',
        ],
      ],
    ]);
    return namespaces.get(source)?.includes(namespace) === true;
  }

  nativeCohort(namespace: string): boolean {
    const cached = this.cohortCache.get(namespace);
    if (cached?.size === this.modules.size) {
      return cached.closed;
    }
    const result = this.uncachedNativeCohort(namespace);
    this.cohortCache.set(namespace, { closed: result, size: this.modules.size });
    return result;
  }
  uncachedNativeCohort(namespace: string): boolean {
    for (const module of this.modules.values()) {
      if (!this.canonicalSdkReexportsClosed(module)) {
        return false;
      }
      for (const binding of module.bindings) {
        const imported = binding.origin;
        const origin = imported === undefined ? undefined : this.nativeBindingOrigin(module, imported);
        if (origin === undefined || !nativeModule(origin.source)) {
          continue;
        }
        const same = origin.imported === namespace || origin.source === `effect/${namespace}`;
        if (same && (!stable(module, binding) || !namespaceClosed(module, binding))) {
          return false;
        }
        if (origin.imported === '*' && origin.source !== `effect/${namespace}` && !directCallsOnly(module, binding)) {
          return false;
        }
      }
    }
    return true;
  }
  static reference(module: Module, expression: Expression, captures: Captures): Reference {
    return { captures, expression, module };
  }
  function(
    module: Module,
    input: Expression,
    hops = 0,
    captures: Captures = new Map(),
  ): { readonly captures?: Captures; readonly fn: Implementation; readonly module: Module } | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const value = unwrap(input);
    const literal = functionValue(value);
    if (literal !== undefined) {
      return { fn: literal, module };
    }
    if (value.type === 'Identifier') {
      const symbol = this.symbol(module, value);
      return symbol?.binding.init === undefined
        ? undefined
        : this.function(symbol.module, symbol.binding.init, hops + 1, captures);
    }
    if (value.type === 'MemberExpression') {
      return this.mountedFunction(module, value, captures, hops);
    }
    if (value.type === 'CallExpression' && value.arguments.length === 1) {
      const [fn] = value.arguments;
      const callee = unwrap(value.callee);
      if (
        fn !== undefined &&
        fn.type !== 'SpreadElement' &&
        (this.native(module, callee, 'Effect', 'gen') ||
          this.native(module, callee, 'Effect', 'fn') ||
          (callee.type === 'CallExpression' && this.native(module, callee.callee, 'Effect', 'fn')))
      ) {
        const implementation = functionValue(fn);
        return implementation === undefined ? undefined : { fn: implementation, module };
      }
    }
    return undefined;
  }
  mountedFunction(
    module: Module,
    node: Extract<Expression, { type: 'MemberExpression' }>,
    captures: Captures,
    hops: number,
  ): { readonly captures: Captures; readonly fn: Implementation; readonly module: Module } | undefined {
    const proof = this.acquisitionProvider;
    if (node.optional || node.computed || proof === undefined) {
      return undefined;
    }
    const receiverBinding =
      node.object.type === 'Identifier' ? bindingAt(module, node.object.name, node.object) : undefined;
    const acquisition = receiverBinding?.init === undefined ? undefined : unwrap(receiverBinding.init);
    if (acquisition?.type !== 'YieldExpression' || !acquisition.delegate || acquisition.argument === null) {
      return undefined;
    }
    const binding = this.tag(module, acquisition.argument);
    if (
      binding === undefined ||
      receiverBinding === undefined ||
      !this.objectCustody(module, receiverBinding, '', new Set())
    ) {
      return undefined;
    }
    const receivers =
      binding === proof.binding
        ? this.providerValues(binding, proof.provider)
        : this.values(FactoryResolver.reference(module, node.object, captures), new Set(), hops + 1);
    return FactoryResolver.mountedMethod(receivers, propertyName(node));
  }
  static mountedMethod(
    receivers: readonly ObjectValue[] | undefined,
    name: string | undefined,
  ): { readonly captures: Captures; readonly fn: Implementation; readonly module: Module } | undefined {
    const [receiver] = receivers ?? [];
    const fn = receiver === undefined || name === undefined ? undefined : FactoryResolver.method(receiver, name);
    return receivers?.length === 1 && receiver?.authority !== undefined && fn !== undefined
      ? { captures: receiver.captures, fn, module: receiver.module }
      : undefined;
  }
  static callFrame(
    target: { readonly captures?: Captures; readonly fn: Implementation; readonly module: Module },
    call: CallExpression,
    caller: Module,
    captures: Captures | undefined,
  ): Captures | false | undefined {
    if (target.captures === undefined) {
      return captures;
    }
    if (call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return false;
    }
    return FactoryResolver.captureCall(
      target.module,
      target.fn,
      call.arguments.filter((argument) => argument.type !== 'SpreadElement'),
      captures ?? new Map(),
      caller,
      target.captures,
    );
  }
  static captureCall(
    module: Module,
    fn: Implementation,
    args: readonly Expression[],
    captures: Captures,
    caller: Module = module,
    lexicalCaptures: Captures = captures,
  ): Captures {
    const result = new Map(lexicalCaptures);
    for (const [index, parameter] of fn.params.entries()) {
      const argument = args[index];
      if (parameter.type === 'Identifier' && argument !== undefined) {
        const binding = bindingAt(module, parameter.name, parameter);
        if (binding !== undefined) {
          result.set(binding, FactoryResolver.reference(caller, argument, captures));
        }
      }
      if (parameter.type === 'RestElement' && parameter.argument.type === 'Identifier') {
        const binding = bindingAt(module, parameter.argument.name, parameter.argument);
        if (binding !== undefined && argument !== undefined) {
          result.set(binding, {
            ...FactoryResolver.reference(caller, argument, captures),
            elements: args.slice(index).map((value) => FactoryResolver.reference(caller, value, captures)),
          });
        }
      }
    }
    return result;
  }
  static projection(module: Module, binding: Binding, captures: Captures): Reference | undefined {
    if (binding.projection === undefined) {
      return undefined;
    }
    const source = unwrap(binding.projection.expression);
    const base = source.type === 'Identifier' ? bindingAt(module, source.name, source) : undefined;
    return base === undefined ? undefined : captures.get(base)?.elements?.at(binding.projection.index);
  }

  static method(value: ObjectValue, name: string): Implementation | undefined {
    const field = ownDataFields(value.expression)?.get(name);
    return field === undefined ? undefined : functionValue(field);
  }

  ownerRoot(file: string): Module | undefined {
    const relative = this.path.relative(this.root, file).replaceAll('\\', '/');
    const match = /^(?<kind>verticals|apps)\/(?<owner>[^/]+)\//u.exec(relative);
    return match === null
      ? undefined
      : this.module(this.path.join(this.root, match.groups?.kind ?? '', match.groups?.owner ?? '', 'api/index.ts'));
  }
  assembly(module: Module, input: Expression, captures: Captures, hops: number): Reference | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const node = unwrap(input);
    if (node.type === 'Identifier') {
      const binding = bindingAt(module, node.name, node);
      const captured =
        binding === undefined
          ? undefined
          : (captures.get(binding) ?? FactoryResolver.projection(module, binding, captures));
      if (captured !== undefined) {
        return this.assembly(captured.module, captured.expression, captured.captures, hops + 1);
      }
      const target = this.symbol(module, node);
      return target?.binding.init === undefined
        ? undefined
        : this.assembly(target.module, target.binding.init, captures, hops + 1);
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    return this.assemblyCall(module, node, captures, hops);
  }
  assemblyCall(module: Module, node: CallExpression, captures: Captures, hops: number): Reference | undefined {
    const callee = unwrap(node.callee);
    if (callee.type === 'Identifier') {
      const binding = bindingAt(module, callee.name, callee);
      if (
        binding?.origin?.source === '@modern-js/bff-effect/assembly' &&
        binding.origin.imported === 'assembleEffectBffRuntime' &&
        stable(module, binding)
      ) {
        const [options] = node.arguments;
        if (
          options?.type !== 'ObjectExpression' ||
          options.properties.some((property) => property.type === 'SpreadElement')
        ) {
          return undefined;
        }
        const fields = options.properties.filter(
          (field) =>
            field.type === 'Property' &&
            !field.computed &&
            ((field.key.type === 'Identifier' && field.key.name === 'handlers') ||
              (field.key.type === 'Literal' && field.key.value === 'handlers')),
        );
        const [field] = fields;
        return fields.length === 1 && field?.type === 'Property'
          ? FactoryResolver.reference(module, field.value, captures)
          : undefined;
      }
    }
    const fn = this.function(module, node.callee);
    const returned = fn === undefined ? undefined : directReturn(fn.fn, fn.module.program);
    return fn === undefined || returned === undefined
      ? undefined
      : this.assembly(
          fn.module,
          returned,
          FactoryResolver.captureCall(
            fn.module,
            fn.fn,
            node.arguments.filter((argument) => argument.type !== 'SpreadElement'),
            captures,
          ),
          hops + 1,
        );
  }
  mounted(root: Module): ReadonlySet<CallExpression> {
    this.currentFixedOutputs = new Set();
    const declaration = root.program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
    if (
      declaration?.type !== 'ExportDefaultDeclaration' ||
      declaration.declaration.type === 'FunctionDeclaration' ||
      declaration.declaration.type === 'ClassDeclaration' ||
      declaration.declaration.type === 'TSInterfaceDeclaration'
    ) {
      return new Set();
    }
    const handlers = this.assembly(root, declaration.declaration, new Map(), 0);
    const result = new Set<CallExpression>();

    if (handlers !== undefined && !this.closedLayer(handlers, new Set(), 0)) {
      return new Set();
    }
    if (handlers !== undefined && !this.layers(handlers, result, new Set(), 0)) {
      result.clear();
    }
    return result;
  }
  conditionalReferences(module: Module, input: Expression, captures: Captures): readonly Reference[] | undefined {
    const node = unwrap(input);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (binding?.origin === undefined || !stable(module, binding)) {
      return undefined;
    }
    const targets = this.conditionalPackageExports.get(binding.origin.source);
    if (targets === undefined || targets.length === 0) {
      return undefined;
    }
    const parts = binding.origin.source.split('/');
    const name = binding.origin.source.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
    const anchor = this.packageExports.get(name);
    const relative = anchor === undefined ? [] : this.path.relative(this.root, anchor).split(this.path.sep);
    if (!['apps', 'packages', 'verticals'].includes(relative[0] ?? '') || relative[1] === undefined) {
      return undefined;
    }
    const owner = this.path.join(this.root, relative[0] ?? '', relative[1]);
    const refs: Reference[] = [];
    let key: string | undefined;
    for (const file of targets) {
      const reference = this.conditionalVariant(file, owner, binding.origin.imported, captures);
      if (reference === undefined || (key !== undefined && key !== reference.key)) {
        return undefined;
      }
      ({ key } = reference);
      refs.push(reference.reference);
    }
    return refs;
  }
  conditionalVariant(
    file: string,
    owner: string,
    exported: string,
    captures: Captures,
  ): { readonly key: string; readonly reference: Reference } | undefined {
    const location = this.path.relative(owner, file);
    if (location.startsWith('..') || this.path.isAbsolute(location)) {
      return undefined;
    }
    const target = this.module(file);
    const symbol = target === undefined ? undefined : this.exportedSymbol(target, exported, new Set());
    const expression = symbol?.binding.init === undefined ? undefined : unwrap(symbol.binding.init);
    const producer =
      expression?.type === 'CallExpression' && symbol !== undefined
        ? this.layerProducer(symbol.module, expression)
        : undefined;
    const tag =
      producer === undefined || symbol === undefined
        ? undefined
        : this.outputTag(symbol.module, producer.tag, captures);
    return symbol === undefined || expression === undefined || tag === undefined || tag.key.length === 0
      ? undefined
      : { key: tag.key, reference: FactoryResolver.reference(symbol.module, expression, captures) };
  }

  fixedLayerKeys(module: Module, input: Expression): readonly string[] | undefined {
    if (this.native(module, input, 'Reactivity', 'layer')) {
      return [NativeReactivity.Reactivity.key];
    }
    if (this.native(module, input, 'FetchHttpClient', 'layer')) {
      return [NativeHttpClient.HttpClient.key];
    }
    const node = unwrap(input);
    if (
      node.type === 'CallExpression' &&
      !node.optional &&
      node.arguments.length >= 1 &&
      node.arguments.length <= 2 &&
      !node.arguments.some((argument) => argument.type === 'SpreadElement') &&
      this.native(module, node.callee, 'Logger', 'layer')
    ) {
      return [NativeLogger.CurrentLoggers.key];
    }
    return node.type === 'CallExpression' &&
      !node.optional &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type !== 'SpreadElement' &&
      this.native(module, node.callee, 'PgClient', 'layerFrom')
      ? [NativePgClient.PgClient.key, NativeSqlClient.SqlClient.key]
      : undefined;
  }

  allClosedLayers(values: readonly Reference[], seen: Set<Binding>, hops: number): boolean {
    let closed = true;
    for (const value of values) {
      closed = this.closedLayer(value, seen, hops) && closed;
    }
    return closed;
  }
  closedLayer(reference: Reference, seen: Set<Binding>, hops: number): boolean {
    const top = seen.size === 0 && hops === 0 && reference.captures.size === 0;
    const { size } = this.modules;
    if (top && this.closedLayerFacts.get(reference.expression) === size) {
      return true;
    }
    const closed = this.proveClosedLayer(reference, seen, hops);
    if (top && closed && this.modules.size === size) {
      this.closedLayerFacts.set(reference.expression, size);
    }
    return closed;
  }
  proveClosedLayer(reference: Reference, seen: Set<Binding>, hops: number): boolean {
    if (hops >= budget) {
      return false;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (this.fixedLayerKeys(module, node) !== undefined) {
      return true;
    }
    if (this.native(module, node, 'Layer', 'empty')) {
      return true;
    }
    if (node.type === 'Identifier') {
      const conditional = this.conditionalReferences(module, node, captures);
      if (conditional !== undefined) {
        return this.allClosedLayers(conditional, seen, hops + 1);
      }
      const binding = bindingAt(module, node.name, node);
      const captured =
        binding === undefined
          ? undefined
          : (captures.get(binding) ?? FactoryResolver.projection(module, binding, captures));
      if (captured !== undefined) {
        return this.closedLayer(captured, seen, hops + 1);
      }
      const target = this.symbol(module, node);
      return target?.binding.init !== undefined && !seen.has(target.binding)
        ? this.closedLayer(
            FactoryResolver.reference(target.module, target.binding.init, captures),
            new Set(seen).add(target.binding),
            hops + 1,
          )
        : false;
    }
    if (node.type === 'ConditionalExpression') {
      return this.allClosedLayers(
        [
          FactoryResolver.reference(module, node.consequent, captures),
          FactoryResolver.reference(module, node.alternate, captures),
        ],
        seen,
        hops + 1,
      );
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    return this.closedLayerCall(reference, node, seen, hops);
  }
  layerProducer(
    module: Module,
    call: CallExpression,
  ): { readonly kind: 'effect' | 'succeed'; readonly program: Expression; readonly tag: Expression } | undefined {
    if (call.optional || call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return undefined;
    }
    const args = call.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const callee = unwrap(call.callee);
    for (const kind of ['effect', 'succeed'] as const) {
      if (this.native(module, callee, 'Layer', kind)) {
        const [tag, program] = args;
        if (args.length === 2 && tag !== undefined && program !== undefined) {
          return { kind, program, tag };
        }
      }
      if (
        callee.type === 'CallExpression' &&
        !callee.optional &&
        callee.arguments.length === 1 &&
        this.native(module, callee.callee, 'Layer', kind)
      ) {
        const [tag] = callee.arguments;
        const [program] = args;
        if (args.length === 1 && tag !== undefined && tag.type !== 'SpreadElement' && program !== undefined) {
          return { kind, program, tag };
        }
      }
    }
    return undefined;
  }
  static effectCallbackOutput(module: Module, input: Expression, captures: Captures): Reference | undefined {
    const fn = functionValue(input);
    const returned = fn === undefined || fn.async ? undefined : directReturn(fn, module.program);
    return returned === undefined ? undefined : FactoryResolver.reference(module, returned, captures);
  }
  effectLayerOutputs(reference: Reference, hops = 0): readonly Reference[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const callee = unwrap(node.callee);
    if (this.native(module, callee, 'Effect', 'succeed')) {
      const [layer] = args;
      return args.length === 1 && layer !== undefined
        ? [FactoryResolver.reference(module, layer, captures)]
        : undefined;
    }
    if (this.native(module, callee, 'Effect', 'gen') || this.native(module, callee, 'Effect', 'map')) {
      const index = this.native(module, callee, 'Effect', 'gen') ? 0 : 1;
      const callback = args[index];
      const output =
        args.length === index + 1 && callback !== undefined
          ? FactoryResolver.effectCallbackOutput(module, callback, captures)
          : undefined;
      return output === undefined ? undefined : [output];
    }
    if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'pipe') {
      return undefined;
    }
    let outputs: readonly Reference[] | undefined;
    for (const transform of args) {
      const next = this.effectLayerTransform(FactoryResolver.reference(module, transform, captures), outputs, hops + 1);
      if (next === undefined) {
        return undefined;
      }
      outputs = next;
    }
    return outputs;
  }
  effectLayerTransform(
    reference: Reference,
    outputs: readonly Reference[] | undefined,
    hops: number,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const [first, second] = args;
    if (this.native(module, node.callee, 'Effect', 'as') && args.length === 1 && first !== undefined) {
      return [FactoryResolver.reference(module, first, captures)];
    }
    if (this.native(module, node.callee, 'Effect', 'map') && args.length === 1 && first !== undefined) {
      const output = FactoryResolver.effectCallbackOutput(module, first, captures);
      return output === undefined ? undefined : [output];
    }
    if (
      this.native(module, node.callee, 'Effect', 'catchTag') &&
      args.length === 2 &&
      second !== undefined &&
      outputs !== undefined
    ) {
      const fallback = FactoryResolver.effectCallbackOutput(module, second, captures);
      const values = fallback === undefined ? undefined : this.effectLayerOutputs(fallback, hops + 1);
      return values === undefined ? undefined : [...outputs, ...values];
    }
    return undefined;
  }

  closedLayerCall(reference: Reference, node: CallExpression, seen: Set<Binding>, hops: number): boolean {
    const { captures, module } = reference;
    const callee = unwrap(node.callee);
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    if (this.native(module, callee, 'Layer', 'unwrap')) {
      const [effect] = args;
      const output =
        args.length === 1 && effect !== undefined
          ? this.effectLayerOutputs(FactoryResolver.reference(module, effect, captures))
          : undefined;
      return output === undefined ? false : this.allClosedLayers(output, seen, hops + 1);
    }
    if (this.errorOnlyMiddleware(module, node)) {
      return true;
    }
    if (this.middlewareLayer(module, node, captures)) {
      return true;
    }
    if (this.native(module, callee, 'HttpApiBuilder', 'group')) {
      return true;
    }
    const producer = this.layerProducer(module, node);
    if (producer !== undefined) {
      return this.closedProducer(reference, node, producer.tag, producer.kind);
    }
    if (
      ['merge', 'mergeAll', 'provide', 'provideMerge', 'fresh'].some((method) =>
        this.native(module, callee, 'Layer', method),
      )
    ) {
      return this.allClosedLayers(
        args.map((argument) => FactoryResolver.reference(module, argument, captures)),
        seen,
        hops + 1,
      );
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe' && !callee.optional) {
      let closed = this.closedLayer(FactoryResolver.reference(module, callee.object, captures), seen, hops + 1);
      for (const argument of args) {
        closed =
          this.closedLayerTransform(FactoryResolver.reference(module, argument, captures), seen, hops + 1) && closed;
      }
      return closed;
    }
    if (FactoryResolver.nativeOwnerRuntime(module, callee)) {
      return true;
    }
    const fn = this.function(module, callee);
    const returned = fn === undefined ? undefined : directReturn(fn.fn, fn.module.program);
    return fn !== undefined && returned !== undefined
      ? this.closedLayer(
          FactoryResolver.reference(
            fn.module,
            returned,
            FactoryResolver.captureCall(fn.module, fn.fn, args, captures, module),
          ),
          seen,
          hops + 1,
        )
      : false;
  }
  closedProducer(reference: Reference, call: CallExpression, tag: Expression, kind: 'effect' | 'succeed'): boolean {
    const { captures, module } = reference;
    const middleware = this.nativeTag(module, tag, 'HttpApiMiddleware', captures);
    return (
      this.outputTag(module, tag, captures) !== undefined &&
      (middleware === undefined || (kind === 'succeed' && this.taggedCallback(module, call, 'handler-transform')))
    );
  }
  static nativeOwnerRuntime(module: Module, callee: Expression): boolean {
    const binding = callee.type === 'Identifier' ? bindingAt(module, callee.name, callee) : undefined;
    return (
      binding?.origin?.source === '@app/core-runtime' &&
      ['makeReadRuntimeLive', 'makeActionRuntimeLive'].includes(binding.origin.imported) &&
      stable(module, binding)
    );
  }
  closedLayerTransform(reference: Reference, seen: Set<Binding>, hops: number): boolean {
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (this.native(module, node, 'Layer', 'orDie')) {
      return true;
    }
    if (
      node.type === 'CallExpression' &&
      node.arguments.length === 1 &&
      ['provide', 'provideMerge'].some((method) => this.native(module, node.callee, 'Layer', method))
    ) {
      const [provider] = node.arguments;
      return (
        provider !== undefined &&
        provider.type !== 'SpreadElement' &&
        this.closedLayer(FactoryResolver.reference(module, provider, captures), seen, hops + 1)
      );
    }
    return false;
  }
  layers(reference: Reference, result: Set<CallExpression>, seen: Set<Binding>, hops: number): boolean {
    if (hops >= budget) {
      return false;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    const fixedKey = this.fixedLayerKeys(module, node);
    if (fixedKey !== undefined) {
      for (const key of fixedKey) {
        this.currentFixedOutputs.add(key);
      }
      return true;
    }
    if (node.type === 'Identifier') {
      const conditional = this.conditionalReferences(module, node, captures);
      if (conditional !== undefined) {
        let active = false;
        for (const value of conditional) {
          active = this.layers(value, result, seen, hops + 1) || active;
        }
        return active;
      }
      const binding = bindingAt(module, node.name, node);
      const captured =
        binding === undefined
          ? undefined
          : (captures.get(binding) ?? FactoryResolver.projection(module, binding, captures));
      if (captured !== undefined) {
        return this.layers(captured, result, seen, hops + 1);
      }
      const symbol = this.symbol(module, node);
      if (symbol?.binding.init === undefined || seen.has(symbol.binding)) {
        return false;
      }
      return this.layers(
        FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
        result,
        new Set(seen).add(symbol.binding),
        hops + 1,
      );
    }
    if (node.type === 'ConditionalExpression') {
      const first = this.layers(FactoryResolver.reference(module, node.consequent, captures), result, seen, hops + 1);
      return this.layers(FactoryResolver.reference(module, node.alternate, captures), result, seen, hops + 1) || first;
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    return this.layerCall(module, node, captures, result, seen, hops);
  }
  referenceFingerprint(
    reference: Reference,
    visiting: Set<Reference>,
    memo: Map<Reference, string>,
    remaining: { value: number },
  ): string | undefined {
    const cached = memo.get(reference);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(reference) || remaining.value <= 0) {
      return undefined;
    }
    remaining.value -= 1;
    const next = new Set(visiting).add(reference);
    const entries: string[] = [];
    for (const [binding, captured] of reference.captures) {
      const owner = [...this.modules.values()].find((module) => module.bindings.includes(binding));
      const value = this.referenceFingerprint(captured, next, memo, remaining);
      if (owner === undefined || value === undefined) {
        return undefined;
      }
      entries.push(`${owner.file}:${binding.node.start}=${value}`);
    }
    for (const element of reference.elements ?? []) {
      const value = this.referenceFingerprint(element, next, memo, remaining);
      if (value === undefined) {
        return undefined;
      }
      entries.push(`element=${value}`);
    }
    if (reference.eagerProducer !== undefined) {
      const producer = this.referenceFingerprint(reference.eagerProducer, next, memo, remaining);
      if (producer === undefined) {
        return undefined;
      }
      entries.push(`producer=${producer}`);
    }
    const result = `${reference.module.file}:${reference.expression.start}:${reference.expression.end}:${reference.success === true}[${entries.join('|')}]`;
    memo.set(reference, result);
    return result;
  }
  recordLayer(module: Module, call: CallExpression, captures: Captures): boolean {
    const keys: string[] = [];
    const memo = new Map<Reference, string>();
    const remaining = { value: budget };
    for (const [binding, reference] of captures) {
      if (!module.bindings.includes(binding) || !inside(call, binding.scope)) {
        continue;
      }
      const fingerprint = this.referenceFingerprint(reference, new Set(), memo, remaining);
      if (fingerprint === undefined) {
        return false;
      }
      keys.push(`${binding.node.start}:${fingerprint}`);
    }
    const frames = this.layerFrames.get(call) ?? new Map<string, Reference>();
    frames.set(keys.join('|'), FactoryResolver.reference(module, call, captures));
    this.layerFrames.set(call, frames);
    return true;
  }

  layerCall(
    module: Module,
    node: CallExpression,
    captures: Captures,
    result: Set<CallExpression>,
    seen: Set<Binding>,
    hops: number,
  ): boolean {
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const callee = unwrap(node.callee);
    if (this.native(module, callee, 'Layer', 'unwrap')) {
      return this.unwrapLayers(module, args, captures, result, seen, hops);
    }
    if (this.errorOnlyMiddleware(module, node)) {
      return true;
    }
    if (this.middlewareLayer(module, node, captures)) {
      result.add(node);
      return this.recordLayer(module, node, captures);
    }
    if (this.native(module, callee, 'HttpApiBuilder', 'group')) {
      return true;
    }
    if (this.layerProducer(module, node) !== undefined) {
      result.add(node);
      return this.recordLayer(module, node, captures);
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe' && !callee.optional) {
      return this.pipeLayers(module, callee.object, args, captures, result, seen, hops);
    }
    if (['merge', 'mergeAll', 'provideMerge', 'fresh'].some((method) => this.native(module, callee, 'Layer', method))) {
      let active = false;
      for (const arg of args) {
        active = this.layers(FactoryResolver.reference(module, arg, captures), result, seen, hops + 1) || active;
      }
      return active;
    }
    if (this.native(module, callee, 'Layer', 'provide')) {
      const [consumer, provider] = args;
      if (
        consumer === undefined ||
        provider === undefined ||
        !this.layers(FactoryResolver.reference(module, consumer, captures), result, seen, hops + 1)
      ) {
        return false;
      }
      this.layers(FactoryResolver.reference(module, provider, captures), result, seen, hops + 1);
      return true;
    }
    if (FactoryResolver.nativeOwnerRuntime(module, callee)) {
      return true;
    }
    return false;
  }
  unwrapLayers(
    module: Module,
    args: readonly Expression[],
    captures: Captures,
    result: Set<CallExpression>,
    seen: Set<Binding>,
    hops: number,
  ): boolean {
    const [effect] = args;
    const outputs =
      args.length === 1 && effect !== undefined
        ? this.effectLayerOutputs(FactoryResolver.reference(module, effect, captures))
        : undefined;
    if (outputs === undefined) {
      return false;
    }
    let active = false;
    for (const value of outputs) {
      active = this.layers(value, result, seen, hops + 1) || active;
    }
    return active;
  }
  pipeLayers(
    module: Module,
    receiver: Expression,
    args: readonly Expression[],
    captures: Captures,
    result: Set<CallExpression>,
    seen: Set<Binding>,
    hops: number,
  ): boolean {
    const active = this.layers(FactoryResolver.reference(module, receiver, captures), result, seen, hops + 1);
    if (!active) {
      return false;
    }
    for (const argument of args) {
      const transform = unwrap(argument);
      if (
        transform.type === 'CallExpression' &&
        ['provide', 'provideMerge'].some((method) => this.native(module, transform.callee, 'Layer', method))
      ) {
        for (const provider of transform.arguments) {
          if (provider.type !== 'SpreadElement') {
            this.layers(FactoryResolver.reference(module, provider, captures), result, seen, hops + 1);
          }
        }
      } else if (!this.native(module, transform, 'Layer', 'orDie')) {
        return false;
      }
    }
    return true;
  }

  nativeTag(
    module: Module,
    input: Expression,
    namespace: 'Context' | 'HttpApiMiddleware',
    captures: Captures = new Map(),
    seen = new Set<Binding>(),
  ): Binding | undefined {
    const node = unwrap(input);
    const local = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (local !== undefined) {
      if (seen.has(local)) {
        return undefined;
      }
      const next = new Set(seen).add(local);
      const captured = captures.get(local);
      if (captured !== undefined) {
        return this.nativeTag(captured.module, captured.expression, namespace, captured.captures, next);
      }
      if (local.init !== undefined && unwrap(local.init).type === 'Identifier') {
        return this.nativeTag(module, local.init, namespace, captures, next);
      }
    }
    const symbol = this.symbol(module, input);
    if (symbol?.binding.kind !== 'class' || ![...this.modules.values()].every(nativeConstructorObjectsClosed)) {
      return undefined;
    }
    let key: string | undefined;
    new Visitor({
      ClassDeclaration: (declaration) => {
        if (
          declaration.id?.start !== symbol.binding.node.start ||
          declaration.superClass?.type !== 'CallExpression' ||
          declaration.body.body.length !== 0 ||
          declaration.decorators.length !== 0
        ) {
          return;
        }
        const factory = unwrap(declaration.superClass.callee);
        const [first] = declaration.superClass.arguments;
        const arity =
          namespace === 'Context'
            ? declaration.superClass.arguments.length === 1
            : declaration.superClass.arguments.length >= 1 && declaration.superClass.arguments.length <= 2;
        if (
          arity &&
          factory.type === 'CallExpression' &&
          factory.arguments.length === 0 &&
          first?.type === 'Literal' &&
          Schema.is(Schema.String)(first.value) &&
          this.native(symbol.module, factory.callee, namespace, 'Service')
        ) {
          key = first.value;
        }
      },
    }).visit(symbol.module.program);
    if (key === undefined) {
      return undefined;
    }
    if (!this.tagCustody(symbol.module, symbol.binding)) {
      return undefined;
    }
    this.tagKeys.set(symbol.binding, key);
    return symbol.binding;
  }
  tag(module: Module, input: Expression, captures: Captures = new Map()): Binding | undefined {
    return this.nativeTag(module, input, 'Context', captures);
  }
  outputTag(
    module: Module,
    input: Expression,
    captures: Captures = new Map(),
    seen = new Set<Binding>(),
  ): NativeTagIdentity | undefined {
    const node = unwrap(input);
    const local = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (local !== undefined) {
      if (seen.has(local)) {
        return undefined;
      }
      const next = new Set(seen).add(local);
      const captured = captures.get(local);
      if (captured !== undefined) {
        return this.outputTag(captured.module, captured.expression, captured.captures, next);
      }
      if (local.init !== undefined && unwrap(local.init).type === 'Identifier') {
        return this.outputTag(module, local.init, captures, next);
      }
    }
    const binding = this.tag(module, input, captures) ?? this.nativeTag(module, input, 'HttpApiMiddleware', captures);
    const key = binding === undefined ? undefined : this.tagKeys.get(binding);
    if (binding !== undefined && key !== undefined) {
      return { binding, key };
    }
    if (this.native(module, node, 'Tracer', 'Tracer')) {
      return { key: NativeTracer.Tracer.key };
    }
    if (this.native(module, node, 'References', 'MinimumLogLevel')) {
      return { key: NativeReferences.MinimumLogLevel.key };
    }
    if (this.native(module, node, 'Crypto', 'Crypto')) {
      return { key: NativeCrypto.Crypto.key };
    }
    if (this.native(module, node, 'Reactivity', 'Reactivity')) {
      return { key: NativeReactivity.Reactivity.key };
    }
    if (this.native(module, node, 'FetchHttpClient', 'RequestInit')) {
      return { key: NativeFetchHttpClient.RequestInit.key };
    }
    if (this.native(module, node, 'HttpClient', 'HttpClient')) {
      return { key: NativeHttpClient.HttpClient.key };
    }
    return this.native(module, node, 'PgClient', 'PgClient') ? { key: NativePgClient.PgClient.key } : undefined;
  }

  middlewareLayer(module: Module, call: CallExpression, captures: Captures = new Map()): boolean {
    const [tag] = call.arguments;
    return (
      call.arguments.length === 2 &&
      this.native(module, call.callee, 'HttpApiMiddleware', 'layerSchemaErrorTransform') &&
      tag !== undefined &&
      tag.type !== 'SpreadElement' &&
      this.nativeTag(module, tag, 'HttpApiMiddleware') !== undefined &&
      this.taggedCallback(module, call, 'schema-error-transform', captures)
    );
  }

  sameRuntimeCohort(cohort: ReadonlySet<Module>): boolean {
    return cohort.size === this.modules.size && [...this.modules.values()].every((module) => cohort.has(module));
  }
  taggedCallbackEnvironment(module: Module, call: CallExpression, captures: Captures): string | undefined {
    const local = new Map(
      [...captures].filter(([binding]) => module.bindings.includes(binding) && inside(call, binding.scope)),
    );
    return this.referenceFingerprint(FactoryResolver.reference(module, call, local), new Set(), new Map(), {
      value: budget,
    });
  }
  taggedCallback(
    module: Module,
    call: CallExpression,
    kind: 'schema-error-transform' | 'handler-transform',
    captures: Captures = new Map(),
  ): boolean {
    const environment =
      kind === 'schema-error-transform' && this.acquisitionProvider === undefined
        ? this.taggedCallbackEnvironment(module, call, captures)
        : undefined;
    const facts = this.taggedCallbackFacts.get(call) ?? [];
    if (
      environment !== undefined &&
      facts.some(
        (fact) =>
          fact.program === module.program &&
          fact.kind === kind &&
          fact.environment === environment &&
          this.sameRuntimeCohort(fact.cohort),
      )
    ) {
      return true;
    }
    const cohort = environment === undefined ? undefined : new Set(this.modules.values());
    const closed = this.proveTaggedCallback(module, call, kind);
    if (
      closed &&
      cohort !== undefined &&
      environment !== undefined &&
      this.acquisitionProvider === undefined &&
      this.sameRuntimeCohort(cohort)
    ) {
      this.taggedCallbackFacts.set(call, [...facts, { cohort, environment, kind, program: module.program }]);
    }
    return closed;
  }
  proveTaggedCallback(
    module: Module,
    call: CallExpression,
    kind: 'schema-error-transform' | 'handler-transform',
  ): boolean {
    const [, _implementation] = call.arguments;
    const producer = kind === 'handler-transform' ? this.layerProducer(module, call) : undefined;
    const implementation = producer?.program ?? _implementation;
    return (
      implementation !== undefined &&
      implementation.type !== 'SpreadElement' &&
      provesTaggedMiddlewareContext({
        call,
        file: module.file,
        implementation,
        isNativeMethod: (file, expression, namespace, method) =>
          this.isNativeMethod(file, expression, namespace, method),
        isServiceFreeSchema: (request) => this.isServiceFreeSchema(request),
        kind,
        program: module.program,
        resolveCapturedValue: (request) => this.resolveCapturedValue(request),
        resolveDataObjectMethod: (request) => this.resolveDataObjectMethod(request),
        resolveDeclaredFunction: (request) => this.resolveDeclaredFunction(request),
        sources: this.sources,
      })
    );
  }
  service(module: Module, tag: Expression): readonly ObjectValue[] | undefined {
    if (this.consumerSourceProofUsed && !this.consumerSnapshotsClosed()) {
      return undefined;
    }
    const binding = this.tag(module, tag);
    if (binding === undefined) {
      return undefined;
    }
    const root = this.acquisitionProvider?.root ?? this.ownerRoot(module.file);
    if (root === undefined) {
      return undefined;
    }
    const cache = this.providerCache.get(binding) ?? new Map<Module, readonly ObjectValue[] | undefined>();
    if (cache.has(root)) {
      return cache.get(root);
    }
    cache.set(root, undefined);
    this.providerCache.set(binding, cache);
    const previousFixedOutputs = this.currentFixedOutputs;
    const mounted = this.mounted(root);
    const fixedOverride = this.currentFixedOutputs.has(this.tagKeys.get(binding) ?? '');
    this.currentFixedOutputs = previousFixedOutputs;
    if (fixedOverride) {
      return undefined;
    }

    const candidates = this.providerCandidates(mounted, binding);
    if (candidates === undefined) {
      return undefined;
    }
    const [provider] = candidates;
    if (candidates.length !== 1 || provider === undefined) {
      return undefined;
    }
    const previous = this.acquisitionProvider;
    this.acquisitionProvider = { binding, provider, root };
    const previousSqlContext = this.nativeSqlContext;
    const environment = this.nativeSqlEnvironment(root);
    this.nativeSqlContext = environment === undefined ? undefined : { environment, root };
    const contextsClosed =
      this.requestedServiceContextClosed(binding) && this.validateServiceContexts(module, tag, binding);
    this.nativeSqlContext = previousSqlContext;
    this.acquisitionProvider = previous;
    if (!contextsClosed) {
      return undefined;
    }
    const rooted = this.providerValues(binding, provider);
    cache.set(root, rooted);
    return rooted;
  }
  providerValues(binding: Binding, provider: LayerCandidate): readonly ObjectValue[] | undefined {
    const fn = this.function(provider.module, provider.program);
    const returned = fn === undefined ? undefined : directReturn(fn.fn, fn.module.program);
    const values =
      fn === undefined || returned === undefined
        ? undefined
        : this.values(FactoryResolver.reference(fn.module, returned, provider.frame.captures), new Set(), 0);
    const rooted = values?.map((value) => ({ ...value, authority: binding }));
    return rooted;
  }
  effectContainsRead(
    module: Module,
    input: Expression,
    readModule: Module,
    read: Span,
    _seen: Set<Binding | Implementation>,
    hops: number,
    requiresEffect = false,
    captures?: Captures,
  ): boolean {
    let cache = this.effectReadFacts.get(read);
    if (cache?.size !== this.modules.size) {
      cache = { facts: new WeakMap(), size: this.modules.size };
      this.effectReadFacts.set(read, cache);
    }
    const closed: { readonly key: string; readonly node: object }[] = [];
    const queue: EffectReadWork[] = [
      { captures, depth: hops, expression: input, kind: 'expression', module, requiresEffect },
    ];
    const visited = new WeakMap<Expression | Implementation, Map<string, number>>();
    const frameIds = new Map<Captures, number>();
    for (const work of queue) {
      const node = work.kind === 'expression' ? unwrap(work.expression) : work.implementation;
      const { framed, key } = FactoryResolver.effectReadMode(work, frameIds);
      const identity = node.type === 'Identifier' ? (bindingAt(work.module, node.name, node) ?? node) : node;
      const fact = cache.size === this.modules.size ? cache.facts.get(identity)?.get(key) : undefined;
      const modes = visited.get(node) ?? new Map<string, number>();
      const prior = modes.get(key);
      if (fact === false || (prior !== undefined && prior <= work.depth)) {
        continue;
      }
      if (work.depth >= budget) {
        return true;
      }
      modes.set(key, work.depth);
      visited.set(node, modes);
      if (!framed) {
        closed.push({ key, node: identity });
      }
      if (work.module === readModule && inside(read, node)) {
        return true;
      }
      if (work.kind === 'function') {
        FactoryResolver.expandFunctionRead(work, queue);
      } else if (!this.expandEffectRead(work, node, queue)) {
        return true;
      }
    }
    this.storeCompletedEffectRead(cache, closed);
    return false;
  }
  static effectReadMode(work: EffectReadWork, frames: Map<Captures, number>) {
    const { captures } = work;
    const base = `${work.kind}:${work.requiresEffect}`;
    if (captures === undefined || captures.size === 0) {
      return { framed: false, key: base };
    }
    let id = frames.get(captures);
    if (id === undefined) {
      id = frames.size + 1;
      frames.set(captures, id);
    }
    return { framed: true, key: `${base}:${id}` };
  }
  static expandFunctionRead(work: EffectReadWork & { readonly kind: 'function' }, queue: EffectReadWork[]): void {
    const expressions = [
      ...FactoryResolver.functionReturnValues(work.module, work.implementation),
      ...work.module.calls.filter((value) => inside(value, work.implementation)),
    ];
    for (const expression of expressions) {
      queue.push({
        captures: work.captures,
        depth: work.depth + 1,
        expression,
        kind: 'expression',
        module: work.module,
        requiresEffect: false,
      });
    }
  }
  storeCompletedEffectRead(
    cache: EffectReadFacts,
    closed: readonly { readonly key: string; readonly node: object }[],
  ): void {
    if (cache.size === this.modules.size) {
      for (const value of closed) {
        const facts = cache.facts.get(value.node) ?? new Map<string, boolean>();
        facts.set(value.key, false);
        cache.facts.set(value.node, facts);
      }
    }
  }
  expandEffectRead(work: EffectReadWork, node: Expression | Implementation, queue: EffectReadWork[]): boolean {
    const { captures, depth, module, requiresEffect } = work;
    for (const expression of FactoryResolver.effectContainerChildren(node)) {
      queue.push({ captures, depth: depth + 1, expression, kind: 'expression', module, requiresEffect: false });
    }
    const literal = functionValue(node);
    if (literal !== undefined) {
      queue.push({
        captures,
        depth: depth + 1,
        implementation: literal,
        kind: 'function',
        module,
        requiresEffect: false,
      });
    }
    if (node.type === 'Identifier') {
      if (FactoryResolver.queueCapturedRead(work, node, queue)) {
        return true;
      }
      const symbol =
        this.symbol(module, node) ??
        (() => {
          const binding = bindingAt(module, node.name, node);
          return binding === undefined ? undefined : { binding, module };
        })();
      if (symbol?.binding.parameter !== undefined) {
        return this.expandEffectParameter(symbol.module, symbol.binding, requiresEffect, depth + 1, queue);
      }
      if (symbol?.binding.init !== undefined) {
        queue.push({
          captures,
          depth: depth + 1,
          expression: symbol.binding.init,
          kind: 'expression',
          module: symbol.module,
          requiresEffect,
        });
      }
    } else if (node.type === 'CallExpression') {
      if (!this.queueFunctionCallRead(work, node, queue)) {
        return false;
      }
      const callee = unwrap(node.callee);
      if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
        queue.push({
          captures,
          depth: depth + 1,
          expression: callee.object,
          kind: 'expression',
          module,
          requiresEffect: true,
        });
      }
      const boundPipe =
        callee.type === 'MemberExpression' && propertyName(callee) === 'pipe'
          ? this.bindFirstPipeRead(work, node, callee.object, queue)
          : false;
      for (const [index, argument] of node.arguments.entries()) {
        if (argument.type !== 'SpreadElement' && !(boundPipe && index === 0)) {
          queue.push({
            captures,
            depth: depth + 1,
            expression: argument,
            kind: 'expression',
            module,
            requiresEffect: this.effectInputSlot(module, node, index),
          });
        }
      }
    }
    return true;
  }
  queueFunctionCallRead(work: EffectReadWork, call: CallExpression, queue: EffectReadWork[]): boolean {
    const receiver = unwrap(call.callee);
    if (
      receiver.type === 'MemberExpression' &&
      this.configProviderOrigin(FactoryResolver.reference(work.module, receiver.object, work.captures ?? new Map())) !==
        undefined
    ) {
      // A retained root can execute when the provider is consumed; absence is not established here.
      return false;
    }
    const capturesAtCall = work.captures ?? new Map();
    const ordinary = this.function(work.module, call.callee, 0, work.captures);
    const source =
      ordinary === undefined ? this.consumerDataCallableSource(work.module, call, capturesAtCall) : undefined;
    const fn = ordinary ?? source;
    if (fn === undefined) {
      // Conditional service source identity cannot prove that an executed read is absent.
      return this.consumerServiceSource(work.module, call, capturesAtCall) === undefined;
    }
    if (source !== undefined) {
      const frames = FactoryResolver.consumerDataCallFrames(work.module, call, source, capturesAtCall);
      if (frames === undefined || !FactoryResolver.consumerExplicitSource(source)) {
        return false;
      }
      const expressions = [
        ...FactoryResolver.functionReturnValues(source.module, source.fn),
        ...FactoryResolver.consumerBodyCalls(source),
      ];
      for (const captures of frames) {
        for (const expression of expressions) {
          queue.push({
            captures,
            depth: work.depth + 1,
            expression,
            kind: 'expression',
            module: source.module,
            requiresEffect: false,
          });
        }
      }
      return true;
    }
    const captures = FactoryResolver.callFrame(fn, call, work.module, work.captures);
    if (captures === false) {
      return false;
    }
    queue.push({
      captures,
      depth: work.depth + 1,
      implementation: fn.fn,
      kind: 'function',
      module: fn.module,
      requiresEffect: false,
    });
    return true;
  }
  static queueCapturedRead(work: EffectReadWork, node: IdentifierReference, queue: EffectReadWork[]): boolean {
    const binding = bindingAt(work.module, node.name, node);
    const captured = binding === undefined ? undefined : work.captures?.get(binding);
    if (captured === undefined) {
      return false;
    }
    queue.push({
      captures: captured.captures,
      depth: work.depth + 1,
      expression: captured.expression,
      kind: 'expression',
      module: captured.module,
      requiresEffect: work.requiresEffect,
    });
    return true;
  }
  bindFirstPipeRead(work: EffectReadWork, call: CallExpression, input: Expression, queue: EffectReadWork[]): boolean {
    const [first] = call.arguments;
    const target =
      first === undefined || first.type === 'SpreadElement' ? undefined : this.function(work.module, first);
    const [parameter] = target?.fn.params ?? [];
    if (target === undefined || target.fn.async || target.fn.params.length !== 1 || parameter?.type !== 'Identifier') {
      return false;
    }
    const binding = bindingAt(target.module, parameter.name, parameter);
    if (binding === undefined || !stable(target.module, binding)) {
      return false;
    }
    const captures = new Map([
      ...(work.captures ?? []),
      [binding, FactoryResolver.reference(work.module, input, work.captures ?? new Map())],
    ]);
    queue.push({
      captures,
      depth: work.depth + 1,
      implementation: target.fn,
      kind: 'function',
      module: target.module,
      requiresEffect: false,
    });
    return true;
  }
  static effectContainerChildren(node: Expression | Implementation): readonly Expression[] {
    if (node.type === 'YieldExpression' && node.delegate && node.argument !== null) {
      return [node.argument];
    }
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((element) =>
        element === null ? [] : [element.type === 'SpreadElement' ? element.argument : element],
      );
    }
    if (node.type === 'ObjectExpression') {
      return node.properties.flatMap((property) =>
        property.type === 'SpreadElement' ? [property.argument] : [property.value],
      );
    }
    if (node.type === 'ConditionalExpression') {
      return [node.test, node.consequent, node.alternate];
    }
    if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') {
      return node.left.type === 'PrivateIdentifier' ? [node.right] : [node.left, node.right];
    }
    if (node.type === 'SequenceExpression') {
      return node.expressions;
    }
    return node.type === 'MemberExpression' ? [node.object] : [];
  }
  effectInputSlot(module: Module, call: CallExpression, index: number): boolean {
    if (index !== 0) {
      return false;
    }
    if (this.contextProvideCall(module, call)) {
      return call.arguments.length === 2;
    }
    if (this.native(module, call.callee, 'Effect', 'provideService')) {
      return call.arguments.length === 3;
    }
    return (
      call.arguments.length >= 2 &&
      [
        'map',
        'flatMap',
        'mapError',
        'catch',
        'catchIf',
        'catchTag',
        'catchTags',
        'tap',
        'ensuring',
        'onExit',
        'as',
        'zip',
        'andThen',
      ].some((method) => this.native(module, call.callee, 'Effect', method))
    );
  }
  expandEffectParameter(
    module: Module,
    binding: Binding,
    requiresEffect: boolean,
    depth: number,
    queue: EffectReadWork[],
  ): boolean {
    const { parameter } = binding;
    if (parameter === undefined) {
      return !requiresEffect;
    }
    const callers = this.callerModules(module, parameter.fn);
    if (callers === undefined) {
      return !requiresEffect;
    }
    let found = false;
    for (const caller of callers) {
      for (const call of caller.calls) {
        if (this.function(caller, call.callee)?.fn === parameter.fn) {
          found = true;
          const argument = call.arguments[parameter.index];
          if (
            call.arguments.some((value) => value.type === 'SpreadElement') ||
            FactoryResolver.requiresFormalBinding(binding, call, caller)
          ) {
            const references = this.callFormalReferences(module, binding, call, caller);
            if (references === undefined) {
              return false;
            }
            for (const reference of references) {
              const value = FactoryResolver.materializeArgumentReference(reference);
              if (value === undefined) {
                return false;
              }
              queue.push({
                depth,
                expression: value.expression,
                kind: 'expression',
                module: value.module,
                requiresEffect,
              });
            }
            continue;
          }
          if (argument === undefined || argument.type === 'SpreadElement') {
            return false;
          }
          queue.push({ depth, expression: argument, kind: 'expression', module: caller, requiresEffect });
        }
        const callee = unwrap(call.callee);
        if (
          parameter.index === 0 &&
          callee.type === 'MemberExpression' &&
          propertyName(callee) === 'pipe' &&
          call.arguments.some(
            (argument) => argument.type !== 'SpreadElement' && this.function(caller, argument)?.fn === parameter.fn,
          )
        ) {
          found = true;
          queue.push({ depth, expression: callee.object, kind: 'expression', module: caller, requiresEffect: true });
        }
      }
    }
    return found || !requiresEffect;
  }
  contextReferenceKeys(
    refs: readonly Reference[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
  ): readonly string[] | undefined {
    const result: string[] = [];
    for (const ref of refs) {
      const keys = this.providedContextKeys(ref.module, ref.expression, seen, wanted, ref.captures);
      if (keys === undefined) {
        return undefined;
      }
      result.push(...keys);
    }
    return result;
  }
  contextFields(reference: Reference, key: string, seen: Set<Binding>, hops: number): readonly Reference[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'ObjectExpression') {
      const field = ownDataFields(node)?.get(key);
      return field === undefined ? undefined : [FactoryResolver.reference(module, field, captures)];
    }
    if (node.type === 'Identifier') {
      return this.contextFieldIdentifier(reference, node, key, seen, hops);
    }
    if (node.type !== 'CallExpression' || node.optional || node.arguments.some((arg) => arg.type === 'SpreadElement')) {
      return undefined;
    }
    const fn = this.function(module, node.callee);
    const returned =
      fn === undefined || fn.fn.async || fn.fn.generator ? undefined : localReturnExpressions(fn.module, fn.fn);
    if (fn === undefined || returned === undefined) {
      return undefined;
    }
    const args = node.arguments.filter((arg) => arg.type !== 'SpreadElement');
    const frame = FactoryResolver.captureCall(fn.module, fn.fn, args, captures, module);
    const refs: Reference[] = [];
    for (const expression of returned) {
      const values = this.contextFields(FactoryResolver.reference(fn.module, expression, frame), key, seen, hops + 1);
      if (values === undefined) {
        return undefined;
      }
      refs.push(...values);
    }
    return refs;
  }
  contextFieldIdentifier(
    reference: Reference,
    node: IdentifierReference,
    key: string,
    seen: Set<Binding>,
    hops: number,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const local = bindingAt(module, node.name, node);
    const capture = local === undefined ? undefined : captures.get(local);
    if (capture !== undefined) {
      return this.contextFields(capture, key, seen, hops + 1);
    }
    const symbol = this.symbol(module, node);
    return symbol === undefined ||
      symbol.binding.init === undefined ||
      seen.has(symbol.binding) ||
      !this.contextBindingCustody(symbol.module, symbol.binding, new Set(), key)
      ? undefined
      : this.contextFields(
          FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
          key,
          new Set(seen).add(symbol.binding),
          hops + 1,
        );
  }
  contextPipeKeys(
    module: Module,
    receiver: Expression,
    args: readonly Expression[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    const initial = this.providedContextKeys(module, receiver, seen, wanted, captures);
    if (initial === undefined) {
      return undefined;
    }
    const keys = [...initial];
    for (const input of args) {
      const call = unwrap(input);
      if (
        keys === undefined ||
        call.type !== 'CallExpression' ||
        call.optional ||
        call.arguments.length !== 2 ||
        !this.native(module, call.callee, 'Context', 'add')
      ) {
        return undefined;
      }
      const [tagInput] = call.arguments;
      const tag =
        tagInput === undefined || tagInput.type === 'SpreadElement'
          ? undefined
          : this.consumerScopedOutputTag(module, tagInput, wanted, captures);
      if (tag === undefined) {
        return undefined;
      }
      keys.push(tag.key);
    }
    return keys;
  }
  providedContextKeys(
    module: Module,
    input: Expression,
    seen = new Set<Binding>(),
    wanted?: Binding,
    captures: Captures = new Map(),
  ): readonly string[] | undefined {
    if (seen.size >= budget) {
      return undefined;
    }
    const node = unwrap(input);
    if (node.type === 'Identifier') {
      return this.contextIdentifierKeys(module, node, seen, wanted, captures);
    }
    if (node.type === 'ConditionalExpression') {
      return this.contextReferenceKeys(
        [
          FactoryResolver.reference(module, node.consequent, captures),
          FactoryResolver.reference(module, node.alternate, captures),
        ],
        seen,
        wanted,
      );
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      const refs = this.contextFields(
        FactoryResolver.reference(module, node.object, captures),
        propertyName(node) ?? '',
        new Set(),
        0,
      );
      return refs === undefined ? undefined : this.contextReferenceKeys(refs, seen, wanted);
    }
    if (node.type === 'YieldExpression' && node.argument !== null) {
      return this.originalContextKeys(module, node, wanted);
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    return this.contextCallKeys(module, node, args, seen, wanted, captures);
  }
  contextIdentifierKeys(
    module: Module,
    node: IdentifierReference,
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    const local = bindingAt(module, node.name, node);
    const captured = local === undefined ? undefined : captures.get(local);
    if (captured !== undefined) {
      return this.providedContextKeys(captured.module, captured.expression, seen, wanted, captured.captures);
    }
    const symbol = this.symbol(module, node);
    return symbol === undefined ||
      symbol.binding.init === undefined ||
      seen.has(symbol.binding) ||
      !this.contextBindingCustody(symbol.module, symbol.binding)
      ? undefined
      : this.providedContextKeys(
          symbol.module,
          symbol.binding.init,
          new Set(seen).add(symbol.binding),
          wanted,
          captures,
        );
  }
  contextCallKeys(
    module: Module,
    node: CallExpression,
    args: readonly Expression[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    if (this.native(module, node.callee, 'Context', 'empty') && args.length === 0) {
      return [];
    }
    if (this.native(module, node.callee, 'Context', 'make') && args.length === 2) {
      const [first] = args;
      const tag = first === undefined ? undefined : this.consumerScopedOutputTag(module, first, wanted, captures);
      return tag === undefined ? undefined : [tag.key];
    }
    if (this.native(module, node.callee, 'Context', 'add') && args.length === 3) {
      return this.contextAddKeys(module, args, seen, wanted, captures);
    }
    if (this.native(module, node.callee, 'Context', 'merge') && args.length === 2) {
      return this.contextMergeKeys(module, args, seen, wanted, captures);
    }
    const callee = unwrap(node.callee);
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'context' && args.length === 1) {
      const tag = this.consumerScopedOutputTag(module, callee.object, wanted, captures);
      return tag === undefined ? undefined : [tag.key];
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return this.contextPipeKeys(module, callee.object, args, seen, wanted, captures);
    }
    return this.contextHelperKeys(module, node, args, seen, wanted, captures);
  }
  contextHelperKeys(
    module: Module,
    node: CallExpression,
    args: readonly Expression[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    const fn = this.function(module, node.callee);
    const fnSymbol = this.symbol(module, node.callee);
    if (fnSymbol !== undefined && seen.has(fnSymbol.binding)) {
      return undefined;
    }
    const next = fnSymbol === undefined ? seen : new Set(seen).add(fnSymbol.binding);
    const returns =
      fn === undefined || fn.fn.async || fn.fn.generator ? undefined : localReturnExpressions(fn.module, fn.fn);
    return fn === undefined || returns === undefined
      ? undefined
      : this.contextReferenceKeys(
          returns.map((expression) =>
            FactoryResolver.reference(
              fn.module,
              expression,
              FactoryResolver.captureCall(fn.module, fn.fn, args, captures, module),
            ),
          ),
          next,
          wanted,
        );
  }
  contextAddKeys(
    module: Module,
    args: readonly Expression[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    const [base, tagInput] = args;
    const keys = base === undefined ? undefined : this.providedContextKeys(module, base, seen, wanted, captures);
    const tag = tagInput === undefined ? undefined : this.consumerScopedOutputTag(module, tagInput, wanted, captures);
    return keys === undefined || tag === undefined ? undefined : [...keys, tag.key];
  }
  contextMergeKeys(
    module: Module,
    args: readonly Expression[],
    seen: Set<Binding>,
    wanted: Binding | undefined,
    captures: Captures,
  ): readonly string[] | undefined {
    const values: string[] = [];
    for (const input of args) {
      const keys = this.providedContextKeys(module, input, seen, wanted, captures);
      if (keys === undefined) {
        return undefined;
      }
      values.push(...keys);
    }
    return values;
  }
  originalContextKeys(module: Module, node: Expression, wanted: Binding | undefined): readonly string[] | undefined {
    if (node.type !== 'YieldExpression' || !node.delegate || node.argument === null || wanted === undefined) {
      return undefined;
    }
    const call = unwrap(node.argument);
    if (
      call.type !== 'CallExpression' ||
      call.arguments.length !== 0 ||
      !this.native(module, call.callee, 'Effect', 'context')
    ) {
      return undefined;
    }
    const key = `${module.file}:${node.start}:${wanted.node.start}`;
    const proofs = this.contextSnapshotProofs;
    if (proofs === undefined) {
      return undefined;
    }
    let proof = proofs.get(key);
    if (proof === undefined) {
      if (proofs.size >= budget) {
        return undefined;
      }
      proof = { expression: node, module, valid: true };
      proofs.set(key, proof);
    }
    return proof.valid ? [] : undefined;
  }
  reachedConsumerCallFrames(
    module: Module,
    call: CallExpression,
    captures: Captures,
    completed: readonly Reference[],
    readScope: { readonly module: Module; readonly read: Expression },
  ): readonly Reference[] | undefined {
    if (completed.some((frame) => frame.invocation?.module === module && frame.invocation.call === call)) {
      return [];
    }
    const relevant = (expression: Expression) =>
      this.effectContainsRead(module, expression, readScope.module, readScope.read, new Set(), 0, true, captures);
    const direct = this.function(module, call.callee);
    if (direct !== undefined) {
      if (
        !call.arguments.some((argument) => relevant(argument.type === 'SpreadElement' ? argument.argument : argument))
      ) {
        return [];
      }
      if (call.arguments.some((argument) => argument.type === 'SpreadElement')) {
        return undefined;
      }
      return [
        FactoryResolver.reference(
          direct.module,
          direct.fn,
          FactoryResolver.captureCall(
            direct.module,
            direct.fn,
            call.arguments.filter((argument) => argument.type !== 'SpreadElement'),
            captures,
            module,
          ),
        ),
      ];
    }
    const callee = unwrap(call.callee);
    if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'pipe' || !relevant(callee.object)) {
      return [];
    }
    const result: Reference[] = [];
    for (const argument of call.arguments) {
      const target = argument.type === 'SpreadElement' ? undefined : this.function(module, argument);
      if (target !== undefined) {
        result.push(
          FactoryResolver.reference(
            target.module,
            target.fn,
            FactoryResolver.captureCall(target.module, target.fn, [callee.object], captures, module),
          ),
        );
      }
    }
    return result;
  }
  reachedConsumerFrames(
    readModule: Module,
    read: Expression,
    frames: readonly Reference[],
  ): readonly Reference[] | undefined {
    if (frames.length === 0) {
      return frames;
    }
    const result = [...frames, FactoryResolver.reference(readModule, read, new Map())];
    const visited = new Map<CallExpression, Set<string>>();
    for (let iteration = 0; iteration < budget; iteration += 1) {
      const size = result.length;
      for (const module of this.modules.values()) {
        for (const call of module.calls) {
          const active = result.filter(
            (frame) =>
              frame.module === module &&
              FactoryResolver.nearestFunction(module, call) ===
                FactoryResolver.nearestFunction(module, frame.expression),
          );
          const topLevel = module === readModule && FactoryResolver.nearestFunction(module, call) === undefined;
          for (const captures of topLevel ? [new Map<Binding, Reference>()] : active.map((frame) => frame.captures)) {
            const key = this.referenceFingerprint(
              FactoryResolver.reference(module, call, captures),
              new Set(),
              new Map(),
              { value: budget },
            );
            const known = visited.get(call) ?? new Set<string>();
            if (key === undefined) {
              return undefined;
            }
            if (known.has(key)) {
              continue;
            }
            known.add(key);
            visited.set(call, known);
            const reached = this.reachedConsumerCallFrames(module, call, captures, frames, {
              module: readModule,
              read,
            });
            if (reached === undefined || result.length + reached.length > budget) {
              return undefined;
            }
            result.push(...reached);
          }
        }
      }
      if (size === result.length) {
        return result;
      }
    }
    return undefined;
  }
  validateServiceContexts(
    module: Module,
    tag: Expression,
    wanted: Binding,
    frames: readonly Reference[] = [],
  ): boolean {
    const reached = this.reachedConsumerFrames(module, tag, frames);
    if (reached === undefined) {
      return false;
    }
    const previous = this.contextSnapshotProofs;
    const proofs = new Map<string, ContextSnapshotProof>();
    this.contextSnapshotProofs = proofs;
    let result = false;
    for (let iteration = 0; iteration < budget; iteration += 1) {
      const count = proofs.size;
      result = this.localServiceContextsClosed(module, tag, wanted, false, reached);
      let changed = false;
      for (const proof of proofs.values()) {
        if (proof.valid && !this.localServiceContextsClosed(proof.module, proof.expression, wanted, true, reached)) {
          proof.valid = false;
          changed = true;
        }
      }
      if (!changed && count === proofs.size) {
        this.contextSnapshotProofs = previous;
        return result;
      }
    }
    this.contextSnapshotProofs = previous;
    return false;
  }

  contextReturnedThrough(module: Module, fn: Implementation, paths: readonly string[], seen: Set<Binding>): boolean {
    const aliases = module.bindings.filter(
      (binding) => binding.init !== undefined && this.function(module, binding.init)?.fn === fn,
    );
    if (
      aliases.length !== 1 ||
      aliases.some(
        (binding) => [...module.exports.values()].includes(binding.name) || !directCallsOnly(module, binding),
      )
    ) {
      return false;
    }
    const calls = module.calls.filter((call) => this.function(module, call.callee)?.fn === fn);
    return (
      calls.length > 0 &&
      calls.every((call) => {
        const recipients = module.bindings.filter((binding) => binding.init === call);
        return (
          recipients.length === 1 &&
          recipients.every((binding) => paths.every((path) => this.contextBindingCustody(module, binding, seen, path)))
        );
      })
    );
  }
  contextReturnCustody(
    module: Module,
    value: Expression,
    binding: Binding,
    suffix: string,
    seen: Set<Binding>,
    at: Span,
  ): boolean {
    const paths = this.objectPaths(module, value, binding, suffix);
    if (paths.length === 0) {
      return true;
    }
    let fn: Implementation | undefined;
    for (const candidate of module.functions) {
      if (inside(at, candidate) && (fn === undefined || candidate.end - candidate.start < fn.end - fn.start)) {
        fn = candidate;
      }
    }
    return fn !== undefined && this.contextReturnedThrough(module, fn, paths, seen);
  }
  contextBindingCustody(module: Module, binding: Binding, seen = new Set<Binding>(), suffix = ''): boolean {
    if (seen.has(binding) || seen.size >= budget || !stable(module, binding)) {
      return false;
    }
    const next = new Set(seen).add(binding);
    let closed = true;
    new Visitor({
      ArrowFunctionExpression: (node) => {
        if (node.body.type !== 'BlockStatement' && this.objectPaths(module, node.body, binding, suffix).length > 0) {
          closed = false;
        }
      },
      MemberExpression: (node) => {
        const path = this.bindingPath(module, node, binding);
        if (
          (path !== undefined && path !== suffix && path.startsWith(suffix.length === 0 ? '' : `${suffix}.`)) ||
          (node.computed && rootedAtBinding(module, node.object, binding))
        ) {
          closed = false;
        }
      },
      ReturnStatement: (node) => {
        if (node.argument !== null && !this.contextReturnCustody(module, node.argument, binding, suffix, next, node)) {
          closed = false;
        }
      },
    }).visit(module.program);
    if (
      !closed ||
      module.escapes.some((expression) => this.objectPaths(module, expression, binding, suffix).length > 0)
    ) {
      return false;
    }
    for (const alias of module.bindings) {
      const input = alias.field?.expression ?? alias.init;
      if (alias !== binding && input !== undefined) {
        const paths = this.objectPaths(module, input, binding, suffix);
        if (
          paths.length > 0 &&
          (!paths.every((path) => path === '') || !this.contextBindingCustody(module, alias, next))
        ) {
          return false;
        }
      }
    }
    return module.calls.every((call) =>
      call.arguments.every(
        (argument, index) =>
          argument.type === 'SpreadElement' ||
          this.objectPaths(module, argument, binding, suffix).length === 0 ||
          this.contextReadonlySlot(module, call, index),
      ),
    );
  }
  contextReadonlySlot(module: Module, call: CallExpression, index: number): boolean {
    if (this.contextProvideCall(module, call)) {
      return index === call.arguments.length - 1;
    }
    if (this.native(module, call.callee, 'Context', 'add')) {
      return call.arguments.length === 3 && index === 0;
    }
    if (['get', 'getOrUndefined', 'merge'].some((method) => this.native(module, call.callee, 'Context', method))) {
      return call.arguments.length === 2 && (index === 0 || this.native(module, call.callee, 'Context', 'merge'));
    }
    const callee = unwrap(call.callee);
    return (
      call.arguments.length === 1 &&
      index === 0 &&
      callee.type === 'CallExpression' &&
      this.native(module, callee.callee, 'Context', 'omit')
    );
  }
  static consumerCallReached(
    module: Module,
    call: CallExpression,
    readModule: Module,
    frames: readonly Reference[],
    actualFrames: readonly Reference[],
  ): boolean {
    return (
      frames.length === 0 ||
      module === readModule ||
      actualFrames.length > 0 ||
      FactoryResolver.nearestFunction(module, call) === undefined
    );
  }
  localServiceContextsClosed(
    readModule: Module,
    tag: Expression,
    binding: Binding,
    exactRead = false,
    frames: readonly Reference[] = [],
  ): boolean {
    let fn: Implementation | undefined;
    for (const candidate of readModule.functions) {
      if (inside(tag, candidate) && (fn === undefined || candidate.end - candidate.start < fn.end - fn.start)) {
        fn = candidate;
      }
    }
    const read = exactRead ? tag : (fn ?? tag);
    for (const module of this.modules.values()) {
      for (const call of module.calls) {
        const actualFrames = frames.filter((frame) => {
          const owner = FactoryResolver.nearestFunction(frame.module, frame.expression);
          return (
            frame.module === module && owner !== undefined && FactoryResolver.nearestFunction(module, call) === owner
          );
        });
        if (!FactoryResolver.consumerCallReached(module, call, readModule, frames, actualFrames)) {
          continue;
        }
        // Security fence: guarded Core pool (transaction I/O guard + session-role check). Core's guard modules are
        // Core's own implementations; a context provision there is still checked below.
        if (
          !exactRead &&
          !isCoreDatabaseGuardModule(module.file) &&
          !(
            actualFrames.length === 0 ? [new Map<Binding, Reference>()] : actualFrames.map((frame) => frame.captures)
          ).every((captures) => this.consumerEffectCallClosed(module, call, readModule, read, binding, captures))
        ) {
          return false;
        }
        if (
          this.contextProvideCall(module, call) &&
          !this.disjointContextProvision(module, call, binding) &&
          this.contextProvisionReads(module, call, readModule, read)
        ) {
          return false;
        }
      }
    }
    return true;
  }
  preservingEffectOperator(module: Module, input: Expression): boolean {
    const node = unwrap(input);
    if (node.type === 'CallExpression') {
      const role = this.nativeEffectCallRole(module, node);
      if (role === 'effect' || role === 'unknown') {
        return false;
      }
    }
    const callee = node.type === 'CallExpression' ? unwrap(node.callee) : node;
    return (
      [
        'gen',
        'succeed',
        'map',
        'flatMap',
        'mapError',
        'catch',
        'catchIf',
        'catchTag',
        'catchTags',
        'tap',
        'tapError',
        'tapCause',
        'ensuring',
        'onExit',
        'as',
        'asVoid',
        'zip',
        'andThen',
        'all',
        'forEach',
        'orDie',
        'uninterruptible',
        'interruptible',
        'suspend',
        'match',
        'matchEffect',
        'provideService',
      ].some((method) => this.native(module, callee, 'Effect', method)) ||
      ['provideServices', 'provideContext'].some((method) => this.nativeContextProvider(module, callee, method))
    );
  }
  nativeEffectFnConstruction(module: Module, call: CallExpression, wanted: Binding): boolean {
    const callee = unwrap(call.callee);
    const native =
      this.native(module, callee, 'Effect', 'fn') ||
      (callee.type === 'CallExpression' && this.native(module, callee.callee, 'Effect', 'fn'));
    const [body, ...transforms] = call.arguments;
    return (
      native &&
      body !== undefined &&
      body.type !== 'SpreadElement' &&
      functionValue(body) !== undefined &&
      this.effectFnKeysDisjoint(wanted) &&
      transforms.every(
        (transform) =>
          transform.type !== 'SpreadElement' &&
          (this.preservingEffectOperator(module, transform) || this.function(module, transform) !== undefined),
      )
    );
  }
  effectFnKeysDisjoint(wanted: Binding): boolean {
    const key = this.tagKeys.get(wanted);
    return (
      key !== undefined &&
      key !== NativeTracer.ParentSpan.key &&
      key !== NativeReferences.CurrentStackFrame.key &&
      this.nativeCohort('Tracer') &&
      this.nativeCohort('References')
    );
  }
  consumerEffectTransformClosed(module: Module, input: Expression, wanted: Binding): boolean {
    const provision = this.consumerSourceServiceProvision(module, input, wanted);
    if (provision !== undefined) {
      return provision;
    }
    const node = unwrap(input);
    const callee = node.type === 'CallExpression' ? node.callee : node;
    return (
      (node.type === 'CallExpression' && this.nativeEffectFnConstruction(module, node, wanted)) ||
      this.preservingEffectOperator(module, node) ||
      this.function(module, callee) !== undefined
    );
  }
  layerTransformRole(module: Module, input: Expression): boolean {
    const node = unwrap(input);
    if (this.native(module, node, 'Layer', 'orDie')) {
      return true;
    }
    return (
      node.type === 'CallExpression' &&
      !node.optional &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type !== 'SpreadElement' &&
      ['provide', 'provideMerge'].some((method) => this.native(module, node.callee, 'Layer', method))
    );
  }
  layerValueRole(reference: Reference, seen: Set<Binding>, hops: number): boolean {
    if (hops >= budget) {
      return false;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (this.native(module, node, 'Layer', 'empty') || this.fixedLayerKeys(module, node) !== undefined) {
      return true;
    }
    if (node.type === 'Identifier') {
      const variants = this.conditionalReferences(module, node, captures);
      if (variants !== undefined) {
        return variants.every((variant) => this.layerValueRole(variant, seen, hops + 1));
      }
      const symbol = this.symbol(module, node);
      const local = bindingAt(module, node.name, node);
      const captured = local === undefined ? undefined : captures.get(local);
      if (captured !== undefined) {
        return this.layerValueRole(captured, seen, hops + 1);
      }
      return (
        symbol !== undefined &&
        symbol.binding.init !== undefined &&
        !seen.has(symbol.binding) &&
        this.layerValueRole(
          FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
          new Set(seen).add(symbol.binding),
          hops + 1,
        )
      );
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    return this.layerCallRole(reference, node, seen, hops);
  }
  layerCallRole(reference: Reference, node: CallExpression, seen: Set<Binding>, hops: number): boolean {
    const { captures, module } = reference;
    const callee = unwrap(node.callee);
    if (
      this.nativeLayerConstructor(module, node) ||
      this.layerProducer(module, node) !== undefined ||
      (node.arguments.length === 3 && this.native(module, callee, 'HttpApiBuilder', 'group')) ||
      (node.arguments.length === 2 && this.native(module, callee, 'HttpApiMiddleware', 'layerSchemaErrorTransform')) ||
      (node.arguments.length === 2 && FactoryResolver.nativeOwnerRuntime(module, callee))
    ) {
      return true;
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return (
        this.layerValueRole(FactoryResolver.reference(module, callee.object, captures), seen, hops + 1) &&
        node.arguments.every(
          (argument) => argument.type !== 'SpreadElement' && this.layerTransformRole(module, argument),
        )
      );
    }
    const fn = this.function(module, callee);
    const result = fn === undefined ? undefined : directReturn(fn.fn, fn.module.program);
    return (
      fn !== undefined &&
      result !== undefined &&
      this.layerValueRole(
        FactoryResolver.reference(
          fn.module,
          result,
          FactoryResolver.captureCall(
            fn.module,
            fn.fn,
            node.arguments.filter((argument) => argument.type !== 'SpreadElement'),
            captures,
            module,
          ),
        ),
        seen,
        hops + 1,
      )
    );
  }
  nativeLayerConstructor(module: Module, call: CallExpression): boolean {
    return (
      this.native(module, call.callee, 'Layer', 'mergeAll') ||
      (call.arguments.length === 2 &&
        ['effect', 'succeed', 'merge', 'provide', 'provideMerge'].some((method) =>
          this.native(module, call.callee, 'Layer', method),
        )) ||
      (call.arguments.length === 1 &&
        ['unwrap', 'fresh'].some((method) => this.native(module, call.callee, 'Layer', method)))
    );
  }
  effectCarrierRead(
    reference: Reference,
    readModule: Module,
    read: Span,
    seen = new Set<Binding | Implementation>(),
    hops = 0,
  ): boolean {
    if (hops >= budget) {
      return true;
    }
    if (reference.elements !== undefined) {
      return reference.elements.some((value) => this.effectCarrierRead(value, readModule, read, seen, hops + 1));
    }
    if (reference.success) {
      return this.successCarrierRead(reference, readModule, read, seen, hops + 1);
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (this.nativeTrimSchemaConstruction(reference.module, node)) {
      return false;
    }
    if (node.type === 'Identifier') {
      return this.identifierCarrierRead(reference, node, readModule, read, seen, hops);
    }
    if (node.type === 'YieldExpression' && node.delegate && node.argument !== null) {
      return this.successCarrierRead(
        FactoryResolver.reference(module, node.argument, captures),
        readModule,
        read,
        seen,
        hops + 1,
      );
    }
    if (node.type === 'MemberExpression') {
      return this.memberCarrierRead(reference, node, readModule, read, seen, hops);
    }
    if (node.type === 'CallExpression') {
      return this.callCarrierRead(reference, node, readModule, read, seen, hops);
    }
    if (node.type === 'ObjectExpression') {
      return node.properties.some((property) => {
        if (property.type === 'Property' && property.kind === 'get') {
          const getter = functionValue(property.value);
          return (
            getter !== undefined &&
            FactoryResolver.functionReturnValues(module, getter).some((expression) =>
              this.effectCarrierRead(
                FactoryResolver.reference(module, expression, captures),
                readModule,
                read,
                seen,
                hops + 1,
              ),
            )
          );
        }
        const expression = property.type === 'SpreadElement' ? property.argument : property.value;
        return this.effectCarrierRead(
          FactoryResolver.reference(module, expression, captures),
          readModule,
          read,
          seen,
          hops + 1,
        );
      });
    }
    if (functionValue(node) !== undefined) {
      return false;
    }
    return FactoryResolver.effectContainerChildren(node).some((expression) =>
      this.effectCarrierRead(FactoryResolver.reference(module, expression, captures), readModule, read, seen, hops + 1),
    );
  }
  memberCarrierRead(
    reference: Reference,
    node: Expression,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { captures, module } = reference;
    if (node.type !== 'MemberExpression' || this.unprovedRestCarrierIndex(reference, node)) {
      return true;
    }
    let base = unwrap(node.object);
    for (let depth = 0; base.type === 'MemberExpression' && !base.computed && depth < budget; depth += 1) {
      base = unwrap(base.object);
    }
    if (base.type === 'Identifier' && this.nativeConfigSuccessBinding(module, base)) {
      return false;
    }
    if (this.native(module, node, 'Schema', 'String') && this.nativeSchemaConstantCustody('String')) {
      return false;
    }
    // The native PgClient service tag is a key, not an effect: it carries no read of its own.
    if (this.native(module, node, 'PgClient', 'PgClient')) {
      return false;
    }
    const key = FactoryResolver.carrierProjectionKey(node);
    const fields = this.nativeSqlFieldEvidence(reference, node);
    if (key !== undefined && fields?.includes(key) === true) {
      return false;
    }
    const projected = this.carrierProjection(reference, node, seen, hops);
    return (
      projected === undefined ||
      projected.some((value) => this.effectCarrierRead(value, readModule, read, seen, hops + 1)) ||
      (projected.length === 0 &&
        this.effectCarrierRead(
          FactoryResolver.reference(module, node.object, captures),
          readModule,
          read,
          seen,
          hops + 1,
        ))
    );
  }
  carrierSuccessValues(reference: Reference, hops = 0, seen = new Set<Binding>()): readonly Reference[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier') {
      return this.carrierIdentifierSuccess(reference, node, hops, seen);
    }
    if (node.type !== 'CallExpression' || node.optional || node.arguments.some((arg) => arg.type === 'SpreadElement')) {
      return undefined;
    }
    const role = this.nativeEffectCallRole(module, node);
    if (role !== undefined && role !== 'effect') {
      return undefined;
    }
    if (this.nativeAtomicSuccessCall(module, node)) {
      return this.carrierAtomicSuccess(reference, node, hops, seen);
    }
    if (this.native(module, node.callee, 'Effect', 'forEach')) {
      return this.carrierForEachSuccess(reference, node, hops, seen);
    }
    if (
      ['map', 'flatMap', 'as', 'mapError', 'catch'].some((method) => this.native(module, node.callee, 'Effect', method))
    ) {
      return this.carrierDirectTransformSuccess(reference, node, hops, seen);
    }
    const callee = unwrap(node.callee);
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return this.carrierPipeSuccess(reference, node, hops, seen);
    }
    if (callee.type === 'CallExpression' && this.nativeEffectPipeableCall(module, callee)) {
      return this.carrierAppliedSuccess(reference, node, hops, seen);
    }
    return this.carrierFunctionSuccess(reference, node, hops, seen);
  }
  static eagerSuccessValue(value: Reference, producer: Reference): Reference {
    return { ...value, eagerProducer: producer };
  }
  nativeAtomicSuccessCall(module: Module, call: CallExpression): boolean {
    return (
      ['succeed', 'sync', 'gen'].some((method) => this.native(module, call.callee, 'Effect', method)) ||
      this.nativeProvisionValue(module, call)
    );
  }
  carrierAtomicSuccess(
    reference: Reference,
    node: CallExpression,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const args = node.arguments.filter((arg) => arg.type !== 'SpreadElement');
    const [first] = args;
    if (this.native(module, node.callee, 'Effect', 'succeed')) {
      return args.length === 1 && first !== undefined
        ? [FactoryResolver.eagerSuccessValue(FactoryResolver.reference(module, first, captures), reference)]
        : undefined;
    }
    if (
      ['sync', 'gen'].some((method) => this.native(module, node.callee, 'Effect', method)) &&
      args.length === 1 &&
      first !== undefined
    ) {
      return this.carrierCallbackValues(FactoryResolver.reference(module, first, captures), []);
    }
    if (this.nativeProvisionValue(module, node)) {
      return first === undefined
        ? undefined
        : this.carrierSuccessValues(FactoryResolver.reference(module, first, captures), hops + 1, seen);
    }
    return undefined;
  }
  carrierForEachSuccess(
    reference: Reference,
    call: CallExpression,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const [input, callback] = call.arguments;
    if (
      (call.arguments.length !== 2 && call.arguments.length !== 3) ||
      input === undefined ||
      callback === undefined ||
      input.type === 'SpreadElement' ||
      callback.type === 'SpreadElement'
    ) {
      return undefined;
    }
    return this.carrierTraversalValues(
      FactoryResolver.reference(module, callback, captures),
      FactoryResolver.reference(module, input, captures),
      hops,
      seen,
    );
  }
  carrierTraversalValues(
    callback: Reference,
    input: Reference,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const values = this.carrierCallbackValues(callback, [input], true);
    const target = this.function(callback.module, callback.expression);
    if (values === undefined) {
      return undefined;
    }
    return target !== undefined && target.fn.generator && this.nativeEffectCallable(callback, target)
      ? values
      : this.flattenCarrierSuccess(values, hops + 1, seen);
  }
  nativeEffectCallable(
    reference: Reference,
    target: { readonly fn: Implementation; readonly module: Module },
  ): boolean {
    const { module } = reference;
    const expression = unwrap(reference.expression);
    const init = expression.type === 'Identifier' ? this.symbol(module, expression)?.binding.init : expression;
    const construction = init === undefined ? undefined : unwrap(init);
    return (
      construction?.type === 'CallExpression' &&
      construction.arguments.length === 1 &&
      this.nativeEffectFnBody(target.module, construction) === target.fn
    );
  }
  nativeProvisionValue(module: Module, call: CallExpression): boolean {
    return (
      this.nativeEffectCallRole(module, call) === 'effect' &&
      (this.native(module, call.callee, 'Effect', 'provideService') ||
        ['provideContext', 'provideServices'].some((method) => this.nativeContextProvider(module, call.callee, method)))
    );
  }
  carrierDirectTransformSuccess(
    reference: Reference,
    call: CallExpression,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const [first, second] = call.arguments;
    if (
      call.arguments.length !== 2 ||
      first === undefined ||
      second === undefined ||
      first.type === 'SpreadElement' ||
      second.type === 'SpreadElement'
    ) {
      return undefined;
    }
    const base = FactoryResolver.reference(reference.module, first, reference.captures);
    return this.carrierTransformValues(
      reference,
      call,
      second,
      base,
      this.carrierSuccessValues(base, hops + 1, seen),
      hops,
      seen,
    );
  }
  carrierTransformValues(
    reference: Reference,
    call: CallExpression,
    argument: Expression,
    base: Reference,
    inputs: readonly Reference[] | undefined,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const callback = FactoryResolver.reference(module, argument, captures);
    if (
      this.native(module, call.callee, 'Effect', 'provideService') ||
      ['provideContext', 'provideServices'].some((method) => this.nativeContextProvider(module, call.callee, method))
    ) {
      return inputs;
    }
    if (this.native(module, call.callee, 'Effect', 'as')) {
      return [FactoryResolver.eagerSuccessValue(callback, FactoryResolver.reference(module, call, captures))];
    }
    if (['map', 'flatMap'].some((method) => this.native(module, call.callee, 'Effect', method))) {
      return this.carrierMappedSuccess(
        callback,
        inputs,
        this.native(module, call.callee, 'Effect', 'flatMap'),
        hops + 1,
        seen,
        base,
      );
    }
    if (this.native(module, call.callee, 'Effect', 'mapError')) {
      return inputs;
    }
    if (this.native(module, call.callee, 'Effect', 'catch')) {
      const fallback = this.carrierFallbackSuccess(callback, base, hops + 1, seen);
      return fallback === undefined ? undefined : [...(inputs ?? [{ ...base, success: true }]), ...fallback];
    }
    return undefined;
  }
  carrierAppliedSuccess(
    reference: Reference,
    call: CallExpression,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const construction = unwrap(call.callee);
    const [input] = call.arguments;
    if (
      construction.type !== 'CallExpression' ||
      !this.nativeEffectPipeableCall(module, construction) ||
      call.arguments.length !== 1 ||
      input === undefined ||
      input.type === 'SpreadElement'
    ) {
      return undefined;
    }
    const [argument] = construction.arguments;
    if (argument === undefined || argument.type === 'SpreadElement') {
      return undefined;
    }
    const base = FactoryResolver.reference(module, input, captures);
    if (
      this.native(module, construction.callee, 'Effect', 'provideService') ||
      ['provideContext', 'provideServices'].some((method) =>
        this.nativeContextProvider(module, construction.callee, method),
      )
    ) {
      return this.carrierSuccessValues(base, hops + 1, seen);
    }
    if (this.native(module, construction.callee, 'Effect', 'forEach')) {
      return this.carrierTraversalValues(FactoryResolver.reference(module, argument, captures), base, hops, seen);
    }
    return this.carrierTransformValues(
      reference,
      construction,
      argument,
      base,
      this.carrierSuccessValues(base, hops + 1, seen),
      hops,
      seen,
    );
  }
  carrierFunctionSuccess(
    reference: Reference,
    call: CallExpression,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const callee = unwrap(call.callee);
    const target = this.function(module, callee, 0, captures);
    if (
      target === undefined ||
      target.fn.async ||
      (target.fn.generator && !this.nativeEffectCallable(FactoryResolver.reference(module, callee, captures), target))
    ) {
      return undefined;
    }
    if (target.captures !== undefined && call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return undefined;
    }
    const args = call.arguments.filter((arg) => arg.type !== 'SpreadElement');
    const frame = FactoryResolver.captureCall(target.module, target.fn, args, captures, module, target.captures);
    const values = FactoryResolver.functionReturnValues(target.module, target.fn).map((expression) =>
      FactoryResolver.reference(target.module, expression, frame),
    );
    return target.fn.generator ? values : this.flattenCarrierSuccess(values, hops + 1, seen);
  }
  carrierIdentifierSuccess(
    reference: Reference,
    node: IdentifierReference,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const binding = bindingAt(module, node.name, node);
    const captured = binding === undefined ? undefined : captures.get(binding);
    if (captured !== undefined) {
      return this.carrierSuccessValues(captured, hops + 1, seen);
    }
    const symbol = this.symbol(module, node);
    return symbol === undefined || symbol.binding.init === undefined || seen.has(symbol.binding)
      ? undefined
      : this.carrierSuccessValues(
          FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
          hops + 1,
          new Set(seen).add(symbol.binding),
        );
  }
  carrierCallbackValues(
    callback: Reference,
    inputs: readonly Reference[] | undefined,
    mayBeUndefined = false,
  ): readonly Reference[] | undefined {
    const target = this.function(callback.module, callback.expression);
    if (target === undefined || target.fn.async || target.fn.params.length > 1 || inputs === undefined) {
      return undefined;
    }
    const returns = FactoryResolver.functionReturnValues(target.module, target.fn);
    const [parameter] = target.fn.params;
    if (parameter === undefined) {
      return returns.map((expression) => FactoryResolver.reference(target.module, expression, callback.captures));
    }
    if (inputs.length === 0) {
      return FactoryResolver.carrierMissingCallbackValues(target.module, parameter, returns, callback.captures);
    }
    const identifier = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
    if (identifier.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(target.module, identifier.name, identifier);
    if (binding === undefined) {
      return undefined;
    }
    const result: Reference[] = [];
    for (const input of inputs) {
      const references = FactoryResolver.formalValueReferences(
        target.module,
        parameter,
        input,
        callback.captures,
        mayBeUndefined,
      );
      if (references === undefined) {
        return undefined;
      }
      for (const value of references) {
        const frame = new Map([...callback.captures, [binding, value]]);
        result.push(...returns.map((expression) => FactoryResolver.reference(target.module, expression, frame)));
      }
    }
    return result;
  }
  static carrierMissingCallbackValues(
    module: Module,
    parameter: ParamPattern,
    returns: readonly Expression[],
    captures: Captures,
  ): readonly Reference[] | undefined {
    const absent = FactoryResolver.absentFormalValue(module, parameter, captures);
    if (absent === undefined) {
      return undefined;
    }
    if (absent.reference === undefined) {
      return returns.map((expression) => FactoryResolver.reference(module, expression, captures));
    }
    if (parameter.type !== 'AssignmentPattern' || parameter.left.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(module, parameter.left.name, parameter.left);
    if (binding === undefined) {
      return undefined;
    }
    const frame = new Map([...captures, [binding, absent.reference]]);
    return returns.map((expression) => FactoryResolver.reference(module, expression, frame));
  }
  static formalValueReferences(
    module: Module,
    parameter: ParamPattern,
    input: Reference | undefined,
    captures: Captures,
    mayBeUndefined = false,
  ): readonly Reference[] | undefined {
    if (parameter.type === 'Identifier') {
      return input === undefined ? [] : [input];
    }
    if (parameter.type !== 'AssignmentPattern' || parameter.left.type !== 'Identifier') {
      return undefined;
    }
    const fallback = FactoryResolver.reference(module, parameter.right, new Map(captures));
    if (input === undefined) {
      return [fallback];
    }
    return !mayBeUndefined && FactoryResolver.definitelyDefinedArgument(input) ? [input] : [input, fallback];
  }
  static definitelyDefinedArgument(reference: Reference, seen = new Set<Binding>(), hops = 0): boolean {
    if (hops >= budget || reference.success === true) {
      return false;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (
      [
        'Literal',
        'ObjectExpression',
        'ArrayExpression',
        'ArrowFunctionExpression',
        'FunctionExpression',
        'ClassExpression',
        'TemplateLiteral',
      ].includes(node.type)
    ) {
      return true;
    }
    if (node.type !== 'Identifier') {
      return false;
    }
    const binding = bindingAt(module, node.name, node);
    if (binding === undefined || seen.has(binding) || !stable(module, binding)) {
      return false;
    }
    const captured = captures.get(binding);
    const value =
      captured ?? (binding.init === undefined ? undefined : FactoryResolver.reference(module, binding.init, captures));
    return (
      value !== undefined && FactoryResolver.definitelyDefinedArgument(value, new Set(seen).add(binding), hops + 1)
    );
  }
  closedArrayIteratorCohort(): boolean {
    for (const module of this.modules.values()) {
      const cached = this.arrayIteratorFacts.get(module.program);
      if (cached === true) {
        continue;
      }
      if (!hasClosedNativeArrayIteratorCustody(module.program)) {
        return false;
      }
      this.arrayIteratorFacts.set(module.program, true);
    }
    return true;
  }
  closedRestVectors(module: Module, call: CallExpression, hops = 0): readonly (readonly Reference[])[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    if (!this.closedArrayIteratorCohort()) {
      return undefined;
    }
    const source = this.soleRestBinding(module, call);
    if (source === undefined) {
      return undefined;
    }
    const { fn } = source;
    const aliases = module.bindings.filter(
      (value) => value.init !== undefined && this.function(module, value.init)?.fn === fn,
    );
    if (aliases.length === 0 || aliases.some((alias) => !stable(module, alias) || !directCallsOnly(module, alias))) {
      return undefined;
    }
    const callers = this.callerModules(module, fn);
    if (callers === undefined) {
      return undefined;
    }
    const vectors: Reference[][] = [];
    for (const caller of callers) {
      for (const actual of caller.calls) {
        if (this.function(caller, actual.callee)?.fn !== fn) {
          continue;
        }
        if (actual.arguments.some((value) => value.type === 'SpreadElement')) {
          return undefined;
        }
        const values = actual.arguments
          .filter((value) => value.type !== 'SpreadElement')
          .map((value) => FactoryResolver.reference(caller, value, new Map()));
        if (vectors.length >= budget || values.length > budget) {
          return undefined;
        }
        vectors.push(values);
      }
    }
    return vectors.length === 0 ? undefined : vectors;
  }
  soleRestBinding(
    module: Module,
    call: CallExpression,
  ): { readonly binding: Binding; readonly fn: Implementation } | undefined {
    if (call.arguments.length !== 1) {
      return undefined;
    }
    const [spread] = call.arguments;
    if (spread?.type !== 'SpreadElement') {
      return undefined;
    }
    const argument = unwrap(spread.argument);
    if (argument.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(module, argument.name, argument);
    const parameter = binding?.parameter;
    const fn = parameter?.fn;
    const [rest] = fn?.params ?? [];
    if (
      binding === undefined ||
      parameter === undefined ||
      fn === undefined ||
      fn.params.length !== 1 ||
      rest?.type !== 'RestElement' ||
      rest.argument.type !== 'Identifier' ||
      !stable(module, binding) ||
      !this.restVectorCustody(module, binding)
    ) {
      return undefined;
    }
    return { binding, fn };
  }
  closedRestBindingVectors(module: Module, binding: Binding): readonly (readonly Reference[])[] | undefined {
    const call = module.calls.find(
      (value) =>
        value.arguments.length === 1 &&
        value.arguments[0]?.type === 'SpreadElement' &&
        (() => {
          const argument = unwrap(value.arguments[0].argument);
          return argument.type === 'Identifier' && bindingAt(module, argument.name, argument) === binding;
        })(),
    );
    return call === undefined ? undefined : this.closedRestVectors(module, call);
  }
  unprovedRestCarrierIndex(reference: Reference, node: Expression): boolean {
    if (
      node.type !== 'MemberExpression' ||
      !node.computed ||
      node.property.type !== 'Literal' ||
      !Schema.is(Schema.Number)(node.property.value)
    ) {
      return false;
    }
    const object = unwrap(node.object);
    const binding = object.type === 'Identifier' ? bindingAt(reference.module, object.name, object) : undefined;
    if (
      binding?.parameter === undefined ||
      binding.parameter.fn.params[binding.parameter.index]?.type !== 'RestElement'
    ) {
      return false;
    }
    const vectors = this.closedRestBindingVectors(reference.module, binding);
    const actual = reference.captures.get(binding)?.elements;
    const index = node.property.value;
    return (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      vectors === undefined ||
      (actual === undefined ? vectors : [actual]).some((vector) => index >= vector.length)
    );
  }
  restCarrierProjection(reference: Reference, node: Expression): readonly Reference[] | undefined {
    if (
      node.type !== 'MemberExpression' ||
      !node.computed ||
      node.property.type !== 'Literal' ||
      !Schema.is(Schema.Number)(node.property.value) ||
      !Number.isSafeInteger(node.property.value) ||
      node.property.value < 0
    ) {
      return undefined;
    }
    const object = unwrap(node.object);
    if (object.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(reference.module, object.name, object);
    if (
      binding?.parameter === undefined ||
      binding.parameter.fn.params[binding.parameter.index]?.type !== 'RestElement'
    ) {
      return undefined;
    }
    const vectors = this.closedRestBindingVectors(reference.module, binding);
    if (vectors === undefined) {
      return undefined;
    }
    const captured = reference.captures.get(binding)?.elements;
    const actual = captured === undefined ? vectors : [captured];
    const index = node.property.value;
    return actual.flatMap((vector) => {
      const value = vector[index];
      return value === undefined ? [] : [value];
    });
  }
  restVectorCustody(module: Module, binding: Binding): boolean {
    if (!stable(module, binding)) {
      return false;
    }
    const allowed = new Set<Span>([binding.node]);
    let closed = true;
    new Visitor({
      MemberExpression: (node) => {
        const object = unwrap(node.object);
        if (object.type === 'Identifier' && bindingAt(module, object.name, object) === binding) {
          if (
            node.computed &&
            node.property.type === 'Literal' &&
            Schema.is(Schema.Number)(node.property.value) &&
            Number.isSafeInteger(node.property.value) &&
            node.property.value >= 0
          ) {
            allowed.add(object);
          } else {
            closed = false;
          }
        }
      },
      SpreadElement: (node) => {
        const argument = unwrap(node.argument);
        if (argument.type === 'Identifier' && bindingAt(module, argument.name, argument) === binding) {
          const target = module.calls.find((call) => call.arguments.includes(node));
          if (
            target === undefined ||
            target.arguments.length !== 1 ||
            this.function(module, target.callee) === undefined
          ) {
            closed = false;
          } else {
            allowed.add(argument);
          }
        }
      },
    }).visit(module.program);
    new Visitor({
      Identifier: (node) => {
        if (node.name === binding.name && bindingAt(module, node.name, node) === binding && !allowed.has(node)) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  callFormalReferences(
    module: Module,
    binding: Binding,
    call: CallExpression,
    caller: Module,
  ): readonly Reference[] | undefined {
    if (!call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return FactoryResolver.callFormalValueReferences(module, binding, call, caller);
    }
    const { parameter } = binding;
    const formal = parameter?.fn.params[parameter.index];
    const vectors = this.closedRestVectors(caller, call);
    if (parameter === undefined || formal === undefined || vectors === undefined) {
      return undefined;
    }
    const result: Reference[] = [];
    for (const vector of vectors) {
      const frame = new Map<Binding, Reference>();
      for (const [index, param] of parameter.fn.params.entries()) {
        const identifier = param.type === 'AssignmentPattern' ? param.left : param;
        if (identifier.type !== 'Identifier') {
          return undefined;
        }
        const bound = bindingAt(module, identifier.name, identifier);
        const values = FactoryResolver.formalValueReferences(module, param, vector[index], frame);
        if (values === undefined) {
          return undefined;
        }
        if (index === parameter.index) {
          result.push(...values);
          break;
        }
        if (bound === undefined || values.length !== 1 || values[0] === undefined) {
          return undefined;
        }
        frame.set(bound, values[0]);
      }
    }
    return result;
  }
  static callFormalValueReferences(
    module: Module,
    binding: Binding,
    call: CallExpression,
    caller: Module,
  ): readonly Reference[] | undefined {
    if (call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return undefined;
    }
    const { parameter } = binding;
    if (parameter === undefined) {
      return undefined;
    }
    const formal = parameter.fn.params[parameter.index];
    if (formal === undefined) {
      return undefined;
    }
    const args = call.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const actual = args[parameter.index];
    const frame = FactoryResolver.captureCall(module, parameter.fn, args, new Map(), caller);
    return FactoryResolver.formalValueReferences(
      module,
      formal,
      actual === undefined ? undefined : FactoryResolver.reference(caller, actual, new Map()),
      frame,
    );
  }
  static requiresFormalBinding(binding: Binding, call: CallExpression, caller: Module): boolean {
    const { parameter } = binding;
    if (parameter === undefined) {
      return false;
    }
    return (
      FactoryResolver.absentActualArgument(caller, call.arguments[parameter.index]) ||
      parameter.fn.params[parameter.index]?.type === 'AssignmentPattern'
    );
  }
  static absentActualArgument(module: Module, argument: CallExpression['arguments'][number] | undefined): boolean {
    if (argument === undefined) {
      return true;
    }
    if (argument.type === 'SpreadElement') {
      return false;
    }
    const value = unwrap(argument);
    return (
      value.type === 'Identifier' && value.name === 'undefined' && bindingAt(module, value.name, value) === undefined
    );
  }
  static absentFormalValue(
    module: Module,
    parameter: ParamPattern,
    captures: Captures,
  ): { readonly reference?: Reference } | undefined {
    const references = FactoryResolver.formalValueReferences(module, parameter, undefined, captures);
    if (references === undefined) {
      return undefined;
    }
    return references.length === 0 ? {} : { reference: references[0] };
  }
  static materializeArgumentReference(reference: Reference): Reference | undefined {
    let value = reference;
    const visited = new Set<Binding>();
    for (let index = 0; index < budget; index += 1) {
      const node = unwrap(value.expression);
      if (node.type !== 'Identifier') {
        return value;
      }
      const binding = bindingAt(value.module, node.name, node);
      const captured = binding === undefined ? undefined : value.captures.get(binding);
      if (captured === undefined) {
        return value;
      }
      if (binding === undefined || visited.has(binding)) {
        return undefined;
      }
      visited.add(binding);
      value = captured;
    }
    return undefined;
  }
  flattenCarrierSuccess(
    values: readonly Reference[],
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const result: Reference[] = [];
    for (const value of values) {
      const next = this.carrierSuccessValues(value, hops + 1, seen);
      if (next === undefined) {
        result.push({ ...value, success: true });
      } else {
        result.push(...next);
      }
    }
    return result;
  }
  carrierMappedSuccess(
    callback: Reference,
    inputs: readonly Reference[] | undefined,
    flatten: boolean,
    hops: number,
    seen: Set<Binding>,
    base?: Reference,
  ): readonly Reference[] | undefined {
    const actualInputs: readonly Reference[] | undefined =
      inputs ?? (base === undefined ? undefined : [{ ...base, success: true }]);
    const values = this.carrierCallbackValues(callback, actualInputs);
    if (values === undefined) {
      return undefined;
    }
    return flatten ? this.flattenCarrierSuccess(values, hops + 1, seen) : values;
  }
  carrierPipeSuccess(
    reference: Reference,
    call: CallExpression,
    hops: number,
    seen: Set<Binding>,
    stopBefore?: CallExpression,
  ): readonly Reference[] | undefined {
    const { captures, module } = reference;
    const callee = unwrap(call.callee);
    if (callee.type !== 'MemberExpression') {
      return undefined;
    }
    const base = FactoryResolver.reference(module, callee.object, captures);
    let values = this.carrierSuccessValues(base, hops + 1, seen);
    for (const argument of call.arguments) {
      if (argument === stopBefore) {
        return values;
      }
      if (argument.type === 'SpreadElement') {
        return undefined;
      }
      const node = unwrap(argument);
      if (node.type !== 'CallExpression') {
        return undefined;
      }
      const [callback] = node.arguments;
      if (callback === undefined || callback.type === 'SpreadElement') {
        return undefined;
      }
      if (!this.nativeEffectPipeableCall(module, node)) {
        return undefined;
      }
      values = this.carrierTransformValues(reference, node, callback, base, values, hops + 1, seen);
    }
    return values;
  }
  carrierFallbackSuccess(
    callback: Reference,
    base: Reference,
    hops: number,
    seen: Set<Binding>,
  ): readonly Reference[] | undefined {
    const values = this.carrierCallbackValues(callback, [{ ...base, success: true }]);
    const target = this.function(callback.module, callback.expression);
    if (values === undefined) {
      return undefined;
    }
    return target !== undefined && target.fn.generator && this.nativeEffectCallable(callback, target)
      ? values
      : this.flattenCarrierSuccess(values, hops + 1, seen);
  }
  pipeableSuccessCarrier(
    reference: Reference,
    call: CallExpression,
    base: Reference,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { captures, module } = reference;
    const [argument] = call.arguments;
    if (argument === undefined || argument.type === 'SpreadElement') {
      return false;
    }
    const values = this.carrierTransformValues(reference, call, argument, base, undefined, hops + 1, new Set());
    return values === undefined
      ? this.effectCarrierRead(FactoryResolver.reference(module, call, captures), readModule, read, seen, hops + 1)
      : values.some((value) => this.effectCarrierRead(value, readModule, read, seen, hops + 1));
  }
  /**
   * A local `const` holding the success of a closed native Config read (`yield* config`, optionally with its
   * failure mapped): decoded data only, so it carries no effect. The guarded Core pool reads its process budget so.
   */
  nativeConfigSuccessBinding(module: Module, node: IdentifierReference): boolean {
    const binding = bindingAt(module, node.name, node);
    const init = binding?.init === undefined ? undefined : unwrap(binding.init);
    return (
      binding !== undefined &&
      binding.kind === 'const' &&
      binding.origin === undefined &&
      stable(module, binding) &&
      init?.type === 'YieldExpression' &&
      init.delegate &&
      init.argument !== null &&
      this.nativeConfig(module, this.failureMappedReceiver(module, unwrap(init.argument)), new Set())
    );
  }
  /** `effect.pipe(Effect.mapError(f))` answered as `effect`; anything else as itself. */
  failureMappedReceiver(module: Module, read: Expression): Expression {
    const callee = read.type === 'CallExpression' && !read.optional ? unwrap(read.callee) : undefined;
    const [adapter] = read.type === 'CallExpression' ? read.arguments : [];
    return callee?.type === 'MemberExpression' &&
      propertyName(callee) === 'pipe' &&
      read.type === 'CallExpression' &&
      read.arguments.length === 1 &&
      adapter?.type === 'CallExpression' &&
      adapter.arguments.length === 1 &&
      this.native(module, adapter.callee, 'Effect', 'mapError')
      ? callee.object
      : read;
  }
  /** A Config built only from native Config constructors over literal keys and defaults. */
  nativeConfig(module: Module, input: Expression, seen: Set<Binding>): boolean {
    const node = unwrap(input);
    if (node.type === 'CallExpression') {
      return this.nativeConfigCall(module, node, seen);
    }
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    return (
      binding !== undefined &&
      binding.kind === 'const' &&
      binding.origin === undefined &&
      binding.init !== undefined &&
      !seen.has(binding) &&
      seen.size < budget &&
      stable(module, binding) &&
      this.nativeConfig(module, binding.init, new Set(seen).add(binding))
    );
  }
  nativeConfigCall(module: Module, call: CallExpression, seen: Set<Binding>): boolean {
    const [argument] = call.arguments;
    const callee = unwrap(call.callee);
    if (call.optional || call.arguments.length !== 1 || argument === undefined || argument.type === 'SpreadElement') {
      return false;
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return (
        argument.type === 'CallExpression' &&
        argument.arguments.length === 1 &&
        argument.arguments[0]?.type === 'Literal' &&
        this.native(module, argument.callee, 'Config', 'withDefault') &&
        this.nativeConfig(module, callee.object, seen)
      );
    }
    if (['Boolean', 'Int', 'Number', 'String'].some((method) => this.native(module, callee, 'Config', method))) {
      return argument.type === 'Literal' && Schema.is(Schema.String)(argument.value);
    }
    if (this.native(module, callee, 'Config', 'option')) {
      return this.nativeConfig(module, argument, seen);
    }
    const fields = this.native(module, callee, 'Config', 'all') ? unwrap(argument) : undefined;
    return (
      fields?.type === 'ObjectExpression' &&
      fields.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.computed &&
          !property.method &&
          this.nativeConfig(module, property.value, seen),
      )
    );
  }
  successCarrierRead(
    reference: Reference,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    if (hops >= budget) {
      return true;
    }
    const values = this.carrierSuccessValues(reference);
    if (values !== undefined) {
      return values.some((value) => this.effectCarrierRead(value, readModule, read, seen, hops + 1));
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type !== 'CallExpression') {
      return this.effectCarrierRead(
        FactoryResolver.reference(module, reference.expression, captures),
        readModule,
        read,
        seen,
        hops + 1,
      );
    }
    if (this.nativeEffectCallRole(module, node) === 'unknown') {
      return true;
    }
    const callee = unwrap(node.callee);
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return this.unknownPipeSuccessCarrier(reference, node, callee.object, readModule, read, seen, hops);
    }
    const symbol = callee.type === 'Identifier' ? this.symbol(module, callee) : undefined;
    const initial = callee.type === 'Identifier' ? symbol?.binding.init : callee;
    const construction = initial === undefined ? undefined : unwrap(initial);
    if (
      construction?.type === 'CallExpression' &&
      this.nativeEffectFnBody(symbol?.module ?? module, construction) !== undefined
    ) {
      return true;
    }
    const target = this.function(module, callee);
    if (target?.fn.generator === true) {
      return true;
    }
    return node.arguments.some((argument) =>
      this.argumentCarrierRead(
        FactoryResolver.reference(module, argument.type === 'SpreadElement' ? argument.argument : argument, captures),
        readModule,
        read,
        seen,
        hops + 1,
      ),
    );
  }
  argumentCarrierRead(
    reference: Reference,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    if (this.effectCarrierRead(reference, readModule, read, seen, hops + 1)) {
      return true;
    }
    const target = this.function(reference.module, reference.expression);
    if (target !== undefined && target.fn.generator && this.nativeEffectCallable(reference, target)) {
      return this.effectContainsRead(target.module, target.fn, readModule, read, new Set(), 0);
    }
    return (
      target !== undefined &&
      FactoryResolver.functionReturnValues(target.module, target.fn).some((expression) =>
        this.effectCarrierRead(
          FactoryResolver.reference(target.module, expression, reference.captures),
          readModule,
          read,
          seen,
          hops + 1,
        ),
      )
    );
  }

  unknownPipeSuccessCarrier(
    reference: Reference,
    call: CallExpression,
    base: Expression,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { captures, module } = reference;
    const receiver = FactoryResolver.reference(module, base, captures);
    if (this.successCarrierRead(receiver, readModule, read, seen, hops + 1)) {
      return true;
    }
    return call.arguments.some((argument) => {
      const expression = argument.type === 'SpreadElement' ? argument.argument : argument;
      const transform = unwrap(expression);
      if (transform.type === 'CallExpression' && this.nativeEffectPipeableCall(module, transform)) {
        return this.pipeableSuccessCarrier(reference, transform, receiver, readModule, read, seen, hops + 1);
      }
      const target = this.function(module, expression);
      if (target === undefined) {
        return this.effectCarrierRead(
          FactoryResolver.reference(module, expression, captures),
          readModule,
          read,
          seen,
          hops + 1,
        );
      }
      const frame = FactoryResolver.captureCall(target.module, target.fn, [base], captures, module);
      return FactoryResolver.functionReturnValues(target.module, target.fn).some((returned) =>
        this.successCarrierRead(
          FactoryResolver.reference(target.module, returned, frame),
          readModule,
          read,
          seen,
          hops + 1,
        ),
      );
    });
  }
  identifierCarrierRead(
    reference: Reference,
    node: IdentifierReference,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { captures, module } = reference;
    const local = bindingAt(module, node.name, node);
    if (local === undefined || seen.has(local)) {
      return false;
    }
    const next = new Set(seen).add(local);
    const captured = captures.get(local);
    if (captured !== undefined) {
      return this.effectCarrierRead(captured, readModule, read, next, hops + 1);
    }
    if (this.nativeConfigSuccessBinding(module, node)) {
      return false;
    }
    const symbol = this.symbol(module, node) ?? { binding: local, module };
    if (symbol.binding.init !== undefined) {
      return this.effectCarrierRead(
        FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
        readModule,
        read,
        next,
        hops + 1,
      );
    }
    return this.parameterCarrierRead(module, local, readModule, read, next, hops);
  }
  parameterCarrierRead(
    module: Module,
    binding: Binding,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { parameter } = binding;
    if (parameter === undefined) {
      return false;
    }
    if (parameter.fn.params[parameter.index]?.type === 'RestElement') {
      return this.restParameterCarrierRead(module, binding, readModule, read, seen, hops);
    }
    for (const caller of this.callerModules(module, parameter.fn) ?? []) {
      for (const call of caller.calls) {
        if (
          parameter.index === 0 &&
          this.mappedParameterCarrier(caller, call, parameter.fn, readModule, read, seen, hops, binding)
        ) {
          return true;
        }
        if (this.function(caller, call.callee)?.fn === parameter.fn) {
          const argument = call.arguments[parameter.index];
          if (
            call.arguments.some((value) => value.type === 'SpreadElement') ||
            FactoryResolver.requiresFormalBinding(binding, call, caller)
          ) {
            const references = this.callFormalReferences(module, binding, call, caller);
            if (
              references === undefined ||
              references.some((reference) => this.effectCarrierRead(reference, readModule, read, seen, hops + 1))
            ) {
              return true;
            }
          }
          if (
            argument !== undefined &&
            argument.type !== 'SpreadElement' &&
            this.effectCarrierRead(
              FactoryResolver.reference(caller, argument, new Map()),
              readModule,
              read,
              seen,
              hops + 1,
            )
          ) {
            return true;
          }
        }
        if (
          parameter.index === 0 &&
          this.pipeParameterCarrier(caller, call, parameter.fn, readModule, read, seen, hops)
        ) {
          return true;
        }
      }
    }
    return false;
  }
  restParameterCarrierRead(
    module: Module,
    binding: Binding,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const vectors = this.closedRestBindingVectors(module, binding);
    return (
      vectors === undefined ||
      vectors.some((vector) => vector.some((value) => this.effectCarrierRead(value, readModule, read, seen, hops + 1)))
    );
  }
  mappedParameterCarrier(
    module: Module,
    call: CallExpression,
    fn: Implementation,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
    binding: Binding,
  ): boolean {
    const traversal = this.native(module, call.callee, 'Effect', 'forEach');
    if (!traversal && !['map', 'flatMap'].some((method) => this.native(module, call.callee, 'Effect', method))) {
      return false;
    }
    const callback = traversal ? call.arguments[1] : call.arguments.at(-1);
    const target =
      callback === undefined || callback.type === 'SpreadElement' ? undefined : this.function(module, callback);
    if (target === undefined || target.fn !== fn) {
      return false;
    }
    const [formal] = target.fn.params;
    if (traversal && formal?.type === 'ArrayPattern') {
      return true;
    }
    const [input] = call.arguments;
    if (traversal || call.arguments.length === 2) {
      if (input === undefined || input.type === 'SpreadElement') {
        return false;
      }
      const base = FactoryResolver.reference(module, input, new Map());
      return this.boundCallbackInputsCarry(
        target,
        base,
        traversal ? [base] : this.carrierSuccessValues(base),
        traversal,
        readModule,
        read,
        seen,
        hops,
        binding,
      );
    }
    if (call.arguments.length !== 1) {
      return false;
    }
    return module.calls.some((parent) => {
      const callee = unwrap(parent.callee);
      if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'pipe' || !parent.arguments.includes(call)) {
        return false;
      }
      const base = FactoryResolver.reference(module, callee.object, new Map());
      const values = this.carrierPipeSuccess(
        FactoryResolver.reference(module, parent, new Map()),
        parent,
        0,
        new Set(),
        call,
      );
      return this.boundCallbackInputsCarry(target, base, values, false, readModule, read, seen, hops, binding);
    });
  }
  boundCallbackInputsCarry(
    target: { readonly fn: Implementation; readonly module: Module },
    base: Reference,
    values: readonly Reference[] | undefined,
    mayBeUndefined: boolean,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
    binding: Binding,
  ): boolean {
    const [formal] = target.fn.params;
    if (formal === undefined) {
      return false;
    }
    const inputs: readonly Reference[] = values ?? [{ ...base, success: true }];
    return inputs.some((input) => {
      const references = this.callbackFormalReferences(target.module, binding, formal, input, mayBeUndefined);
      return (
        references === undefined ||
        references.some((reference) => this.effectCarrierRead(reference, readModule, read, seen, hops + 1))
      );
    });
  }
  callbackFormalReferences(
    module: Module,
    binding: Binding,
    formal: ParamPattern,
    input: Reference,
    mayBeUndefined: boolean,
  ): readonly Reference[] | undefined {
    if (formal.type !== 'ArrayPattern') {
      return FactoryResolver.formalValueReferences(module, formal, input, new Map(), mayBeUndefined);
    }
    if (
      !this.closedArrayIteratorCohort() ||
      formal.elements.some(
        (element) =>
          element !== null &&
          element.type !== 'Identifier' &&
          (element.type !== 'AssignmentPattern' || element.left.type !== 'Identifier'),
      )
    ) {
      return undefined;
    }
    const frame = new Map<Binding, Reference>();
    for (const [index, element] of formal.elements.entries()) {
      if (element === null) {
        continue;
      }
      const identifier = element.type === 'AssignmentPattern' ? element.left : element;
      if (identifier.type !== 'Identifier') {
        return undefined;
      }
      const actual = this.callbackArrayElement(input, index, new Set(), 0, binding);
      if (actual === undefined) {
        return undefined;
      }
      const values: Reference[] = [];
      for (const value of actual) {
        const bound = FactoryResolver.formalValueReferences(module, element, value, frame);
        if (bound === undefined) {
          return undefined;
        }
        values.push(...bound);
      }
      const target = bindingAt(module, identifier.name, identifier);
      if (target === binding) {
        return values;
      }
      if (target === undefined || values.length > 1) {
        return undefined;
      }
      const [value] = values;
      if (value !== undefined) {
        frame.set(target, value);
      }
    }
    return undefined;
  }
  callbackArrayElement(
    input: Reference,
    index: number,
    seen: Set<Binding>,
    hops: number,
    target: Binding,
  ): readonly (Reference | undefined)[] | undefined {
    if (hops >= budget || !FactoryResolver.eagerTupleProducerClosed(input, target)) {
      return undefined;
    }
    if (input.elements !== undefined) {
      return [input.elements[index]];
    }
    const node = unwrap(input.expression);
    if (input.success) {
      const values = this.carrierSuccessValues(input);
      if (values === undefined) {
        return undefined;
      }
      const result: (Reference | undefined)[] = [];
      for (const value of values) {
        const projected = this.callbackArrayElement(value, index, seen, hops + 1, target);
        if (projected === undefined) {
          return undefined;
        }
        result.push(...projected);
      }
      return result;
    }
    if (
      node.type === 'ArrayExpression' &&
      node.elements.every((value) => value !== null && value.type !== 'SpreadElement')
    ) {
      const value = node.elements[index];
      return [value === undefined ? undefined : FactoryResolver.reference(input.module, value, input.captures)];
    }
    if (node.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(input.module, node.name, node);
    if (
      binding === undefined ||
      seen.has(binding) ||
      !stable(input.module, binding) ||
      !this.callbackTupleBindingClosed(input.module, binding, node)
    ) {
      return undefined;
    }
    const value =
      input.captures.get(binding) ??
      (binding.init === undefined ? undefined : FactoryResolver.reference(input.module, binding.init, input.captures));
    return value === undefined
      ? undefined
      : this.callbackArrayElement(
          { ...value, eagerProducer: input.eagerProducer ?? value.eagerProducer },
          index,
          new Set(seen).add(binding),
          hops + 1,
          target,
        );
  }
  static eagerTupleProducerClosed(input: Reference, target: Binding): boolean {
    const producer = input.eagerProducer;
    if (producer === undefined) {
      return true;
    }
    if (!producer.module.bindings.includes(target)) {
      return false;
    }
    const owner = FactoryResolver.nearestFunction(producer.module, producer.expression);
    const callback = target.parameter?.fn;
    const parent =
      callback === undefined ? undefined : FactoryResolver.nearestFunction(producer.module, callback, callback);
    if (owner === undefined || owner !== parent || !owner.generator) {
      return false;
    }
    const stored = producer.module.bindings.some(
      (binding) =>
        binding.init !== undefined &&
        unwrap(binding.init).type !== 'YieldExpression' &&
        FactoryResolver.nearestFunction(producer.module, binding.node) === owner &&
        inside(producer.expression, binding.init),
    );
    const escaped = producer.module.escapes.some(
      (value) =>
        inside(producer.expression, value) && FactoryResolver.nearestFunction(producer.module, value) === owner,
    );
    const returned = FactoryResolver.functionReturnValues(producer.module, owner).some(
      (value) => unwrap(value).type !== 'YieldExpression' && inside(producer.expression, value),
    );
    return !stored && !escaped && !returned;
  }
  static nearestFunction(module: Module, span: Span, exclude?: Implementation): Implementation | undefined {
    let selected: Implementation | undefined;
    for (const fn of module.functions) {
      if (
        fn !== exclude &&
        inside(span, fn) &&
        (selected === undefined || fn.end - fn.start < selected.end - selected.start)
      ) {
        selected = fn;
      }
    }
    return selected;
  }
  callbackTupleBindingClosed(module: Module, binding: Binding, reference: IdentifierReference): boolean {
    const allocation = FactoryResolver.nearestFunction(module, binding.node);
    if (
      allocation === undefined ||
      allocation !== FactoryResolver.nearestFunction(module, reference) ||
      !FactoryResolver.functionReturnValues(module, allocation).some((value) => unwrap(value) === reference) ||
      !this.objectCustody(module, binding, '', new Set())
    ) {
      return false;
    }
    let closed = true;
    new Visitor({
      Identifier(node) {
        if (
          node !== binding.node &&
          node !== reference &&
          node.name === binding.name &&
          bindingAt(module, node.name, node) === binding
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  pipeParameterCarrier(
    module: Module,
    call: CallExpression,
    fn: Implementation,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const callee = unwrap(call.callee);
    if (
      callee.type === 'MemberExpression' &&
      propertyName(callee) === 'pipe' &&
      call.arguments.some((arg) => arg.type !== 'SpreadElement' && this.function(module, arg)?.fn === fn)
    ) {
      return this.effectCarrierRead(
        FactoryResolver.reference(module, callee.object, new Map()),
        readModule,
        read,
        seen,
        hops + 1,
      );
    }
    const nativeFn =
      this.native(module, callee, 'Effect', 'fn') ||
      (callee.type === 'CallExpression' && this.native(module, callee.callee, 'Effect', 'fn'));
    const [body, ...transforms] = call.arguments;
    return (
      nativeFn &&
      body !== undefined &&
      body.type !== 'SpreadElement' &&
      functionValue(body) !== undefined &&
      transforms.some((arg) => arg.type !== 'SpreadElement' && this.function(module, arg)?.fn === fn) &&
      this.effectContainsRead(module, body, readModule, read, new Set(), 0)
    );
  }
  nativeEffectCallRole(module: Module, call: CallExpression, hops = 0): NativeEffectCallRole | undefined {
    if (hops >= budget) {
      return 'unknown';
    }
    const callee = unwrap(call.callee);
    if (callee.type === 'CallExpression' && this.nativeEffectCallRole(module, callee, hops + 1) === 'pipeable') {
      return call.arguments.length === 1 ? 'effect' : 'unknown';
    }
    if (this.nativeEffectFnBody(module, call) !== undefined || this.native(module, call.callee, 'Effect', 'fn')) {
      return 'callable';
    }
    if (this.native(module, call.callee, 'Effect', 'forEach')) {
      return this.nativeForEachRole(module, call);
    }
    if (
      ['provideContext', 'provideServices'].some((method) => this.nativeContextProvider(module, call.callee, method))
    ) {
      if (call.arguments.length === 2) {
        return 'effect';
      }
      return call.arguments.length === 1 ? 'pipeable' : 'unknown';
    }
    for (const [method, arities] of nativeEffectCallArities) {
      if (this.native(module, call.callee, 'Effect', method)) {
        if (call.arguments.some((arg) => arg.type === 'SpreadElement')) {
          return 'unknown';
        }
        if (arities.effect.includes(call.arguments.length)) {
          return 'effect';
        }
        return arities.pipeable.includes(call.arguments.length) ? 'pipeable' : 'unknown';
      }
    }
    return undefined;
  }
  nativeForEachRole(module: Module, call: CallExpression): NativeEffectCallRole {
    const [first, second] = call.arguments;
    if (second !== undefined && second.type !== 'SpreadElement' && this.function(module, second) !== undefined) {
      return call.arguments.length === 2 || call.arguments.length === 3 ? 'effect' : 'unknown';
    }
    return first !== undefined &&
      first.type !== 'SpreadElement' &&
      this.function(module, first) !== undefined &&
      (call.arguments.length === 1 || call.arguments.length === 2)
      ? 'pipeable'
      : 'unknown';
  }
  nativeEffectPipeableCall(module: Module, call: CallExpression): boolean {
    return this.nativeEffectCallRole(module, call) === 'pipeable';
  }
  nativeEffectValueCall(module: Module, call: CallExpression): boolean {
    return this.nativeEffectCallRole(module, call) === 'effect';
  }
  nativeCarrierRead(
    reference: Reference,
    call: CallExpression,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean | undefined {
    const { captures, module } = reference;
    const role = this.nativeEffectCallRole(module, call);
    if (role === 'unknown') {
      return true;
    }
    if (role === 'pipeable' || role === 'callable') {
      const body = this.nativeEffectFnBody(module, call);
      return (
        (body !== undefined && this.effectContainsRead(module, body, readModule, read, new Set(), 0)) ||
        call.arguments.some((argument) =>
          this.argumentCarrierRead(
            FactoryResolver.reference(
              module,
              argument.type === 'SpreadElement' ? argument.argument : argument,
              captures,
            ),
            readModule,
            read,
            seen,
            hops + 1,
          ),
        )
      );
    }
    if (this.nativeEffectValueCall(module, call)) {
      return this.effectContainsRead(module, call, readModule, read, new Set(), 0);
    }
    return undefined;
  }
  configProviderOrigin(reference: Reference, seen = new Set<Binding>(), hops = 0): RetainedConfigRoot {
    if (hops >= budget) {
      return false;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'CallExpression') {
      return this.configProviderCallOrigin(reference, node, seen, hops);
    }
    if (node.type === 'MemberExpression') {
      const projected = this.carrierProjection(reference, node, new Set(), hops + 1);
      return projected?.some((value) => this.configProviderOrigin(value, seen, hops + 1) !== undefined) === true ||
        this.configProviderOrigin(FactoryResolver.reference(module, node.object, captures), seen, hops + 1) !==
          undefined
        ? false
        : undefined;
    }
    const children = FactoryResolver.effectContainerChildren(node);
    if (children.length > 0) {
      return children.some(
        (value) =>
          this.configProviderOrigin(FactoryResolver.reference(module, value, captures), seen, hops + 1) !== undefined,
      ) ||
        module.calls.some(
          (call) => inside(call, node) && this.native(module, call.callee, 'ConfigProvider', 'fromUnknown'),
        )
        ? false
        : undefined;
    }
    if (node.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(module, node.name, node);
    if (binding === undefined) {
      return undefined;
    }
    return this.configProviderBindingOrigin(reference, binding, seen, hops);
  }
  configProviderCallOrigin(
    reference: Reference,
    node: CallExpression,
    seen: Set<Binding>,
    hops: number,
  ): RetainedConfigRoot {
    const { captures, module } = reference;
    if (this.native(module, node.callee, 'ConfigProvider', 'fromUnknown')) {
      const [root] = node.arguments;
      return !node.optional && node.arguments.length === 1 && root !== undefined && root.type !== 'SpreadElement'
        ? FactoryResolver.reference(module, root, captures)
        : false;
    }
    const callee = unwrap(node.callee);
    if (
      callee.type === 'MemberExpression' &&
      this.configProviderOrigin(FactoryResolver.reference(module, callee.object, captures), seen, hops + 1) !==
        undefined
    ) {
      // Unknown or mutated methods cannot establish that the retained root is absent.
      return false;
    }
    return node.arguments.some(
      (argument) =>
        this.configProviderOrigin(
          FactoryResolver.reference(module, argument.type === 'SpreadElement' ? argument.argument : argument, captures),
          seen,
          hops + 1,
        ) !== undefined,
    )
      ? false
      : this.configProviderReturnedOrigin(reference, node, seen, hops);
  }
  configProviderReturnedOrigin(
    reference: Reference,
    call: CallExpression,
    seen: Set<Binding>,
    hops: number,
  ): RetainedConfigRoot {
    const { captures, module } = reference;
    const target =
      this.function(module, call.callee, 0, captures) ?? this.consumerDataCallableSource(module, call, captures);
    if (target === undefined) {
      return undefined;
    }
    const source = { ...target, captures: target.captures ?? captures };
    const returned = FactoryResolver.functionReturnValues(source.module, source.fn);
    const frames = FactoryResolver.consumerDataCallFrames(module, call, source, captures);
    if (frames === undefined) {
      // An unsupported binding can still retain a known origin; it supplies no substitute execution frame.
      const defaults = source.fn.params.flatMap((parameter) =>
        parameter.type === 'AssignmentPattern' ? [parameter.right] : [],
      );
      return [...returned, ...defaults].some(
        (value) =>
          this.configProviderOrigin(
            FactoryResolver.reference(source.module, value, source.captures),
            seen,
            hops + 1,
          ) !== undefined,
      )
        ? false
        : undefined;
    }
    return frames.some((frame) =>
      returned.some(
        (value) =>
          this.configProviderOrigin(FactoryResolver.reference(source.module, value, frame), seen, hops + 1) !==
          undefined,
      ),
    )
      ? false
      : undefined;
  }
  configProviderBindingOrigin(
    reference: Reference,
    binding: Binding,
    seen: Set<Binding>,
    hops: number,
  ): RetainedConfigRoot {
    const { captures, module } = reference;
    if (seen.has(binding)) {
      return false;
    }
    const next = new Set(seen).add(binding);
    const captured = captures.get(binding);
    const initial =
      captured ?? (binding.init === undefined ? undefined : FactoryResolver.reference(module, binding.init, captures));
    const origin = initial === undefined ? undefined : this.configProviderOrigin(initial, next, hops + 1);
    if (origin !== undefined || stable(module, binding)) {
      return origin;
    }
    let assigned = false;
    new Visitor({
      AssignmentExpression: (assignment) => {
        if (
          (assignment.left.type === 'Identifier' || assignment.left.type === 'MemberExpression') &&
          rootedAtBinding(module, assignment.left, binding) &&
          this.configProviderOrigin(FactoryResolver.reference(module, assignment.right, captures), next, hops + 1) !==
            undefined
        ) {
          assigned = true;
        }
      },
    }).visit(module.program);
    return assigned ? false : undefined;
  }
  callCarrierRead(
    reference: Reference,
    call: CallExpression,
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): boolean {
    const { captures, module } = reference;
    const callee = unwrap(call.callee);
    if (
      callee.type === 'MemberExpression' &&
      this.configProviderOrigin(FactoryResolver.reference(module, callee.object, captures)) !== undefined
    ) {
      return true;
    }
    if (this.nativeStringArgument(module, call) !== undefined) {
      return false;
    }
    const native = this.nativeCarrierRead(reference, call, readModule, read, seen, hops);
    if (native !== undefined) {
      return native;
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return this.effectCarrierRead(
        FactoryResolver.reference(module, callee.object, captures),
        readModule,
        read,
        seen,
        hops + 1,
      );
    }
    const ordinary = this.function(module, callee, 0, captures);
    const source = ordinary === undefined ? this.consumerDataCallableSource(module, call, captures) : undefined;
    if (source !== undefined && !FactoryResolver.consumerExplicitSource(source)) {
      return true;
    }
    const target = ordinary ?? source;
    if (target === undefined) {
      if (this.consumerServiceSource(module, call, captures) !== undefined) {
        return true;
      }
      return call.arguments.some((argument) =>
        this.argumentCarrierRead(
          FactoryResolver.reference(module, argument.type === 'SpreadElement' ? argument.argument : argument, captures),
          readModule,
          read,
          seen,
          hops + 1,
        ),
      );
    }
    const frames =
      source === undefined ? undefined : FactoryResolver.consumerDataCallFrames(module, call, source, captures);
    if (source !== undefined && frames === undefined) {
      return true;
    }
    return this.resolvedCallCarrierRead(reference, call, target, readModule, read, seen, hops, frames);
  }
  resolvedCallCarrierRead(
    reference: Reference,
    call: CallExpression,
    target: { readonly captures?: Captures; readonly fn: Implementation; readonly module: Module },
    readModule: Module,
    read: Span,
    seen: Set<Binding | Implementation>,
    hops: number,
    sourceFrames?: readonly Captures[],
  ): boolean {
    const { captures, module } = reference;
    const callee = unwrap(call.callee);
    if (target.captures !== undefined && call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return true;
    }
    if (target.fn.async || seen.has(target.fn)) {
      return false;
    }
    const nativeFn = callee.type === 'CallExpression' && this.nativeEffectValueCall(module, callee);
    const init = callee.type === 'Identifier' ? this.symbol(module, callee)?.binding.init : callee;
    const initializer = init === undefined ? undefined : unwrap(init);
    const fnConstructor = initializer?.type === 'CallExpression' ? unwrap(initializer.callee) : undefined;
    if (
      target.fn.generator &&
      (nativeFn ||
        (fnConstructor !== undefined &&
          (this.native(target.module, fnConstructor, 'Effect', 'fn') ||
            (fnConstructor.type === 'CallExpression' &&
              this.native(target.module, fnConstructor.callee, 'Effect', 'fn')))))
    ) {
      return this.effectContainsRead(target.module, target.fn, readModule, read, new Set(), 0);
    }
    const args = call.arguments.filter((arg) => arg.type !== 'SpreadElement');
    const frames = sourceFrames ?? [
      FactoryResolver.captureCall(target.module, target.fn, args, captures, module, target.captures),
    ];
    return frames.some((frame) =>
      FactoryResolver.functionReturnValues(target.module, target.fn).some((expression) =>
        this.effectCarrierRead(
          FactoryResolver.reference(target.module, expression, frame),
          readModule,
          read,
          new Set(seen).add(target.fn),
          hops + 1,
        ),
      ),
    );
  }
  static carrierProjectionKey(node: Expression): string | undefined {
    if (node.type !== 'MemberExpression') {
      return undefined;
    }
    if (!node.computed && node.property.type === 'Identifier') {
      return node.property.name;
    }
    return node.property.type === 'Literal' ? String(node.property.value) : undefined;
  }
  static carrierLiteralProjection(reference: Reference, key: string | undefined): readonly Reference[] | undefined {
    const node = unwrap(reference.expression);
    if (node.type === 'ObjectExpression') {
      const field = key === undefined ? undefined : ownDataFields(node)?.get(key);
      return field === undefined
        ? undefined
        : [
            {
              ...FactoryResolver.reference(reference.module, field, reference.captures),
              eagerProducer: reference.eagerProducer,
            },
          ];
    }
    if (node.type === 'ArrayExpression') {
      if (key === undefined || !/^(?:0|[1-9]\d*)$/u.test(key)) {
        return undefined;
      }
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index >= node.elements.length ||
        node.elements.some((element) => element === null || element.type === 'SpreadElement')
      ) {
        return undefined;
      }
      const element = node.elements[index];
      return element === undefined || element === null || element.type === 'SpreadElement'
        ? undefined
        : [
            {
              ...FactoryResolver.reference(reference.module, element, reference.captures),
              eagerProducer: reference.eagerProducer,
            },
          ];
    }
    return [];
  }
  memberProjectionBindingClosed(
    module: Module,
    binding: Binding,
    tuple: boolean,
    handoffs: ReadonlySet<Span>,
  ): boolean {
    if (!stable(module, binding) || !this.objectCustody(module, binding, '', new Set())) {
      return false;
    }
    const callees = new Set<Span>(module.calls.map((call) => unwrap(call.callee)));
    new Visitor({
      NewExpression(node) {
        callees.add(unwrap(node.callee));
      },
      TaggedTemplateExpression(node) {
        callees.add(unwrap(node.tag));
      },
    }).visit(module.program);
    const allowed = new Set<Span>([binding.node, ...handoffs]);
    new Visitor({
      BinaryExpression(node) {
        if (tuple || !['===', '!=='].includes(node.operator)) {
          return;
        }
        const left = unwrap(node.left);
        const right = unwrap(node.right);
        for (const [value, other] of [
          [left, right],
          [right, left],
        ]) {
          if (
            value?.type === 'Identifier' &&
            bindingAt(module, value.name, value) === binding &&
            other?.type === 'Identifier' &&
            other.name === 'undefined' &&
            bindingAt(module, other.name, other) === undefined
          ) {
            allowed.add(value);
          }
        }
      },
      MemberExpression: (node) => {
        const object = unwrap(node.object);
        if (
          object.type === 'Identifier' &&
          bindingAt(module, object.name, object) === binding &&
          this.bindingPath(module, node, binding) !== undefined &&
          (!tuple ||
            (node.computed &&
              node.property.type === 'Literal' &&
              /^(?:0|[1-9]\d*)$/u.test(String(node.property.value)))) &&
          !callees.has(node)
        ) {
          allowed.add(object);
        }
      },
    }).visit(module.program);
    let closed = true;
    new Visitor({
      Identifier(node) {
        if (node.name === binding.name && bindingAt(module, node.name, node) === binding && !allowed.has(node)) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  static projectionAliasHandoff(
    previous: ProjectionOrigin['bindings'][number] | undefined,
    current: Reference,
    node: IdentifierReference,
  ): boolean {
    return (
      previous !== undefined &&
      previous.module === current.module &&
      previous.binding.init !== undefined &&
      unwrap(previous.binding.init) === node
    );
  }
  nestedProjectionOrigin(reference: Reference, node: Expression, hops: number): Reference | undefined {
    if (hops >= budget || node.type !== 'MemberExpression') {
      return undefined;
    }
    let receiver = false;
    new Visitor({
      MemberExpression(parent) {
        if (unwrap(parent.object) === node) {
          receiver = true;
        }
      },
    }).visit(reference.module.program);
    if (!receiver) {
      return undefined;
    }
    const object = unwrap(node.object);
    if (object.type === 'Identifier') {
      const binding = bindingAt(reference.module, object.name, object);
      const owner = binding === undefined ? undefined : FactoryResolver.nearestFunction(reference.module, binding.node);
      if (
        binding === undefined ||
        owner === undefined ||
        owner !== FactoryResolver.nearestFunction(reference.module, object) ||
        !this.memberProjectionBindingClosed(reference.module, binding, false, new Set())
      ) {
        return undefined;
      }
      let unique = true;
      new Visitor({
        Identifier(value) {
          if (
            value !== binding.node &&
            value !== object &&
            value.name === binding.name &&
            bindingAt(reference.module, value.name, value) === binding
          ) {
            unique = false;
          }
        },
      }).visit(reference.module.program);
      if (!unique) {
        return undefined;
      }
    }
    const values = this.carrierProjection(reference, node, new Set(), hops + 1);
    return values?.length === 1 ? values[0] : undefined;
  }
  static conflictingProjectionProducers(left: Reference, right: Reference): boolean {
    return (
      left.eagerProducer !== undefined &&
      right.eagerProducer !== undefined &&
      left.eagerProducer !== right.eagerProducer
    );
  }
  projectionOrigin(
    input: Reference,
    first: readonly { readonly binding: Binding; readonly module: Module }[],
    hops: number,
  ): ProjectionOrigin | undefined {
    const bindings = [...first];
    let previous = first.at(-1);
    const handoffs = new Set<Span>();
    const seen = new Set<Binding>();
    let current = input;
    for (let depth = hops; depth < budget; depth += 1) {
      const node = unwrap(current.expression);
      if (node.type === 'MemberExpression') {
        const selected = this.nestedProjectionOrigin(current, node, depth + 1);
        if (selected === undefined) {
          return undefined;
        }
        current = selected;
        continue;
      }
      if (node.type !== 'Identifier') {
        return node.type === 'ArrayExpression' || node.type === 'ObjectExpression'
          ? { bindings, handoffs, reference: current }
          : undefined;
      }
      const local = bindingAt(current.module, node.name, node);
      if (local === undefined || seen.has(local) || !stable(current.module, local)) {
        return undefined;
      }
      seen.add(local);
      bindings.push({ binding: local, module: current.module });
      if (FactoryResolver.projectionAliasHandoff(previous, current, node)) {
        handoffs.add(node);
      }
      const captured = current.captures.get(local);
      const symbol = this.symbol(current.module, node);
      if (symbol !== undefined && symbol.binding !== local) {
        bindings.push(symbol);
      }
      const value =
        captured ??
        (symbol?.binding.init === undefined
          ? undefined
          : FactoryResolver.reference(symbol.module, symbol.binding.init, current.captures));
      if (value === undefined || FactoryResolver.conflictingProjectionProducers(current, value)) {
        return undefined;
      }
      previous = symbol ?? { binding: local, module: current.module };
      current = { ...value, eagerProducer: current.eagerProducer ?? value.eagerProducer };
    }
    return undefined;
  }
  resolvedProjection(
    origin: ProjectionOrigin | undefined,
    key: string | undefined,
    target?: Binding,
  ): readonly Reference[] | undefined {
    if (origin === undefined) {
      return undefined;
    }
    const tuple = unwrap(origin.reference.expression).type === 'ArrayExpression';
    if (
      !origin.bindings.every((value) =>
        this.memberProjectionBindingClosed(value.module, value.binding, tuple, origin.handoffs),
      )
    ) {
      return undefined;
    }
    const binding = target ?? origin.bindings[0]?.binding;
    if (
      origin.reference.eagerProducer !== undefined &&
      (binding === undefined || !FactoryResolver.eagerTupleProducerClosed(origin.reference, binding))
    ) {
      return undefined;
    }
    return FactoryResolver.carrierLiteralProjection(origin.reference, key);
  }
  carrierProjection(
    reference: Reference,
    node: Expression,
    seen: Set<Binding | Implementation>,
    hops: number,
  ): readonly Reference[] | undefined {
    const rest = this.restCarrierProjection(reference, node);
    if (rest !== undefined) {
      return rest;
    }
    const key = FactoryResolver.carrierProjectionKey(node);
    if (hops >= budget || node.type !== 'MemberExpression') {
      return undefined;
    }
    const object = unwrap(node.object);
    if (object.type !== 'Identifier') {
      const origin = this.projectionOrigin(
        FactoryResolver.reference(reference.module, object, reference.captures),
        [],
        hops + 1,
      );
      return this.resolvedProjection(origin, key);
    }
    const binding = bindingAt(reference.module, object.name, object);
    const captured = binding === undefined ? undefined : reference.captures.get(binding);
    const symbol = this.symbol(reference.module, object);
    const input =
      captured ??
      (symbol?.binding.init === undefined
        ? undefined
        : FactoryResolver.reference(symbol.module, symbol.binding.init, reference.captures));
    if (binding === undefined || seen.has(binding) || input === undefined) {
      return undefined;
    }
    const initial = [{ binding, module: reference.module }];
    if (captured === undefined && symbol !== undefined && symbol.binding !== binding) {
      initial.push(symbol);
    }
    const origin = this.projectionOrigin(input, initial, hops + 1);
    return this.resolvedProjection(origin, key, binding);
  }
  static functionReturnValues(module: Module, fn: Implementation): readonly Expression[] {
    const facts =
      FactoryResolver.functionReturnFacts.get(module.program) ?? new WeakMap<Implementation, readonly Expression[]>();
    const cached = facts.get(fn);
    if (cached !== undefined) {
      return cached;
    }
    const values = FactoryResolver.collectFunctionReturnValues(module, fn);
    facts.set(fn, values);
    FactoryResolver.functionReturnFacts.set(module.program, facts);
    return values;
  }
  static collectFunctionReturnValues(module: Module, fn: Implementation): readonly Expression[] {
    if (fn.body === null) {
      return [];
    }
    if (fn.body.type !== 'BlockStatement') {
      return [fn.body];
    }
    const nested = module.functions.filter((value) => value !== fn && inside(value, fn));
    const values: Expression[] = [];
    new Visitor({
      ReturnStatement(node) {
        if (node.argument !== null && inside(node, fn) && !nested.some((value) => inside(node, value))) {
          values.push(node.argument);
        }
      },
    }).visit(module.program);
    return values;
  }
  nativeMinimumOneCheck(module: Module, check: CallExpression): boolean {
    const [filter] = check.arguments;
    const minimum = filter?.type === 'CallExpression' ? filter.arguments[0] : undefined;
    return (
      filter?.type === 'CallExpression' &&
      filter.arguments.length === 1 &&
      this.native(module, filter.callee, 'Schema', 'isMinLength') &&
      minimum?.type === 'Literal' &&
      minimum.value === 1
    );
  }
  nativeTrimSchemaConstruction(module: Module, input: Expression): boolean {
    const node = unwrap(input);
    if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) {
      return false;
    }
    const callee = unwrap(node.callee);
    const [check] = node.arguments;
    if (
      callee.type !== 'MemberExpression' ||
      propertyName(callee) !== 'pipe' ||
      !this.native(module, callee.object, 'Schema', 'Trim') ||
      check?.type !== 'CallExpression' ||
      check.arguments.length !== 1 ||
      !this.native(module, check.callee, 'Schema', 'check')
    ) {
      return false;
    }
    if (!this.nativeMinimumOneCheck(module, check)) {
      return false;
    }
    const declaration = bindingSyntax(module).initialized.find(
      (binding) => binding.init !== undefined && unwrap(binding.init) === node,
    );
    if (declaration === undefined || declaration.kind !== 'const' || !this.schemaCustody(module, declaration)) {
      return false;
    }
    return this.nativeSchemaConstantCustody();
  }
  nativeSchemaConstantCustody(method = 'Trim'): boolean {
    for (const consumer of this.modules.values()) {
      for (const binding of consumer.bindings) {
        const { origin } = binding;
        if (
          origin?.imported === 'Schema' &&
          FactoryResolver.nativeSource(origin.source, 'Schema') &&
          !this.objectCustody(consumer, binding, method, new Set(), false, true)
        ) {
          return false;
        }
      }
    }
    return true;
  }
  nativeServiceFreeStructConstruction(module: Module, call: CallExpression): boolean {
    const binding = bindingSyntax(module).initialized.find(
      (value) => value.init !== undefined && unwrap(value.init) === call,
    );
    return (
      binding !== undefined &&
      this.nativeServiceFreeStructBinding(module, binding) &&
      this.schemaCustody(module, binding)
    );
  }
  nativeServiceFreeStructBinding(module: Module, binding: Binding): boolean {
    if (binding.origin !== undefined) {
      const target = this.dependency(module, binding.origin.source);
      const symbol = target === undefined ? undefined : this.exportedSymbol(target, binding.origin.imported, new Set());
      return symbol !== undefined && this.nativeServiceFreeStructBinding(symbol.module, symbol.binding);
    }
    const init = binding.init === undefined ? undefined : unwrap(binding.init);
    return (
      stable(module, binding) &&
      init?.type === 'CallExpression' &&
      !init.optional &&
      init.arguments.length === 1 &&
      this.native(module, init.callee, 'Schema', 'Struct') &&
      this.producerServiceFreeSchema(module, binding)
    );
  }
  nativeSchemaEquivalence(module: Module, call: CallExpression): boolean {
    const [schema] = call.arguments;
    return (
      call.arguments.length === 1 &&
      schema !== undefined &&
      schema.type !== 'SpreadElement' &&
      this.native(module, call.callee, 'Schema', 'toEquivalence') &&
      this.isServiceFreeSchema({ expression: schema, file: module.file })
    );
  }
  comparatorServiceFields(
    module: Module,
    call: CallExpression,
  ): { readonly fields: ReadonlyMap<string, Expression>; readonly tag: Binding } | undefined {
    const [tag, value] = call.arguments;
    if (
      call.optional ||
      call.arguments.length !== 2 ||
      tag === undefined ||
      tag.type === 'SpreadElement' ||
      value?.type !== 'ObjectExpression' ||
      !this.native(module, call.callee, 'Layer', 'succeed')
    ) {
      return undefined;
    }
    const binding = this.tag(module, tag);
    const fields = ownDataFields(value);
    return binding === undefined || fields === undefined ? undefined : { fields, tag: binding };
  }
  comparatorOwnedMethod(module: Module, fn: Implementation, root: Module): ComparatorMethodFrame | undefined {
    const matches: { call: CallExpression; name: string; tag: Binding }[] = [];
    for (const call of module.calls) {
      const service = this.comparatorServiceFields(module, call);
      if (service === undefined) {
        continue;
      }
      for (const [name, field] of service.fields) {
        if (this.function(module, field)?.fn === fn) {
          matches.push({ call, name, tag: service.tag });
        }
      }
    }
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) {
      return undefined;
    }
    const installed = this.comparatorRootProviders(root, match.tag);
    if (installed === undefined || installed.length > 1) {
      return undefined;
    }
    const [mounted] = installed;
    const local = mounted === undefined ? this.comparatorOptionalProvider(root, match.tag, match.call) : undefined;
    const provider = mounted ?? local?.provider;
    if (provider?.call !== match.call) {
      return undefined;
    }
    const method = { captures: provider.frame.captures, fn, module, name: match.name, tag: match.tag };
    return local === undefined ? method : { ...method, layer: local.layer };
  }
  comparatorRootProviders(root: Module, tag: Binding): readonly LayerCandidate[] | undefined {
    const fixed = this.currentFixedOutputs;
    try {
      const mounted = this.mounted(root);
      return this.currentFixedOutputs.has(this.tagKeys.get(tag) ?? '')
        ? undefined
        : this.providerCandidates(mounted, tag, true);
    } finally {
      this.currentFixedOutputs = fixed;
    }
  }
  comparatorLayerProviders(reference: Reference, tag: Binding): readonly LayerCandidate[] | undefined {
    const fixed = this.currentFixedOutputs;
    this.currentFixedOutputs = new Set();
    try {
      if (!this.closedLayer(reference, new Set(), 0)) {
        return undefined;
      }
      const local = new Set<CallExpression>();
      if (!this.layers(reference, local, new Set(), 0) || this.currentFixedOutputs.has(this.tagKeys.get(tag) ?? '')) {
        return undefined;
      }
      return this.providerCandidates(local, tag, true);
    } finally {
      this.currentFixedOutputs = fixed;
    }
  }
  comparatorExportedLayer(root: Module, local: string | NonNullable<Binding['origin']>): Reference | undefined {
    if (!Schema.is(Schema.String)(local)) {
      return undefined;
    }
    const binding = root.bindings.find((value) => value.name === local && value.scope === root.program);
    if (binding?.init === undefined || !stable(root, binding)) {
      return undefined;
    }
    const layer = FactoryResolver.reference(root, binding.init, new Map());
    return this.layerValueRole(layer, new Set(), 0) ? layer : undefined;
  }
  comparatorOptionalProvider(
    root: Module,
    tag: Binding,
    call: CallExpression,
  ): { readonly layer: Reference; readonly provider: LayerCandidate } | undefined {
    const matches: { layer: Reference; provider: LayerCandidate }[] = [];
    for (const local of root.exports.values()) {
      const layer = this.comparatorExportedLayer(root, local);
      if (layer === undefined) {
        continue;
      }
      const candidates = this.comparatorLayerProviders(layer, tag);
      const [provider] = candidates ?? [];
      if (candidates === undefined || candidates.length > 1 || (provider !== undefined && provider.call !== call)) {
        return undefined;
      }
      if (provider !== undefined) {
        if (!this.layerDependencyCompatible(layer, tag, provider)) {
          return undefined;
        }
        matches.push({ layer, provider });
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  comparatorYieldedTag(module: Module, binding: Binding): Binding | undefined {
    const acquired = binding.init === undefined ? undefined : unwrap(binding.init);
    return acquired?.type === 'YieldExpression' && acquired.delegate && acquired.argument !== null
      ? this.tag(module, acquired.argument)
      : undefined;
  }
  static comparatorReceiverCall(module: Module, call: CallExpression, binding: Binding): boolean {
    const callee = unwrap(call.callee);
    return (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      bindingAt(module, callee.object.name, callee.object) === binding
    );
  }
  comparatorMethodCalls(
    method: ComparatorMethodFrame,
  ): readonly { readonly call: CallExpression; readonly frame: Captures; readonly module: Module }[] | undefined {
    const result: { call: CallExpression; frame: Captures; module: Module }[] = [];
    for (const module of this.modules.values()) {
      for (const binding of module.bindings) {
        if (this.comparatorYieldedTag(module, binding) !== method.tag) {
          continue;
        }
        if (!this.objectCustody(module, binding, '', new Set())) {
          return undefined;
        }
        for (const call of module.calls) {
          const callee = unwrap(call.callee);
          if (!FactoryResolver.comparatorReceiverCall(module, call, binding)) {
            continue;
          }
          if (
            call.optional ||
            callee.type !== 'MemberExpression' ||
            callee.optional ||
            callee.computed ||
            propertyName(callee) !== method.name ||
            call.arguments.length !== 1 ||
            call.arguments.some((argument) => argument.type === 'SpreadElement')
          ) {
            return undefined;
          }
          result.push({
            call,
            frame: FactoryResolver.captureCall(
              method.module,
              method.fn,
              call.arguments.filter((argument) => argument.type !== 'SpreadElement'),
              new Map(),
              module,
              method.captures,
            ),
            module,
          });
        }
      }
    }
    return result.length === 0 ? undefined : result;
  }
  comparatorProvidedValue(
    module: Module,
    invocation: CallExpression,
    tag: Binding,
    captures: Captures,
  ): Reference | undefined {
    const values: Reference[] = [];
    for (const parent of module.calls) {
      const callee = unwrap(parent.callee);
      if (
        callee.type !== 'MemberExpression' ||
        propertyName(callee) !== 'pipe' ||
        unwrap(callee.object) !== invocation
      ) {
        continue;
      }
      for (const argument of parent.arguments) {
        if (argument.type === 'SpreadElement') {
          return undefined;
        }
        const transform = unwrap(argument);
        if (
          transform.type !== 'CallExpression' ||
          transform.optional ||
          transform.arguments.length !== 2 ||
          !this.native(module, transform.callee, 'Effect', 'provideService')
        ) {
          if (
            ['provideServices', 'provideContext'].some((method) =>
              this.nativeContextProvider(
                module,
                transform.type === 'CallExpression' ? transform.callee : transform,
                method,
              ),
            ) ||
            !this.preservingEffectOperator(module, argument)
          ) {
            return undefined;
          }
          continue;
        }
        const [provided, value] = transform.arguments;
        if (
          provided === undefined ||
          provided.type === 'SpreadElement' ||
          value === undefined ||
          value.type === 'SpreadElement' ||
          this.tag(module, provided) !== tag
        ) {
          return undefined;
        }
        values.push(FactoryResolver.reference(module, value, captures));
      }
    }
    return values.length === 1 ? values[0] : undefined;
  }
  comparatorDefaultSchema(module: Module, expression: Expression): Binding | undefined {
    const symbol = this.symbol(module, expression);
    if (symbol === undefined || !this.isServiceFreeSchema({ expression, file: module.file })) {
      return undefined;
    }
    const source = this.sources.get(symbol.module.file);
    const exported = [...symbol.module.exports].find(([, local]) => local === symbol.binding.name)?.[0];
    if (source === undefined || exported === undefined) {
      return undefined;
    }
    const filename = this.path.relative(this.root, symbol.module.file).split(this.path.sep).join('/');
    let ownerPath = this.path.dirname(filename);
    for (let index = 0; index < budget; index += 1) {
      if (this.relativeContractSources.has(`${ownerPath}/package.json`)) {
        return provesDefaultStructEquivalenceSchemaExport(source, exported, {
          filename,
          isImmutableContractSource: () => false,
          ownerPath,
          sources: this.relativeContractSources,
        })
          ? symbol.binding
          : undefined;
      }
      const parent = this.path.dirname(ownerPath);
      if (parent === ownerPath) {
        return undefined;
      }
      ownerPath = parent;
    }
    return undefined;
  }
  comparatorPrototypeClosed(): boolean {
    for (const module of this.modules.values()) {
      if (this.comparatorPrototypeFacts.has(module.program)) {
        continue;
      }
      if (
        !hasClosedNativeObjectPrototypeKeyCustody(module.program, comparatorRequestKeys) ||
        !hasClosedNativeObjectIntrinsicCustody(module.program, ['freeze'])
      ) {
        return false;
      }
      this.comparatorPrototypeFacts.add(module.program);
    }
    return true;
  }
  static comparatorPropertyKey(property: ObjectProperty): string | undefined {
    if (property.type !== 'Property') {
      return undefined;
    }
    if (property.key.type === 'Identifier') {
      return property.key.name;
    }
    return property.key.type === 'Literal' ? String(property.key.value) : undefined;
  }
  static comparatorDataProperty(property: ObjectProperty): boolean {
    return (
      property.type === 'Property' &&
      !property.computed &&
      !property.method &&
      property.kind === 'init' &&
      (property.key.type === 'Identifier' || property.key.type === 'Literal') &&
      !['__proto__', 'constructor', 'prototype'].includes(
        property.key.type === 'Identifier' ? property.key.name : String(property.key.value),
      )
    );
  }
  comparatorDecodedCustody(module: Module, binding: Binding, consumer: CallExpression): boolean {
    return (
      stable(module, binding) &&
      module.escapes.every((expression) => this.schemaObjectPaths(module, expression, binding, '').length === 0) &&
      module.bindings.every(
        (alias) =>
          alias === binding ||
          alias.init === undefined ||
          this.schemaObjectPaths(module, alias.init, binding, '').length === 0,
      ) &&
      module.calls.every(
        (call) =>
          call === consumer ||
          call.arguments.every(
            (argument, index) =>
              this.schemaObjectPaths(
                module,
                argument.type === 'SpreadElement' ? argument.argument : argument,
                binding,
                '',
              ).length === 0 || this.comparatorDecodedReadonlyBorrower(module, call, index, binding),
          ),
      )
    );
  }
  static comparatorReadonlyCall(call: CallExpression, fn: Implementation): boolean {
    return (
      !call.optional &&
      fn.type === 'ArrowFunctionExpression' &&
      !fn.async &&
      !fn.generator &&
      fn.params.length === call.arguments.length &&
      fn.params.every((parameter) => parameter.type === 'Identifier') &&
      call.arguments.every((argument) => argument.type !== 'SpreadElement')
    );
  }
  comparatorDecodedReadonlyBorrower(module: Module, call: CallExpression, index: number, decoded: Binding): boolean {
    const callee = unwrap(call.callee);
    const argument = call.arguments[index];
    const symbol = callee.type === 'Identifier' ? this.symbol(module, callee) : undefined;
    const target = symbol === undefined ? undefined : this.function(module, callee);
    if (
      argument === undefined ||
      argument.type === 'SpreadElement' ||
      this.bindingPath(module, argument, decoded) !== '' ||
      symbol?.module !== module ||
      !stable(module, symbol.binding) ||
      !directCallsOnly(module, symbol.binding) ||
      target?.module !== module ||
      !FactoryResolver.comparatorReadonlyCall(call, target.fn)
    ) {
      return false;
    }
    const parameter = target.fn.params[index];
    const formal = parameter?.type === 'Identifier' ? bindingAt(module, parameter.name, parameter) : undefined;
    if (
      formal === undefined ||
      !this.objectCustody(module, formal, '', new Set()) ||
      !this.comparatorProjectionParameterClosed(module, target.fn, formal)
    ) {
      return false;
    }
    let closed = true;
    new Visitor({
      Identifier: (node) => {
        if (
          inside(node, target.fn) &&
          bindingAt(module, node.name, node) === formal &&
          FactoryResolver.nearestFunction(module, node) !== target.fn
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  comparatorDecodedSpread(
    module: Module,
    input: Expression,
    schema: Binding,
    consumer: CallExpression,
  ): { readonly builder: CallExpression; readonly module: Module } | undefined {
    const binding = this.symbol(module, input);
    const yielded = binding?.binding.init === undefined ? undefined : unwrap(binding.binding.init);
    if (
      binding === undefined ||
      yielded?.type !== 'YieldExpression' ||
      !yielded.delegate ||
      yielded.argument === null ||
      !this.comparatorDecodedCustody(binding.module, binding.binding, consumer)
    ) {
      return undefined;
    }
    const value = this.comparatorDecodeCall(binding.module, yielded.argument);
    return value === undefined || this.symbol(binding.module, value.schema)?.binding !== schema
      ? undefined
      : { builder: value.builder, module: binding.module };
  }
  comparatorDecodedArgument(reference: Reference, schema: Binding, consumer: CallExpression): boolean {
    const node = unwrap(reference.expression);
    if (node.type !== 'ObjectExpression') {
      return false;
    }
    const decoded: { builder: CallExpression; module: Module }[] = [];
    for (const property of node.properties) {
      if (property.type !== 'SpreadElement') {
        if (
          !FactoryResolver.comparatorDataProperty(property) ||
          !this.comparatorPrimitive(reference.module, property.value)
        ) {
          return false;
        }
        continue;
      }
      const value = this.comparatorDecodedSpread(reference.module, property.argument, schema, consumer);
      if (value === undefined) {
        return false;
      }
      decoded.push(value);
    }
    const root = this.acquisitionProvider?.root;
    const [value] = decoded;
    const source = value === undefined ? undefined : this.sources.get(value.module.file);
    if (decoded.length !== 1 || value === undefined || root === undefined || source === undefined) {
      return false;
    }
    this.comparatorDecoderBuilders.set(value.builder, { root, schema, source });
    return true;
  }
  comparatorDecodeCall(
    module: Module,
    input: Expression,
  ): { readonly builder: CallExpression; readonly schema: Expression } | undefined {
    let node = unwrap(input);
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
        if (
          !node.arguments.every(
            (argument) =>
              argument.type === 'CallExpression' &&
              this.native(module, argument.callee, 'Effect', 'mapError') &&
              argument.arguments.length === 1,
          )
        ) {
          return undefined;
        }
        node = unwrap(callee.object);
      }
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.length !== 1 ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const builder = unwrap(node.callee);
    if (builder.type !== 'CallExpression' || !this.nativeSchemaDecodeEffectBorrower(module, builder, 0)) {
      return undefined;
    }
    const [schema] = builder.arguments;
    return schema === undefined || schema.type === 'SpreadElement' ? undefined : { builder, schema };
  }
  comparatorDecoderConstructionClosed(module: Module, call: CallExpression): boolean {
    const fact = this.comparatorDecoderBuilders.get(call);
    const [schema] = call.arguments;
    return (
      fact !== undefined &&
      fact.root === this.acquisitionProvider?.root &&
      fact.source === this.sources.get(module.file) &&
      this.nativeSchemaDecodeEffectBorrower(module, call, 0) &&
      schema !== undefined &&
      schema.type !== 'SpreadElement' &&
      this.comparatorDefaultSchema(module, schema) === fact.schema &&
      this.comparatorPrototypeClosed()
    );
  }
  comparatorPrimitive(module: Module, input: Expression, hops = 0): boolean {
    if (hops >= budget) {
      return false;
    }
    const node = unwrap(input);
    if (node.type === 'Literal') {
      return (
        node.value === null ||
        Schema.is(Schema.String)(node.value) ||
        Schema.is(Schema.Number)(node.value) ||
        Schema.is(Schema.Boolean)(node.value) ||
        Schema.is(Schema.BigInt)(node.value)
      );
    }
    const symbol = node.type === 'Identifier' ? this.symbol(module, node) : undefined;
    return symbol?.binding.init !== undefined && this.comparatorPrimitive(symbol.module, symbol.binding.init, hops + 1);
  }
  comparatorCapturedRecord(reference: Reference): Reference | undefined {
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (binding === undefined || !stable(module, binding)) {
      return undefined;
    }
    const symbol = this.symbol(module, node);
    const source =
      captures.get(binding) ??
      (symbol?.binding.init === undefined
        ? undefined
        : FactoryResolver.reference(symbol.module, symbol.binding.init, captures));
    return source !== undefined &&
      (FactoryResolver.comparatorFrozenRecord(source) !== undefined ||
        this.objectCustody(module, binding, '', new Set()))
      ? source
      : undefined;
  }
  static comparatorFrozenRecord(reference: Reference): Reference | undefined {
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) {
      return undefined;
    }
    const callee = unwrap(node.callee);
    const [value] = node.arguments;
    return callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      bindingAt(module, 'Object', callee.object) === undefined &&
      propertyName(callee) === 'freeze' &&
      objectIntrinsicClosed(module) &&
      value !== undefined &&
      value.type !== 'SpreadElement'
      ? FactoryResolver.reference(module, value, captures)
      : undefined;
  }
  comparatorRecordField(reference: Reference, name: string, hops = 0): Reference | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier' || node.type === 'CallExpression') {
      const source =
        node.type === 'Identifier'
          ? this.comparatorCapturedRecord(reference)
          : FactoryResolver.comparatorFrozenRecord(reference);
      return source === undefined ? undefined : this.comparatorRecordField(source, name, hops + 1);
    }
    if (node.type !== 'ObjectExpression') {
      return undefined;
    }
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index];
      if (property === undefined) {
        return undefined;
      }
      if (property.type === 'SpreadElement') {
        return this.comparatorRecordField(
          FactoryResolver.reference(module, property.argument, captures),
          name,
          hops + 1,
        );
      }
      if (!FactoryResolver.comparatorDataProperty(property)) {
        return undefined;
      }
      const key = FactoryResolver.comparatorPropertyKey(property);
      if (key === name) {
        return FactoryResolver.reference(module, property.value, captures);
      }
    }
    return undefined;
  }
  comparatorFreshRecord(reference: Reference, hops = 0): boolean {
    if (hops >= budget) {
      return false;
    }
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier' || node.type === 'CallExpression') {
      const source =
        node.type === 'Identifier'
          ? this.comparatorCapturedRecord(reference)
          : FactoryResolver.comparatorFrozenRecord(reference);
      if (node.type === 'CallExpression' && source !== undefined) {
        const snapshot = unwrap(source.expression);
        if (
          snapshot.type === 'ObjectExpression' &&
          snapshot.properties.every(
            (property) => property.type === 'SpreadElement' || FactoryResolver.comparatorDataProperty(property),
          )
        ) {
          return true;
        }
      }
      return source !== undefined && this.comparatorFreshRecord(source, hops + 1);
    }
    return (
      node.type === 'ObjectExpression' &&
      node.properties.every((property) =>
        property.type === 'SpreadElement'
          ? this.comparatorFreshRecord(
              FactoryResolver.reference(reference.module, property.argument, reference.captures),
              hops + 1,
            )
          : FactoryResolver.comparatorDataProperty(property),
      )
    );
  }
  comparatorAuthorizationTag(module: Module, input: Expression): Binding | undefined {
    const node = unwrap(input);
    if (node.type !== 'MemberExpression' || propertyName(node) !== 'request') {
      return undefined;
    }
    const value = unwrap(node.object);
    if (value.type !== 'MemberExpression' || propertyName(value) !== 'value' || value.object.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(module, value.object.name, value.object);
    const acquired = binding?.init === undefined ? undefined : unwrap(binding.init);
    const call =
      acquired?.type === 'YieldExpression' && acquired.delegate && acquired.argument !== null
        ? unwrap(acquired.argument)
        : undefined;
    if (
      call?.type !== 'CallExpression' ||
      call.optional ||
      call.arguments.length !== 1 ||
      !this.native(module, call.callee, 'Effect', 'serviceOption')
    ) {
      return undefined;
    }
    const [tag] = call.arguments;
    return tag === undefined || tag.type === 'SpreadElement' ? undefined : this.tag(module, tag);
  }
  comparatorProjectionParameterClosed(
    module: Module,
    fn: Implementation,
    binding: Binding,
    record?: Reference,
  ): boolean {
    const reads = new Set([binding.node.start]);
    const ignored: Span[] = [];
    new Visitor({
      MemberExpression: (node) => {
        if (!node.computed) {
          ignored.push(node.property);
        }
        if (inside(node, fn) && this.comparatorProjectionRead(module, node, binding, record)) {
          reads.add(node.object.start);
        }
      },
      Property(node) {
        if (!node.computed && !node.shorthand) {
          ignored.push(node.key);
        }
      },
      TSTypeAnnotation(node) {
        ignored.push(node);
      },
      TSTypeQuery(node) {
        ignored.push(node);
      },
      TSTypeReference(node) {
        ignored.push(node);
      },
    }).visit(module.program);
    let closed = true;
    new Visitor({
      Identifier(node) {
        if (
          inside(node, fn) &&
          bindingAt(module, node.name, node) === binding &&
          !reads.has(node.start) &&
          !ignored.some((span) => inside(node, span))
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  comparatorProjectionBody(module: Module, fn: Implementation, record: Reference): boolean {
    const [parameter] = fn.params;
    const result = directReturn(fn, module.program);
    if (
      fn.async ||
      fn.generator ||
      fn.params.length !== 1 ||
      parameter?.type !== 'Identifier' ||
      result === undefined ||
      !this.comparatorFreshRecord(record)
    ) {
      return false;
    }
    if (module.calls.some((call) => inside(call, fn))) {
      return false;
    }
    const binding = bindingAt(module, parameter.name, parameter);
    return (
      binding !== undefined &&
      this.objectCustody(module, binding, '', new Set()) &&
      this.comparatorProjectionParameterClosed(module, fn, binding, record) &&
      this.comparatorProjectionExpression(module, result, binding, record, 0)
    );
  }
  comparatorProjectionRead(
    module: Module,
    input: Expression,
    binding: Binding,
    record: Reference | undefined,
  ): boolean {
    const value = unwrap(input);
    if (
      value.type !== 'MemberExpression' ||
      value.computed ||
      value.optional ||
      this.bindingPath(module, value.object, binding) !== ''
    ) {
      return false;
    }
    const name = propertyName(value);
    return (
      name !== undefined &&
      ((record !== undefined && this.comparatorRecordField(record, name) !== undefined) ||
        comparatorRequestKeys.includes(name))
    );
  }
  comparatorProjectionExpression(
    module: Module,
    input: Expression,
    binding: Binding,
    record: Reference,
    hops: number,
  ): boolean {
    if (hops >= budget) {
      return false;
    }
    const node = unwrap(input);
    if (node.type === 'Identifier') {
      const symbol = this.symbol(module, node);
      return (
        symbol?.binding.init !== undefined &&
        this.comparatorProjectionExpression(symbol.module, symbol.binding.init, binding, record, hops + 1)
      );
    }
    if (node.type === 'ConditionalExpression') {
      const condition = unwrap(node.test);
      const absent = condition.type === 'BinaryExpression' ? unwrap(condition.right) : undefined;
      return (
        condition.type === 'BinaryExpression' &&
        condition.operator === '===' &&
        this.comparatorProjectionRead(module, condition.left, binding, record) &&
        absent?.type === 'Identifier' &&
        absent.name === 'undefined' &&
        bindingAt(module, absent.name, absent) === undefined &&
        this.comparatorProjectionExpression(module, node.consequent, binding, record, hops + 1) &&
        this.comparatorProjectionExpression(module, node.alternate, binding, record, hops + 1)
      );
    }
    if (node.type !== 'ObjectExpression') {
      return false;
    }
    return node.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return this.comparatorProjectionExpression(module, property.argument, binding, record, hops + 1);
      }
      return (
        FactoryResolver.comparatorDataProperty(property) &&
        (this.comparatorPrimitive(module, property.value) ||
          this.comparatorProjectionRead(module, property.value, binding, record))
      );
    });
  }
  comparatorInvocationOwned(module: Module, call: CallExpression, root: Module): boolean {
    if (this.ownerRoot(module.file) !== root || call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return false;
    }
    const callee = unwrap(call.callee);
    if (callee.type !== 'Identifier') {
      return true;
    }
    const binding = bindingAt(module, callee.name, callee);
    return binding !== undefined && directCallsOnly(module, binding);
  }
  comparatorInvocationRecords(
    module: Module,
    call: CallExpression,
    tag: Binding,
    readScope: ComparatorReadScope,
    layer?: Reference,
  ): readonly Reference[] | undefined {
    const owner = FactoryResolver.nearestFunction(module, call);
    if (owner === undefined) {
      return undefined;
    }
    const records: Reference[] = [];
    const root = this.acquisitionProvider?.root;
    if (root === undefined) {
      return undefined;
    }
    for (const caller of this.modules.values()) {
      for (const invocation of caller.calls) {
        const target =
          invocation.callee.type === 'Identifier'
            ? this.function(caller, invocation.callee)
            : this.comparatorVerifierMethod(caller, invocation.callee, root, layer);
        if (invocation.optional || target?.fn !== owner) {
          continue;
        }
        if (!this.comparatorInvocationOwned(caller, invocation, root)) {
          return undefined;
        }
        const provided = this.comparatorProvidedValue(caller, invocation, tag, new Map());
        const record = provided === undefined ? undefined : this.comparatorRecordField(provided, 'request');
        if (record === undefined || !this.comparatorFreshRecord(record)) {
          return undefined;
        }
        const frame = FactoryResolver.captureCall(
          module,
          owner,
          invocation.arguments.filter((argument) => argument.type !== 'SpreadElement'),
          readScope.captures,
          caller,
          target.captures,
        );
        const captures = new Map([...record.captures, ...frame]);
        if (
          invocation.arguments.some(
            (argument) =>
              argument.type !== 'SpreadElement' &&
              this.effectContainsRead(caller, argument, readScope.module, readScope.read, new Set(), 0, true, captures),
          ) ||
          this.effectContainsRead(
            record.module,
            record.expression,
            readScope.module,
            readScope.read,
            new Set(),
            0,
            true,
            captures,
          )
        ) {
          return undefined;
        }
        records.push({ ...record, captures });
      }
    }
    return records.length === 0 ? undefined : records;
  }
  comparatorProviderRecords(reference: Reference, hops = 0): readonly Reference[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const node = unwrap(reference.expression);
    if (node.type === 'YieldExpression' && node.delegate && node.argument !== null) {
      return this.comparatorProviderRecords(
        FactoryResolver.reference(reference.module, node.argument, reference.captures),
        hops + 1,
      );
    }
    if (node.type === 'ObjectExpression') {
      return ownDataFields(node) === undefined ? undefined : [reference];
    }
    const values = this.carrierSuccessValues(reference, hops);
    if (values === undefined) {
      return undefined;
    }
    const records: Reference[] = [];
    for (const value of values) {
      const nested = this.comparatorProviderRecords(value, hops + 1);
      if (nested === undefined) {
        return undefined;
      }
      records.push(...nested);
    }
    return records;
  }
  comparatorVerifierTag(module: Module, input: Expression): Binding | undefined {
    const node = unwrap(input);
    const receiver = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    const tag = receiver === undefined ? undefined : this.comparatorYieldedTag(module, receiver);
    return receiver !== undefined &&
      tag !== undefined &&
      this.objectCustody(module, receiver, '', new Set()) &&
      this.requestedServiceContextClosed(tag)
      ? tag
      : undefined;
  }
  comparatorSameProvider(first: LayerCandidate, second: LayerCandidate): boolean {
    const key = this.referenceFingerprint(first.frame, new Set(), new Map(), { value: budget });
    return (
      first.call === second.call &&
      key !== undefined &&
      this.referenceFingerprint(second.frame, new Set(), new Map(), { value: budget }) === key
    );
  }
  comparatorUniqueProvider(root: Module, tag: Binding, layer?: Reference): LayerCandidate | undefined {
    if (layer !== undefined && layer.captures.size === 0 && this.comparatorLayerProviders(layer, tag)?.length === 0) {
      return undefined;
    }
    const installed = this.comparatorRootProviders(root, tag);
    if (installed === undefined || installed.length > 1) {
      return undefined;
    }
    const candidates = layer === undefined ? installed : this.comparatorLayerProviders(layer, tag);
    const [provider] = candidates ?? [];
    const [mounted] = installed;
    return candidates?.length === 1 &&
      provider !== undefined &&
      this.ownerRoot(provider.module.file) === root &&
      (mounted === undefined || this.comparatorSameProvider(mounted, provider)) &&
      (layer === undefined || this.layerDependencyCompatible(layer, tag, provider))
      ? provider
      : undefined;
  }
  comparatorVerifierMethod(
    module: Module,
    input: Expression,
    root: Module,
    layer?: Reference,
  ): { readonly captures: Captures; readonly fn: Implementation; readonly module: Module } | undefined {
    const node = unwrap(input);
    if (node.type !== 'MemberExpression' || node.computed || node.optional || node.object.type !== 'Identifier') {
      return undefined;
    }
    const tag = this.comparatorVerifierTag(module, node.object);
    const provider = tag === undefined ? undefined : this.comparatorUniqueProvider(root, tag, layer);
    if (provider === undefined || !this.native(provider.module, provider.call.callee, 'Layer', 'effect')) {
      return undefined;
    }
    const records = this.comparatorProviderRecords(
      FactoryResolver.reference(provider.module, provider.program, provider.frame.captures),
    );
    const [record] = records ?? [];
    const name = propertyName(node);
    if (records?.length !== 1 || record === undefined || name === undefined) {
      return undefined;
    }
    const expression = ownDataFields(record.expression)?.get(name);
    const target = expression === undefined ? undefined : this.function(record.module, expression, 0, record.captures);
    return target === undefined ? undefined : { captures: record.captures, fn: target.fn, module: target.module };
  }
  comparatorArgumentsClosed(
    module: Module,
    call: CallExpression,
    schema: Binding,
    root: Module,
    readScope: ComparatorReadScope,
  ): boolean {
    const [first, second] = call.arguments;
    const owner = FactoryResolver.nearestFunction(module, call);
    if (
      first?.type !== 'Identifier' ||
      second?.type !== 'CallExpression' ||
      second.optional ||
      second.arguments.length !== 1 ||
      owner === undefined
    ) {
      return false;
    }
    const method = this.comparatorOwnedMethod(module, owner, root);
    const parameter = bindingAt(module, first.name, first);
    const projection = this.function(module, second.callee);
    const [input] = second.arguments;
    const tag =
      input === undefined || input.type === 'SpreadElement'
        ? undefined
        : this.comparatorAuthorizationTag(module, input);
    if (method === undefined || parameter?.parameter?.fn !== owner || projection === undefined || tag === undefined) {
      return false;
    }
    const calls = this.comparatorMethodCalls(method);
    return (
      calls !== undefined &&
      calls.every((site) => {
        const argument = site.frame.get(parameter);
        const records = this.comparatorInvocationRecords(site.module, site.call, tag, readScope, method.layer);
        return (
          argument !== undefined &&
          this.comparatorDecodedArgument(argument, schema, site.call) &&
          records !== undefined &&
          records.every((record) => this.comparatorProjectionBody(projection.module, projection.fn, record))
        );
      })
    );
  }
  static comparatorCallArity(call: CallExpression, construction: CallExpression): boolean {
    return (
      !call.optional &&
      call.arguments.length === 2 &&
      call.arguments.every((argument) => argument.type !== 'SpreadElement') &&
      !construction.optional &&
      construction.arguments.length === 1
    );
  }
  comparatorCallClosed(module: Module, call: CallExpression, readScope: ComparatorReadScope): boolean | undefined {
    const callee = unwrap(call.callee);
    const symbol = callee.type === 'Identifier' ? this.symbol(module, callee) : undefined;
    const construction = symbol?.binding.init === undefined ? undefined : unwrap(symbol.binding.init);
    if (
      symbol === undefined ||
      construction?.type !== 'CallExpression' ||
      !this.native(symbol.module, construction.callee, 'Schema', 'toEquivalence')
    ) {
      return undefined;
    }
    const root = this.acquisitionProvider?.root;
    const [input] = construction.arguments;
    if (
      root === undefined ||
      symbol.module !== module ||
      !FactoryResolver.comparatorCallArity(call, construction) ||
      input === undefined ||
      input.type === 'SpreadElement' ||
      !directCallsOnly(symbol.module, symbol.binding) ||
      this.activeComparatorCalls.has(call)
    ) {
      return false;
    }
    const schema = this.comparatorDefaultSchema(symbol.module, input);
    if (schema === undefined || !this.comparatorPrototypeClosed()) {
      return false;
    }
    this.activeComparatorCalls.add(call);
    try {
      return this.comparatorArgumentsClosed(module, call, schema, root, readScope);
    } finally {
      this.activeComparatorCalls.delete(call);
    }
  }
  nativeStringArgument(module: Module, call: CallExpression): Expression | undefined {
    const callee = unwrap(call.callee);
    const [argument] = call.arguments;
    if (
      call.optional ||
      call.arguments.length !== 1 ||
      argument === undefined ||
      argument.type === 'SpreadElement' ||
      callee.type !== 'Identifier' ||
      callee.name !== 'String' ||
      bindingAt(module, callee.name, callee) !== undefined
    ) {
      return undefined;
    }
    for (const member of this.modules.values()) {
      if (this.stringConstructorFacts.get(member.program) === true) {
        continue;
      }
      if (!hasClosedNativeStringConstructorCustody(member.program)) {
        return undefined;
      }
      this.stringConstructorFacts.set(member.program, true);
    }
    return argument;
  }
  nativeConfigProviderCallClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    captures: Captures,
  ): boolean | undefined {
    if (!this.native(module, call.callee, 'ConfigProvider', 'fromUnknown')) {
      return undefined;
    }
    const [root] = call.arguments;
    return (
      !call.optional &&
      call.arguments.length === 1 &&
      root !== undefined &&
      root.type !== 'SpreadElement' &&
      !this.effectContainsRead(module, root, readModule, read, new Set(), 0, false, captures)
    );
  }
  nativeMetadataCallClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    captures: Captures,
  ): boolean | undefined {
    const configuration = this.nativeConfigProviderCallClosed(module, call, readModule, read, captures);
    if (configuration !== undefined) {
      return configuration;
    }
    const argument = this.nativeStringArgument(module, call);
    if (argument !== undefined) {
      return !this.effectContainsRead(module, argument, readModule, read, new Set(), 0, true, captures);
    }
    const comparator = this.comparatorCallClosed(module, call, { captures, module: readModule, read });
    if (comparator !== undefined) {
      return comparator;
    }
    if (this.comparatorDecoderConstructionClosed(module, call)) {
      return true;
    }
    return this.nativeSchemaMetadataCallClosed(module, call) ? true : undefined;
  }
  nativeSchemaMetadataCallClosed(module: Module, call: CallExpression): boolean {
    return (
      this.nativeTrimSchemaConstruction(module, call) ||
      this.nativeSchemaEquivalence(module, call) ||
      this.nativeServiceFreeStructConstruction(module, call)
    );
  }
  consumerEffectCallClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    wanted: Binding,
    captures: Captures = new Map(),
  ): boolean {
    const selected = this.consumerSourceCalls.get(call);
    if (
      selected?.caller === module &&
      wanted === selected.tag &&
      this.consumerSnapshotsClosed() &&
      this.consumerSameFrame(module, call, captures, selected.callerCaptures)
    ) {
      return true;
    }
    const member = this.consumerPlainMemberSource(module, call, captures);
    if (member !== undefined) {
      return this.checkConsumerDataSource(module, call, member, captures, readModule, read, wanted);
    }
    if (
      this.consumerOriginalCallClosed(module, call, readModule, read, wanted, captures) ||
      this.guardedCorePoolAcquisition(module, call) ||
      this.nativeSchemaComposition(module, call, 0)
    ) {
      return true;
    }
    const local = this.consumerDataCallableSource(module, call, captures);
    if (local !== undefined) {
      return this.checkConsumerDataSource(module, call, local, captures, readModule, read, wanted);
    }
    const source = this.consumerServiceSource(module, call, captures);
    return source !== undefined && this.checkConsumerSource(source, readModule, read, wanted);
  }
  consumerRecordValues(reference: Reference, seen: Set<Binding>, hops: number): readonly ObjectValue[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier') {
      const binding = bindingAt(module, node.name, node);
      const captured = binding === undefined ? undefined : captures.get(binding);
      if (
        binding === undefined ||
        seen.has(binding) ||
        !this.consumerRecordCustody(reference, binding, '', new Set())
      ) {
        return undefined;
      }
      if (captured !== undefined) {
        return this.consumerRecordValues(captured, new Set(seen).add(binding), hops + 1);
      }
      if (binding.origin === undefined && binding.init !== undefined) {
        return this.consumerRecordValues(
          FactoryResolver.reference(module, binding.init, captures),
          new Set(seen).add(binding),
          hops + 1,
        );
      }
    }
    if (node.type === 'MemberExpression' && !node.computed && !node.optional) {
      return this.consumerRecordMemberValues(reference, node, seen, hops);
    }
    return this.values(reference, seen, hops + 1);
  }
  consumerRecordMemberValues(
    reference: Reference,
    node: Extract<Expression, { type: 'MemberExpression' }>,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const { captures, module } = reference;
    const base = unwrap(node.object);
    const binding = base.type === 'Identifier' ? bindingAt(module, base.name, base) : undefined;
    const name = propertyName(node);
    if (
      name === undefined ||
      (binding !== undefined && !this.consumerRecordCustody(reference, binding, name, new Set()))
    ) {
      return undefined;
    }
    const objects = this.consumerRecordValues(FactoryResolver.reference(module, node.object, captures), seen, hops + 1);
    const result: ObjectValue[] = [];
    for (const object of objects ?? []) {
      const field = ownDataFields(object.expression)?.get(name);
      const values =
        field === undefined
          ? undefined
          : this.consumerRecordValues(FactoryResolver.reference(object.module, field, object.captures), seen, hops + 1);
      if (values === undefined) {
        return undefined;
      }
      result.push(...values);
    }
    return objects === undefined ? undefined : result;
  }
  consumerRecordCustody(
    reference: Pick<Reference, 'captures' | 'module'>,
    binding: Binding,
    suffix: string,
    seen: Set<string>,
  ): boolean {
    const loans = new Set<Span>();
    const borrower: RecordBorrower = {
      argument: (module, current, selected, next, call, index) => {
        if (
          module !== reference.module ||
          !this.consumerRecordBorrow(reference.captures, module, current, selected, next, call, index)
        ) {
          return false;
        }
        const argument = call.arguments[index];
        if (argument !== undefined && argument.type !== 'SpreadElement') {
          loans.add(argument);
        }
        return true;
      },
      references: (module, current, selected) => this.consumerRecordReferencesClosed(module, current, selected, loans),
    };
    return this.objectCustody(reference.module, binding, suffix, seen, false, false, borrower);
  }
  consumerRecordBorrow(
    captures: Captures,
    module: Module,
    binding: Binding,
    suffix: string,
    seen: Set<string>,
    call: CallExpression,
    index: number,
  ): boolean {
    const direct = this.function(module, call.callee, 0, captures);
    const source =
      direct === undefined
        ? this.consumerDataCallableSource(module, call, captures)
        : { ...direct, captures: direct.captures ?? captures };
    if (source === undefined || !FactoryResolver.consumerExplicitSource(source)) {
      return false;
    }
    const parameter = source.fn.params[index];
    const identifier = parameter?.type === 'AssignmentPattern' ? parameter.left : parameter;
    const formal =
      identifier?.type === 'Identifier' ? bindingAt(source.module, identifier.name, identifier) : undefined;
    const frames = FactoryResolver.consumerDataCallFrames(module, call, source, captures);
    const argument = call.arguments[index];
    if (
      formal === undefined ||
      identifier?.type !== 'Identifier' ||
      frames === undefined ||
      frames.length === 0 ||
      argument === undefined ||
      argument.type === 'SpreadElement'
    ) {
      return false;
    }
    const paths = this.schemaObjectPaths(module, argument, binding, suffix);
    return (
      paths.length > 0 &&
      frames.every((frame) =>
        paths.every((path) =>
          this.consumerRecordCustody({ captures: frame, module: source.module }, formal, path, seen),
        ),
      )
    );
  }
  consumerRecordReferencesClosed(module: Module, binding: Binding, suffix: string, loans: ReadonlySet<Span>): boolean {
    const allowed: Span[] = [binding.node, ...loans];
    for (const alias of module.bindings) {
      const input = alias.field?.expression ?? alias.init;
      if (
        alias !== binding &&
        input !== undefined &&
        this.schemaObjectPaths(module, input, binding, suffix).length > 0
      ) {
        allowed.push(input);
      }
    }
    let closed = true;
    new Visitor({
      ArrowFunctionExpression: (node) => {
        if (
          node.body.type !== 'BlockStatement' &&
          this.schemaObjectPaths(module, node.body, binding, suffix).length > 0
        ) {
          closed = false;
        }
      },
      MemberExpression(node) {
        const object = unwrap(node.object);
        if (object.type === 'Identifier') {
          allowed.push(object);
        }
        if (!node.computed) {
          allowed.push(node.property);
        }
      },
      Property(node) {
        if (!node.computed && !node.shorthand) {
          allowed.push(node.key);
        }
      },
      ReturnStatement: (node) => {
        if (node.argument !== null && this.schemaObjectPaths(module, node.argument, binding, suffix).length > 0) {
          closed = false;
        }
      },
      TSTypeAnnotation(node) {
        allowed.push(node);
      },
      TSTypeQuery(node) {
        allowed.push(node);
      },
      TSTypeReference(node) {
        allowed.push(node);
      },
    }).visit(module.program);
    new Visitor({
      Identifier(node) {
        if (bindingAt(module, node.name, node) === binding && !allowed.some((span) => inside(node, span))) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  consumerPlainMemberSource(module: Module, call: CallExpression, captures: Captures): ConsumerBodySource | undefined {
    const callee = unwrap(call.callee);
    return callee.type === 'MemberExpression' && this.function(module, callee, 0, captures) === undefined
      ? this.consumerDataCallableSource(module, call, captures)
      : undefined;
  }
  consumerDataCallableSource(module: Module, call: CallExpression, captures: Captures): ConsumerBodySource | undefined {
    if (
      this.modules.get(module.file) !== module ||
      !this.consumerSnapshotsClosed() ||
      call.optional ||
      call.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const found: ConsumerSourceObservation = {};
    const observe: ConsumerSourceObserver = (source) => {
      found.value = source;
    };
    const callee = unwrap(call.callee);
    const result =
      callee.type === 'MemberExpression'
        ? this.dataObjectMethodCandidate({ callee, file: module.file }, observe, captures, (reference) =>
            this.consumerRecordValues(reference, new Set(), 0),
          )
        : this.dataCallable(FactoryResolver.reference(module, callee, captures), new Set(), 0, observe);
    const source = found.value;
    if (result === undefined || source === undefined || this.modules.get(source.module.file) !== source.module) {
      return undefined;
    }
    this.consumerSourceProofUsed = true;
    return source;
  }
  static consumerExplicitSource(source: ConsumerBodySource): boolean {
    return source.module.functions
      .filter((fn) => fn === source.fn || inside(source.fn, fn))
      .every((fn) => FactoryResolver.consumerExplicitBody(source.module, fn));
  }
  static consumerExplicitBody(module: Module, fn: Implementation): boolean {
    let closed = true;
    new Visitor({
      Identifier(node) {
        if (inside(node, fn) && node.name === 'arguments') {
          closed = false;
        }
      },
      ThisExpression(node) {
        if (inside(node, fn)) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  static consumerDefaultClosed(
    source: ConsumerBodySource,
    parameter: Extract<ParamPattern, { type: 'AssignmentPattern' }>,
    index: number,
    frame: Captures,
  ): boolean {
    const node = unwrap(parameter.right);
    if (node.type === 'Literal') {
      return (
        node.value === null ||
        Schema.is(Schema.String)(node.value) ||
        Schema.is(Schema.Number)(node.value) ||
        Schema.is(Schema.Boolean)(node.value)
      );
    }
    if (node.type === 'ObjectExpression') {
      return node.properties.length === 0;
    }
    const binding = node.type === 'Identifier' ? bindingAt(source.module, node.name, node) : undefined;
    return binding?.parameter?.fn === source.fn && binding.parameter.index < index && frame.has(binding);
  }
  static consumerParameterValues(
    source: ConsumerBodySource,
    parameter: ParamPattern,
    index: number,
    input: Reference | undefined,
    frame: Captures,
  ): readonly Reference[] | undefined {
    const values = FactoryResolver.formalValueReferences(source.module, parameter, input, frame);
    if (values === undefined || values.length === 0) {
      return undefined;
    }
    if (
      parameter.type === 'AssignmentPattern' &&
      values.some((value) => value.module === source.module && value.expression === parameter.right) &&
      !FactoryResolver.consumerDefaultClosed(source, parameter, index, frame)
    ) {
      return undefined;
    }
    return values;
  }
  static consumerParameterFrames(
    caller: Module,
    source: ConsumerBodySource,
    parameter: ParamPattern,
    index: number,
    argument: Expression | undefined,
    captures: Captures,
    frames: readonly Captures[],
    defaults: boolean,
  ): readonly Captures[] | undefined {
    const identifier = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
    const binding =
      identifier.type === 'Identifier' ? bindingAt(source.module, identifier.name, identifier) : undefined;
    if (
      binding === undefined ||
      (parameter.type !== 'Identifier' && parameter.type !== 'AssignmentPattern') ||
      (defaults && !stable(source.module, binding))
    ) {
      return undefined;
    }
    const absent = parameter.type === 'AssignmentPattern' && FactoryResolver.absentActualArgument(caller, argument);
    const input = argument === undefined || absent ? undefined : FactoryResolver.reference(caller, argument, captures);
    const next: Captures[] = [];
    for (const frame of frames) {
      const values = FactoryResolver.consumerParameterValues(source, parameter, index, input, frame);
      if (values === undefined) {
        return undefined;
      }
      for (const value of values) {
        if (next.length >= budget) {
          return undefined;
        }
        next.push(new Map([...frame, [binding, value]]));
      }
    }
    return next;
  }
  static consumerDataCallFrames(
    caller: Module,
    call: CallExpression,
    source: ConsumerBodySource,
    captures: Captures,
  ): readonly Captures[] | undefined {
    if (
      call.optional ||
      call.arguments.length > source.fn.params.length ||
      call.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const defaults = source.fn.params.some((parameter) => parameter.type === 'AssignmentPattern');
    if (defaults && (source.fn.async || source.fn.generator)) {
      return undefined;
    }
    const args = call.arguments.filter((argument) => argument.type !== 'SpreadElement');
    let frames: readonly Captures[] = [new Map(source.captures)];
    for (const [index, parameter] of source.fn.params.entries()) {
      const next = FactoryResolver.consumerParameterFrames(
        caller,
        source,
        parameter,
        index,
        args[index],
        captures,
        frames,
        defaults,
      );
      if (next === undefined) {
        return undefined;
      }
      frames = next;
    }
    return frames;
  }
  static consumerBodyCalls(source: ConsumerBodySource): readonly CallExpression[] {
    const defaults = source.fn.params
      .filter((parameter) => parameter.type === 'AssignmentPattern')
      .map((parameter) => parameter.right);
    return source.module.calls.filter(
      (call) => inside(call, source.fn) && !defaults.some((value) => inside(call, value)),
    );
  }
  consumerBodyCallClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    wanted: Binding,
    captures: Captures,
  ): boolean {
    return (
      this.consumerEffectCallClosed(module, call, readModule, read, wanted, captures) &&
      !(
        this.contextProvideCall(module, call) &&
        !this.disjointContextProvision(module, call, wanted, captures) &&
        this.contextProvisionReads(module, call, readModule, read, captures)
      )
    );
  }
  checkConsumerDataSource(
    caller: Module,
    call: CallExpression,
    source: ConsumerBodySource,
    captures: Captures,
    readModule: Module,
    read: Span,
    wanted: Binding,
  ): boolean {
    if (!FactoryResolver.consumerExplicitSource(source) || this.activeConsumerBodies.has(source.fn)) {
      return false;
    }
    const frames = FactoryResolver.consumerDataCallFrames(caller, call, source, captures);
    if (frames === undefined) {
      return false;
    }
    this.activeConsumerBodies.add(source.fn);
    const scoped = this.consumerKeyScopes.has(wanted);
    this.consumerKeyScopes.add(wanted);
    try {
      const closed = frames.every((frame) =>
        FactoryResolver.consumerBodyCalls(source).every((candidate) =>
          this.consumerBodyCallClosed(source.module, candidate, readModule, read, wanted, frame),
        ),
      );
      if (closed) {
        this.consumerSourceProofUsed = true;
      }
      return closed;
    } finally {
      this.activeConsumerBodies.delete(source.fn);
      if (!scoped) {
        this.consumerKeyScopes.delete(wanted);
      }
    }
  }
  consumerScopedOutputTag(
    module: Module,
    input: Expression,
    wanted: Binding | undefined,
    captures: Captures = new Map(),
  ): NativeTagIdentity | undefined {
    const identity = this.outputTag(module, input, captures);
    const binding = identity?.binding;
    if (binding === undefined || wanted === undefined || !this.consumerKeyScopes.has(wanted)) {
      return identity;
    }
    if (!this.consumerSnapshotsClosed() || this.activeConsumerKeyCustody.has(binding)) {
      return undefined;
    }
    this.activeConsumerKeyCustody.add(binding);
    try {
      const modules = this.consumerInventoryModules();
      const definition = modules?.find((candidate) => candidate.bindings.includes(binding));
      return modules !== undefined &&
        definition !== undefined &&
        this.consumerConstructorKeysClosed(modules, new Map([[binding, definition]]))
        ? identity
        : undefined;
    } finally {
      this.activeConsumerKeyCustody.delete(binding);
    }
  }
  consumerSourceServiceProvision(module: Module, input: Expression, wanted: Binding): boolean | undefined {
    const call = unwrap(input);
    if (
      !this.consumerKeyScopes.has(wanted) ||
      call.type !== 'CallExpression' ||
      !this.native(module, call.callee, 'Effect', 'provideService')
    ) {
      return undefined;
    }
    const tag = call.arguments[call.arguments.length === 3 ? 1 : 0];
    const actual =
      tag === undefined || tag.type === 'SpreadElement' ? undefined : this.consumerScopedOutputTag(module, tag, wanted);
    return (
      !call.optional &&
      [2, 3].includes(call.arguments.length) &&
      actual !== undefined &&
      actual.key !== this.tagKeys.get(wanted)
    );
  }
  consumerSourceProvisionReads(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    captures: Captures,
  ): boolean {
    const [first] = call.arguments;
    return (
      (call.arguments.length === 3 &&
        first !== undefined &&
        first.type !== 'SpreadElement' &&
        (this.effectCarrierRead(FactoryResolver.reference(module, first, captures), readModule, read) ||
          this.effectContainsRead(module, first, readModule, read, new Set(), 0, true))) ||
      this.contextProvisionReads(module, call, readModule, read)
    );
  }
  /**
   * Security fence: guarded Core pool (transaction I/O guard + session-role check). Inside Core's `db/client.ts`,
   * the pool acquisition the guards wrap (native `PgClient.make` or Core's `openDatabaseClient`) over the plain
   * pool settings Core's `configureDatabasePool` returned provides no service and runs no effect it is handed.
   */
  guardedCorePoolAcquisition(module: Module, call: CallExpression): boolean {
    const [argument] = call.arguments;
    const settings = argument?.type === 'Identifier' ? bindingAt(module, argument.name, argument) : undefined;
    const init = settings?.init === undefined ? undefined : unwrap(settings.init);
    const configured =
      init?.type === 'YieldExpression' &&
      init.delegate &&
      init.argument?.type === 'CallExpression' &&
      this.coreDatabaseImport(module, init.argument.callee, 'configureDatabasePool', 'pool-configuration.ts');
    return (
      call.arguments.length === 1 &&
      !call.optional &&
      settings?.kind === 'const' &&
      stable(module, settings) &&
      configured &&
      (this.native(module, call.callee, 'PgClient', 'make') ||
        this.coreDatabaseImport(module, call.callee, 'openDatabaseClient', 'database-client.ts'))
    );
  }
  /**
   * A native Schema constructor applied only to native Schema members and such constructions: it builds a
   * description, provides no service and runs no effect (Core's database environment schema is one).
   */
  nativeSchemaComposition(module: Module, call: CallExpression, depth: number): boolean {
    const callee = unwrap(call.callee);
    const method = callee.type === 'MemberExpression' ? propertyName(callee) : undefined;
    return (
      depth < budget &&
      !call.optional &&
      method !== undefined &&
      this.native(module, callee, 'Schema', method) &&
      call.arguments.every((argument) => {
        const node = argument.type === 'SpreadElement' ? undefined : unwrap(argument);
        const member = node?.type === 'MemberExpression' ? propertyName(node) : undefined;
        return (
          (node?.type === 'MemberExpression' && member !== undefined && this.native(module, node, 'Schema', member)) ||
          (node?.type === 'CallExpression' && this.nativeSchemaComposition(module, node, depth + 1))
        );
      })
    );
  }
  /** An import, in Core's `db/client.ts`, of the export declared by that exact sibling Core module. */
  coreDatabaseImport(module: Module, callee: Expression, name: string, file: string): boolean {
    const client = '/packages/core-runtime/src/db/client.ts';
    const node = unwrap(callee);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    const dependency = binding?.origin === undefined ? undefined : this.dependency(module, binding.origin.source);
    const declared = dependency === undefined ? undefined : this.exportedSymbol(dependency, name, new Set());
    return (
      module.file.endsWith(client) &&
      binding?.origin?.imported === name &&
      dependency?.file === `${module.file.slice(0, module.file.length - 'client.ts'.length)}${file}` &&
      declared?.module === dependency &&
      declared.binding.origin === undefined &&
      declared.binding.kind === 'const'
    );
  }
  consumerOriginalCallClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    wanted: Binding,
    captures: Captures,
  ): boolean {
    if (
      this.consumerSourceServiceProvision(module, call, wanted) === false &&
      this.consumerSourceProvisionReads(module, call, readModule, read, captures)
    ) {
      return false;
    }
    const callee = unwrap(call.callee);
    const metadata = this.nativeMetadataCallClosed(module, call, readModule, read, captures);
    if (metadata !== undefined) {
      return metadata;
    }
    const fnBody = this.nativeEffectFnBody(module, call);
    if (fnBody !== undefined && this.effectContainsRead(module, fnBody, readModule, read, new Set(), 0)) {
      return this.nativeEffectFnConstruction(module, call, wanted);
    }
    const layerResult = this.layerConsumerContextClosed(module, call, readModule, read, wanted);
    if (layerResult !== undefined) {
      return layerResult;
    }
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return (
        call.arguments.every(
          (argument) =>
            argument.type !== 'SpreadElement' && this.consumerEffectTransformClosed(module, argument, wanted),
        ) || !this.effectCarrierRead(FactoryResolver.reference(module, callee.object, captures), readModule, read)
      );
    }
    if (
      (this.layerTransformRole(module, call) && this.layerConstructorAcquisitionClosed(module, call, wanted)) ||
      (this.nativeLayerConstructor(module, call) && this.layerConstructorAcquisitionClosed(module, call, wanted)) ||
      this.layerProducer(module, call) !== undefined ||
      this.nativeEffectFnConstruction(module, call, wanted) ||
      this.preservingEffectOperator(module, callee) ||
      this.function(module, callee, 0, captures) !== undefined ||
      (call.arguments.length === 2 && this.native(module, callee, 'Layer', 'effect'))
    ) {
      return true;
    }
    return call.arguments.every(
      (argument) =>
        !this.effectCarrierRead(
          FactoryResolver.reference(module, argument.type === 'SpreadElement' ? argument.argument : argument, captures),
          readModule,
          read,
        ),
    );
  }
  static sameStringSnapshot(current: ReadonlyMap<string, string>, snapshot: ReadonlyMap<string, string>): boolean {
    return current.size === snapshot.size && [...snapshot].every(([name, value]) => current.get(name) === value);
  }
  consumerSameFrame(module: Module, call: CallExpression, first: Captures, second: Captures): boolean {
    const key = this.referenceFingerprint(FactoryResolver.reference(module, call, first), new Set(), new Map(), {
      value: budget,
    });
    return (
      key !== undefined &&
      key ===
        this.referenceFingerprint(FactoryResolver.reference(module, call, second), new Set(), new Map(), {
          value: budget,
        })
    );
  }
  consumerSnapshotsClosed(): boolean {
    return (
      FactoryResolver.sameStringSnapshot(this.sources, this.consumerSourceSnapshot) &&
      FactoryResolver.sameStringSnapshot(this.packageExports, this.consumerExportSnapshot) &&
      FactoryResolver.sameStringSnapshot(this.contractSources, this.consumerContractSnapshot) &&
      this.conditionalPackageExports.size === this.consumerConditionalSnapshot.size &&
      [...this.consumerConditionalSnapshot].every(([name, files]) => {
        const current = this.conditionalPackageExports.get(name);
        return current?.length === files.length && files.every((file, index) => current[index] === file);
      })
    );
  }
  consumerCandidateSymbol(
    module: Module,
    input: Expression,
  ): { readonly binding: Binding; readonly module: Module } | undefined {
    const node = unwrap(input);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (binding === undefined || !stable(module, binding)) {
      return undefined;
    }
    if (binding.origin === undefined) {
      return { binding, module };
    }
    const target = this.candidateDependency(module, binding.origin.source);
    return target === undefined ? undefined : this.exportedSymbol(target, binding.origin.imported, new Set(), true);
  }
  consumerInventoryModules(): readonly Module[] | undefined {
    const modules: Module[] = [];
    for (const file of this.sources.keys()) {
      if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?tsx?$/u.test(file)) {
        continue;
      }
      const module = this.candidateModule(file);
      if (module === undefined) {
        return undefined;
      }
      modules.push(module);
    }
    return modules;
  }
  consumerPrivateExports(modules: readonly Module[], wanted: Binding, root: Module): boolean {
    const owner = this.path.dirname(this.path.dirname(root.file));
    for (const module of modules) {
      for (const statement of module.program.body) {
        if (statement.type !== 'ExportAllDeclaration' || statement.exportKind === 'type') {
          continue;
        }
        const target = this.candidateDependency(module, statement.source.value);
        if (
          target !== undefined &&
          [...target.exports.keys()].some(
            (name) => this.exportedSymbol(target, name, new Set(), true)?.binding === wanted,
          )
        ) {
          return false;
        }
      }
      const exportedNames = [...module.exports.keys()].filter(
        (name) => this.exportedSymbol(module, name, new Set(), true)?.binding === wanted,
      );
      if (exportedNames.length === 0) {
        continue;
      }
      const relative = this.path.relative(owner, module.file);
      if (
        relative.startsWith('..') ||
        this.path.isAbsolute(relative) ||
        [...this.packageExports.values()].includes(module.file) ||
        [...this.conditionalPackageExports.values()].some((files) => files.includes(module.file))
      ) {
        return false;
      }
    }
    return true;
  }
  consumerKeySurfaceClosed(modules: readonly Module[], wanted: Binding, definition: Module): boolean {
    const wantedKey = this.tagKeys.get(wanted);
    if (wantedKey === undefined) {
      return false;
    }
    const constructors = new Map<Binding, Module>();
    for (const module of modules) {
      if (!this.consumerModuleKeysClosed(module, wantedKey, wanted, definition, constructors)) {
        return false;
      }
    }
    const owner = constructors.get(wanted);
    return owner === definition && this.consumerConstructorKeysClosed(modules, new Map([[wanted, definition]]));
  }
  consumerConstructorKeysClosed(modules: readonly Module[], constructors: ReadonlyMap<Binding, Module>): boolean {
    for (const [binding, module] of constructors) {
      if (!this.consumerTagValueClosed(module, binding)) {
        return false;
      }
    }
    for (const module of modules) {
      if (!this.consumerConstructorStarsClosed(module, constructors)) {
        return false;
      }
      for (const imported of module.bindings.filter((binding) => binding.origin !== undefined)) {
        const { origin } = imported;
        const target = origin === undefined ? undefined : this.candidateDependency(module, origin.source);
        if (target === undefined) {
          continue;
        }
        if (
          origin?.imported === '*' &&
          [...target.exports.keys()].some((name) => {
            const symbol = this.exportedSymbol(target, name, new Set(), true);
            return symbol !== undefined && constructors.has(symbol.binding);
          })
        ) {
          return false;
        }
        const symbol = this.exportedSymbol(target, origin?.imported ?? '', new Set(), true);
        if (
          symbol !== undefined &&
          constructors.has(symbol.binding) &&
          !this.consumerTagValueClosed(module, imported)
        ) {
          return false;
        }
      }
    }
    return true;
  }
  consumerConstructorStarsClosed(module: Module, constructors: ReadonlyMap<Binding, Module>): boolean {
    for (const statement of module.program.body) {
      if (statement.type !== 'ExportAllDeclaration' || statement.exportKind === 'type') {
        continue;
      }
      const target = this.candidateDependency(module, statement.source.value);
      if (
        target !== undefined &&
        [...target.exports.keys()].some((name) => {
          const symbol = this.exportedSymbol(target, name, new Set(), true);
          return symbol !== undefined && constructors.has(symbol.binding);
        })
      ) {
        return false;
      }
    }
    return true;
  }
  static consumerConstructorOutput(module: Module, construction: CallExpression): Binding | undefined {
    const declaration = module.program.body
      .map((statement) => (statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement))
      .find((statement) => statement?.type === 'ClassDeclaration' && statement.superClass === construction);
    if (declaration?.type === 'ClassDeclaration') {
      return declaration.body.body.length === 0 && declaration.decorators.length === 0
        ? module.bindings.find((binding) => binding.node === declaration.id)
        : undefined;
    }
    return module.bindings.find((binding) => binding.init === construction);
  }
  consumerTagValueClosed(module: Module, binding: Binding, seen = new Set<Binding>()): boolean {
    if (seen.has(binding) || seen.size >= budget || !stable(module, binding)) {
      return false;
    }
    const next = new Set(seen).add(binding);
    if (
      module.bindings.some((alias) => {
        const input = alias.field?.expression ?? alias.init;
        return (
          alias !== binding && input !== undefined && this.schemaObjectPaths(module, input, binding, '').length > 0
        );
      })
    ) {
      return false;
    }
    const allowed: Span[] = [binding.node];
    for (const call of module.calls) {
      for (const [index, argument] of call.arguments.entries()) {
        const input = argument.type === 'SpreadElement' ? argument.argument : argument;
        if (this.schemaObjectPaths(module, input, binding, '').length === 0) {
          continue;
        }
        if (
          argument.type === 'SpreadElement' ||
          module.functions.some((fn) => inside(fn, argument)) ||
          !this.consumerTagArgumentClosed(module, call, index, next)
        ) {
          return false;
        }
        allowed.push(argument);
      }
    }
    return (
      this.consumerTagIdentifiersClosed(module, binding, allowed) &&
      this.objectCustody(module, binding, '', new Set(), true)
    );
  }
  consumerTagArgumentClosed(module: Module, call: CallExpression, index: number, seen: Set<Binding>): boolean {
    if (nativeReadonlyTagArgument(module, call, index, namespaceClosed)) {
      return true;
    }
    if (this.modules.get(module.file) !== module) {
      return false;
    }
    const source = this.function(module, unwrap(call.callee));
    if (
      call.optional ||
      call.arguments.some((argument) => argument.type === 'SpreadElement') ||
      source?.fn.type !== 'ArrowFunctionExpression' ||
      source.fn.async ||
      source.fn.generator ||
      !source.fn.params.every((parameter) => parameter.type === 'Identifier')
    ) {
      return false;
    }
    const parameter = source.fn.params[index];
    const binding = source?.module.bindings.find((value) => value.node === parameter);
    return (
      source !== undefined &&
      parameter?.type === 'Identifier' &&
      binding !== undefined &&
      this.consumerTagValueClosed(source.module, binding, seen)
    );
  }
  consumerTagIdentifiersClosed(module: Module, binding: Binding, allowed: Span[]): boolean {
    const exact = (node: Expression) => this.bindingPath(module, node, binding) === '';
    new Visitor({
      ExportNamedDeclaration(node) {
        if (node.source !== null || node.exportKind === 'type') {
          allowed.push(node);
          return;
        }
        for (const specifier of node.specifiers) {
          allowed.push(specifier.local);
        }
      },
      ImportDeclaration(node) {
        allowed.push(node);
      },
      MemberExpression(node) {
        if (exact(node.object) && !node.computed) {
          allowed.push(node.object);
        }
      },
      TSTypeAnnotation(node) {
        allowed.push(node);
      },
      TSTypeQuery(node) {
        allowed.push(node);
      },
      TSTypeReference(node) {
        allowed.push(node);
      },
      YieldExpression(node) {
        if (node.delegate && node.argument !== null && exact(node.argument)) {
          allowed.push(node.argument);
        }
      },
    }).visit(module.program);
    let closed = true;
    new Visitor({
      Identifier(node) {
        if (bindingAt(module, node.name, node) === binding && !allowed.some((span) => inside(node, span))) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  static consumerKeyConstruction(module: Module, node: Expression): CallExpression | undefined {
    const factory = module.calls.find((call) => unwrap(call.callee) === node);
    const outer = factory === undefined ? undefined : module.calls.find((call) => unwrap(call.callee) === factory);
    if (factory?.arguments.length === 0) {
      return outer;
    }
    return outer === undefined ? factory : undefined;
  }
  static consumerConstructorNamespace(source: string): boolean {
    return (
      source === nativeContextModule ||
      FactoryResolver.nativeSource(source, 'Context') ||
      FactoryResolver.nativeSource(source, 'HttpApiMiddleware')
    );
  }
  consumerModuleKeysClosed(
    module: Module,
    wantedKey: string,
    wanted: Binding,
    definition: Module,
    constructors: Map<Binding, Module>,
  ): boolean {
    if (
      module.bindings.some(
        (binding) =>
          binding.origin?.source === nativeContextModule ||
          (binding.origin?.imported === '*' && FactoryResolver.consumerConstructorNamespace(binding.origin.source)),
      )
    ) {
      return false;
    }
    if (
      module.program.body.some(
        (statement) =>
          (statement.type === 'ExportAllDeclaration' &&
            statement.exportKind !== 'type' &&
            FactoryResolver.consumerConstructorNamespace(statement.source.value)) ||
          (statement.type === 'ExportNamedDeclaration' &&
            statement.exportKind !== 'type' &&
            statement.source !== null &&
            FactoryResolver.consumerConstructorNamespace(statement.source.value) &&
            statement.specifiers.some(
              (specifier) =>
                specifier.exportKind !== 'type' &&
                specifier.local.type === 'Identifier' &&
                ['Context', 'Service', 'Reference', 'HttpApiMiddleware'].includes(specifier.local.name),
            )),
      )
    ) {
      return false;
    }
    let closed = true;
    const namespaces = module.bindings.filter(
      (binding) => binding.origin?.imported === 'Context' || binding.origin?.imported === 'HttpApiMiddleware',
    );
    const allowed = new Set(namespaces.map((binding) => binding.node.start));
    const ignored: Span[] = [];
    new Visitor({
      MemberExpression: (node) => {
        const binding = namespaces.find((value) => this.bindingPath(module, node.object, value) === '');
        if (binding === undefined) {
          return;
        }
        allowed.add(node.object.start);
        const member = propertyName(node);
        if (
          node.computed ||
          !['effect', nativeHttpApiModule, nativeEffectEdge, nativeEffectClient].includes(binding.origin?.source ?? '')
        ) {
          closed = false;
          return;
        }
        if (member !== 'Service' && member !== 'Reference') {
          return;
        }
        const construction = FactoryResolver.consumerKeyConstruction(module, node);
        const key = construction?.arguments[0];
        if (key?.type !== 'Literal' || !Schema.is(Schema.String)(key.value)) {
          closed = false;
          return;
        }
        const output =
          construction === undefined ? undefined : FactoryResolver.consumerConstructorOutput(module, construction);
        if (output === undefined || !namespaceClosed(module, binding)) {
          closed = false;
          return;
        }
        constructors.set(output, module);
        if (key.value === wantedKey) {
          const ownClass = module.program.body.some((statement) => {
            const ownDeclaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
            return (
              ownDeclaration?.type === 'ClassDeclaration' &&
              ownDeclaration.id === wanted.node &&
              ownDeclaration.superClass === construction
            );
          });
          closed &&= module === definition && ownClass;
        }
      },
      TSTypeAnnotation(node) {
        ignored.push(node);
      },
      TSTypeQuery(node) {
        ignored.push(node);
      },
      TSTypeReference(node) {
        ignored.push(node);
      },
    }).visit(module.program);
    new Visitor({
      Identifier: (node) => {
        if (
          namespaces.some((binding) => bindingAt(module, node.name, node) === binding) &&
          !allowed.has(node.start) &&
          !ignored.some((span) => inside(node, span))
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  consumerTagInventory(
    modules: readonly Module[],
    wanted: Binding,
    root: Module,
  ): { readonly call: CallExpression; readonly module: Module; readonly value: Expression } | undefined {
    const owner = this.path.dirname(this.path.dirname(root.file));
    const providers: { readonly call: CallExpression; readonly module: Module; readonly value: Expression }[] = [];
    for (const module of modules) {
      const namespaceEscape = module.bindings.some((binding) => {
        if (binding.origin?.imported !== '*') {
          return false;
        }
        const target = this.candidateDependency(module, binding.origin.source);
        return (
          target !== undefined &&
          [...target.exports.keys()].some(
            (name) => this.exportedSymbol(target, name, new Set(), true)?.binding === wanted,
          )
        );
      });
      if (namespaceEscape) {
        return undefined;
      }
      const aliases = module.bindings.filter((binding) => {
        if (binding === wanted) {
          return true;
        }
        if (binding.origin === undefined) {
          return false;
        }
        const target = this.candidateDependency(module, binding.origin.source);
        if (
          binding.origin.imported === '*' &&
          target !== undefined &&
          [...target.exports.keys()].some(
            (name) => this.exportedSymbol(target, name, new Set(), true)?.binding === wanted,
          )
        ) {
          return false;
        }
        return (
          target !== undefined &&
          this.exportedSymbol(target, binding.origin.imported, new Set(), true)?.binding === wanted
        );
      });
      if (aliases.length === 0) {
        continue;
      }
      const relative = this.path.relative(owner, module.file);
      if (
        relative.startsWith('..') ||
        this.path.isAbsolute(relative) ||
        !this.consumerTagReferencesClosed(module, aliases, providers)
      ) {
        return undefined;
      }
    }
    const [provider] = providers;
    return providers.length === 1 ? provider : undefined;
  }
  consumerTagReferencesClosed(
    module: Module,
    aliases: readonly Binding[],
    providers: { readonly call: CallExpression; readonly module: Module; readonly value: Expression }[],
  ): boolean {
    let closed = true;
    const allowed = new Set(aliases.map((binding) => binding.node.start));
    const ignored: Span[] = [];
    const exact = (node: Expression) => aliases.some((binding) => this.bindingPath(module, node, binding) === '');
    new Visitor({
      CallExpression: (node) => {
        const [tag, value] = node.arguments;
        if (tag === undefined || tag.type === 'SpreadElement' || !exact(tag)) {
          return;
        }
        if (
          node.optional ||
          node.arguments.length !== 2 ||
          value?.type !== 'ObjectExpression' ||
          ownDataFields(value) === undefined ||
          !this.native(module, node.callee, 'Layer', 'succeed')
        ) {
          closed = false;
          return;
        }
        allowed.add(tag.start);
        providers.push({ call: node, module, value });
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind !== 'type' && node.source === null) {
          for (const specifier of node.specifiers) {
            if (specifier.exportKind !== 'type' && exact(specifier.local)) {
              allowed.add(specifier.local.start);
            }
          }
        }
      },
      TSTypeAnnotation(node) {
        ignored.push(node);
      },
      TSTypeQuery(node) {
        ignored.push(node);
      },
      TSTypeReference(node) {
        ignored.push(node);
      },
      YieldExpression: (node) => {
        if (node.delegate && node.argument !== null && exact(node.argument)) {
          allowed.add(node.argument.start);
          const receiver = module.bindings.find(
            (binding) => binding.init !== undefined && unwrap(binding.init) === node,
          );
          if (
            this.modules.get(module.file) !== module ||
            receiver === undefined ||
            !this.objectCustody(module, receiver, '', new Set())
          ) {
            closed = false;
          }
        }
      },
    }).visit(module.program);
    new Visitor({
      Identifier: (node) => {
        if (
          aliases.some((binding) => bindingAt(module, node.name, node) === binding) &&
          !allowed.has(node.start) &&
          !ignored.some((span) => inside(node, span))
        ) {
          closed = false;
        }
      },
    }).visit(module.program);
    return closed;
  }
  consumerAcquisition(
    module: Module,
    call: CallExpression,
  ): { readonly acquisition: Expression; readonly tag: Binding } | undefined {
    const callee = unwrap(call.callee);
    if (
      call.optional ||
      call.arguments.some((argument) => argument.type === 'SpreadElement') ||
      callee.type !== 'MemberExpression' ||
      callee.computed ||
      callee.optional ||
      callee.object.type !== 'Identifier'
    ) {
      return undefined;
    }
    const receiver = bindingAt(module, callee.object.name, callee.object);
    const acquired = receiver?.init === undefined ? undefined : unwrap(receiver.init);
    if (
      receiver === undefined ||
      acquired?.type !== 'YieldExpression' ||
      !acquired.delegate ||
      acquired.argument === null ||
      !this.objectCustody(module, receiver, '', new Set())
    ) {
      return undefined;
    }
    const tag = this.tag(module, acquired.argument);
    return tag === undefined ? undefined : { acquisition: acquired.argument, tag };
  }
  consumerSourceProvider(
    tag: Binding,
    root: Module,
  ): { readonly call: CallExpression; readonly module: Module; readonly value: Expression } | undefined {
    const definition = [...this.modules.values()].find((value) => value.bindings.includes(tag));
    if (definition === undefined || this.ownerRoot(definition.file) !== root || !this.consumerSnapshotsClosed()) {
      return undefined;
    }
    const modules = this.consumerInventoryModules();
    if (
      modules === undefined ||
      !this.consumerPrivateExports(modules, tag, root) ||
      !this.consumerKeySurfaceClosed(modules, tag, definition)
    ) {
      return undefined;
    }
    const source = this.consumerTagInventory(modules, tag, root);
    return source !== undefined && this.modules.get(source.module.file) === source.module ? source : undefined;
  }
  consumerServiceSource(module: Module, call: CallExpression, captures: Captures): ConsumerCallableSource | undefined {
    const acquired = this.consumerAcquisition(module, call);
    const root = this.acquisitionProvider?.root ?? this.ownerRoot(module.file);
    if (acquired === undefined || root === undefined) {
      return undefined;
    }
    const { tag } = acquired;
    const source = this.consumerSourceProvider(tag, root);
    if (source === undefined) {
      return undefined;
    }
    const method = ownDataFields(source.value)?.get(propertyName(unwrap(call.callee)) ?? '');
    const target = method === undefined ? undefined : this.function(source.module, method);
    if (
      target === undefined ||
      target.fn.params.length !== call.arguments.length ||
      !target.fn.params.every((parameter) => parameter.type === 'Identifier')
    ) {
      return undefined;
    }
    const layer = FactoryResolver.reference(source.module, source.call, new Map());
    const providers = this.comparatorLayerProviders(layer, tag);
    const [provider] = providers ?? [];
    return providers?.length !== 1 || provider === undefined
      ? undefined
      : {
          acquisition: acquired.acquisition,
          call,
          caller: module,
          callerCaptures: captures,
          captures: FactoryResolver.captureCall(
            target.module,
            target.fn,
            call.arguments.filter((argument) => argument.type !== 'SpreadElement'),
            captures,
            module,
            target.captures,
          ),
          fn: target.fn,
          module: target.module,
          provider,
          tag,
        };
  }
  checkConsumerSource(source: ConsumerCallableSource, readModule: Module, read: Span, wanted: Binding): boolean {
    if (this.activeConsumerBodies.has(source.fn)) {
      return false;
    }
    this.activeConsumerBodies.add(source.fn);
    const wantedScoped = this.consumerKeyScopes.has(wanted);
    const receiverScoped = this.consumerKeyScopes.has(source.tag);
    this.consumerKeyScopes.add(wanted);
    this.consumerKeyScopes.add(source.tag);
    try {
      for (const call of source.module.calls.filter((candidate) => inside(candidate, source.fn))) {
        if (!this.consumerBodyCallClosed(source.module, call, readModule, read, wanted, source.captures)) {
          return false;
        }
      }
      this.consumerSourceCalls.set(source.call, source);
      try {
        const caller = FactoryResolver.nearestFunction(source.caller, source.call);
        const frames = [FactoryResolver.reference(source.module, source.fn, source.captures)];
        if (caller !== undefined) {
          frames.push(FactoryResolver.reference(source.caller, caller, source.callerCaptures));
        }
        const closed =
          this.requestedServiceContextClosed(source.tag) &&
          this.validateServiceContexts(source.caller, source.acquisition, source.tag, frames);
        if (closed) {
          this.consumerSourceProofUsed = true;
        }
        return closed;
      } finally {
        this.consumerSourceCalls.delete(source.call);
      }
    } finally {
      this.activeConsumerBodies.delete(source.fn);
      if (!wantedScoped) {
        this.consumerKeyScopes.delete(wanted);
      }
      if (!receiverScoped) {
        this.consumerKeyScopes.delete(source.tag);
      }
    }
  }
  layerConsumerContextClosed(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    wanted: Binding,
  ): boolean | undefined {
    const callee = unwrap(call.callee);
    if (
      callee.type === 'MemberExpression' &&
      propertyName(callee) === 'pipe' &&
      call.arguments.every(
        (argument) => argument.type !== 'SpreadElement' && this.layerTransformRole(module, argument),
      ) &&
      this.layerValueRole(FactoryResolver.reference(module, callee.object, new Map()), new Set(), 0)
    ) {
      return (
        this.layerAcquisitionClosed(module, call, wanted) ||
        !this.effectContainsRead(module, callee.object, readModule, read, new Set(), 0)
      );
    }
    if (
      call.arguments.length === 2 &&
      ['provide', 'provideMerge'].some((method) => this.native(module, callee, 'Layer', method))
    ) {
      const [consumer] = call.arguments;
      return (
        this.layerConstructorAcquisitionClosed(module, call, wanted) ||
        (consumer !== undefined &&
          consumer.type !== 'SpreadElement' &&
          !this.effectContainsRead(module, consumer, readModule, read, new Set(), 0))
      );
    }
    return undefined;
  }
  nativeContextProvider(module: Module, input: Expression, method: string, seen = new Set<Binding>()): boolean {
    if (this.native(module, input, 'Effect', method)) {
      return true;
    }
    const node = unwrap(input);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    if (
      binding === undefined ||
      seen.has(binding) ||
      seen.size >= budget ||
      !stable(module, binding) ||
      !directCallsOnly(module, binding)
    ) {
      return false;
    }
    return (
      binding.init !== undefined && this.nativeContextProvider(module, binding.init, method, new Set(seen).add(binding))
    );
  }
  nativeEffectFnBody(module: Module, call: CallExpression): Expression | undefined {
    const callee = unwrap(call.callee);
    if (
      !this.native(module, callee, 'Effect', 'fn') &&
      !(callee.type === 'CallExpression' && this.native(module, callee.callee, 'Effect', 'fn'))
    ) {
      return undefined;
    }
    const [body] = call.arguments;
    return body === undefined || body.type === 'SpreadElement' || functionValue(body) === undefined ? undefined : body;
  }
  layerConstructorAcquisitionClosed(module: Module, call: CallExpression, wanted: Binding): boolean {
    if (!['provide', 'provideMerge'].some((method) => this.native(module, call.callee, 'Layer', method))) {
      return true;
    }
    const provider = call.arguments.at(-1);
    const providerSource = this.contextSourceProvider(wanted);
    return (
      providerSource !== undefined &&
      provider !== undefined &&
      provider.type !== 'SpreadElement' &&
      this.layerDependencyCompatible(FactoryResolver.reference(module, provider, new Map()), wanted, providerSource)
    );
  }
  contextSourceProvider(wanted: Binding): LayerCandidate | undefined {
    if (this.acquisitionProvider?.binding === wanted) {
      return this.acquisitionProvider.provider;
    }
    const source = [...this.consumerSourceCalls.values()].find((value) => value.tag === wanted);
    return source !== undefined && this.consumerSnapshotsClosed() ? source.provider : undefined;
  }
  layerAcquisitionClosed(module: Module, call: CallExpression, wanted: Binding): boolean {
    const providerSource = this.contextSourceProvider(wanted);
    if (providerSource === undefined) {
      return false;
    }
    for (const argument of call.arguments) {
      if (argument.type === 'SpreadElement') {
        return false;
      }
      const transform = unwrap(argument);
      if (transform.type === 'CallExpression') {
        const [provider] = transform.arguments;
        if (
          provider === undefined ||
          provider.type === 'SpreadElement' ||
          !this.layerDependencyCompatible(
            FactoryResolver.reference(module, provider, new Map()),
            wanted,
            providerSource,
          )
        ) {
          return false;
        }
      }
    }
    return true;
  }
  layerDependencyCompatible(reference: Reference, wanted: Binding, expected: LayerCandidate): boolean {
    if (!this.closedLayer(reference, new Set(), 0)) {
      return false;
    }
    const fixed = this.currentFixedOutputs;
    this.currentFixedOutputs = new Set();
    const local = new Set<CallExpression>();
    this.layers(reference, local, new Set(), 0);
    const collision = this.currentFixedOutputs.has(this.tagKeys.get(wanted) ?? '');
    this.currentFixedOutputs = fixed;
    const candidates = this.providerCandidates(
      local,
      wanted,
      this.native(expected.module, expected.call.callee, 'Layer', 'succeed'),
    );
    if (collision || candidates === undefined) {
      return false;
    }
    const expectedKey = this.referenceFingerprint(expected.frame, new Set(), new Map(), { value: budget });
    return (
      expectedKey !== undefined &&
      candidates.every(
        (candidate) =>
          candidate.call === expected.call &&
          this.referenceFingerprint(candidate.frame, new Set(), new Map(), { value: budget }) === expectedKey,
      )
    );
  }
  disjointContextProvision(
    module: Module,
    call: CallExpression,
    binding: Binding,
    captures: Captures = new Map(),
  ): boolean {
    const context = call.arguments.at(-1);
    const genuine = ['provideServices', 'provideContext'].some((method) =>
      this.nativeContextProvider(module, call.callee, method),
    );
    const keys =
      context === undefined || context.type === 'SpreadElement' || !genuine
        ? undefined
        : this.providedContextKeys(module, context, new Set(), binding, captures);
    return keys !== undefined && !keys.includes(this.tagKeys.get(binding) ?? '');
  }
  contextProvisionReads(
    module: Module,
    call: CallExpression,
    readModule: Module,
    read: Span,
    captures: Captures = new Map(),
  ): boolean {
    const [first] = call.arguments;
    if (
      call.arguments.length === 2 &&
      first !== undefined &&
      first.type !== 'SpreadElement' &&
      (this.effectCarrierRead(FactoryResolver.reference(module, first, captures), readModule, read) ||
        this.effectContainsRead(module, first, readModule, read, new Set(), 0, true, captures))
    ) {
      return true;
    }
    if (
      module.calls.some(
        (parent) =>
          unwrap(parent.callee) === call &&
          parent.arguments.some(
            (argument) =>
              argument.type !== 'SpreadElement' &&
              (this.effectCarrierRead(FactoryResolver.reference(module, argument, captures), readModule, read) ||
                this.effectContainsRead(module, argument, readModule, read, new Set(), 0, true, captures)),
          ),
      )
    ) {
      return true;
    }
    return module.calls.some((parent) => {
      const callee = unwrap(parent.callee);
      return (
        callee.type === 'MemberExpression' &&
        propertyName(callee) === 'pipe' &&
        parent.arguments.includes(call) &&
        (this.effectCarrierRead(FactoryResolver.reference(module, callee.object, captures), readModule, read) ||
          this.effectContainsRead(module, callee.object, readModule, read, new Set(), 0, true, captures))
      );
    });
  }
  contextProviderOrigin(module: Module, input: Expression, seen = new Set<Binding>()): boolean {
    if (['provideServices', 'provideContext'].some((method) => this.native(module, input, 'Effect', method))) {
      return true;
    }
    const node = unwrap(input);
    const binding = node.type === 'Identifier' ? bindingAt(module, node.name, node) : undefined;
    return (
      binding !== undefined &&
      binding.init !== undefined &&
      !seen.has(binding) &&
      seen.size < budget &&
      this.contextProviderOrigin(module, binding.init, new Set(seen).add(binding))
    );
  }
  contextProvideCall(module: Module, call: CallExpression): boolean {
    return !call.optional && [1, 2].includes(call.arguments.length) && this.contextProviderOrigin(module, call.callee);
  }
  requestedServiceContextClosed(binding: Binding): boolean {
    for (const module of this.modules.values()) {
      for (const call of module.calls) {
        const callee = unwrap(call.callee);
        if (
          callee.type === 'MemberExpression' &&
          propertyName(callee) === 'context' &&
          this.outputTag(module, callee.object)?.key === this.tagKeys.get(binding)
        ) {
          return false;
        }
        if (
          this.native(module, call.callee, 'Effect', 'provideService') ||
          ['make', 'add'].some((method) => this.native(module, call.callee, 'Context', method))
        ) {
          for (const argument of call.arguments) {
            if (
              argument.type !== 'SpreadElement' &&
              this.outputTag(module, argument)?.key === this.tagKeys.get(binding)
            ) {
              return false;
            }
          }
        }
      }
    }
    return true;
  }
  providerCandidates(
    mounted: ReadonlySet<CallExpression>,
    binding: Binding,
    sourceValues = false,
  ): readonly LayerCandidate[] | undefined {
    const candidates: LayerCandidate[] = [];
    for (const target of this.modules.values()) {
      for (const call of target.calls.filter((value) => mounted.has(value))) {
        const values = this.providerCallCandidates(target, call, binding, sourceValues);
        if (values === undefined) {
          return undefined;
        }
        candidates.push(...values);
      }
    }
    return candidates;
  }
  static sourceProviderKind(kind: string | undefined, sourceValues: boolean): boolean {
    return kind === 'effect' || (sourceValues && kind === 'succeed');
  }
  providerCallCandidates(
    target: Module,
    call: CallExpression,
    binding: Binding,
    sourceValues = false,
  ): readonly LayerCandidate[] | undefined {
    const producer = this.layerProducer(target, call);
    const frames = [...(this.layerFrames.get(call)?.values() ?? [])];
    const middleware = frames.length > 0 && frames.every((frame) => this.middlewareLayer(target, call, frame.captures));
    const [first] = call.arguments;
    const input = producer?.tag ?? (first?.type === 'SpreadElement' ? undefined : first);
    if ((producer === undefined && !middleware) || input === undefined) {
      return [];
    }
    const candidates: LayerCandidate[] = [];
    for (const frame of frames) {
      const outputIdentity = this.consumerScopedOutputTag(target, input, binding, frame.captures);
      if (this.consumerKeyScopes.has(binding) && outputIdentity === undefined) {
        return undefined;
      }
      if (outputIdentity !== undefined && outputIdentity.key === this.tagKeys.get(binding)) {
        if (
          producer === undefined ||
          !FactoryResolver.sourceProviderKind(producer.kind, sourceValues) ||
          outputIdentity.binding !== binding
        ) {
          return undefined;
        }
        candidates.push({ call, frame, module: target, program: producer.program });
      }
    }
    return candidates;
  }
  callerModules(module: Module, fn: Implementation, methodName?: string): readonly Module[] | undefined {
    const exportedNames = new Set<string>();
    const wantedSymbols = new Set<string>();
    const ownBindings = bindingSyntax(module).initialized.filter(
      (binding) => binding.init !== undefined && this.function(module, binding.init)?.fn === fn,
    );
    if (
      methodName === undefined &&
      !ownBindings.some((binding) => [...module.exports.values()].includes(binding.name))
    ) {
      return [module];
    }
    for (const binding of ownBindings) {
      wantedSymbols.add(`${module.file}:${binding.node.start}`);
      exportedNames.add(binding.name);
      for (const [exported, local] of module.exports) {
        if (local === binding.name) {
          exportedNames.add(exported);
        }
      }
    }
    if (
      ownBindings.some((binding) => [...module.exports.values()].includes(binding.name)) &&
      [...this.packageExports.values()].includes(module.file)
    ) {
      return undefined;
    }
    if (methodName !== undefined) {
      this.addFactoryCallerTargets(module, fn, exportedNames, wantedSymbols);
    }
    // This inventory is synchronous and inspects ASTs only; it never executes source callbacks or awaits.
    // External source/metadata snapshots are rechecked for every invocation; all local module writes advance mutation.
    const query = { mutation: this.moduleMutationRevision, revision: this.structuralQueryRevision() };
    const result: Module[] = [];
    const files = this.callerCandidateFiles(module, fn, methodName, exportedNames, wantedSymbols, query);
    for (const [file] of files) {
      const consumer = this.modules.get(file) ?? this.candidateModule(file);
      this.refreshCallerInventory(query);
      if (
        consumer === undefined ||
        (consumer !== module && !this.candidateImportsWanted(consumer, wantedSymbols, query))
      ) {
        continue;
      }
      if (!this.closedFunctionImports(module, consumer, exportedNames)) {
        return undefined;
      }
      if (!this.modules.has(file)) {
        return undefined;
      }
      result.push(consumer);
      this.refreshCallerInventory(query);
    }
    return result;
  }
  refreshCallerInventory(query: CallerInventoryQuery): void {
    if (query.mutation !== this.moduleMutationRevision) {
      query.revision = this.structuralQueryRevision();
      query.mutation = this.moduleMutationRevision;
    }
  }
  structuralQueryRevision(): number {
    const sourcesMatch =
      this.structuralSources.size === this.sources.size &&
      [...this.sources].every(([file, source]) => this.structuralSources.get(file) === source);
    const runtimeMatches = this.sameRuntimeCohort(this.structuralRuntime);
    const candidatesMatch =
      this.structuralCandidates.size === this.parsedCandidates.size &&
      [...this.parsedCandidates.values()].every((module) => this.structuralCandidates.has(module));
    const metadataMatches =
      FactoryResolver.sameStringMap(this.structuralPackageExports, this.packageExports) &&
      FactoryResolver.sameStringMap(this.structuralContracts, this.contractSources) &&
      FactoryResolver.sameStringMap(this.structuralRelativeContracts, this.relativeContractSources) &&
      this.structuralConditionalExports.size === this.conditionalPackageExports.size &&
      [...this.conditionalPackageExports].every(([key, paths]) => {
        const previous = this.structuralConditionalExports.get(key);
        return (
          previous !== undefined &&
          previous.length === paths.length &&
          paths.every((path, index) => path === previous[index])
        );
      });
    if (!sourcesMatch || !runtimeMatches || !candidatesMatch || !metadataMatches) {
      this.structuralSources = new Map(this.sources);
      this.structuralPackageExports = new Map(this.packageExports);
      this.structuralContracts = new Map(this.contractSources);
      this.structuralRelativeContracts = new Map(this.relativeContractSources);
      this.structuralConditionalExports = new Map(
        [...this.conditionalPackageExports].map(([key, paths]) => [key, [...paths]]),
      );
      this.structuralRuntime = new Set(this.modules.values());
      this.structuralCandidates = new Set(this.parsedCandidates.values());
      this.structuralRevision += 1;
    }
    return this.structuralRevision;
  }
  callerCandidateFiles(
    module: Module,
    fn: Implementation,
    methodName: string | undefined,
    exportedNames: ReadonlySet<string>,
    wantedSymbols: ReadonlySet<string>,
    query: CallerInventoryQuery,
  ): readonly (readonly [string, string])[] {
    const { revision } = query;
    const records = this.callerCandidateFacts.get(fn) ?? [];
    const cached = records.find(
      (fact) =>
        fact.program === module.program &&
        fact.file === module.file &&
        fact.methodName === methodName &&
        fact.revision === revision &&
        FactoryResolver.sameSetMembers(fact.exportedNames, exportedNames) &&
        FactoryResolver.sameSetMembers(fact.wantedSymbols, wantedSymbols),
    );
    if (cached !== undefined) {
      return cached.files;
    }
    const exportedNameList = [...exportedNames];
    const basename = this.path.basename(module.file).replace(/\.[cm]?tsx?$/u, '');
    const files = [...this.sources].filter(
      ([file, source]) =>
        file === module.file || source.includes(basename) || exportedNameList.some((name) => source.includes(name)),
    );
    this.refreshCallerInventory(query);
    if (query.revision === revision) {
      this.callerCandidateFacts.set(fn, [
        ...records.filter((fact) => fact.revision === revision),
        {
          exportedNames: new Set(exportedNames),
          file: module.file,
          files,
          methodName,
          program: module.program,
          revision,
          wantedSymbols: new Set(wantedSymbols),
        },
      ]);
    }
    return files;
  }
  static sameStringMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
    return left.size === right.size && [...right].every(([key, value]) => left.get(key) === value);
  }
  static sameSetMembers<Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
  }
  addFactoryCallerTargets(
    module: Module,
    fn: Implementation,
    exportedNames: Set<string>,
    wantedSymbols: Set<string>,
  ): void {
    for (const call of module.calls) {
      if (this.native(module, call.callee, 'Layer', 'effect') && inside(fn, call)) {
        const [tag] = call.arguments;
        const binding = tag === undefined || tag.type === 'SpreadElement' ? undefined : this.outputTag(module, tag);
        if (binding?.binding !== undefined) {
          exportedNames.add(binding.binding.name);
          const symbol = tag === undefined || tag.type === 'SpreadElement' ? undefined : this.symbol(module, tag);
          if (symbol !== undefined) {
            wantedSymbols.add(`${symbol.module.file}:${symbol.binding.node.start}`);
          }
        }
      }
    }
  }
  canonicalCandidateImport(
    module: Module,
    binding: Binding,
    name: string,
    query: CallerInventoryQuery,
  ): CanonicalImportFact['symbol'] | undefined {
    const { revision } = query;
    let bindings = this.canonicalImportFacts.get(module);
    if (bindings === undefined) {
      bindings = new WeakMap();
      this.canonicalImportFacts.set(module, bindings);
    }
    let importedFacts = bindings.get(binding);
    if (importedFacts === undefined) {
      importedFacts = new Map();
      bindings.set(binding, importedFacts);
    }
    const known = importedFacts.get(name);
    if (known?.program === module.program && known.revision === revision) {
      return known.symbol;
    }
    const target = binding.origin === undefined ? undefined : this.candidateDependency(module, binding.origin.source);
    const symbol = target === undefined ? undefined : this.exportedSymbol(target, name, new Set(), true);
    this.refreshCallerInventory(query);
    if (symbol !== undefined && query.revision === revision) {
      importedFacts.set(name, { program: module.program, revision, symbol });
    }
    return symbol;
  }
  candidateImportsWanted(module: Module, wanted: ReadonlySet<string>, query: CallerInventoryQuery): boolean {
    return bindingSyntax(module).origins.some((binding) => {
      const { origin } = binding;
      if (origin === undefined) {
        return false;
      }
      const target = origin.imported === '*' ? this.candidateDependency(module, origin.source) : undefined;
      this.refreshCallerInventory(query);
      const importedNames = origin.imported === '*' ? [...(target?.exports.keys() ?? [])] : [origin.imported];
      return importedNames.some((name) => {
        const symbol = this.canonicalCandidateImport(module, binding, name, query);
        return symbol !== undefined && wanted.has(`${symbol.module.file}:${symbol.binding.node.start}`);
      });
    });
  }
  closedFunctionImports(target: Module, consumer: Module, exportedNames: ReadonlySet<string>): boolean {
    for (const binding of consumer.bindings) {
      if (
        binding.origin === undefined ||
        this.candidateDependency(consumer, binding.origin.source)?.file !== target.file
      ) {
        continue;
      }
      if (binding.origin.imported === '*') {
        return false;
      }
      if (
        exportedNames.has(binding.origin.imported) &&
        (!stable(consumer, binding) || !directCallsOnly(consumer, binding))
      ) {
        return false;
      }
    }
    for (const statement of consumer.program.body) {
      if (
        (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') &&
        statement.exportKind !== 'type' &&
        statement.source !== null &&
        this.candidateDependency(consumer, statement.source.value)?.file === target.file
      ) {
        return false;
      }
    }
    let closed = true;
    new Visitor({
      ImportExpression: (node) => {
        if (
          node.source.type === 'Literal' &&
          Schema.is(Schema.String)(node.source.value) &&
          this.candidateDependency(consumer, node.source.value)?.file === target.file
        ) {
          closed = false;
        }
      },
    }).visit(consumer.program);
    return closed;
  }
  parameterValues(
    module: Module,
    binding: Binding,
    captures: Captures,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const { parameter } = binding;
    if (parameter === undefined) {
      return undefined;
    }
    const mapped = this.mappedParameter(module, binding, captures, seen, hops);
    if (mapped !== undefined) {
      return mapped;
    }
    for (const candidateBinding of module.bindings) {
      if (
        candidateBinding.init !== undefined &&
        this.function(module, candidateBinding.init)?.fn === parameter.fn &&
        !directCallsOnly(module, candidateBinding)
      ) {
        return undefined;
      }
    }

    const results: ObjectValue[] = [];
    let methodName: string | undefined;
    new Visitor({
      Property(node) {
        if (node.value === parameter.fn && !node.computed && node.key.type === 'Identifier') {
          methodName = node.key.name;
        }
      },
    }).visit(module.program);
    const callers = this.callerModules(module, parameter.fn, methodName);
    if (callers === undefined) {
      return undefined;
    }
    for (const caller of callers) {
      for (const call of caller.calls) {
        if (!this.matchesCaller(caller, call, module, parameter.fn, methodName, captures, seen, hops)) {
          continue;
        }
        const argument = call.arguments[parameter.index];
        if (argument === undefined || argument.type === 'SpreadElement') {
          return undefined;
        }
        const values = this.values(FactoryResolver.reference(caller, argument, captures), seen, hops + 1);
        if (values === undefined) {
          return undefined;
        }
        results.push(...values);
      }
    }
    return results.length === 0 ? undefined : results;
  }
  matchesCaller(
    caller: Module,
    call: CallExpression,
    module: Module,
    fn: Implementation,
    name: string | undefined,
    captures: Captures,
    seen: Set<Binding>,
    hops: number,
  ): boolean {
    const direct = this.function(caller, call.callee);
    if (direct?.fn === fn && direct.module === module) {
      return true;
    }
    const callee = unwrap(call.callee);
    if (name === undefined || callee.type !== 'MemberExpression' || propertyName(callee) !== name) {
      return false;
    }
    const objects = this.values(FactoryResolver.reference(caller, callee.object, captures), seen, hops + 1);
    return objects?.some((object) => object.module === module && FactoryResolver.method(object, name) === fn) ?? false;
  }
  mappedParameter(
    module: Module,
    binding: Binding,
    captures: Captures,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const { parameter } = binding;
    if (parameter === undefined) {
      return undefined;
    }
    const mapCall = module.calls.find(
      (call) =>
        call.arguments.some((argument) => argument === parameter.fn) &&
        ['map', 'flatMap'].some((method) => this.native(module, call.callee, 'Effect', method)),
    );
    if (mapCall !== undefined) {
      const pipe = module.calls.find(
        (call) =>
          call.arguments.includes(mapCall) &&
          call.callee.type === 'MemberExpression' &&
          propertyName(call.callee) === 'pipe',
      );
      if (pipe?.callee.type === 'MemberExpression') {
        const source = unwrap(pipe.callee.object);
        const pattern = parameter.fn.params[parameter.index];
        const objectValue = this.mappedObject(module, binding, source, captures, seen, hops);
        if (objectValue !== undefined) {
          return objectValue;
        }
        if (
          pattern?.type === 'ArrayPattern' &&
          source.type === 'CallExpression' &&
          this.native(module, source.callee, 'Effect', 'all')
        ) {
          const [inputs] = source.arguments;
          const index = pattern.elements.findIndex(
            (element) => element !== null && names(element).some((name) => name.start === binding.node.start),
          );
          const input = inputs?.type === 'ArrayExpression' ? inputs.elements.at(index) : undefined;
          return input === undefined || input === null || input.type === 'SpreadElement'
            ? undefined
            : this.values(FactoryResolver.reference(module, input, captures), seen, hops + 1);
        }
        return this.values(FactoryResolver.reference(module, source, captures), seen, hops + 1);
      }
    }

    return undefined;
  }
  mappedObject(
    module: Module,
    binding: Binding,
    source: Expression,
    captures: Captures,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const pattern = binding.parameter?.fn.params[binding.parameter.index];
    if (
      pattern?.type === 'ObjectPattern' &&
      source.type === 'CallExpression' &&
      this.native(module, source.callee, 'Effect', 'all')
    ) {
      const [inputs] = source.arguments;
      const property = pattern.properties.find(
        (entry) => entry.type === 'Property' && names(entry.value).some((name) => name.start === binding.node.start),
      );
      if (property?.type === 'Property' && property.key.type === 'Identifier' && inputs?.type === 'ObjectExpression') {
        return this.fieldValues([{ captures, expression: inputs, module }], property.key.name, seen, hops + 1);
      }
      return undefined;
    }

    return undefined;
  }
  memberValues(reference: Reference, seen: Set<Binding>, hops: number): readonly ObjectValue[] | undefined {
    const node = unwrap(reference.expression);
    if (node.type !== 'MemberExpression' || node.computed) {
      return undefined;
    }
    const name = propertyName(node);
    const objects = this.values(
      FactoryResolver.reference(reference.module, node.object, reference.captures),
      seen,
      hops + 1,
    );
    if (objects === undefined || name === undefined) {
      return undefined;
    }
    return this.fieldValues(objects, name, seen, hops);
  }
  fieldValues(
    objects: readonly ObjectValue[],
    name: string,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const result: ObjectValue[] = [];
    for (const object of objects) {
      const field = ownDataFields(object.expression)?.get(name);
      if (field === undefined) {
        return undefined;
      }
      const nested = this.values(FactoryResolver.reference(object.module, field, object.captures), seen, hops + 1);
      if (nested === undefined) {
        return undefined;
      }
      result.push(...nested);
    }
    return result;
  }
  callValues(
    reference: Reference,
    call: CallExpression,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const { captures, module } = reference;
    if (call.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return undefined;
    }
    const args = call.arguments.filter((argument) => argument.type !== 'SpreadElement');
    const callee = unwrap(call.callee);
    if (callee.type === 'MemberExpression') {
      if (
        callee.object.type === 'Identifier' &&
        callee.object.name === 'Object' &&
        propertyName(callee) === 'freeze' &&
        bindingAt(module, 'Object', callee.object) === undefined &&
        objectIntrinsicClosed(module)
      ) {
        const [input] = args;
        return input === undefined
          ? undefined
          : this.values(FactoryResolver.reference(module, input, captures), seen, hops + 1);
      }
      const receivers = this.values(FactoryResolver.reference(module, callee.object, captures), seen, hops + 1);
      const name = propertyName(callee);
      if (receivers === undefined || name === undefined) {
        return undefined;
      }
      const result: ObjectValue[] = [];
      for (const receiver of receivers) {
        const fn = FactoryResolver.method(receiver, name);
        const returned = fn === undefined ? undefined : directReturn(fn, receiver.module.program);
        if (fn === undefined || returned === undefined) {
          return undefined;
        }
        const values = this.values(
          FactoryResolver.reference(
            receiver.module,
            returned,
            FactoryResolver.captureCall(receiver.module, fn, args, receiver.captures, module),
          ),
          seen,
          hops + 1,
        );
        if (values === undefined) {
          return undefined;
        }
        result.push(
          ...values.map((value) =>
            receiver.authority === undefined ? value : { ...value, authority: receiver.authority },
          ),
        );
      }
      return result;
    }
    const fn = this.function(module, callee);
    const returned = fn === undefined ? undefined : directReturn(fn.fn, fn.module.program);
    return fn === undefined || returned === undefined
      ? undefined
      : this.values(
          FactoryResolver.reference(
            fn.module,
            returned,
            FactoryResolver.captureCall(fn.module, fn.fn, args, captures, module),
          ),
          seen,
          hops + 1,
        );
  }
  destructuredValues(
    module: Module,
    binding: Binding,
    captures: Captures,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    if (binding.field === undefined) {
      return undefined;
    }
    const objects = this.values(
      FactoryResolver.reference(module, binding.field.expression, captures),
      new Set(seen).add(binding),
      hops + 1,
    );
    return objects === undefined ? undefined : this.fieldValues(objects, binding.field.key, seen, hops + 1);
  }
  objectPaths(module: Module, input: Expression, binding: Binding, suffix: string): readonly string[] {
    const node = unwrap(input);
    const path = this.bindingPath(module, node, binding);
    if (path !== undefined) {
      if (path === suffix) {
        return [''];
      }
      return suffix.startsWith(path.length === 0 ? '' : `${path}.`)
        ? [path.length === 0 ? suffix : suffix.slice(path.length + 1)]
        : [];
    }
    if (node.type !== 'ObjectExpression') {
      return [];
    }
    return node.properties.flatMap((property) => {
      if (property.type === 'SpreadElement') {
        return this.objectPaths(module, property.argument, binding, suffix);
      }
      if (property.computed || property.key.type !== 'Identifier') {
        return [];
      }
      const { name } = property.key;
      return this.objectPaths(module, property.value, binding, suffix).map((childPath) =>
        childPath.length === 0 ? name : `${name}.${childPath}`,
      );
    });
  }
  bindingPath(module: Module, input: Expression, binding: Binding): string | undefined {
    const node = unwrap(input);
    if (node.type === 'Identifier') {
      return bindingAt(module, node.name, node) === binding ? '' : undefined;
    }
    if (node.type !== 'MemberExpression') {
      return undefined;
    }
    let field: string | undefined;
    if (!node.computed && node.property.type === 'Identifier') {
      field = node.property.name;
    }
    if (
      node.computed &&
      node.property.type === 'Literal' &&
      (Schema.is(Schema.String)(node.property.value) || Schema.is(Schema.Number)(node.property.value))
    ) {
      field = String(node.property.value);
    }
    if (field === undefined) {
      return undefined;
    }
    const base = this.bindingPath(module, node.object, binding);
    if (base === undefined) {
      return undefined;
    }
    return base.length === 0 ? field : `${base}.${field}`;
  }
  static aliasSuffix(alias: Binding, path: string): string | undefined {
    if (alias.field === undefined) {
      return path;
    }
    if (path === alias.field.key) {
      return '';
    }
    return path.startsWith(`${alias.field.key}.`) ? path.slice(alias.field.key.length + 1) : undefined;
  }
  custodyObjectPaths(
    module: Module,
    input: Expression,
    binding: Binding,
    suffix: string,
    schemaMode: boolean,
    borrower?: RecordBorrower,
  ): readonly string[] {
    return schemaMode || borrower !== undefined
      ? this.schemaObjectPaths(module, input, binding, suffix)
      : this.objectPaths(module, input, binding, suffix);
  }
  custodyAliases(
    module: Module,
    binding: Binding,
    suffix: string,
    next: Set<string>,
    tagMode = false,
    schemaMode = false,
    borrower?: RecordBorrower,
  ): boolean {
    for (const alias of module.bindings) {
      const input = alias.field?.expression ?? alias.init;
      if (alias === binding || input === undefined) {
        continue;
      }
      const paths = this.custodyObjectPaths(module, input, binding, suffix, schemaMode, borrower);
      for (const path of paths) {
        const selected = FactoryResolver.aliasSuffix(alias, path);
        if (
          selected !== undefined &&
          !this.objectCustody(module, alias, selected, next, tagMode, schemaMode, borrower)
        ) {
          return false;
        }
      }
    }
    return true;
  }
  custodyArgument(
    module: Module,
    binding: Binding,
    suffix: string,
    next: Set<string>,
    call: CallExpression,
    index: number,
    tagMode = false,
    schemaMode = false,
    borrower?: RecordBorrower,
  ): boolean {
    const argument = call.arguments[index];
    if (argument === undefined || argument.type === 'SpreadElement' || inside(binding.scope, argument)) {
      return true;
    }
    const paths = this.custodyObjectPaths(module, argument, binding, suffix, schemaMode, borrower);
    if (paths.length === 0) {
      return true;
    }
    const callee = unwrap(call.callee);
    if (schemaMode && this.nativeSchemaBorrower(module, call, index)) {
      return true;
    }
    if (tagMode && this.nativeTagConsumer(module, call, index)) {
      return true;
    }
    if (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      propertyName(callee) === 'freeze' &&
      objectIntrinsicClosed(module)
    ) {
      return true;
    }
    if (borrower !== undefined) {
      return borrower.argument(module, binding, suffix, next, call, index);
    }
    const direct = this.function(module, callee);
    const candidates =
      direct === undefined
        ? this.resolve({ callee, file: module.file })
        : [FactoryResolver.candidate(direct.module, direct.fn, new Map())];
    if (candidates === undefined) {
      return false;
    }
    return candidates.every((candidate) => {
      const target = this.module(candidate.file);
      const parameter = candidate.implementation.params[index];
      if (target === undefined || parameter?.type !== 'Identifier') {
        return false;
      }
      const receiver = bindingAt(target, parameter.name, parameter);
      return (
        receiver !== undefined &&
        paths.every((path) => this.objectCustody(target, receiver, path, next, tagMode, schemaMode))
      );
    });
  }
  nativeTagConsumer(module: Module, call: CallExpression, index: number): boolean {
    const callee = unwrap(call.callee);
    if (
      index === 0 &&
      callee.type === 'MemberExpression' &&
      propertyName(callee) === 'middleware' &&
      this.nativeHttpContract(module, callee.object, new Set(), 0) !== undefined
    ) {
      return true;
    }

    for (const [namespace, methods] of [
      ['Layer', ['effect', 'succeed']],
      ['Effect', ['serviceOption', 'service', 'all', 'provideService']],
      ['Context', ['make', 'add', 'get', 'getOrUndefined', 'omit']],
      ['HttpApiMiddleware', ['layerSchemaErrorTransform']],
    ] as const) {
      if (
        methods.some(
          (method) =>
            readonlyNativeTagSlot(namespace, method, call.arguments.length, index) &&
            this.native(module, call.callee, namespace, method),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  nativeHttpContract(
    module: Module,
    input: Expression,
    seen: Set<Binding>,
    hops: number,
  ): 'api' | 'group' | 'endpoint' | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const node = unwrap(input);
    if (node.type === 'Identifier') {
      const local = bindingAt(module, node.name, node);
      const symbol = this.symbol(module, node);
      if (
        symbol === undefined ||
        seen.has(symbol.binding) ||
        symbol.binding.init === undefined ||
        (local !== undefined && !this.builderCustody(module, local)) ||
        !this.builderCustody(symbol.module, symbol.binding)
      ) {
        return undefined;
      }
      return this.nativeHttpContract(symbol.module, symbol.binding.init, new Set(seen).add(symbol.binding), hops + 1);
    }
    if (
      node.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const args = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
    if (this.native(module, node.callee, 'HttpApi', 'make')) {
      return 'api';
    }
    if (this.native(module, node.callee, 'HttpApiGroup', 'make')) {
      return 'group';
    }
    if (
      ['get', 'post', 'put', 'patch', 'del', 'head', 'options'].some((method) =>
        this.native(module, node.callee, 'HttpApiEndpoint', method),
      )
    ) {
      return 'endpoint';
    }
    return this.nativeHttpContractChain(module, node, args, seen, hops);
  }
  nativeHttpContractChain(
    module: Module,
    node: CallExpression,
    args: readonly Expression[],
    seen: Set<Binding>,
    hops: number,
  ): 'api' | 'group' | 'endpoint' | undefined {
    const callee = unwrap(node.callee);
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) {
      return undefined;
    }
    const method = propertyName(callee);
    const receiver = this.nativeHttpContract(module, callee.object, seen, hops + 1);
    if (receiver === undefined) {
      return undefined;
    }
    if (method === 'add' || method === 'addHttpApi') {
      let expected: 'api' | 'group' | 'endpoint' = 'endpoint';
      if (method === 'addHttpApi') {
        expected = 'api';
      } else if (receiver === 'api') {
        expected = 'group';
      }
      return args.length > 0 &&
        args.every((argument) => this.nativeHttpContract(module, argument, new Set(seen), hops + 1) === expected)
        ? receiver
        : undefined;
    }
    return [
      'middleware',
      'prefix',
      'annotate',
      'annotateMerge',
      'annotateEndpoints',
      'annotateEndpointsMerge',
    ].includes(method ?? '')
      ? receiver
      : undefined;
  }
  builderCustody(module: Module, binding: Binding, seen = new Set<Binding>()): boolean {
    if (seen.has(binding) || seen.size >= budget || !stable(module, binding)) {
      return false;
    }
    const next = new Set(seen).add(binding);
    const aliases = module.bindings.filter(
      (alias) =>
        alias !== binding && alias.init !== undefined && this.objectPaths(module, alias.init, binding, '').length > 0,
    );
    if (
      !aliases.every(
        (alias) =>
          alias.init !== undefined &&
          this.objectPaths(module, alias.init, binding, '').every((path) => path === '') &&
          this.builderCustody(module, alias, next),
      )
    ) {
      return false;
    }
    return (
      module.escapes.every((expression) => this.objectPaths(module, expression, binding, '').length === 0) &&
      module.calls.every((call) =>
        call.arguments.every((argument) => {
          if (argument.type === 'SpreadElement' || this.objectPaths(module, argument, binding, '').length === 0) {
            return true;
          }
          const callee = unwrap(call.callee);
          return (
            callee.type === 'MemberExpression' &&
            ['add', 'addHttpApi'].includes(propertyName(callee) ?? '') &&
            this.nativeHttpContract(module, callee.object, new Set([binding]), 0) !== undefined
          );
        }),
      )
    );
  }
  nativeSchemaBorrower(module: Module, call: CallExpression, index: number): boolean {
    const callee = unwrap(call.callee);
    if (
      index === 1 &&
      call.arguments.length === 2 &&
      callee.type === 'CallExpression' &&
      callee.arguments.length === 0 &&
      this.native(module, callee.callee, 'HttpApiMiddleware', 'Service')
    ) {
      return true;
    }
    const member = nativeMember(call.callee);
    if (member === undefined) {
      return false;
    }
    if (member.method === 'decodeEffect') {
      return this.nativeSchemaDecodeEffectBorrower(module, call, index);
    }
    if (member.method === 'optionalKey') {
      const [argument] = call.arguments;
      const symbol =
        argument === undefined || argument.type === 'SpreadElement' ? undefined : this.symbol(module, argument);
      return (
        index === 0 &&
        call.arguments.length === 1 &&
        this.native(module, call.callee, 'Schema', 'optionalKey') &&
        symbol !== undefined &&
        this.producerServiceFreeSchema(symbol.module, symbol.binding)
      );
    }
    const schemaMethods = [
      'Struct',
      'check',
      'Record',
      'Redacted',
      'Union',
      'Array',
      'ReadonlyArray',
      'Tuple',
      'Optional',
      'optional',
      'NullOr',
      'Option',
      'OptionFromNullOr',
      'TaggedErrorClass',
      'TaggedClass',
      'Class',
      'TaggedUnion',
      'encodeEffect',
      'encodeUnknownEffect',
      'decodeUnknownEffect',
      'decodeUnknownOption',
      'decodeUnknownResult',
      'is',
      'asserts',
      'toEncoded',
      'toType',
      'toEquivalence',
      'fromJsonString',
      'toCodecJson',
      'toCodecString',
      'annotations',
    ];
    if (
      index === 0 &&
      schemaMethods.includes(member.method) &&
      this.native(module, call.callee, 'Schema', member.method)
    ) {
      return true;
    }
    return (
      ['get', 'post', 'put', 'patch', 'del', 'head', 'options'].includes(member.method) &&
      this.native(module, call.callee, 'HttpApiEndpoint', member.method)
    );
  }
  nativeSchemaDecodeEffectBorrower(module: Module, call: CallExpression, index: number): boolean {
    const [, options] = call.arguments;
    const fields = options?.type === 'ObjectExpression' ? ownDataFields(options) : undefined;
    const closedOptions =
      options === undefined ||
      (fields !== undefined && [...fields.values()].every((value) => unwrap(value).type === 'Literal'));
    return (
      index === 0 &&
      !call.optional &&
      [1, 2].includes(call.arguments.length) &&
      this.native(module, call.callee, 'Schema', 'decodeEffect') &&
      closedOptions
    );
  }
  schemaObjectPaths(module: Module, input: Expression, binding: Binding, suffix: string): readonly string[] {
    const node = unwrap(input);
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((value, index) => {
        if (value === null) {
          return [];
        }
        if (value.type === 'SpreadElement') {
          return this.schemaObjectPaths(module, value.argument, binding, suffix);
        }
        return this.schemaObjectPaths(module, value, binding, suffix).map((path) =>
          path.length === 0 ? String(index) : `${index}.${path}`,
        );
      });
    }
    if (node.type === 'ConditionalExpression') {
      return [
        ...this.schemaObjectPaths(module, node.consequent, binding, suffix),
        ...this.schemaObjectPaths(module, node.alternate, binding, suffix),
      ];
    }
    if (node.type === 'LogicalExpression') {
      return [
        ...this.schemaObjectPaths(module, node.left, binding, suffix),
        ...this.schemaObjectPaths(module, node.right, binding, suffix),
      ];
    }
    return this.objectPaths(module, input, binding, suffix);
  }
  schemaMembersClosed(module: Module, binding: Binding, suffix: string): boolean {
    let closed = true;
    new Visitor({
      MemberExpression: (node) => {
        if (
          node.computed &&
          rootedAtBinding(module, node.object, binding) &&
          this.bindingPath(module, node, binding) === undefined
        ) {
          closed = false;
        }
        const path = this.bindingPath(module, node, binding);
        const prefix = suffix.length === 0 ? '' : `${suffix}.`;
        if (path === undefined || path === suffix || !path.startsWith(prefix)) {
          return;
        }
        const field = path.slice(prefix.length).split('.')[0] ?? '';
        if (
          field === 'fields' &&
          path === `${prefix}fields` &&
          suffix === '' &&
          this.nativeServiceFreeStructBinding(module, binding)
        ) {
          return;
        }
        if (!['make', 'makeUnsafe', 'pipe'].includes(field)) {
          closed = false;
        }
        if (field === 'pipe') {
          const call = module.calls.find((value) => unwrap(value.callee) === node);
          if (
            call !== undefined &&
            !call.arguments.every((arg) => arg.type === 'CallExpression' && this.nativeSchemaBorrower(module, arg, 0))
          ) {
            closed = false;
          }
        }
      },
    }).visit(module.program);
    return closed;
  }
  schemaCustody(module: Module, binding: Binding): boolean {
    if (!this.objectCustody(module, binding, '', new Set(), false, true)) {
      return false;
    }
    for (const consumer of this.modules.values()) {
      for (const imported of consumer.bindings) {
        const { origin } = imported;
        const target = origin === undefined ? undefined : this.dependency(consumer, origin.source);
        if (target === undefined) {
          continue;
        }
        if (
          origin?.imported === '*' &&
          [...target.exports.keys()].some((name) => this.exportedSymbol(target, name, new Set())?.binding === binding)
        ) {
          return false;
        }
        const actual = this.exportedSymbol(target, origin?.imported ?? '', new Set());
        if (actual?.binding === binding && !this.objectCustody(consumer, imported, '', new Set(), false, true)) {
          return false;
        }
      }
    }
    return true;
  }
  nativeTagPipeTransform(module: Module, input: Expression): boolean {
    if (this.native(module, input, 'Effect', 'exit')) {
      return true;
    }
    return (
      input.type === 'CallExpression' &&
      (['map', 'flatMap', 'mapError', 'as'].some((method) => this.native(module, input.callee, 'Effect', method)) ||
        (!input.optional &&
          input.arguments.length === 1 &&
          input.arguments[0]?.type !== 'SpreadElement' &&
          this.native(module, input.callee, 'Effect', 'andThen')))
    );
  }
  tagMembersClosed(module: Module, binding: Binding, suffix: string): boolean {
    let closed = true;
    new Visitor({
      MemberExpression: (node) => {
        if (node.computed && rootedAtBinding(module, node.object, binding)) {
          closed = false;
        }
        const path = this.bindingPath(module, node, binding);
        const prefix = suffix.length === 0 ? '' : `${suffix}.`;
        if (path === undefined || !path.startsWith(prefix) || path === suffix) {
          return;
        }
        const member = path.slice(prefix.length).split('.')[0] ?? '';
        if (!['key', 'pipe', 'of', 'context', 'use', 'useSync', 'toJSON'].includes(member)) {
          closed = false;
        }
        if (member === 'pipe') {
          const call = module.calls.find((candidate) => unwrap(candidate.callee) === node);
          if (
            call !== undefined &&
            (call.arguments.length === 0 ||
              !call.arguments.every(
                (argument) => argument.type !== 'SpreadElement' && this.nativeTagPipeTransform(module, argument),
              ))
          ) {
            closed = false;
          }
        }
      },
    }).visit(module.program);
    return closed;
  }
  tagCustody(module: Module, binding: Binding): boolean {
    const cached = this.tagCustodyCache.get(binding);
    if (cached?.size === this.modules.size) {
      return cached.closed;
    }
    this.tagCustodyCache.set(binding, { closed: false, size: this.modules.size });
    const closed = this.uncachedTagCustody(module, binding);
    this.tagCustodyCache.set(binding, { closed, size: this.modules.size });
    return closed;
  }
  uncachedTagCustody(module: Module, binding: Binding): boolean {
    if (!this.objectCustody(module, binding, '', new Set(), true)) {
      return false;
    }
    for (const consumer of this.modules.values()) {
      for (const imported of consumer.bindings.filter((value) => value.origin !== undefined)) {
        const { origin } = imported;
        const target = origin === undefined ? undefined : this.dependency(consumer, origin.source);
        if (target === undefined) {
          continue;
        }
        if (
          origin?.imported === '*' &&
          (target === module ||
            [...target.exports.keys()].some(
              (name) => this.exportedSymbol(target, name, new Set())?.binding === binding,
            ))
        ) {
          return false;
        }
        const symbol = this.exportedSymbol(target, origin?.imported ?? '', new Set());
        if (symbol?.binding === binding && !this.objectCustody(consumer, imported, '', new Set(), true)) {
          return false;
        }
      }
    }
    return true;
  }
  objectCustody(
    module: Module,
    binding: Binding,
    suffix: string,
    seen: Set<string>,
    tagMode = false,
    schemaMode = false,
    borrower?: RecordBorrower,
  ): boolean {
    const key = `${tagMode}:${schemaMode}:${suffix}`;
    const active = this.activeObjectCustody.get(binding) ?? new Set<string>();
    if (active.has(key)) {
      return false;
    }
    active.add(key);
    this.activeObjectCustody.set(binding, active);
    try {
      return this.proveObjectCustody(module, binding, suffix, seen, tagMode, schemaMode, borrower);
    } finally {
      active.delete(key);
    }
  }
  proveObjectCustody(
    module: Module,
    binding: Binding,
    suffix: string,
    seen: Set<string>,
    tagMode = false,
    schemaMode = false,
    borrower?: RecordBorrower,
  ): boolean {
    const key = `${module.file}:${binding.node.start}:${suffix}`;
    if (
      seen.has(key) ||
      seen.size >= budget ||
      !stable(module, binding) ||
      (tagMode && !this.tagMembersClosed(module, binding, suffix)) ||
      (schemaMode && !this.schemaMembersClosed(module, binding, suffix))
    ) {
      return false;
    }
    const next = new Set(seen).add(key);
    return (
      module.escapes.every(
        (expression) =>
          (borrower === undefined
            ? this.objectPaths(module, expression, binding, suffix)
            : this.schemaObjectPaths(module, expression, binding, suffix)
          ).length === 0,
      ) &&
      this.custodyAliases(module, binding, suffix, next, tagMode, schemaMode, borrower) &&
      module.calls.every((call) =>
        call.arguments.every((_argument, index) =>
          this.custodyArgument(module, binding, suffix, next, call, index, tagMode, schemaMode, borrower),
        ),
      ) &&
      (borrower === undefined || borrower.references(module, binding, suffix))
    );
  }

  identifierValues(
    reference: Reference,
    node: IdentifierReference,
    seen: Set<Binding>,
    hops: number,
  ): readonly ObjectValue[] | undefined {
    const { captures, module } = reference;
    const binding = bindingAt(module, node.name, node);
    if (binding === undefined || !stable(module, binding) || seen.has(binding)) {
      return undefined;
    }
    const captured = captures.get(binding) ?? FactoryResolver.projection(module, binding, captures);
    if (captured !== undefined) {
      if (!this.objectCustody(module, binding, '', new Set())) {
        return undefined;
      }
      return this.values(captured, new Set(seen).add(binding), hops + 1);
    }
    if (this.tag(module, node) !== undefined) {
      return this.service(module, node);
    }
    if (!this.objectCustody(module, binding, '', new Set())) {
      return undefined;
    }
    if (binding.init !== undefined) {
      return this.values(
        FactoryResolver.reference(module, binding.init, captures),
        new Set(seen).add(binding),
        hops + 1,
      );
    }
    if (binding.field !== undefined) {
      return this.destructuredValues(module, binding, captures, seen, hops);
    }
    return this.parameterValues(module, binding, captures, new Set(seen).add(binding), hops + 1);
  }
  optionalAbsent(reference: Reference, seen: Set<Binding>, hops: number): boolean {
    const node = unwrap(reference.expression);
    if (node.type !== 'CallExpression' || !node.optional) {
      return false;
    }
    const callee = unwrap(node.callee);
    if (callee.type !== 'MemberExpression' || callee.computed) {
      return false;
    }
    const name = propertyName(callee);
    const receivers = this.values(
      FactoryResolver.reference(reference.module, callee.object, reference.captures),
      seen,
      hops + 1,
    );
    return (
      name !== undefined &&
      receivers !== undefined &&
      receivers.length > 0 &&
      receivers.every((receiver) => {
        const fields = ownDataFields(receiver.expression);
        return fields !== undefined && !fields.has(name) && !inheritedObjectNames.has(name);
      })
    );
  }

  values(reference: Reference, seen: Set<Binding>, hops: number): readonly ObjectValue[] | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'ObjectExpression') {
      return [{ captures, expression: node, module }];
    }
    if (node.type === 'YieldExpression' && node.delegate && node.argument !== null) {
      return this.service(module, node.argument);
    }
    if (node.type === 'Identifier') {
      return this.identifierValues(reference, node, seen, hops);
    }
    if (node.type === 'MemberExpression') {
      return this.memberValues(reference, seen, hops);
    }
    if (node.type === 'CallExpression') {
      return this.callValues(reference, node, seen, hops);
    }
    if (node.type === 'LogicalExpression' && node.operator === '??') {
      const left = this.values(FactoryResolver.reference(module, node.left, captures), seen, hops + 1);
      if (left !== undefined) {
        return left;
      }
      const absent = this.optionalAbsent(FactoryResolver.reference(module, node.left, captures), seen, hops + 1);
      return absent ? this.values(FactoryResolver.reference(module, node.right, captures), seen, hops + 1) : undefined;
    }

    return undefined;
  }
  static candidate(module: Module, fn: Implementation, captures: Captures): ScopedContextFactoryCandidate {
    const bindings = new Map(
      [...captures].map(([binding, ref]) => [binding.name, { expression: ref.expression, file: ref.module.file }]),
    );
    const parameters = new Map<string, ScopedCapturedParameter>();
    const referenced = new Set<Binding>();
    new Visitor({
      Identifier(node) {
        const binding = bindingAt(module, node.name, node);
        if (binding !== undefined && inside(node, fn)) {
          referenced.add(binding);
        }
      },
    }).visit(module.program);
    for (const binding of referenced) {
      if (!inside(fn, binding.scope) || inside(binding.node, fn) || !stable(module, binding)) {
        continue;
      }
      if (binding.init !== undefined) {
        bindings.set(binding.name, { expression: binding.init, file: module.file });
      }
      if (binding.parameter !== undefined && !captures.has(binding)) {
        parameters.set(binding.name, {
          binding: binding.node,
          file: module.file,
          implementation: binding.parameter.fn,
          index: binding.parameter.index,
        });
      }
    }
    return {
      capturedBindings: bindings,
      capturedParameters: parameters,
      file: module.file,
      implementation: fn,
      program: module.program,
    };
  }
  errorOnlyMiddleware(module: Module, call: CallExpression): boolean {
    return (
      this.native(module, call.callee, 'HttpRouter', 'middleware') &&
      provesErrorOnlyGlobalMiddleware({
        call,
        file: module.file,
        isNativeMethod: (file, expression, namespace, method) =>
          this.isNativeMethod(file, expression, namespace, method),
        isServiceFreeSchema: (request) => this.isServiceFreeSchema(request),
        program: module.program,
        resolveCapturedValue: (request) => this.resolveCapturedValue(request),
        resolveDeclaredFunction: (request) => this.resolveDeclaredFunction(request),
        sources: this.sources,
      })
    );
  }
  isServiceFreeSchema(request: ScopedCapturedValueRequest): boolean {
    const module = this.module(request.file);
    const symbol = module === undefined ? undefined : this.symbol(module, request.expression);
    if (
      symbol === undefined ||
      !stable(symbol.module, symbol.binding) ||
      !this.schemaCustody(symbol.module, symbol.binding)
    ) {
      return false;
    }
    return this.producerServiceFreeSchema(symbol.module, symbol.binding);
  }
  producerServiceFreeSchema(module: Module, binding: Binding): boolean {
    const exported = [...module.exports].find(([, local]) => local === binding.name)?.[0];
    const source = this.sources.get(module.file);
    const filename = this.path.relative(this.root, module.file).split(this.path.sep).join('/');
    const snapshot = this.relativeContractSources;
    let directory = this.path.dirname(filename);
    for (let index = 0; index < budget; index += 1) {
      if (snapshot.has(`${directory}/package.json`)) {
        if (source === undefined || exported === undefined) {
          return false;
        }
        const fact = { exported, filename, ownerPath: directory, snapshot, source };
        if (FactoryResolver.sameProducerSchemaFact(this.producerSchemaFacts.get(binding), fact)) {
          return true;
        }
        const proven = provesServiceFreeSchemaExport(source, exported, {
          filename,
          isImmutableContractSource: () => false,
          ownerPath: directory,
          sources: snapshot,
        });
        if (proven) {
          this.producerSchemaFacts.set(binding, fact);
        }
        return proven;
      }
      const parent = this.path.dirname(directory);
      if (parent === directory) {
        return false;
      }
      directory = parent;
    }
    return false;
  }
  static sameProducerSchemaFact(previous: ProducerSchemaFact | undefined, current: ProducerSchemaFact): boolean {
    return (
      previous?.snapshot === current.snapshot &&
      previous.exported === current.exported &&
      previous.filename === current.filename &&
      previous.ownerPath === current.ownerPath &&
      previous.source === current.source
    );
  }
  isNativeMethod(file: string, expression: Expression, namespace: string, method: string): boolean {
    const module = this.module(file);
    return module !== undefined && this.native(module, expression, namespace, method);
  }
  dataCallable(
    reference: Reference,
    seen: Set<Binding>,
    hops: number,
    observe?: ConsumerSourceObserver,
  ): ScopedContextFactoryCandidate | undefined {
    if (hops >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    const literal = functionValue(node);
    if (literal !== undefined) {
      observe?.({ captures, fn: literal, module });
      return FactoryResolver.candidate(module, literal, captures);
    }
    if (node.type === 'Identifier') {
      return this.dataCallableIdentifier(reference, node, seen, hops, observe);
    }
    if (node.type !== 'CallExpression' || node.optional || node.arguments.some((arg) => arg.type === 'SpreadElement')) {
      return undefined;
    }
    return this.dataFactoryClosure(reference, node, seen, hops, observe);
  }
  dataCallableIdentifier(
    reference: Reference,
    node: IdentifierReference,
    seen: Set<Binding>,
    hops: number,
    observe?: ConsumerSourceObserver,
  ): ScopedContextFactoryCandidate | undefined {
    const { captures, module } = reference;
    const local = bindingAt(module, node.name, node);
    if (local === undefined || seen.has(local) || !stable(module, local)) {
      return undefined;
    }
    const next = new Set(seen).add(local);
    const captured = captures.get(local);
    if (captured !== undefined) {
      return this.dataCallable(captured, next, hops + 1, observe);
    }
    const symbol = this.symbol(module, node);
    const declaration = symbol?.binding.init;
    if (
      symbol?.binding.kind === 'function' &&
      declaration?.type === 'FunctionDeclaration' &&
      declaration.body?.type === 'BlockStatement' &&
      declaration.id === symbol.binding.node
    ) {
      observe?.({ captures, fn: declaration, module: symbol.module });
      return FactoryResolver.candidate(symbol.module, declaration, captures);
    }
    return symbol?.binding.init === undefined
      ? undefined
      : this.dataCallable(
          FactoryResolver.reference(symbol.module, symbol.binding.init, captures),
          next,
          hops + 1,
          observe,
        );
  }
  static soleFunctionResult(fn: Implementation): Expression | undefined {
    const { body } = fn;
    if (body === null) {
      return undefined;
    }
    if (body.type !== 'BlockStatement') {
      return body;
    }
    const [first] = body.body;
    return body.body.length === 1 && first?.type === 'ReturnStatement' && first.argument !== null
      ? first.argument
      : undefined;
  }
  dataFactoryClosure(
    reference: Reference,
    node: CallExpression,
    seen: Set<Binding>,
    hops: number,
    observe?: ConsumerSourceObserver,
  ): ScopedContextFactoryCandidate | undefined {
    const { captures, module } = reference;
    const factory = this.function(module, node.callee);
    const fn = factory?.fn;
    const result = fn === undefined ? undefined : FactoryResolver.soleFunctionResult(fn);
    if (
      factory === undefined ||
      fn === undefined ||
      fn.async ||
      fn.generator ||
      fn.params.length !== node.arguments.length ||
      fn.params.some((param) => param.type !== 'Identifier') ||
      result === undefined ||
      functionValue(result) === undefined
    ) {
      return undefined;
    }
    return this.dataCallable(
      FactoryResolver.reference(
        factory.module,
        result,
        FactoryResolver.captureCall(
          factory.module,
          fn,
          node.arguments.filter((arg) => arg.type !== 'SpreadElement'),
          captures,
          module,
        ),
      ),
      seen,
      hops + 1,
      observe,
    );
  }
  resolveDataObjectMethod(request: ScopedContextFactoryRequest): ScopedContextFactoryCandidate | undefined {
    return this.dataObjectMethodCandidate(request);
  }
  dataObjectMethodCandidate(
    request: ScopedContextFactoryRequest,
    observe?: ConsumerSourceObserver,
    captures: Captures = new Map(),
    readRecord?: RecordValues,
  ): ScopedContextFactoryCandidate | undefined {
    const module = this.module(request.file);
    const callee = unwrap(request.callee);
    if (module === undefined || callee.type !== 'MemberExpression' || callee.computed || callee.optional) {
      return undefined;
    }
    const receiver = readRecord === undefined ? this.dataObjectReceiver(module, callee.object, captures) : undefined;
    const ordinary = receiver === undefined ? undefined : this.values(receiver, new Set(), 0);
    const values =
      readRecord === undefined ? ordinary : readRecord(FactoryResolver.reference(module, callee.object, captures));
    const [value] = values ?? [];
    const field = value === undefined ? undefined : ownDataFields(value.expression)?.get(propertyName(callee) ?? '');
    return values?.length !== 1 || value === undefined || value.authority !== undefined || field === undefined
      ? undefined
      : this.dataCallable(FactoryResolver.reference(value.module, field, value.captures), new Set(), 0, observe);
  }
  dataObjectReceiver(module: Module, expression: Expression, captures: Captures = new Map()): Reference | undefined {
    const node = unwrap(expression);
    if (node.type === 'Identifier') {
      const local = bindingAt(module, node.name, node);
      const symbol = this.symbol(module, node);
      if (
        local === undefined ||
        symbol === undefined ||
        !this.objectCustody(module, local, '', new Set()) ||
        !this.objectCustody(symbol.module, symbol.binding, '', new Set())
      ) {
        return undefined;
      }
      if (symbol.binding.origin === undefined && symbol.binding.init !== undefined) {
        return FactoryResolver.reference(symbol.module, symbol.binding.init, captures);
      }
    }
    return FactoryResolver.reference(module, expression, captures);
  }
  nativeSqlErrorClassClosed(target: { readonly binding: Binding; readonly module: Module }): boolean {
    for (const module of this.modules.values()) {
      const allowed: Span[] = [];
      new Visitor({
        CallExpression: (node) => {
          if (this.native(module, node.callee, 'Effect', 'mapError')) {
            const callback = node.arguments.at(-1);
            if (callback?.type === 'ArrowFunctionExpression' && callback.body.type === 'NewExpression') {
              allowed.push(callback.body.callee);
            }
          }
        },
        ExportNamedDeclaration(node) {
          if (node.source !== null) {
            allowed.push(node);
          }
        },
        ImportDeclaration(node) {
          allowed.push(node);
        },
        NewExpression(node) {
          // Security fence: guarded Core pool (transaction I/O guard + session-role check). Core's session-role
          // check constructs the error as the cause of its connection failure; construction is all it may do.
          if (isCoreDatabaseGuardModule(module.file)) {
            allowed.push(node.callee);
          }
        },
        TSTypeAnnotation(node) {
          allowed.push(node);
        },
        TSTypeQuery(node) {
          allowed.push(node);
        },
        TSTypeReference(node) {
          allowed.push(node);
        },
        YieldExpression(node) {
          if (node.argument?.type === 'NewExpression') {
            allowed.push(node.argument.callee);
          }
        },
      }).visit(module.program);
      let closed = true;
      new Visitor({
        Identifier: (node) => {
          if (node.start === target.binding.node.start && module === target.module) {
            return;
          }
          if (allowed.some((span) => inside(node, span)) || node.type !== 'Identifier') {
            return;
          }
          const binding = bindingAt(module, node.name, node);
          const dependency = binding?.origin === undefined ? undefined : this.dependency(module, binding.origin.source);
          let resolved = binding;
          if (binding?.origin !== undefined) {
            resolved =
              dependency === undefined
                ? undefined
                : this.exportedSymbol(dependency, binding.origin.imported, new Set())?.binding;
          }
          if (resolved === target.binding) {
            closed = false;
          }
        },
      }).visit(module.program);
      if (!closed) {
        return false;
      }
    }
    return true;
  }
  nativeSqlEnvironment(root: Module): NativeSqlProofEnvironment | undefined {
    const inputs = this.nativeSqlRuntimeProof;
    if (inputs === undefined) {
      return undefined;
    }
    const modules = new Map(this.modules);
    for (const module of modules.values()) {
      const edges = inputs.imports.get(module.file);
      if (edges === undefined) {
        return undefined;
      }
      for (const edge of edges.values()) {
        let files: readonly string[] = [];
        if (edge.kind === 'module') {
          files = [edge.file];
        } else if (edge.kind === 'conditional-modules') {
          ({ files } = edge);
        }
        for (const file of files) {
          const candidate = modules.get(file) ?? this.candidateModule(file);
          if (candidate === undefined) {
            return undefined;
          }
          modules.set(file, candidate);
        }
      }
    }
    const resolve = (file: string, source: string) => inputs.imports.get(file)?.get(source);
    if (!hasClosedNativePgDecoderRegistryCustody([...modules.values()], resolve)) {
      return undefined;
    }
    return {
      modules: [...modules.values()],
      resolveFunction: (reference) => this.resolveNativeSqlFunction(reference),
      resolveImport: (file, source): NativeSqlImportEdge | undefined => {
        const edge = resolve(file, source);
        if (edge?.kind === 'module') {
          return edge;
        }
        if (edge?.kind === 'native-pg-root') {
          return { kind: 'native-pg-root' };
        }
        if (edge?.kind === nativeRuntimeOther) {
          const roles = new Map([
            ['effect', 'native-effect'],
            ['drizzle-orm', 'native-drizzle'],
            ['drizzle-orm/effect-postgres', 'native-drizzle-effect'],
          ] as const);
          for (const [name, kind] of roles) {
            if (source === name) {
              return { kind };
            }
          }
        }
        return undefined;
      },
      resolveValue: (reference) => this.resolveNativeSqlSource(reference, { file: root.file }),
    };
  }
  nativeSqlQuery(reference: Reference, seen = new Set<Binding>(), depth = 0): Reference | undefined {
    if (depth >= budget) {
      return undefined;
    }
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier') {
      const binding = bindingAt(reference.module, node.name, node);
      const input =
        binding === undefined
          ? undefined
          : (reference.captures.get(binding) ??
            (binding.init === undefined
              ? undefined
              : FactoryResolver.reference(reference.module, binding.init, reference.captures)));
      return binding === undefined || seen.has(binding) || input === undefined || !stable(reference.module, binding)
        ? undefined
        : this.nativeSqlQuery(input, new Set(seen).add(binding), depth + 1);
    }
    if (node.type === 'YieldExpression') {
      return !node.delegate || node.argument === null
        ? undefined
        : this.nativeSqlQuery({ ...reference, expression: node.argument }, seen, depth + 1);
    }
    if (node.type !== 'CallExpression' || node.optional) {
      return undefined;
    }
    const callee = unwrap(node.callee);
    if (callee.type === 'MemberExpression' && propertyName(callee) === 'pipe') {
      return node.arguments.every(
        (argument) =>
          argument.type !== 'SpreadElement' &&
          argument.type === 'CallExpression' &&
          argument.arguments.length === 1 &&
          this.native(reference.module, argument.callee, 'Effect', 'mapError'),
      )
        ? this.nativeSqlQuery({ ...reference, expression: callee.object }, seen, depth + 1)
        : undefined;
    }
    return reference;
  }
  nativeSqlRowQuery(reference: Reference, binding: Binding): Reference | undefined {
    if (
      !this.closedArrayIteratorCohort() ||
      !this.memberProjectionBindingClosed(reference.module, binding, false, new Set())
    ) {
      return undefined;
    }
    if (binding.projection?.index === 0) {
      return this.nativeSqlQuery({ ...reference, expression: binding.projection.expression });
    }
    return this.nativeSqlCallbackRowQuery(reference, binding);
  }
  nativeSqlCallbackRowQuery(reference: Reference, binding: Binding): Reference | undefined {
    const fn = binding.parameter?.fn;
    const [formal] = fn?.params ?? [];
    if (
      fn === undefined ||
      formal?.type !== 'ArrayPattern' ||
      formal.elements.length !== 1 ||
      formal.elements[0] !== binding.node
    ) {
      return undefined;
    }
    for (const call of reference.module.calls) {
      if (
        call.arguments.length !== 1 ||
        call.arguments[0] !== fn ||
        !this.native(reference.module, call.callee, 'Effect', 'flatMap')
      ) {
        continue;
      }
      for (const parent of reference.module.calls) {
        const callee = unwrap(parent.callee);
        const position = parent.arguments.indexOf(call);
        if (position === -1 || callee.type !== 'MemberExpression' || propertyName(callee) !== 'pipe') {
          continue;
        }
        const previous = parent.arguments.slice(0, position);
        if (
          !previous.every(
            (argument) =>
              argument.type === 'CallExpression' &&
              argument.arguments.length === 1 &&
              this.native(reference.module, argument.callee, 'Effect', 'mapError'),
          )
        ) {
          return undefined;
        }
        return this.nativeSqlQuery({ ...reference, expression: callee.object });
      }
    }
    return undefined;
  }
  static nativeSqlQueryReceiver(query: Reference): Reference | undefined {
    let node = unwrap(query.expression);
    for (let depth = 0; depth < budget; depth += 1) {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
        return undefined;
      }
      const method = propertyName(node.callee);
      if (method === 'execute' || method === 'select') {
        return { ...query, expression: node.callee.object };
      }
      node = unwrap(node.callee.object);
    }
    return undefined;
  }
  nativeSqlReceiverProofs(
    reference: Reference,
    environment: NativeSqlProofEnvironment,
    root: Module,
    seen = new Set<Binding>(),
    depth = 0,
  ): readonly NativeSqlReceiverProof[] | undefined {
    if (depth >= budget) {
      return undefined;
    }
    const input = FactoryResolver.nativeSqlOutput(reference);
    const output = input === undefined ? undefined : this.resolveNativeSqlSource(input, { file: root.file });
    const value = output === undefined ? undefined : this.nativeSqlInput(output);
    if (value === undefined || output === undefined) {
      return undefined;
    }
    const database = describeNativeSqlDatabase(environment, output);
    if (database !== undefined) {
      return [{ database, reference: value }];
    }
    const node = unwrap(value.expression);
    const binding = node.type === 'Identifier' ? bindingAt(value.module, node.name, node) : undefined;
    if (binding?.parameter === undefined || seen.has(binding)) {
      return undefined;
    }
    return this.nativeSqlFormalReceiverProofs(
      value,
      binding,
      { environment, root },
      new Set(seen).add(binding),
      depth + 1,
    );
  }
  nativeSqlFormalReceiverProofs(
    value: Reference,
    binding: Binding,
    scope: NativeSqlProofScope,
    seen: Set<Binding>,
    depth: number,
  ): readonly NativeSqlReceiverProof[] | undefined {
    const { parameter } = binding;
    const callers = parameter === undefined ? undefined : this.callerModules(value.module, parameter.fn);
    if (parameter === undefined || callers === undefined || depth >= budget) {
      return undefined;
    }
    const result: NativeSqlReceiverProof[] = [];
    for (const caller of callers) {
      for (const call of caller.calls) {
        if (this.function(caller, call.callee)?.fn === parameter.fn) {
          const inputs = this.callFormalReferences(value.module, binding, call, caller);
          if (inputs === undefined) {
            return undefined;
          }
          for (const input of inputs) {
            const proofs = this.nativeSqlReceiverProofs(input, scope.environment, scope.root, seen, depth + 1);
            if (proofs === undefined) {
              return undefined;
            }
            result.push(...proofs);
          }
        }
        const transactions = this.nativeSqlTransactionReceiverProofs(
          value,
          binding,
          caller,
          call,
          scope,
          seen,
          depth + 1,
        );
        if (transactions === undefined || result.length + transactions.length > budget) {
          return undefined;
        }
        result.push(...transactions);
      }
    }
    return result.length === 0 ? undefined : result;
  }
  nativeSqlTransactionReceiverProofs(
    value: Reference,
    binding: Binding,
    caller: Module,
    call: CallExpression,
    scope: NativeSqlProofScope,
    seen: Set<Binding>,
    depth: number,
  ): readonly NativeSqlReceiverProof[] | undefined {
    const callee = unwrap(call.callee);
    const [callback] = call.arguments;
    if (
      callee.type !== 'MemberExpression' ||
      propertyName(callee) !== 'transaction' ||
      call.arguments.length !== 1 ||
      callback === undefined ||
      callback.type === 'SpreadElement' ||
      this.function(caller, callback)?.fn !== binding.parameter?.fn
    ) {
      return [];
    }
    const inputs = this.nativeSqlReceiverProofs(
      FactoryResolver.reference(caller, callee.object, value.captures),
      scope.environment,
      scope.root,
      seen,
      depth + 1,
    );
    if (inputs === undefined) {
      return undefined;
    }
    const result: NativeSqlReceiverProof[] = [];
    for (const input of inputs) {
      if (input.transaction !== undefined) {
        return undefined;
      }
      const transaction = FactoryResolver.nativeSqlOutput(FactoryResolver.reference(caller, call, value.captures));
      const proof =
        transaction === undefined
          ? undefined
          : describeNativeSqlTransaction(scope.environment, input.database, transaction);
      if (proof === undefined) {
        return undefined;
      }
      result.push({ database: input.database, reference: value, transaction: proof });
    }
    return result;
  }
  nativeSqlFieldEvidence(
    reference: Reference,
    node: Extract<Expression, { type: 'MemberExpression' }>,
  ): readonly string[] | undefined {
    const scope = this.nativeSqlContext;
    const object = unwrap(node.object);
    const binding = object.type === 'Identifier' ? bindingAt(reference.module, object.name, object) : undefined;
    if (scope === undefined || binding === undefined) {
      return undefined;
    }
    const query = this.nativeSqlRowQuery(reference, binding);
    const receiver = query === undefined ? undefined : FactoryResolver.nativeSqlQueryReceiver(query);
    const proofs =
      receiver === undefined ? undefined : this.nativeSqlReceiverProofs(receiver, scope.environment, scope.root);
    if (query === undefined || receiver === undefined || proofs === undefined || proofs.length === 0) {
      return undefined;
    }
    const receiverNode = unwrap(receiver.expression);
    const receiverBinding =
      receiverNode.type === 'Identifier' ? bindingAt(receiver.module, receiverNode.name, receiverNode) : undefined;
    const fields: string[][] = [];
    for (const proof of proofs) {
      const captures = new Map(query.captures);
      if (receiverBinding !== undefined) {
        captures.set(receiverBinding, proof.reference);
      }
      const source = FactoryResolver.nativeSqlOutput({ ...query, captures });
      if (source === undefined) {
        return undefined;
      }
      let selected: readonly string[] | undefined;
      if (proof.transaction !== undefined) {
        selected = describeNativeSqlExecute(scope.environment, proof.transaction, source);
      }
      selected ??= describeNativeSqlTextSelection(scope.environment, proof.transaction ?? proof.database, source, {
        filename: 'packages/core-runtime/src/db/schema.ts',
        ownerPath: 'packages/core-runtime',
        runtimeFile: this.path.join(this.root, 'packages/core-runtime/src/db/schema.ts'),
        sources: this.relativeContractSources,
        tableExportName: 'auditEvents',
      });
      if (selected === undefined) {
        return undefined;
      }
      fields.push([...selected]);
    }
    return fields[0]?.filter((field) => fields.every((value) => value.includes(field)));
  }
  nativeSqlFailureReturn(module: Module, expression: Expression): boolean {
    const value = unwrap(expression);
    if (value.type !== 'YieldExpression' || !value.delegate || value.argument?.type !== 'NewExpression') {
      return false;
    }
    const constructed = value.argument;
    const [payload] = constructed.arguments;
    if (
      constructed.callee.type !== 'Identifier' ||
      constructed.arguments.length !== 1 ||
      payload === undefined ||
      payload.type === 'SpreadElement' ||
      ownDataFields(payload) === undefined
    ) {
      return false;
    }
    if (ownDataFields(payload)?.has('~effect/Effect/evaluate') === true) {
      return false;
    }
    const target = this.symbol(module, constructed.callee);
    if (target?.binding.kind !== 'class' || !stable(target.module, target.binding)) {
      return false;
    }
    let genuine = false;
    new Visitor({
      ClassDeclaration: (node) => {
        const base = node.superClass;
        if (
          node.id !== target.binding.node ||
          node.body.body.length !== 0 ||
          node.decorators.length !== 0 ||
          base?.type !== 'CallExpression' ||
          base.arguments.length !== 1
        ) {
          return;
        }
        const [tag] = base.arguments;
        genuine =
          tag?.type === 'Literal' &&
          Schema.is(Schema.String)(tag.value) &&
          this.native(target.module, base.callee, 'Data', 'TaggedError');
      },
    }).visit(target.module.program);
    return genuine && this.nativeSqlErrorClassClosed(target);
  }
  nativeSqlFunctionReturn(module: Module, fn: Implementation): Expression | undefined {
    const direct = directReturn(fn, module.program);
    if (direct !== undefined || !fn.generator) {
      return direct;
    }
    const returns = localReturnExpressions(module, fn);
    const successes = returns?.filter((expression) => !this.nativeSqlFailureReturn(module, expression));
    return successes?.length === 1 ? successes[0] : undefined;
  }
  nativeSqlAcquisition(
    reference: Reference,
    tag: Expression,
    root: Module,
    seen: Set<Binding>,
    depth: number,
    resolution?: NativeSqlResolution,
  ): Reference | undefined {
    const binding = this.tag(reference.module, tag);
    if (
      binding === undefined ||
      seen.has(binding) ||
      resolution === undefined ||
      resolution.root !== root ||
      resolution.proofs.length >= budget
    ) {
      return undefined;
    }
    const mounted = this.mounted(root);
    const candidates = this.providerCandidates(mounted, binding, true);
    const [provider] = candidates ?? [];
    if (
      candidates?.length !== 1 ||
      provider === undefined ||
      this.currentFixedOutputs.has(this.tagKeys.get(binding) ?? '')
    ) {
      return undefined;
    }
    const target = this.function(provider.module, provider.program);
    const literal = this.native(provider.module, provider.call.callee, 'Layer', 'succeed');
    let returned = target === undefined ? undefined : this.nativeSqlFunctionReturn(target.module, target.fn);
    if (literal) {
      returned = provider.program;
    }
    const value =
      returned === undefined
        ? undefined
        : this.nativeSqlValue(
            FactoryResolver.reference(target?.module ?? provider.module, returned, provider.frame.captures),
            new Set(seen).add(binding),
            depth + 1,
            root,
            resolution,
          );
    if (value === undefined) {
      return undefined;
    }
    resolution.frames.push(value);
    resolution.proofs.push({ binding, provider, reference, tag });
    return value;
  }
  nativeSqlInput(reference: NativeSqlSourceReference, depth = 0): Reference | undefined {
    const module = this.module(reference.file);
    if (module === undefined || depth >= budget) {
      return undefined;
    }
    const captures = new Map<Binding, Reference>();
    for (const [node, input] of reference.captures ?? []) {
      const binding = [...this.modules.values()]
        .flatMap((value) => value.bindings)
        .find((value) => value.node === node);
      const captured = this.nativeSqlInput(input, depth + 1);
      if (binding === undefined || captured === undefined) {
        return undefined;
      }
      captures.set(binding, captured);
    }
    return FactoryResolver.reference(module, reference.expression, captures);
  }
  static nativeSqlOutput(reference: Reference, depth = 0): NativeSqlSourceReference | undefined {
    if (depth >= budget) {
      return undefined;
    }
    const captures = new Map<Span, NativeSqlSourceReference>();
    for (const [binding, input] of reference.captures) {
      const captured = FactoryResolver.nativeSqlOutput(input, depth + 1);
      if (captured === undefined) {
        return undefined;
      }
      captures.set(binding.node, captured);
    }
    return { captures, expression: reference.expression, file: reference.module.file };
  }
  nativeSqlValue(
    reference: Reference,
    seen: Set<Binding>,
    depth: number,
    root?: Module,
    resolution?: NativeSqlResolution,
  ): Reference | undefined {
    if (depth >= budget) {
      return undefined;
    }
    const { captures, module } = reference;
    const node = unwrap(reference.expression);
    if (node.type === 'Identifier') {
      return this.nativeSqlIdentifierValue(reference, node, seen, depth, root, resolution);
    }
    if (node.type === 'MemberExpression') {
      const key = FactoryResolver.carrierProjectionKey(node);
      return key === undefined
        ? undefined
        : this.nativeSqlFieldValue(
            FactoryResolver.reference(module, node.object, captures),
            key,
            seen,
            depth + 1,
            root,
            resolution,
          );
    }
    if (node.type === 'YieldExpression') {
      if (
        node.delegate &&
        node.argument?.type === 'Identifier' &&
        root !== undefined &&
        this.tag(module, node.argument) !== undefined
      ) {
        return this.nativeSqlAcquisition(reference, node.argument, root, seen, depth, resolution);
      }
      return node.argument === null
        ? undefined
        : this.nativeSqlValue(
            FactoryResolver.reference(module, node.argument, captures),
            seen,
            depth + 1,
            root,
            resolution,
          );
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      return this.nativeSqlCallValue(reference, node, seen, depth, root, resolution);
    }
    return { ...reference, expression: node };
  }
  nativeSqlIdentifierValue(
    reference: Reference,
    node: IdentifierReference,
    seen: Set<Binding>,
    depth: number,
    root?: Module,
    resolution?: NativeSqlResolution,
  ): Reference | undefined {
    const { captures, module } = reference;
    const local = bindingAt(module, node.name, node);
    if (local === undefined || seen.has(local) || !stable(module, local)) {
      return undefined;
    }
    const captured = captures.get(local);
    const callable = captured === undefined ? this.function(module, node) : undefined;
    if (callable?.fn.generator === true && this.nativeEffectCallable(reference, callable)) {
      return FactoryResolver.reference(callable.module, callable.fn, captures);
    }
    if (captured === undefined && local.field !== undefined) {
      return this.nativeSqlFieldValue(
        FactoryResolver.reference(module, local.field.expression, captures),
        local.field.key,
        new Set(seen).add(local),
        depth + 1,
        root,
        resolution,
      );
    }
    const symbol = captured === undefined ? this.symbol(module, node) : undefined;
    const input =
      captured ??
      (symbol?.binding.init === undefined
        ? undefined
        : FactoryResolver.reference(symbol.module, symbol.binding.init, captures));
    return input === undefined
      ? reference
      : this.nativeSqlValue(input, new Set(seen).add(local), depth + 1, root, resolution);
  }
  nativeSqlFieldValue(
    reference: Reference,
    key: string,
    seen: Set<Binding>,
    depth: number,
    root?: Module,
    resolution?: NativeSqlResolution,
  ): Reference | undefined {
    const value = this.nativeSqlValue(reference, seen, depth + 1, root, resolution);
    const expression = value === undefined ? undefined : ownDataFields(value.expression)?.get(key);
    return value === undefined || expression === undefined
      ? undefined
      : this.nativeSqlValue(
          FactoryResolver.reference(value.module, expression, value.captures),
          seen,
          depth + 1,
          root,
          resolution,
        );
  }
  nativeSqlCallValue(
    reference: Reference,
    node: CallExpression,
    seen: Set<Binding>,
    depth: number,
    root?: Module,
    resolution?: NativeSqlResolution,
  ): Reference | undefined {
    const { captures, module } = reference;
    const target = this.function(module, node.callee);
    if (target !== undefined) {
      const returned = this.nativeSqlFunctionReturn(target.module, target.fn);
      if (
        target.fn.async ||
        (target.fn.generator &&
          !this.nativeEffectCallable(FactoryResolver.reference(module, node.callee, captures), target)) ||
        returned === undefined ||
        node.arguments.some((argument) => argument.type === 'SpreadElement')
      ) {
        return undefined;
      }
      const frame = new Map(
        FactoryResolver.captureCall(
          target.module,
          target.fn,
          node.arguments.filter((argument) => argument.type !== 'SpreadElement'),
          captures,
          module,
        ),
      );
      if (root !== undefined) {
        for (const [binding, argument] of frame) {
          if (binding.parameter?.fn === target.fn) {
            const actual = this.nativeSqlValue(argument, seen, depth + 1, root, resolution);
            if (actual === undefined) {
              return undefined;
            }
            frame.set(binding, actual);
          }
        }
      }
      const output = {
        ...FactoryResolver.reference(target.module, returned, frame),
        invocation: { call: node, module },
      };
      resolution?.frames.push(output);
      return this.nativeSqlValue(output, seen, depth + 1, root, resolution);
    }
    return reference;
  }
  resolveNativeSqlSource(
    reference: NativeSqlSourceReference,
    composition?: { readonly file: string },
  ): NativeSqlSourceReference | undefined {
    const input = this.nativeSqlInput(reference);
    const root = composition === undefined ? undefined : this.ownerRoot(composition.file);
    const resolution = root === undefined ? undefined : { frames: [], proofs: [], root };
    const value = input === undefined ? undefined : this.nativeSqlValue(input, new Set(), 0, root, resolution);
    if (value === undefined || (resolution !== undefined && !this.nativeSqlResolutionClosed(resolution))) {
      return undefined;
    }
    return FactoryResolver.nativeSqlOutput(value);
  }
  nativeSqlResolutionClosed(resolution: NativeSqlResolution): boolean {
    for (const proof of resolution.proofs) {
      const previous = this.acquisitionProvider;
      this.acquisitionProvider = { binding: proof.binding, provider: proof.provider, root: resolution.root };
      const closed =
        this.requestedServiceContextClosed(proof.binding) &&
        this.validateServiceContexts(proof.reference.module, proof.tag, proof.binding, resolution.frames);
      this.acquisitionProvider = previous;
      if (!closed) {
        return false;
      }
    }
    return true;
  }
  resolveNativeSqlFunction(reference: NativeSqlSourceReference):
    | {
        readonly captures?: ReadonlyMap<Span, NativeSqlSourceReference>;
        readonly file: string;
        readonly implementation: Implementation;
      }
    | undefined {
    const input = this.nativeSqlInput(reference);
    const target = input === undefined ? undefined : this.function(input.module, input.expression);
    const output = input === undefined ? undefined : FactoryResolver.nativeSqlOutput(input);
    return target === undefined || output === undefined
      ? undefined
      : { captures: output.captures, file: target.module.file, implementation: target.fn };
  }
  resolveDeclaredFunction(request: ScopedContextFactoryRequest): ScopedContextFactoryCandidate | undefined {
    const module = this.module(request.file);
    const callee = unwrap(request.callee);
    if (module === undefined || callee.type !== 'Identifier') {
      return undefined;
    }
    const target = this.function(module, callee);
    return target === undefined ? undefined : FactoryResolver.candidate(target.module, target.fn, new Map());
  }
  resolveCapturedValue(request: ScopedCapturedValueRequest): ScopedCapturedValue | undefined {
    let module = this.module(request.file);
    if (module === undefined) {
      return undefined;
    }
    let { expression } = request;
    const frames: ScopedCapturedValueRequest[] = [];
    const seen = new Set<Binding>();
    for (let hops = 0; hops < budget; hops += 1) {
      frames.push({ expression, file: module.file });
      const node = unwrap(expression);
      if (node.type !== 'Identifier') {
        return { expression, file: module.file, frames };
      }
      const target = this.symbol(module, node);
      if (target === undefined || seen.has(target.binding)) {
        return undefined;
      }
      seen.add(target.binding);
      if (target.binding.parameter !== undefined) {
        return {
          expression,
          file: module.file,
          frames,
          parameter: {
            binding: target.binding.node,
            file: target.module.file,
            implementation: target.binding.parameter.fn,
            index: target.binding.parameter.index,
          },
        };
      }
      if (target.binding.init === undefined) {
        return undefined;
      }
      ({ module } = target);
      expression = target.binding.init;
    }
    return undefined;
  }
  resolve(request: ScopedContextFactoryRequest): readonly ScopedContextFactoryCandidate[] | undefined {
    this.ownerRoot(request.file);
    const module = this.module(request.file);
    const callee = unwrap(request.callee);
    if (
      module === undefined ||
      callee.type !== 'MemberExpression' ||
      callee.computed ||
      propertyName(callee) === undefined
    ) {
      return undefined;
    }
    const values = this.values(FactoryResolver.reference(module, callee.object, new Map()), new Set(), 0);
    if (values === undefined || values.length === 0) {
      return undefined;
    }
    const result: ScopedContextFactoryCandidate[] = [];
    for (const value of values) {
      const fn = FactoryResolver.method(value, propertyName(callee) ?? '');
      if (fn === undefined) {
        const node = unwrap(value.expression);
        const optional = module.calls.some(
          (call) => call.optional && call.callee.start === callee.start && call.callee.end === callee.end,
        );
        const fields = ownDataFields(node);
        const absent =
          fields !== undefined &&
          !fields.has(propertyName(callee) ?? '') &&
          !inheritedObjectNames.has(propertyName(callee) ?? '');
        if (optional && absent) {
          continue;
        }
        return undefined;
      }
      if (value.authority === undefined) {
        return undefined;
      }
      result.push(FactoryResolver.candidate(value.module, fn, value.captures));
    }
    return result;
  }
}
/** Resolve real native Context producers; the caller must still inspect every returned body. */
export const makeScopedContextFactoryResolver = (
  sources: ReadonlyMap<string, string>,
  root: string,
  path: Path.Path,
  packageExports: ReadonlyMap<string, string>,
  conditionalPackageExports: ReadonlyMap<string, readonly string[]> = new Map(),
  contractSources: ReadonlyMap<string, string> = sources,
  nativeSqlRuntimeProof?: NativeSqlRuntimeProofEnvironment,
): Pick<
  FactoryResolver,
  | 'resolve'
  | 'resolveDeclaredFunction'
  | 'resolveDataObjectMethod'
  | 'resolveCapturedValue'
  | 'isNativeMethod'
  | 'isServiceFreeSchema'
  | 'runtimeProofModules'
  | 'resolveNativeSqlSource'
  | 'resolveNativeSqlFunction'
> =>
  new FactoryResolver(
    sources,
    root,
    path,
    packageExports,
    conditionalPackageExports,
    contractSources,
    nativeSqlRuntimeProof,
  );
