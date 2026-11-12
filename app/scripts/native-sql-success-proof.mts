import { createHash } from 'node:crypto';

import { Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  Expression,
  Function as FunctionNode,
  Program,
  Span,
  Statement,
} from 'oxc-parser';

import { nativeColumnInitializationEvidence } from '../tools/oxlint/anti-slop/effect/rules/data-factory-proof.ts';

const nativeSqlTag = 'native-drizzle:sql';
const nativeDrizzleFactory = 'native-drizzle-effect:makeWithDefaults';
const nativePgMake = 'native-pg-root:PgClient.make';
const nativeProvideService = 'native-effect:Effect.provideService';
const nativePgService = 'native-pg-root:PgClient.PgClient';
const nativeLayerEffect = 'native-effect:Layer.effect';
const nativeContextGet = 'native-effect:Context.get';
const transactionIoGuardModule = 'transaction-io-guard.ts';
const word = /^[a-z_][a-z0-9_]*$/u;
const unsafeAliases = new Set(['__proto__', 'prototype', 'constructor']);
const clauseWords = new Set([
  'as',
  'from',
  'select',
  'where',
  'union',
  'intersect',
  'except',
  'order',
  'group',
  'having',
  'limit',
  'offset',
  'distinct',
  'all',
  'with',
  'join',
  'into',
  'returning',
  'over',
  'filter',
]);

const tokens = (source: string): readonly string[] | undefined => {
  if (source.length > 8192) {
    return undefined;
  }
  const token = /'(?:[^'\\]|'')*'|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|::|[(),.]/uy;
  const result: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    token.lastIndex = cursor;
    const match = token.exec(source);
    if (match === null || result.length >= 512) {
      return undefined;
    }
    result.push(match[0].startsWith("'") ? match[0] : match[0].toLowerCase());
    cursor = token.lastIndex;
  }
  return result;
};

class ClosedSelectParser {
  readonly input: readonly string[];
  cursor = 0;
  constructor(input: readonly string[]) {
    this.input = input;
  }
  consume(value: string): boolean {
    if (this.input[this.cursor] !== value) {
      return false;
    }
    this.cursor += 1;
    return true;
  }
  identifier(): boolean {
    const value = this.input[this.cursor];
    if (value === undefined || !word.test(value) || clauseWords.has(value)) {
      return false;
    }
    this.cursor += 1;
    return true;
  }
  qualified(): boolean {
    if (!this.identifier()) {
      return false;
    }
    while (this.consume('.')) {
      if (!this.identifier()) {
        return false;
      }
    }
    return true;
  }
  expression(depth = 0): boolean {
    if (depth >= 64) {
      return false;
    }
    const value = this.input[this.cursor];
    if (value === undefined) {
      return false;
    }
    if (value.startsWith("'") || /^[0-9]+$/u.test(value) || ['true', 'false', 'null'].includes(value)) {
      this.cursor += 1;
    } else if (!this.callOrName(depth)) {
      return false;
    }
    while (this.consume('::')) {
      if (!this.qualified()) {
        return false;
      }
    }
    return true;
  }
  callOrName(depth: number): boolean {
    if (!this.qualified()) {
      return false;
    }
    if (!this.consume('(')) {
      return true;
    }
    if (this.consume(')')) {
      return true;
    }
    do {
      if (!this.expression(depth + 1)) {
        return false;
      }
    } while (this.consume(','));
    return this.consume(')');
  }
  projection(): readonly string[] | undefined {
    if (!this.consume('select')) {
      return undefined;
    }
    const fields: string[] = [];
    do {
      if (!this.expression() || !this.consume('as')) {
        return undefined;
      }
      const alias = this.input[this.cursor];
      if (
        !this.identifier() ||
        alias === undefined ||
        alias.length > 63 ||
        unsafeAliases.has(alias) ||
        fields.includes(alias)
      ) {
        return undefined;
      }
      fields.push(alias);
    } while (this.consume(','));
    return this.cursor === this.input.length ? fields : undefined;
  }
}

/** Syntax evidence only: callers must independently prove the genuine native tag, executor and decoders. */
export const parseClosedNativeSelectProjection = (source: string): readonly string[] | undefined => {
  const input = tokens(source);
  return input === undefined ? undefined : new ClosedSelectParser(input).projection();
};

export interface NativeSqlSourceReference {
  readonly captures?: ReadonlyMap<Span, NativeSqlSourceReference>;
  readonly expression: Expression;
  readonly file: string;
}
export interface NativeSqlProofModule {
  readonly bindings: readonly {
    readonly init?: Expression;
    readonly kind: string;
    readonly name: string;
    readonly node: Span;
    readonly origin?: { readonly imported: string; readonly source: string };
    readonly scope: Span;
  }[];
  readonly file: string;
  readonly program: Program;
  /** The text `program` was parsed from. */
  readonly source: string;
}
export type NativeSqlImportEdge =
  | { readonly kind: 'native-drizzle' | 'native-drizzle-effect' | 'native-pg-root' | 'native-effect' }
  | { readonly file: string; readonly kind: 'module' };
export interface NativeSqlCallableReference {
  readonly captures?: ReadonlyMap<Span, NativeSqlSourceReference>;
  readonly file: string;
  readonly implementation: ArrowFunctionExpression | FunctionNode;
}
export interface NativeSqlProofEnvironment {
  /** `<workspace root>/packages/core-runtime/src/db/`: the only directory whose guarded pool the fence accepts. */
  readonly coreDatabaseDirectory: string;
  readonly modules: readonly NativeSqlProofModule[];
  readonly resolveFunction?: (reference: NativeSqlSourceReference) => NativeSqlCallableReference | undefined;
  readonly resolveImport: (file: string, source: string) => NativeSqlImportEdge | undefined;
  /** Existing source resolver only: follow actual call captures/returns, never a type assertion. */
  readonly resolveValue: (reference: NativeSqlSourceReference) => NativeSqlSourceReference | undefined;
}
export interface NativeSqlDatabaseDescriptor {
  readonly client: NativeSqlSourceReference;
  readonly executor: NativeSqlSourceReference;
}
export interface NativeSqlTransactionDescriptor {
  readonly database: NativeSqlDatabaseDescriptor;
  readonly parameter: {
    readonly binding: Span;
    readonly captures?: ReadonlyMap<Span, NativeSqlSourceReference>;
    readonly file: string;
  };
  readonly transaction: NativeSqlSourceReference;
}

const sourceNodes = new WeakMap<Program, WeakSet<object>>();
const sourceExists = (
  environment: NativeSqlProofEnvironment,
  reference: { readonly expression: Span; readonly file: string },
): boolean => {
  const module = environment.modules.find((candidate) => candidate.file === reference.file);
  if (module === undefined) {
    return false;
  }
  const cached = sourceNodes.get(module.program);
  if (cached !== undefined) {
    return cached.has(reference.expression);
  }
  const nodes = new WeakSet();
  const inspect = (node: Span) => {
    nodes.add(node);
  };
  new Visitor({
    ArrowFunctionExpression: inspect,
    CallExpression: inspect,
    FunctionDeclaration: inspect,
    FunctionExpression: inspect,
    Identifier: inspect,
    Literal: inspect,
    MemberExpression: inspect,
    ObjectExpression: inspect,
    TaggedTemplateExpression: inspect,
    YieldExpression: inspect,
  }).visit(module.program);
  sourceNodes.set(module.program, nodes);
  return nodes.has(reference.expression);
};
const bindingAt = (
  environment: NativeSqlProofEnvironment,
  file: string,
  identifier: Span & { readonly name: string },
): NativeSqlProofModule['bindings'][number] | undefined => {
  const module = environment.modules.find((candidate) => candidate.file === file);
  let found: NativeSqlProofModule['bindings'][number] | undefined;
  for (const binding of module?.bindings ?? []) {
    if (
      binding.name !== identifier.name ||
      binding.scope.start > identifier.start ||
      binding.scope.end < identifier.end
    ) {
      continue;
    }
    if (found === undefined || binding.scope.end - binding.scope.start < found.scope.end - found.scope.start) {
      found = binding;
    } else if (binding.scope.start === found.scope.start && binding.scope.end === found.scope.end) {
      return undefined;
    }
  }
  return found;
};
const sourceValue = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => {
  if (!sourceExists(environment, reference)) {
    return undefined;
  }
  const binding =
    reference.expression.type === 'Identifier'
      ? bindingAt(environment, reference.file, reference.expression)
      : undefined;
  if (
    binding !== undefined &&
    binding.origin === undefined &&
    binding.kind !== 'const' &&
    binding.kind !== 'parameter'
  ) {
    return undefined;
  }
  const resolved = environment.resolveValue(reference);
  return resolved !== undefined && sourceExists(environment, resolved) ? resolved : undefined;
};
const memberName = (expression: Expression): string | undefined =>
  expression.type === 'MemberExpression' &&
  !expression.optional &&
  !expression.computed &&
  expression.property.type === 'Identifier'
    ? expression.property.name
    : undefined;
const nativeIdentity = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  seen: ReadonlySet<Expression> = new Set(),
): string | undefined => {
  if (seen.has(reference.expression) || seen.size >= 32 || !sourceExists(environment, reference)) {
    return undefined;
  }
  const nextSeen = new Set([...seen, reference.expression]);
  const { expression } = reference;
  if (expression.type === 'MemberExpression' && memberName(expression) !== undefined) {
    const owner = nativeIdentity(environment, { ...reference, expression: expression.object }, nextSeen);
    return owner === undefined ? undefined : `${owner}.${memberName(expression)}`;
  }
  if (expression.type !== 'Identifier') {
    return undefined;
  }
  const binding =
    reference.expression.type === 'Identifier'
      ? bindingAt(environment, reference.file, reference.expression)
      : undefined;
  if (binding?.origin !== undefined) {
    const edge = environment.resolveImport(reference.file, binding.origin.source);
    const published = new Map([
      ['native-pg-root', '@effect/sql-pg'],
      ['native-drizzle', 'drizzle-orm'],
      ['native-drizzle-effect', 'drizzle-orm/effect-postgres'],
      ['native-effect', 'effect'],
    ]);
    return edge === undefined || edge.kind === 'module' || published.get(edge.kind) !== binding.origin.source
      ? undefined
      : `${edge.kind}:${binding.origin.imported}`;
  }
  return binding?.kind === 'const' && binding.init !== undefined
    ? nativeIdentity(environment, { ...reference, expression: binding.init }, nextSeen)
    : undefined;
};
/*
 * Security fence: guarded Core pool (transaction I/O guard + session-role check). Core builds its client through
 * these exports of its own database modules; each is accepted only as the import of that exact Core module, named
 * from Core's `db/client.ts` at `<workspace root>/packages/core-runtime/src/db/`, never by name or path suffix.
 */
const coreDatabaseClient = 'client.ts';
const coreDatabaseExports = new Map([
  ['configureDatabasePool', 'pool-configuration.ts'],
  ['guardPoolAcquisition', transactionIoGuardModule],
  ['openDatabaseClient', 'database-client.ts'],
  ['refuseInsideDatabaseTransaction', transactionIoGuardModule],
  ['verifySessionRoleOnFirstUse', 'session-identity.ts'],
]);
/**
 * Security fence: guarded Core pool. The proofs do not close the guard modules' own code (Proxy traps, session
 * state, the shared-pool registry); they trust it only as the exact reviewed source. Each digest is SHA-256 over the
 * module's source text, so any change (a no-op guard, a skipped role query, injected codecs, an appended statement,
 * and equally a reworded comment) fails closed until the guard is reviewed again and its digest updated here.
 */
const reviewedCoreDatabaseGuardModules = new Map([
  ['database-client.ts', '1f749b737c5a0eb691cd602f6aa14a4145ff66913b73d1839a17ab55752036c8'],
  ['session-identity.ts', 'f3f193b79b717163ec79197fb3db7abc829a86d6939c13cab5e6f374fca01223'],
  [transactionIoGuardModule, '4417b2144e1b7b549e5fe0d842f6191076ddb94f12a8538e154dab7ec7499599'],
]);
const reviewedSources = new WeakMap<Program, boolean>();
const isCoreDatabaseClient = (environment: NativeSqlProofEnvironment, file: string): boolean =>
  file === `${environment.coreDatabaseDirectory}${coreDatabaseClient}`;
/** One of Core's guard modules, at Core's own database directory, exactly as reviewed. */
export const isReviewedCoreDatabaseGuardModule = (
  module: Pick<NativeSqlProofModule, 'file' | 'program' | 'source'>,
  coreDatabaseDirectory: string,
): boolean => {
  const name = module.file.startsWith(coreDatabaseDirectory)
    ? module.file.slice(coreDatabaseDirectory.length)
    : undefined;
  const reviewed = name === undefined ? undefined : reviewedCoreDatabaseGuardModules.get(name);
  if (reviewed === undefined) {
    return false;
  }
  let matches = reviewedSources.get(module.program);
  if (matches === undefined) {
    matches = createHash('sha256').update(module.source).digest('hex') === reviewed;
    reviewedSources.set(module.program, matches);
  }
  return matches;
};
/** One exported top-level `const` of this name, and no other top-level declaration of it. */
const declaresExportedConst = (module: NativeSqlProofModule, name: string): boolean => {
  let exported = 0;
  let declared = 0;
  for (const statement of module.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.id.name === name) {
          declared += 1;
          if (statement !== declaration && declaration.kind === 'const' && declarator.init !== null) {
            exported += 1;
          }
        }
      }
    } else if (
      (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') &&
      declaration.id?.name === name
    ) {
      declared += 1;
    }
  }
  return (
    exported === 1 &&
    declared === 1 &&
    !module.bindings.some((binding) => binding.name === name && binding.origin !== undefined)
  );
};
/** The Core export an identifier in Core's `db/client.ts` imports, when it is that exact Core declaration. */
const coreDatabaseExport = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): string | undefined => {
  const directory = isCoreDatabaseClient(environment, reference.file) ? environment.coreDatabaseDirectory : undefined;
  const { expression } = reference;
  const binding =
    expression.type === 'Identifier' && sourceExists(environment, reference)
      ? bindingAt(environment, reference.file, expression)
      : undefined;
  const declaredIn = binding?.origin === undefined ? undefined : coreDatabaseExports.get(binding.origin.imported);
  if (directory === undefined || binding?.origin === undefined || declaredIn === undefined) {
    return undefined;
  }
  const edge = environment.resolveImport(reference.file, binding.origin.source);
  const module =
    edge?.kind === 'module' && edge.file === `${directory}${declaredIn}`
      ? environment.modules.find((candidate) => candidate.file === edge.file)
      : undefined;
  const reviewed =
    module !== undefined &&
    (!reviewedCoreDatabaseGuardModules.has(declaredIn) ||
      isReviewedCoreDatabaseGuardModule(module, environment.coreDatabaseDirectory));
  return module !== undefined && reviewed && declaresExportedConst(module, binding.origin.imported)
    ? binding.origin.imported
    : undefined;
};
const isNativeHandleIdentity = (identity: string | undefined): boolean =>
  identity !== undefined &&
  ['native-pg-root:PgClient', nativeSqlTag, nativeDrizzleFactory, 'native-effect:Effect'].some(
    (root) => identity === root || identity.startsWith(`${root}.`),
  );
const hasClosedNativeModuleHandles = (
  environment: NativeSqlProofEnvironment,
  module: NativeSqlProofModule,
): boolean => {
  // Security fence: guarded Core pool (transaction I/O guard + session-role check). Core's own guard modules
  // hold the client inside their guards; only their exact reviewed source is skipped here.
  if (isReviewedCoreDatabaseGuardModule(module, environment.coreDatabaseDirectory)) {
    return true;
  }
  let valid = true;
  const allowed: Span[] = [];
  const identifiers: (Span & { readonly name: string })[] = [];
  const reference = (expression: Expression) => ({ expression, file: module.file });
  const tracked = (expression: Expression) =>
    isNativeHandleIdentity(nativeIdentity(environment, reference(expression)));
  // Security fence: guarded Core pool. Core's client builds the PgClient service as a Layer and reads it back.
  const coreClientTag = (call: Extract<Expression, { type: 'CallExpression' }>): Expression | undefined => {
    const identity = nativeIdentity(environment, reference(call.callee));
    const tag = call.arguments[identity === nativeLayerEffect ? 0 : 1];
    return isCoreDatabaseClient(environment, module.file) &&
      call.arguments.length === 2 &&
      (identity === nativeLayerEffect || identity === nativeContextGet) &&
      tag !== undefined &&
      tag.type !== 'SpreadElement' &&
      nativeIdentity(environment, reference(tag)) === nativePgService
      ? tag
      : undefined;
  };
  new Visitor({
    CallExpression: (node) => {
      const identity = nativeIdentity(environment, reference(node.callee));
      const tag = coreClientTag(node);
      if (tag !== undefined) {
        allowed.push(tag);
      }
      if (
        identity === nativePgMake ||
        identity === nativeDrizzleFactory ||
        identity === 'native-drizzle:sql.raw' ||
        identity === 'native-drizzle:sql.join' ||
        identity?.startsWith('native-effect:Effect.') === true
      ) {
        allowed.push(node.callee);
      }
      if (identity === nativeProvideService) {
        const [service] = node.arguments;
        if (
          service !== undefined &&
          service.type !== 'SpreadElement' &&
          nativeIdentity(environment, reference(service)) === nativePgService
        ) {
          allowed.push(service);
        }
      }
    },
    ExportNamedDeclaration: (node) => {
      if (node.declaration?.type === 'VariableDeclaration') {
        for (const declaration of node.declaration.declarations) {
          if (declaration.init !== null && declaration.init !== undefined && tracked(declaration.init)) {
            valid = false;
          }
        }
      }
      for (const specifier of node.specifiers) {
        if (specifier.local.type === 'Identifier' && tracked(specifier.local)) {
          valid = false;
        }
      }
    },
    Identifier: (node) => {
      identifiers.push(node);
    },
    ImportDeclaration: (node) => {
      allowed.push(node);
    },
    MemberExpression: (node) => {
      if (!node.computed) {
        allowed.push(node.property);
      }
      if (
        ['native-effect:Effect.asVoid', 'native-effect:Effect.void'].includes(
          nativeIdentity(environment, reference(node)) ?? '',
        )
      ) {
        allowed.push(node);
      }
    },
    Property: (node) => {
      if (!node.computed && !node.shorthand) {
        allowed.push(node.key);
      }
    },
    TaggedTemplateExpression: (node) => {
      if (nativeIdentity(environment, reference(node.tag)) === nativeSqlTag) {
        allowed.push(node.tag);
      }
    },
    TSInterfaceDeclaration: (node) => {
      allowed.push(node);
    },
    TSTypeAliasDeclaration: (node) => {
      allowed.push(node);
    },
    TSTypeAnnotation: (node) => {
      allowed.push(node);
    },
    VariableDeclarator: (node) => {
      allowed.push(node.id);
      if (node.init !== null && node.init !== undefined && tracked(node.init)) {
        const alias = module.bindings.find((binding) => binding.node === node.id);
        if (alias?.kind === 'const') {
          allowed.push(node.init);
        }
      }
    },
  }).visit(module.program);
  for (const identifier of identifiers) {
    const binding = bindingAt(environment, module.file, identifier);
    const identity =
      binding?.origin === undefined ? undefined : environment.resolveImport(module.file, binding.origin.source);
    const isTracked =
      (identity !== undefined &&
        identity.kind !== 'module' &&
        binding?.origin !== undefined &&
        isNativeHandleIdentity(`${identity.kind}:${binding.origin.imported}`)) ||
      (binding?.init !== undefined && tracked(binding.init));
    if (isTracked && !allowed.some((span) => span.start <= identifier.start && identifier.end <= span.end)) {
      valid = false;
    }
  }
  return valid;
};
const hasClosedNativeHandles = (environment: NativeSqlProofEnvironment): boolean =>
  environment.modules.every((module) => hasClosedNativeModuleHandles(environment, module));

const callOf = (reference: NativeSqlSourceReference) =>
  reference.expression.type === 'CallExpression' && !reference.expression.optional ? reference.expression : undefined;
const resolveArgument = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  index: number,
): NativeSqlSourceReference | undefined => {
  const expression = callOf(reference)?.arguments[index];
  return expression === undefined || expression.type === 'SpreadElement'
    ? undefined
    : sourceValue(environment, { ...reference, expression });
};
const sameSource = (
  left: NativeSqlSourceReference | undefined,
  right: NativeSqlSourceReference,
  depth = 0,
): boolean => {
  if (left?.file !== right.file || left.expression !== right.expression) {
    return false;
  }
  if (left.captures === right.captures) {
    return true;
  }
  if (depth >= 64 || (left.captures?.size ?? 0) !== (right.captures?.size ?? 0)) {
    return false;
  }
  for (const [binding, value] of left.captures ?? []) {
    const other = right.captures?.get(binding);
    if (other === undefined || !sameSource(value, other, depth + 1)) {
      return false;
    }
  }
  return true;
};
const sameCaptures = (
  left: NativeSqlSourceReference['captures'],
  right: NativeSqlSourceReference['captures'],
): boolean => {
  if ((left?.size ?? 0) !== (right?.size ?? 0)) {
    return false;
  }
  for (const [binding, value] of left ?? []) {
    const other = right?.get(binding);
    if (other === undefined || !sameSource(value, other)) {
      return false;
    }
  }
  return true;
};
const hasClosedConfigModuleHandles = (
  environment: NativeSqlProofEnvironment,
  target: NativeSqlSourceReference,
  module: NativeSqlProofModule,
): boolean => {
  let valid = true;
  const matches = (expression: Expression) =>
    sameSource(sourceValue(environment, { ...target, expression, file: module.file }), target);
  const checkArguments = (
    inputs: readonly (Expression | { readonly argument: Expression; readonly type: 'SpreadElement' })[],
    safe: boolean,
  ) => {
    if (!safe && inputs.some((argument) => matches(argument.type === 'SpreadElement' ? argument.argument : argument))) {
      valid = false;
    }
  };
  new Visitor({
    ArrayExpression: (node) => {
      if (
        node.elements.some(
          (element) => element !== null && matches(element.type === 'SpreadElement' ? element.argument : element),
        )
      ) {
        valid = false;
      }
    },
    AssignmentExpression: (node) => {
      if (matches(node.right) || (node.left.type === 'MemberExpression' && matches(node.left.object))) {
        valid = false;
      }
    },
    CallExpression: (node) => {
      const callee = { expression: node.callee, file: module.file };
      checkArguments(
        node.arguments,
        [nativePgMake, nativeDrizzleFactory].includes(nativeIdentity(environment, callee) ?? '') ||
          // Security fence: guarded Core pool. Core opens its pooled client from the same configuration.
          coreDatabaseExport(environment, callee) === 'openDatabaseClient',
      );
    },
    NewExpression: (node) => {
      checkArguments(node.arguments, false);
    },
    Property: (node) => {
      const { value } = node;
      if (
        (value.type === 'ObjectExpression' && matches(value)) ||
        (value.type === 'Identifier' &&
          module.bindings.some(
            (binding) =>
              binding.name === value.name &&
              binding.scope.start <= value.start &&
              value.end <= binding.scope.end &&
              binding.init !== undefined &&
              matches(binding.init),
          ))
      ) {
        valid = false;
      }
    },
    ReturnStatement: (node) => {
      if (
        node.argument !== null &&
        node.argument !== undefined &&
        node.argument !== target.expression &&
        matches(node.argument)
      ) {
        valid = false;
      }
    },
    UpdateExpression: (node) => {
      if (node.argument.type === 'MemberExpression' && matches(node.argument.object)) {
        valid = false;
      }
    },
  }).visit(module.program);
  return valid;
};
const hasClosedConfigHandles = (environment: NativeSqlProofEnvironment, target: NativeSqlSourceReference): boolean =>
  environment.modules.every((module) => hasClosedConfigModuleHandles(environment, target, module));

const objectKeys = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  allowed: ReadonlySet<string>,
  seen: ReadonlySet<Expression> = new Set(),
): ReadonlySet<string> | undefined => {
  const resolved = sourceValue(environment, reference);
  if (
    resolved === undefined ||
    resolved.expression.type !== 'ObjectExpression' ||
    seen.has(resolved.expression) ||
    seen.size >= 32 ||
    !hasClosedConfigHandles(environment, resolved)
  ) {
    return undefined;
  }
  const keys = new Set<string>();
  const nextSeen = new Set([...seen, resolved.expression]);
  for (const property of resolved.expression.properties) {
    if (property.type === 'SpreadElement') {
      const spread = objectKeys(environment, { ...resolved, expression: property.argument }, allowed, nextSeen);
      if (spread === undefined) {
        return undefined;
      }
      for (const key of spread) {
        if (keys.has(key)) {
          return undefined;
        }
        keys.add(key);
      }
      continue;
    }
    if (
      property.computed ||
      property.kind !== 'init' ||
      property.method ||
      property.key.type !== 'Identifier' ||
      !allowed.has(property.key.name) ||
      keys.has(property.key.name)
    ) {
      return undefined;
    }
    keys.add(property.key.name);
  }
  return keys;
};

type NativeInstanceTarget = NativeSqlSourceReference | { readonly binding: Span; readonly file: string };
const custodyAliasOrigin = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  seen: ReadonlySet<Span> = new Set(),
): NativeSqlSourceReference => {
  const binding =
    reference.expression.type === 'Identifier'
      ? bindingAt(environment, reference.file, reference.expression)
      : undefined;
  if (binding !== undefined && !seen.has(binding.node) && seen.size < 64) {
    const captured = reference.captures?.get(binding.node);
    const input = captured ?? (binding.init === undefined ? undefined : { ...reference, expression: binding.init });
    if (input !== undefined) {
      return custodyAliasOrigin(environment, input, new Set([...seen, binding.node]));
    }
  }
  return reference;
};
const custodyValue = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => sourceValue(environment, custodyAliasOrigin(environment, reference));
const containsNativeInstance = (
  environment: NativeSqlProofEnvironment,
  input: NativeSqlSourceReference,
  target: NativeInstanceTarget,
  seen: ReadonlySet<Expression> = new Set(),
): boolean => {
  if (seen.size >= 64 || seen.has(input.expression)) {
    return false;
  }
  const resolved = custodyValue(environment, input);
  if (resolved === undefined) {
    return false;
  }
  if (
    'binding' in target &&
    resolved.expression.type === 'Identifier' &&
    resolved.file === target.file &&
    bindingAt(environment, resolved.file, resolved.expression)?.node === target.binding
  ) {
    return true;
  }
  if ('expression' in target && resolved.file === target.file && resolved.expression === target.expression) {
    return true;
  }
  const next = new Set([...seen, input.expression]);
  const { expression } = resolved;
  const children: Expression[] = [];
  if (expression.type === 'ObjectExpression') {
    children.push(
      ...expression.properties.map((property) =>
        property.type === 'SpreadElement' ? property.argument : property.value,
      ),
    );
  } else if (expression.type === 'ArrayExpression') {
    children.push(
      ...expression.elements.flatMap((element) =>
        element === null ? [] : [element.type === 'SpreadElement' ? element.argument : element],
      ),
    );
  } else if (expression.type === 'MemberExpression') {
    children.push(expression.object);
  }

  return children.some((child) =>
    containsNativeInstance(environment, { ...resolved, expression: child }, target, next),
  );
};
const nativeCallCaptures = (
  environment: NativeSqlProofEnvironment,
  frame: Pick<NativeSqlSourceReference, 'captures' | 'file'>,
  call: Extract<Expression, { type: 'CallExpression' }>,
  fn: NativeSqlCallableReference,
): ReadonlyMap<Span, NativeSqlSourceReference> | undefined => {
  if (!sourceExists(environment, { expression: fn.implementation, file: fn.file })) {
    return undefined;
  }
  const captures = new Map(fn.captures);
  for (const [index, parameter] of fn.implementation.params.entries()) {
    const argument = call.arguments[index];
    if (parameter.type !== 'Identifier' || argument === undefined || argument.type === 'SpreadElement') {
      return undefined;
    }
    const module = environment.modules.find((candidate) => candidate.file === fn.file);
    const binding = module?.bindings.find((candidate) => candidate.node === parameter);
    if (binding === undefined) {
      return undefined;
    }
    captures.set(binding.node, { ...frame, expression: argument });
  }
  return captures;
};
const hasClosedInstanceScope = (
  environment: NativeSqlProofEnvironment,
  frame: Pick<NativeSqlSourceReference, 'captures' | 'file'>,
  scope: Span,
  target: NativeInstanceTarget,
  stack: ReadonlySet<Span>,
): boolean => {
  let valid = true;
  const moduleProgram = environment.modules.find((module) => module.file === frame.file)?.program;
  if (moduleProgram === undefined) {
    return false;
  }
  const within = (node: Span) => scope.start <= node.start && node.end <= scope.end;
  const contains = (expression: Expression) => containsNativeInstance(environment, { ...frame, expression }, target);
  new Visitor({
    AssignmentExpression: (node) => {
      if (!within(node)) {
        return;
      }
      if (contains(node.right) || (node.left.type === 'MemberExpression' && contains(node.left.object))) {
        valid = false;
      }
    },
    CallExpression: (node) => {
      if (!within(node)) {
        return;
      }
      const indexes = node.arguments.flatMap((argument, index) =>
        contains(argument.type === 'SpreadElement' ? argument.argument : argument) ? [index] : [],
      );
      if (indexes.length === 0) {
        return;
      }
      const identity = nativeIdentity(environment, { ...frame, expression: node.callee });
      if (identity === nativeProvideService && indexes.every((index) => index === 1)) {
        return;
      }
      if (
        node.callee.type === 'MemberExpression' &&
        memberName(node.callee) === 'bind' &&
        contains(node.callee.object) &&
        indexes.length === 1 &&
        indexes[0] === 0
      ) {
        return;
      }
      const fn = environment.resolveFunction?.({ ...frame, expression: node.callee });
      if (fn === undefined || fn.implementation.body === null || stack.has(fn.implementation) || stack.size >= 64) {
        valid = false;
        return;
      }
      const captures = nativeCallCaptures(environment, frame, node, fn);
      if (captures === undefined) {
        valid = false;
        return;
      }
      valid &&= hasClosedInstanceScope(
        environment,
        { captures, file: fn.file },
        fn.implementation.body,
        target,
        new Set([...stack, fn.implementation]),
      );
    },
    NewExpression: (node) => {
      if (!within(node)) {
        return;
      }
      if (
        node.arguments.some((argument) => contains(argument.type === 'SpreadElement' ? argument.argument : argument))
      ) {
        valid = false;
      }
    },
    PropertyDefinition: (node) => {
      if (within(node) && node.value !== null && node.value !== undefined && contains(node.value)) {
        valid = false;
      }
    },
    UpdateExpression: (node) => {
      if (!within(node)) {
        return;
      }
      if (node.argument.type === 'MemberExpression' && contains(node.argument.object)) {
        valid = false;
      }
    },
  }).visit(moduleProgram);
  return valid;
};
const hasClosedNativeInstance = (environment: NativeSqlProofEnvironment, target: NativeInstanceTarget): boolean =>
  environment.modules.every((module) =>
    hasClosedInstanceScope(environment, { file: module.file }, module.program, target, new Set()),
  );

const nativeClientFactory = (
  environment: NativeSqlProofEnvironment,
  client: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => {
  const call = callOf(client);
  if (call?.callee.type !== 'MemberExpression' || memberName(call.callee) !== 'pipe') {
    return client;
  }
  for (let index = 0; index < call.arguments.length; index += 1) {
    const adapter = resolveArgument(environment, client, index);
    const adapterCall = adapter === undefined ? undefined : callOf(adapter);
    const identity =
      adapter === undefined || adapterCall === undefined
        ? undefined
        : nativeIdentity(environment, { ...adapter, expression: adapterCall.callee });
    if (identity !== nativeProvideService && identity !== 'native-effect:Effect.mapError') {
      return undefined;
    }
  }
  return { ...client, expression: call.callee.object };
};
const nativeDatabaseProvider = (
  environment: NativeSqlProofEnvironment,
  resolved: NativeSqlSourceReference,
  factoryExpression: Expression,
): NativeSqlSourceReference | undefined => {
  const factory = { ...resolved, expression: factoryExpression };
  const factoryCall = callOf(factory);
  if (
    factoryCall === undefined ||
    factoryCall.arguments.length !== 1 ||
    nativeIdentity(environment, { ...factory, expression: factoryCall.callee }) !== nativeDrizzleFactory
  ) {
    return undefined;
  }
  const options = resolveArgument(environment, factory, 0);
  const optionsKeys = options === undefined ? undefined : objectKeys(environment, options, new Set(['relations']));
  if (optionsKeys?.size !== 1) {
    return undefined;
  }
  const provider = resolveArgument(environment, resolved, 0);
  const providerCall = provider === undefined ? undefined : callOf(provider);
  if (
    provider === undefined ||
    providerCall === undefined ||
    providerCall.arguments.length !== 2 ||
    nativeIdentity(environment, { ...provider, expression: providerCall.callee }) !== nativeProvideService
  ) {
    return undefined;
  }
  const [service] = providerCall.arguments;
  if (
    service === undefined ||
    service.type === 'SpreadElement' ||
    nativeIdentity(environment, { ...provider, expression: service }) !== nativePgService
  ) {
    return undefined;
  }
  return provider;
};
/*
 * Security fence: guarded Core pool (transaction I/O guard + session-role check). Exactly Core's construction:
 *
 *   verifySessionRoleOnFirstUse(Context.get(yield* Layer.build(guardedPgClientLayer(...)).pipe(mapError), PgClient), role)
 *   guardedPgClientLayer = Layer.effect(PgClient, Effect.gen(function* () {
 *     yield* refuseInsideDatabaseTransaction(...); const configuration = yield* configureDatabasePool(...);
 *     const reactivity = yield* Reactivity.make;
 *     const client = yield* (pooled ? openDatabaseClient(configuration) : PgClient.make(configuration)).pipe(provideService);
 *     return guardPoolAcquisition(client);
 *   }))
 *
 * Every guard is the import of Core's own export; anything else (an unguarded pool, a missing guard, a look-alike
 * guard) is not this shape and falls back to the native `PgClient.make` proof, which refuses it.
 */
interface GuardedCorePool {
  /** Each pool acquisition the guards wrap: a native `PgClient.make` or Core's `openDatabaseClient`. */
  readonly acquisitions: readonly NativeSqlSourceReference[];
  readonly client: NativeSqlSourceReference;
}
const delegatedOperand = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => {
  const origin = custodyAliasOrigin(environment, reference);
  const { expression } = origin;
  return expression.type === 'YieldExpression' && expression.delegate && expression.argument !== null
    ? { ...origin, expression: expression.argument }
    : undefined;
};
/** The piped receiver, when every adapter is a direct call of one of the given native identities. */
const pipedReceiver = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  adapter: string,
): NativeSqlSourceReference | undefined => {
  const call = callOf(reference);
  if (call?.callee.type !== 'MemberExpression' || memberName(call.callee) !== 'pipe' || call.arguments.length === 0) {
    return undefined;
  }
  const adapted = call.arguments.every(
    (argument) =>
      argument.type === 'CallExpression' &&
      !argument.optional &&
      nativeIdentity(environment, { ...reference, expression: argument.callee }) === adapter,
  );
  return adapted ? { ...reference, expression: call.callee.object } : undefined;
};
const coreCallOf = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  expression: Expression,
  name: string,
  arity: number,
) =>
  expression.type === 'CallExpression' &&
  !expression.optional &&
  expression.arguments.length === arity &&
  expression.arguments.every((argument) => argument.type !== 'SpreadElement') &&
  coreDatabaseExport(environment, { ...reference, expression: expression.callee }) === name
    ? expression
    : undefined;
const isDelegatedCoreCall = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  expression: Expression,
  name: string,
  arity: number,
): boolean =>
  expression.type === 'YieldExpression' &&
  expression.delegate &&
  expression.argument !== null &&
  coreCallOf(environment, reference, expression.argument, name, arity) !== undefined;
const soleConstIdentifier = (statement: Statement | undefined) =>
  statement?.type === 'VariableDeclaration' &&
  statement.kind === 'const' &&
  statement.declarations.length === 1 &&
  statement.declarations[0]?.id.type === 'Identifier' &&
  statement.declarations[0].init !== null &&
  statement.declarations[0].init !== undefined
    ? { id: statement.declarations[0].id, init: statement.declarations[0].init }
    : undefined;
/** `pooled ? openDatabaseClient(configuration) : PgClient.make(configuration)`, or one of them alone. */
const poolAcquisitions = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): readonly NativeSqlSourceReference[] | undefined => {
  const node =
    reference.expression.type === 'ParenthesizedExpression' ? reference.expression.expression : reference.expression;
  const plainCondition =
    node.type === 'ConditionalExpression' &&
    node.test.type === 'BinaryExpression' &&
    node.test.operator === '===' &&
    [node.test.left, node.test.right].every((side) => side.type === 'MemberExpression' || side.type === 'Literal');
  const branches = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node];
  if (node.type === 'ConditionalExpression' && !plainCondition) {
    return undefined;
  }
  const acquisitions = branches.map((branch) => ({ ...reference, expression: branch }));
  return acquisitions.every((acquisition) => {
    const call = callOf(acquisition);
    return (
      call !== undefined &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type !== 'SpreadElement' &&
      (nativeIdentity(environment, { ...acquisition, expression: call.callee }) === nativePgMake ||
        coreCallOf(environment, acquisition, call, 'openDatabaseClient', 1) !== undefined)
    );
  })
    ? acquisitions
    : undefined;
};
/** The body of Core's guarded layer: exactly the transaction I/O guards around one pool acquisition. */
/** A direct call of the given native identity with exactly `arity` plain arguments. */
const nativeCallOf = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference | undefined,
  identity: string,
  arity: number,
) => {
  const call = reference === undefined ? undefined : callOf(reference);
  return reference !== undefined &&
    call !== undefined &&
    call.arguments.length === arity &&
    call.arguments.every((argument) => argument.type !== 'SpreadElement') &&
    nativeIdentity(environment, { ...reference, expression: call.callee }) === identity
    ? call
    : undefined;
};
const plainArgument = (call: Extract<Expression, { type: 'CallExpression' }> | undefined, index: number) => {
  const argument = call?.arguments[index];
  return argument === undefined || argument.type === 'SpreadElement' ? undefined : argument;
};
const isNativeTag = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  expression: Expression | undefined,
): boolean => expression !== undefined && nativeIdentity(environment, { ...reference, expression }) === nativePgService;
/** `const reactivity = yield* Reactivity.make`, with `Reactivity` imported from `effect/reactivity`. */
const isReactivityMake = (
  environment: NativeSqlProofEnvironment,
  program: NativeSqlSourceReference,
  init: Expression,
): boolean => {
  const made = init.type === 'YieldExpression' ? init.argument : undefined;
  const owner = made?.type === 'MemberExpression' && memberName(made) === 'make' ? made.object : undefined;
  const origin = owner?.type === 'Identifier' ? bindingAt(environment, program.file, owner)?.origin : undefined;
  return origin?.source === 'effect/reactivity' && origin.imported === 'Reactivity';
};
/** The acquired client is read once in the layer body: by the guard that returns it. */
const readOnceByGuard = (
  environment: NativeSqlProofEnvironment,
  program: NativeSqlSourceReference,
  returned: Statement | undefined,
  client: Span,
): boolean => {
  const guard =
    returned?.type === 'ReturnStatement' && returned.argument !== null && returned.argument !== undefined
      ? coreCallOf(environment, program, returned.argument, 'guardPoolAcquisition', 1)
      : undefined;
  const guarded = plainArgument(guard, 0);
  const module = environment.modules.find((candidate) => candidate.file === program.file);
  if (guarded?.type !== 'Identifier' || bindingAt(environment, program.file, guarded)?.node !== client || !module) {
    return false;
  }
  let uses = 0;
  new Visitor({
    Identifier: (node) => {
      if (node !== client && bindingAt(environment, program.file, node)?.node === client) {
        uses += 1;
      }
    },
  }).visit(module.program);
  return uses === 1;
};
/** The body of Core's guarded layer: exactly the transaction I/O guards around one pool acquisition. */
const guardedLayerAcquisitions = (
  environment: NativeSqlProofEnvironment,
  program: NativeSqlSourceReference,
): readonly NativeSqlSourceReference[] | undefined => {
  const fn = program.expression;
  const plain = fn.type === 'FunctionExpression' && fn.generator && !fn.async && fn.params.length === 0;
  const statements = plain ? fn.body?.body : undefined;
  if (statements?.length !== 5) {
    return undefined;
  }
  const [refusal, configured, reactive, acquired, returned] = statements;
  const configuration = soleConstIdentifier(configured);
  const reactivity = soleConstIdentifier(reactive);
  const client = soleConstIdentifier(acquired);
  if (
    refusal?.type !== 'ExpressionStatement' ||
    !isDelegatedCoreCall(environment, program, refusal.expression, 'refuseInsideDatabaseTransaction', 2) ||
    configuration === undefined ||
    !isDelegatedCoreCall(environment, program, configuration.init, 'configureDatabasePool', 3) ||
    reactivity === undefined ||
    !isReactivityMake(environment, program, reactivity.init) ||
    client === undefined ||
    !readOnceByGuard(environment, program, returned, client.id)
  ) {
    return undefined;
  }
  const pooled = delegatedOperand(environment, { ...program, expression: client.init });
  const receiver = pooled === undefined ? undefined : pipedReceiver(environment, pooled, nativeProvideService);
  return receiver === undefined ? undefined : poolAcquisitions(environment, receiver);
};
/** `yield* Layer.build(layer).pipe(Effect.mapError(...))`, answered as the layer it builds. */
const builtLayer = (
  environment: NativeSqlProofEnvironment,
  context: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => {
  const built = delegatedOperand(environment, context);
  const build = built === undefined ? undefined : pipedReceiver(environment, built, 'native-effect:Effect.mapError');
  return nativeCallOf(environment, build, 'native-effect:Layer.build', 1) === undefined || build === undefined
    ? undefined
    : resolveArgument(environment, build, 0);
};
const guardedCorePool = (
  environment: NativeSqlProofEnvironment,
  provided: NativeSqlSourceReference,
): GuardedCorePool | undefined => {
  const client = custodyAliasOrigin(environment, provided);
  const pooled = plainArgument(coreCallOf(environment, client, client.expression, 'verifySessionRoleOnFirstUse', 2), 0);
  const lookup = pooled === undefined ? undefined : custodyAliasOrigin(environment, { ...client, expression: pooled });
  const get = nativeCallOf(environment, lookup, nativeContextGet, 2);
  const context = plainArgument(get, 0);
  const layer =
    lookup === undefined || context === undefined || !isNativeTag(environment, lookup, plainArgument(get, 1))
      ? undefined
      : builtLayer(environment, { ...lookup, expression: context });
  const layerCall = nativeCallOf(environment, layer, nativeLayerEffect, 2);
  const program = plainArgument(layerCall, 1);
  const generator =
    layer === undefined || program === undefined
      ? undefined
      : nativeCallOf(environment, { ...layer, expression: program }, 'native-effect:Effect.gen', 1);
  const body = plainArgument(generator, 0);
  const acquisitions =
    layer === undefined ||
    body === undefined ||
    !isCoreDatabaseClient(environment, layer.file) ||
    !isNativeTag(environment, layer, plainArgument(layerCall, 0))
      ? undefined
      : guardedLayerAcquisitions(environment, { ...layer, expression: body });
  return acquisitions === undefined ? undefined : { acquisitions, client };
};
/**
 * Security fence: guarded Core pool. The guarded client is one `const` of Core's client, initialized by the
 * session-role check itself and read only as the PgClient service the executor is built over.
 */
const guardedClientClosed = (
  environment: NativeSqlProofEnvironment,
  provider: NativeSqlSourceReference,
  provided: Expression,
  client: NativeSqlSourceReference,
): boolean => {
  if (provided === client.expression) {
    return true;
  }
  const binding = provided.type === 'Identifier' ? bindingAt(environment, provider.file, provided) : undefined;
  const module = environment.modules.find((candidate) => candidate.file === provider.file);
  if (
    binding?.kind !== 'const' ||
    binding.origin !== undefined ||
    binding.init !== client.expression ||
    client.file !== provider.file ||
    module === undefined
  ) {
    return false;
  }
  const provisions: Span[] = [];
  const reads: Span[] = [];
  new Visitor({
    CallExpression: (node) => {
      const [, service] = node.arguments;
      if (
        node.arguments.length === 2 &&
        service !== undefined &&
        service.type !== 'SpreadElement' &&
        nativeIdentity(environment, { expression: node.callee, file: module.file }) === nativeProvideService
      ) {
        provisions.push(service);
      }
    },
    Identifier: (node) => {
      if (node !== binding.node && bindingAt(environment, module.file, node)?.node === binding.node) {
        reads.push(node);
      }
    },
  }).visit(module.program);
  return reads.length > 0 && reads.every((read) => provisions.includes(read));
};
const guardedPoolConfigKeys = new Set([
  'url',
  'connectTimeout',
  'idleTimeout',
  'maxConnections',
  'processShared',
  'startupParameters',
]);
const copyNativeSource = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  depth = 0,
): NativeSqlSourceReference | undefined => {
  if (depth >= 64 || !sourceExists(environment, reference)) {
    return undefined;
  }
  const captures = new Map<Span, NativeSqlSourceReference>();
  for (const [binding, input] of reference.captures ?? []) {
    if (!environment.modules.some((module) => module.bindings.some((candidate) => candidate.node === binding))) {
      return undefined;
    }
    const value = copyNativeSource(environment, input, depth + 1);
    if (value === undefined) {
      return undefined;
    }
    captures.set(binding, value);
  }
  return Object.freeze({ captures: Object.freeze(captures), expression: reference.expression, file: reference.file });
};
interface NativeDatabaseFact {
  readonly environment: NativeSqlProofEnvironment;
  readonly executor: NativeSqlSourceReference;
}
interface NativeTransactionFact {
  readonly environment: NativeSqlProofEnvironment;
  readonly parameter: NativeSqlTransactionDescriptor['parameter'];
}
const databaseTokens = new WeakMap<NativeSqlDatabaseDescriptor, NativeDatabaseFact>();
const transactionTokens = new WeakMap<NativeSqlTransactionDescriptor, NativeTransactionFact>();

const nativeDatabaseToken = (
  environment: NativeSqlProofEnvironment,
  client: NativeSqlSourceReference,
  resolved: NativeSqlSourceReference,
): NativeSqlDatabaseDescriptor | undefined => {
  const privateExecutor = copyNativeSource(environment, resolved);
  const publicExecutor = copyNativeSource(environment, resolved);
  const publicClient = copyNativeSource(environment, client);
  if (privateExecutor === undefined || publicExecutor === undefined || publicClient === undefined) {
    return undefined;
  }
  const descriptor = Object.freeze({ client: publicClient, executor: publicExecutor });
  databaseTokens.set(descriptor, { environment, executor: privateExecutor });
  return descriptor;
};
/** Main's native shape: the executor is built over one `PgClient.make` client, adapted only by provide/mapError. */
const describeNativePgMakeDatabase = (
  environment: NativeSqlProofEnvironment,
  provider: NativeSqlSourceReference,
  resolved: NativeSqlSourceReference,
): NativeSqlDatabaseDescriptor | undefined => {
  const client = resolveArgument(environment, provider, 1);
  if (client === undefined) {
    return undefined;
  }
  const clientFactory = nativeClientFactory(environment, client);
  const clientCall = clientFactory === undefined ? undefined : callOf(clientFactory);

  if (
    clientFactory === undefined ||
    clientCall === undefined ||
    clientCall.arguments.length !== 1 ||
    nativeIdentity(environment, { ...clientFactory, expression: clientCall.callee }) !== nativePgMake
  ) {
    return undefined;
  }
  const config = resolveArgument(environment, clientFactory, 0);
  const configKeys =
    config === undefined
      ? undefined
      : objectKeys(environment, config, new Set(['url', 'connectTimeout', 'startupParameters', 'maxConnections']));
  if (
    configKeys?.has('url') !== true ||
    !hasClosedNativeInstance(environment, client) ||
    !hasClosedNativeInstance(environment, resolved)
  ) {
    return undefined;
  }
  return nativeDatabaseToken(environment, client, resolved);
};
const notGuarded = 'not guarded';
/**
 * Security fence: guarded Core pool (transaction I/O guard + session-role check). The guards wrap a pool
 * acquisition whose configuration names the URL and pool settings only, never codecs. `not guarded` hands the
 * provider to the native `PgClient.make` proof unchanged.
 */
const guardedCorePoolDatabase = (
  environment: NativeSqlProofEnvironment,
  provider: NativeSqlSourceReference,
  resolved: NativeSqlSourceReference,
): NativeSqlDatabaseDescriptor | typeof notGuarded | undefined => {
  const provided = plainArgument(callOf(provider), 1);
  const guarded =
    provided === undefined ? undefined : guardedCorePool(environment, { ...provider, expression: provided });
  if (guarded === undefined || provided === undefined) {
    return notGuarded;
  }
  const configured = guarded.acquisitions.every((acquisition) => {
    const config = resolveArgument(environment, acquisition, 0);
    return config !== undefined && objectKeys(environment, config, guardedPoolConfigKeys)?.has('url') === true;
  });
  return configured &&
    guardedClientClosed(environment, provider, provided, guarded.client) &&
    hasClosedNativeInstance(environment, resolved)
    ? nativeDatabaseToken(environment, guarded.client, resolved)
    : undefined;
};
/** Conditional native constructor evidence; does not establish decoder custody or row contents. */
export const describeNativeSqlDatabase = (
  environment: NativeSqlProofEnvironment,
  executor: NativeSqlSourceReference,
): NativeSqlDatabaseDescriptor | undefined => {
  if (!hasClosedNativeHandles(environment)) {
    return undefined;
  }
  const resolved = sourceValue(environment, executor);
  const pipe = resolved === undefined ? undefined : callOf(resolved);
  if (
    resolved === undefined ||
    pipe === undefined ||
    pipe.callee.type !== 'MemberExpression' ||
    memberName(pipe.callee) !== 'pipe' ||
    pipe.arguments.length !== 1
  ) {
    return undefined;
  }
  const provider = nativeDatabaseProvider(environment, resolved, pipe.callee.object);
  if (provider === undefined) {
    return undefined;
  }
  const guarded = guardedCorePoolDatabase(environment, provider, resolved);
  return guarded === notGuarded ? describeNativePgMakeDatabase(environment, provider, resolved) : guarded;
};

const nativeTransactionToken = (
  environment: NativeSqlProofEnvironment,
  database: NativeSqlDatabaseDescriptor,
  transaction: NativeSqlSourceReference,
  callback: NativeSqlSourceReference,
  parameter: Span,
): NativeSqlTransactionDescriptor | undefined => {
  const privateCallback = copyNativeSource(environment, callback);
  const publicCallback = copyNativeSource(environment, callback);
  const publicTransaction = copyNativeSource(environment, transaction);
  if (privateCallback === undefined || publicCallback === undefined || publicTransaction === undefined) {
    return undefined;
  }
  const descriptor = Object.freeze({
    database,
    parameter: Object.freeze({ binding: parameter, captures: publicCallback.captures, file: callback.file }),
    transaction: publicTransaction,
  });
  transactionTokens.set(descriptor, {
    environment,
    parameter: Object.freeze({ binding: parameter, captures: privateCallback.captures, file: callback.file }),
  });
  return descriptor;
};
/** The callback parameter is authorized by the actual native executor.transaction call only. */
export const describeNativeSqlTransaction = (
  environment: NativeSqlProofEnvironment,
  database: NativeSqlDatabaseDescriptor,
  transaction: NativeSqlSourceReference,
): NativeSqlTransactionDescriptor | undefined => {
  const call = callOf(transaction);
  if (
    databaseTokens.get(database)?.environment !== environment ||
    !sourceExists(environment, transaction) ||
    call?.callee.type !== 'MemberExpression' ||
    memberName(call.callee) !== 'transaction' ||
    call.arguments.length !== 1 ||
    !sameSource(
      sourceValue(environment, { ...transaction, expression: call.callee.object }),
      databaseTokens.get(database)?.executor ?? database.executor,
    )
  ) {
    return undefined;
  }
  const callback = resolveArgument(environment, transaction, 0);
  if (
    callback === undefined ||
    (callback.expression.type !== 'ArrowFunctionExpression' && callback.expression.type !== 'FunctionExpression') ||
    callback.expression.params.length !== 1
  ) {
    return undefined;
  }
  const [parameter] = callback.expression.params;
  if (parameter?.type !== 'Identifier') {
    return undefined;
  }
  if (!hasClosedNativeInstance(environment, { binding: parameter, file: callback.file })) {
    return undefined;
  }
  return nativeTransactionToken(environment, database, transaction, callback, parameter);
};

const referencesParameter = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
  transaction: NativeSqlTransactionDescriptor,
): boolean => {
  const resolved = sourceValue(environment, reference);
  const parameter = transactionTokens.get(transaction)?.parameter;
  return (
    resolved !== undefined &&
    parameter !== undefined &&
    resolved.file === parameter.file &&
    sameCaptures(resolved.captures, parameter.captures) &&
    (resolved.expression.type === 'Identifier'
      ? bindingAt(environment, resolved.file, resolved.expression)?.node
      : undefined) === parameter.binding
  );
};

/** Exact own wire keys, conditional on separately proved native decoder custody. No value/type waiver. */
export const describeNativeSqlExecute = (
  environment: NativeSqlProofEnvironment,
  transaction: NativeSqlTransactionDescriptor,
  query: NativeSqlSourceReference,
): readonly string[] | undefined => {
  const call = callOf(query);
  if (
    transactionTokens.get(transaction)?.environment !== environment ||
    !sourceExists(environment, query) ||
    call?.callee.type !== 'MemberExpression' ||
    memberName(call.callee) !== 'execute' ||
    call.arguments.length !== 2 ||
    !referencesParameter(environment, { ...query, expression: call.callee.object }, transaction)
  ) {
    return undefined;
  }
  const [, mode] = call.arguments;
  const statement = resolveArgument(environment, query, 0);
  if (
    mode?.type !== 'Literal' ||
    mode.value !== 'objects' ||
    statement?.expression.type !== 'TaggedTemplateExpression' ||
    nativeIdentity(environment, { ...statement, expression: statement.expression.tag }) !== nativeSqlTag ||
    statement.expression.quasi.expressions.length !== 0 ||
    statement.expression.quasi.quasis.length !== 1
  ) {
    return undefined;
  }
  const [quasi] = statement.expression.quasi.quasis;
  return quasi?.value.cooked === undefined || quasi.value.cooked === null
    ? undefined
    : parseClosedNativeSelectProjection(quasi.value.cooked);
};

export interface NativeSqlSelectedTableRequest {
  readonly filename: string;
  readonly ownerPath: string;
  readonly runtimeFile: string;
  readonly sources: ReadonlyMap<string, string>;
  readonly tableExportName: string;
}
const nativeTableValue = (
  environment: NativeSqlProofEnvironment,
  reference: NativeSqlSourceReference,
): NativeSqlSourceReference | undefined => {
  const value = sourceValue(environment, reference);
  if (value === undefined) {
    return undefined;
  }
  const call = callOf(value);
  if (
    call?.callee.type === 'MemberExpression' &&
    memberName(call.callee) === 'enableRLS' &&
    call.arguments.length === 0
  ) {
    return sourceValue(environment, { ...value, expression: call.callee.object });
  }
  return value;
};
interface NativeSelectionParts {
  readonly fields: NativeSqlSourceReference | undefined;
  readonly receiver: NativeSqlSourceReference;
  readonly safeCalls: ReadonlySet<Span>;
  readonly table: NativeSqlSourceReference;
}
const selectedQueryParts = (
  environment: NativeSqlProofEnvironment,
  query: NativeSqlSourceReference,
): NativeSelectionParts | undefined => {
  let current = query;
  const safeCalls = new Set<Span>();
  for (let depth = 0; depth < 4; depth += 1) {
    const call = callOf(current);
    if (
      call?.callee.type !== 'MemberExpression' ||
      call.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return undefined;
    }
    const method = memberName(call.callee);
    safeCalls.add(call);
    if (method === 'where' || method === 'limit') {
      if (call.arguments.length !== 1) {
        return undefined;
      }
      current = { captures: current.captures, expression: call.callee.object, file: current.file };
      continue;
    }
    if (method !== 'from' || call.arguments.length !== 1) {
      return undefined;
    }
    const table = resolveArgument(environment, current, 0);
    const select = { ...current, expression: call.callee.object };
    const selectCall = callOf(select);
    if (
      table === undefined ||
      selectCall?.callee.type !== 'MemberExpression' ||
      memberName(selectCall.callee) !== 'select' ||
      selectCall.arguments.length !== 1
    ) {
      return undefined;
    }
    safeCalls.add(selectCall);
    return {
      fields: resolveArgument(environment, select, 0),
      receiver: { ...select, expression: selectCall.callee.object },
      safeCalls,
      table,
    };
  }
  return undefined;
};
const selectedColumnCustody = (
  environment: NativeSqlProofEnvironment,
  table: NativeSqlSourceReference,
  ownerFile: string,
  field: string,
  safeCalls: ReadonlySet<Span>,
): boolean => {
  const contains = (reference: NativeSqlSourceReference, seen: ReadonlySet<Expression> = new Set()): boolean => {
    if (seen.has(reference.expression) || seen.size >= 64) {
      return false;
    }
    const originReference = custodyAliasOrigin(environment, reference);
    // A native column is not an own-data projection. Keep the original member for custody
    // inspection when value resolution cannot project it, so its table receiver stays visible.
    const unresolvedMember =
      originReference.expression.type === 'MemberExpression' && sourceExists(environment, originReference)
        ? originReference
        : undefined;
    const value = sourceValue(environment, originReference) ?? unresolvedMember;
    if (value === undefined) {
      return false;
    }
    const { expression } = value;
    if (expression.type === 'MemberExpression' && memberName(expression) === field) {
      const origin = nativeTableValue(environment, { ...value, expression: expression.object });
      if (origin?.file === table.file && origin.expression === table.expression) {
        return true;
      }
    }
    const origin = nativeTableValue(environment, value);
    if (origin?.file === table.file && origin.expression === table.expression) {
      return true;
    }
    const children: Expression[] = [];
    if (expression.type === 'MemberExpression') {
      children.push(expression.object);
    } else if (expression.type === 'ObjectExpression') {
      children.push(
        ...expression.properties.map((property) =>
          property.type === 'SpreadElement' ? property.argument : property.value,
        ),
      );
    } else if (expression.type === 'ArrayExpression') {
      children.push(
        ...expression.elements.flatMap((element) =>
          element === null ? [] : [element.type === 'SpreadElement' ? element.argument : element],
        ),
      );
    }
    return children.some((child) =>
      contains({ ...value, expression: child }, new Set([...seen, reference.expression])),
    );
  };
  return environment.modules
    .filter((module) => module.file !== ownerFile)
    .every((module) => {
      let valid = true;
      const has = (expression: Expression) => contains({ expression, file: module.file });
      new Visitor({
        AssignmentExpression: (node) => {
          if (has(node.right) || (node.left.type === 'MemberExpression' && has(node.left.object))) {
            valid = false;
          }
        },
        CallExpression: (node) => {
          if (
            !node.arguments.some((argument) => has(argument.type === 'SpreadElement' ? argument.argument : argument))
          ) {
            return;
          }
          const identity = nativeIdentity(environment, { expression: node.callee, file: module.file });
          if (!safeCalls.has(node) && identity !== 'native-drizzle:eq' && identity !== 'native-drizzle:and') {
            valid = false;
          }
        },
        NewExpression: (node) => {
          if (
            node.arguments.some((argument) => has(argument.type === 'SpreadElement' ? argument.argument : argument))
          ) {
            valid = false;
          }
        },
        PropertyDefinition: (node) => {
          if (node.value !== null && node.value !== undefined && has(node.value)) {
            valid = false;
          }
        },
        UpdateExpression: (node) => {
          if (node.argument.type === 'MemberExpression' && has(node.argument.object)) {
            valid = false;
          }
        },
      }).visit(module.program);
      return valid;
    });
};

const nativeSelectionReceiver = (
  environment: NativeSqlProofEnvironment,
  executor: NativeSqlDatabaseDescriptor | NativeSqlTransactionDescriptor,
  receiver: NativeSqlSourceReference,
): boolean => {
  if ('executor' in executor) {
    return (
      databaseTokens.get(executor)?.environment === environment &&
      sameSource(sourceValue(environment, receiver), databaseTokens.get(executor)?.executor ?? executor.executor)
    );
  }
  return (
    transactionTokens.get(executor)?.environment === environment && referencesParameter(environment, receiver, executor)
  );
};
type NativeSelectionProperty = Extract<Expression, { type: 'ObjectExpression' }>['properties'][number];
const nativeSelectedTextTable = (
  environment: NativeSqlProofEnvironment,
  request: NativeSqlSelectedTableRequest,
  field: string,
): NativeSqlSourceReference | undefined => {
  const source = request.sources.get(request.filename);
  const module = environment.modules.find((candidate) => candidate.file === request.runtimeFile);
  if (source === undefined || module === undefined) {
    return undefined;
  }
  const evidence = nativeColumnInitializationEvidence(source, request.tableExportName, field, request);
  if (
    evidence === null ||
    evidence.nativeRoot.kind !== 'text' ||
    evidence.nativeRoot.argumentCount > 1 ||
    evidence.builderMethods.some((method) => method.name !== 'notNull' || method.argumentCount !== 0)
  ) {
    return undefined;
  }
  const binding = module.bindings.find(
    (candidate) =>
      candidate.name === evidence.tableLocalName && candidate.scope === module.program && candidate.kind === 'const',
  );
  return binding?.init === undefined
    ? undefined
    : nativeTableValue(environment, { expression: binding.init, file: module.file });
};
const selectedTextKey = (
  environment: NativeSqlProofEnvironment,
  request: NativeSqlSelectedTableRequest,
  parts: NativeSelectionParts,
  property: NativeSelectionProperty,
): string | undefined => {
  if (
    property.type !== 'Property' ||
    property.computed ||
    property.method ||
    property.kind !== 'init' ||
    property.key.type !== 'Identifier' ||
    unsafeAliases.has(property.key.name) ||
    property.value.type !== 'MemberExpression'
  ) {
    return undefined;
  }
  const field = memberName(property.value);
  if (field === undefined || parts.fields === undefined) {
    return undefined;
  }
  const table = nativeSelectedTextTable(environment, request, field);
  const from = nativeTableValue(environment, parts.table);
  const selected = nativeTableValue(environment, { ...parts.fields, expression: property.value.object });
  if (
    table === undefined ||
    from?.file !== table.file ||
    from.expression !== table.expression ||
    selected?.file !== table.file ||
    selected.expression !== table.expression
  ) {
    return undefined;
  }
  return selectedColumnCustody(environment, table, request.runtimeFile, field, parts.safeCalls)
    ? property.key.name
    : undefined;
};
/** Native selected-key mapping plus native PgText decoders. Decoder registry custody is separate. */
export const describeNativeSqlTextSelection = (
  environment: NativeSqlProofEnvironment,
  executor: NativeSqlDatabaseDescriptor | NativeSqlTransactionDescriptor,
  query: NativeSqlSourceReference,
  request: NativeSqlSelectedTableRequest,
): readonly string[] | undefined => {
  if (!sourceExists(environment, query)) {
    return undefined;
  }
  const parts = selectedQueryParts(environment, query);
  if (
    parts?.fields?.expression.type !== 'ObjectExpression' ||
    !nativeSelectionReceiver(environment, executor, parts.receiver)
  ) {
    return undefined;
  }
  const fields: string[] = [];
  for (const property of parts.fields.expression.properties) {
    const key = selectedTextKey(environment, request, parts, property);
    if (key === undefined || fields.includes(key)) {
      return undefined;
    }
    fields.push(key);
  }
  return fields.length === 0 ? undefined : fields;
};
