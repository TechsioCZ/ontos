import { PgTypes as NativePgTypes } from '@effect/sql-pg';
import { Schema } from 'effect';
import { Visitor } from 'oxc-parser';
import type {
  CallExpression,
  Expression,
  IdentifierReference,
  ImportDeclaration,
  ParamPattern,
  Program,
  Span,
} from 'oxc-parser';

const nativeRootEdge = 'native-pg-root';
const nativeTypesEdge = 'native-pg-types';

export interface PgDecoderCustodyBinding {
  readonly kind?: string;
  readonly name: string;
  readonly node: Span;
  readonly scope: Span;
}

export interface PgDecoderCustodyModule {
  readonly bindings: readonly PgDecoderCustodyBinding[];
  readonly file: string;
  readonly program: Program;
}

export type PgDecoderImportEdge =
  | { readonly kind: typeof nativeRootEdge | typeof nativeTypesEdge | 'other-native' }
  | { readonly file: string; readonly kind: 'module' }
  | { readonly files: readonly string[]; readonly kind: 'conditional-modules' };

export type PgDecoderImportResolver = (file: string, source: string) => PgDecoderImportEdge | undefined;

const NativeRoleSchema = Schema.Literals(['root', 'types', 'oid', 'jsonb', 'array', 'forbidden']);
type NativeRole = typeof NativeRoleSchema.Type;
interface NativeReference {
  readonly identifier: IdentifierReference;
  readonly path: readonly string[];
  readonly role: NativeRole;
}

const inside = (outer: Span, inner: Span): boolean => outer.start <= inner.start && inner.end <= outer.end;
const same = (left: Span, right: Span): boolean => left.start === right.start && left.end === right.end;
const unwrap = (input: Expression): Expression => {
  let node = input;
  for (let depth = 0; depth < 64; depth += 1) {
    if (
      node.type !== 'TSAsExpression' &&
      node.type !== 'TSSatisfiesExpression' &&
      node.type !== 'TSNonNullExpression' &&
      node.type !== 'TSTypeAssertion' &&
      node.type !== 'ParenthesizedExpression'
    ) {
      return node;
    }
    node = node.expression;
  }
  return node;
};

const memberKey = (input: Expression): string | undefined => {
  if (input.type !== 'MemberExpression' || input.optional) {
    return undefined;
  }
  if (!input.computed && input.property.type === 'Identifier') {
    return input.property.name;
  }
  return input.property.type === 'Literal' && Schema.is(Schema.String)(input.property.value)
    ? input.property.value
    : undefined;
};

const bindingAt = (
  module: PgDecoderCustodyModule,
  identifier: Span & { readonly name: string },
): PgDecoderCustodyBinding | undefined => {
  let found: PgDecoderCustodyBinding | undefined;
  let ambiguous = false;
  for (const binding of module.bindings) {
    if (binding.name === identifier.name && inside(binding.scope, identifier)) {
      const length = binding.scope.end - binding.scope.start;
      if (found === undefined || length < found.scope.end - found.scope.start) {
        found = binding;
        ambiguous = false;
      } else if (length === found.scope.end - found.scope.start) {
        ambiguous = true;
      }
    }
  }
  return ambiguous ? undefined : found;
};

const importedRole = (edge: PgDecoderImportEdge, imported: string): NativeRole | undefined => {
  if (edge.kind === nativeRootEdge) {
    if (imported === '*') {
      return 'root';
    }
    return imported === 'PgTypes' ? 'types' : undefined;
  }
  if (edge.kind !== nativeTypesEdge) {
    return undefined;
  }
  if (imported === '*') {
    return 'types';
  }
  if (imported === 'OID') {
    return 'oid';
  }
  return imported === 'jsonb' || imported === 'array' ? imported : 'forbidden';
};

const nativeReference = (
  module: PgDecoderCustodyModule,
  input: Expression,
  nativeBindings: ReadonlyMap<Span, NativeRole>,
): NativeReference | undefined => {
  let node = unwrap(input);
  const path: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    if (node.type === 'Identifier') {
      const binding = bindingAt(module, node);
      const role = binding === undefined ? undefined : nativeBindings.get(binding.node);
      return role === undefined ? undefined : { identifier: node, path, role };
    }
    const key = memberKey(node);
    if (node.type !== 'MemberExpression' || key === undefined) {
      return undefined;
    }
    path.unshift(key);
    node = unwrap(node.object);
  }
  return undefined;
};

const narrowedReference = (reference: NativeReference): NativeReference => {
  if (reference.role === 'root' && reference.path[0] === 'PgTypes') {
    return { ...reference, path: reference.path.slice(1), role: 'types' };
  }
  return reference;
};

const ownOidNumber = (key: string): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(NativePgTypes.OID, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && Schema.is(Schema.Number)(descriptor.value);
};

const primitiveRead = (reference: NativeReference): boolean => {
  const value = narrowedReference(reference);
  return value.role === 'oid'
    ? value.path.length === 1 && ownOidNumber(value.path[0] ?? '')
    : value.role === 'types' && value.path.length === 2 && value.path[0] === 'OID' && ownOidNumber(value.path[1] ?? '');
};

const parameterCall = (reference: NativeReference, argumentCount: number): boolean => {
  const value = narrowedReference(reference);
  let method: string | undefined;
  if (value.role === 'types' && value.path.length === 1) {
    [method] = value.path;
  } else if (value.path.length === 0) {
    method = value.role;
  }
  return (method === 'jsonb' && argumentCount === 1) || (method === 'array' && argumentCount === 2);
};

const nativeReexport = (edge: PgDecoderImportEdge, names: readonly string[]): boolean =>
  edge.kind === nativeTypesEdge || (edge.kind === nativeRootEdge && (names.length === 0 || names.includes('PgTypes')));

const specifierName = (specifier: ImportDeclaration['specifiers'][number]): string => {
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return '*';
  }
  if (specifier.type === 'ImportSpecifier') {
    if (specifier.imported.type === 'Identifier') {
      return specifier.imported.name;
    }
    if (Schema.is(Schema.String)(specifier.imported.value)) {
      return specifier.imported.value;
    }
  }
  return 'default';
};

const loaderNames = new Set(['eval', 'Function', 'require', 'createRequire']);
const loaderProperties = new Set([...loaderNames, 'constructor', 'getBuiltinModule']);
const actualFunctionTarget = (
  module: PgDecoderCustodyModule,
  input: Expression,
  initializers: ReadonlyMap<Span, readonly Expression[]>,
  declaredFunctions: ReadonlySet<Span>,
  seen: ReadonlySet<Span> = new Set(),
): boolean => {
  const node = unwrap(input);
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ClassExpression'
  ) {
    return true;
  }
  if (node.type !== 'Identifier' || seen.size >= 64) {
    return false;
  }
  const binding = bindingAt(module, node);
  if (binding === undefined) {
    return loaderNames.has(node.name);
  }
  if (declaredFunctions.has(binding.node)) {
    return true;
  }
  if (seen.has(binding.node)) {
    return false;
  }
  const next = new Set(seen).add(binding.node);
  return (
    initializers
      .get(binding.node)
      ?.some((value) => actualFunctionTarget(module, value, initializers, declaredFunctions, next)) ?? false
  );
};

/** Negative classifier only: any possible native branch remains sensitive; this never authorizes a host call. */
const possibleNativeNamespace = (
  module: PgDecoderCustodyModule,
  input: Expression,
  name: string,
  initializers: ReadonlyMap<Span, readonly Expression[]>,
  seen: ReadonlySet<Span> = new Set(),
): boolean => {
  const node = unwrap(input);
  if (node.type !== 'Identifier' || seen.size >= 64) {
    return false;
  }
  const binding = bindingAt(module, node);
  if (binding === undefined) {
    return node.name === name;
  }
  if (seen.has(binding.node)) {
    return false;
  }
  const values = initializers.get(binding.node);
  const next = new Set(seen).add(binding.node);
  return (
    values !== undefined && values.some((value) => possibleNativeNamespace(module, value, name, initializers, next))
  );
};

const actualLoaderNamespace = (
  module: PgDecoderCustodyModule,
  input: Expression,
  initializers: ReadonlyMap<Span, readonly Expression[]>,
): boolean =>
  ['process', 'globalThis', 'global', 'self', 'window'].some((name) =>
    possibleNativeNamespace(module, input, name, initializers),
  );
const ordinaryRestReceiver = (
  module: PgDecoderCustodyModule,
  input: Expression,
  key: string | undefined,
  opaqueProjections: ReadonlySet<Span>,
): boolean => {
  const receiver = unwrap(input);
  const binding = receiver.type === 'Identifier' ? bindingAt(module, receiver) : undefined;
  return (
    binding !== undefined &&
    opaqueProjections.has(binding.node) &&
    key !== undefined &&
    !loaderProperties.has(key) &&
    !/^(?:0|[1-9]\d*)$/u.test(key)
  );
};
const forbiddenLoader = (
  module: PgDecoderCustodyModule,
  node: Expression,
  initializers: ReadonlyMap<Span, readonly Expression[]>,
  opaqueProjections: ReadonlySet<Span>,
  declaredFunctions: ReadonlySet<Span>,
  seen: ReadonlySet<Span> = new Set(),
  depth = 0,
): boolean => {
  if (depth >= 64) {
    return true;
  }
  const callee = unwrap(node);
  if (callee.type === 'Identifier') {
    const binding = bindingAt(module, callee);
    if (binding === undefined) {
      return loaderNames.has(callee.name);
    }
    if (opaqueProjections.has(binding.node)) {
      return true;
    }
    const values = initializers.get(binding.node);
    if (values === undefined) {
      return false;
    }
    if (seen.has(binding.node)) {
      return true;
    }
    const next = new Set(seen).add(binding.node);
    return values.some((value) =>
      forbiddenLoader(module, value, initializers, opaqueProjections, declaredFunctions, next, depth + 1),
    );
  }
  if (callee.type !== 'MemberExpression') {
    return false;
  }
  const key = memberKey(callee);
  if (ordinaryRestReceiver(module, callee.object, key, opaqueProjections)) {
    return false;
  }
  return (
    (key === undefined &&
      (actualFunctionTarget(module, callee.object, initializers, declaredFunctions) ||
        actualLoaderNamespace(module, callee.object, initializers))) ||
    (key !== undefined && loaderProperties.has(key)) ||
    forbiddenLoader(module, callee.object, initializers, opaqueProjections, declaredFunctions, seen, depth + 1)
  );
};

const reflectiveLoaderKey = (
  module: PgDecoderCustodyModule,
  callee: Expression,
  args: readonly (Expression | { readonly type: 'SpreadElement' })[],
  initializers: ReadonlyMap<Span, readonly Expression[]>,
  declaredFunctions: ReadonlySet<Span>,
): boolean => {
  const node = unwrap(callee);
  const method = memberKey(node);
  if (!['get', 'getOwnPropertyDescriptor'].includes(method ?? '') || args.length < 2) {
    return false;
  }
  if (node.type !== 'MemberExpression') {
    return false;
  }
  const canonical =
    possibleNativeNamespace(module, node.object, 'Reflect', initializers) ||
    (method === 'getOwnPropertyDescriptor' && possibleNativeNamespace(module, node.object, 'Object', initializers));
  const [target] = args;
  if (
    !canonical ||
    target === undefined ||
    target.type === 'SpreadElement' ||
    !actualFunctionTarget(module, target, initializers, declaredFunctions)
  ) {
    return false;
  }
  const [, key] = args;
  return (
    key === undefined ||
    key.type === 'SpreadElement' ||
    key.type !== 'Literal' ||
    !Schema.is(Schema.String)(key.value) ||
    loaderProperties.has(key.value)
  );
};

const approvedHostCall = (
  module: PgDecoderCustodyModule,
  call: CallExpression,
  resolveImport: PgDecoderImportResolver,
): boolean => {
  const callee = unwrap(call.callee);
  if (
    call.optional ||
    callee.type !== 'MemberExpression' ||
    callee.optional ||
    callee.computed ||
    memberKey(callee) !== 'getBuiltinModule'
  ) {
    return false;
  }
  if (
    callee.object.type !== 'Identifier' ||
    callee.object.name !== 'process' ||
    bindingAt(module, callee.object) !== undefined ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  const [target] = call.arguments;
  if (target?.type !== 'Literal') {
    return false;
  }
  const canonical = target.value === 'http' ? 'node:http' : target.value;
  return (
    (target.value === 'node:fs' || target.value === 'node:path' || target.value === 'http') &&
    Schema.is(Schema.String)(canonical) &&
    resolveImport(module.file, canonical)?.kind === 'other-native'
  );
};

const schemaMetadataBorrower = (
  module: PgDecoderCustodyModule,
  call: CallExpression,
  namespaces: ReadonlySet<Span>,
  factories: ReadonlySet<Span>,
): Span | undefined => {
  const callee = unwrap(call.callee);
  const [argument] = call.arguments;
  if (
    call.optional ||
    call.arguments.length !== 1 ||
    argument?.type !== 'Identifier' ||
    argument.name !== 'Function' ||
    bindingAt(module, argument) !== undefined
  ) {
    return undefined;
  }
  const namespace =
    callee.type === 'MemberExpression' && memberKey(callee) === 'instanceOf' && !callee.optional
      ? unwrap(callee.object)
      : undefined;
  const namespaceBinding = namespace?.type === 'Identifier' ? bindingAt(module, namespace) : undefined;
  const factoryBinding = callee.type === 'Identifier' ? bindingAt(module, callee) : undefined;
  return (namespaceBinding !== undefined && namespaces.has(namespaceBinding.node)) ||
    (factoryBinding !== undefined && factories.has(factoryBinding.node))
    ? argument
    : undefined;
};

const patternKey = (
  property: Extract<ParamPattern, { readonly type: 'ObjectPattern' }>['properties'][number],
): string | undefined => {
  if (property.type === 'RestElement') {
    return undefined;
  }
  if (!property.computed && property.key.type === 'Identifier') {
    return property.key.name;
  }
  return property.key.type === 'Literal' && Schema.is(Schema.String)(property.key.value)
    ? property.key.value
    : undefined;
};

const moduleCustody = (
  module: PgDecoderCustodyModule,
  files: ReadonlySet<string>,
  resolveImport: PgDecoderImportResolver,
): boolean => {
  let closed = true;
  const nativeBindings = new Map<Span, NativeRole>();
  const erased: Span[] = [];
  const writes: Span[] = [];
  const allowed: Span[] = [];
  const initializers = new Map<Span, Expression[]>();
  const loaderHandles = new Set<Span>();
  const opaqueProjections = new Set<Span>();
  const declaredFunctions = new Set<Span>();
  const hostCallees = new Set<Span>();
  const schemaNamespaces = new Set<Span>();
  const schemaFactories = new Set<Span>();
  const metadataBorrowers = new Set<Span>();
  new Visitor({
    CallExpression: (node) => {
      if (approvedHostCall(module, node, resolveImport)) {
        hostCallees.add(unwrap(node.callee));
      }
    },
  }).visit(module.program);
  const erase = (node: Span): void => {
    erased.push(node);
  };
  const edgeAt = (source: string): PgDecoderImportEdge | undefined => {
    const edge = resolveImport(module.file, source);
    if (source === '@effect/sql-pg') {
      return edge?.kind === nativeRootEdge ? edge : undefined;
    }
    if (source === '@effect/sql-pg/PgTypes') {
      return edge?.kind === nativeTypesEdge ? edge : undefined;
    }
    if (edge?.kind === nativeRootEdge || edge?.kind === nativeTypesEdge) {
      return undefined;
    }
    if (edge?.kind === 'conditional-modules') {
      return edge.files.length > 0 && edge.files.every((target) => files.has(target)) ? edge : undefined;
    }
    return edge?.kind === 'module' && !files.has(edge.file) ? undefined : edge;
  };
  const importBinding = (specifier: ImportDeclaration['specifiers'][number], edge: PgDecoderImportEdge): void => {
    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
      return;
    }
    const role = importedRole(edge, specifierName(specifier));
    if (role === undefined) {
      return;
    }
    const binding = module.bindings.find((candidate) => candidate.node === specifier.local);
    if (binding === undefined) {
      closed = false;
      return;
    }
    nativeBindings.set(binding.node, role);
  };
  const importSchemaBinding = (
    specifier: ImportDeclaration['specifiers'][number],
    source: string,
    edge: PgDecoderImportEdge,
  ): void => {
    if (edge.kind !== 'other-native' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')) {
      return;
    }
    const name = specifierName(specifier);
    const namespace = (source === 'effect' && name === 'Schema') || (source === 'effect/Schema' && name === '*');
    const factory = source === 'effect/Schema' && name === 'instanceOf';
    if (!namespace && !factory) {
      return;
    }
    const binding = module.bindings.find((candidate) => candidate.node === specifier.local);
    if (binding === undefined) {
      closed = false;
      return;
    }
    if (namespace) {
      schemaNamespaces.add(binding.node);
    } else {
      schemaFactories.add(binding.node);
    }
  };
  const addInitializer = (node: Span & { readonly name: string }, value: Expression): void => {
    const binding = bindingAt(module, node);
    if (binding === undefined) {
      return;
    }
    const values = initializers.get(binding.node) ?? [];
    values.push(value);
    initializers.set(binding.node, values);
  };
  const markIdentifier = (pattern: Span & { readonly name: string }, handle: boolean, opaque: boolean): void => {
    const binding = bindingAt(module, pattern);
    if (binding === undefined && (handle || opaque)) {
      closed = false;
    } else if (binding !== undefined && handle) {
      loaderHandles.add(binding.node);
      opaqueProjections.add(binding.node);
    } else if (binding !== undefined && opaque) {
      opaqueProjections.add(binding.node);
    }
  };
  const markPattern = (pattern: ParamPattern, handle = false, opaque = false, depth = 0): void => {
    if (depth >= 64) {
      closed = false;
      return;
    }
    if (pattern.type === 'Identifier') {
      markIdentifier(pattern, handle, opaque);
      return;
    }
    if (pattern.type === 'TSParameterProperty') {
      markPattern(pattern.parameter, handle, opaque, depth + 1);
    } else if (pattern.type === 'RestElement') {
      markPattern(pattern.argument, handle, true, depth + 1);
    } else if (pattern.type === 'AssignmentPattern') {
      if (pattern.left.type === 'Identifier') {
        addInitializer(pattern.left, pattern.right);
      }
      markPattern(pattern.left, handle, opaque, depth + 1);
    } else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) {
        if (element !== null) {
          markPattern(element, handle, opaque, depth + 1);
        }
      }
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          markPattern(property.argument, handle, true, depth + 1);
        } else {
          const key = patternKey(property);
          markPattern(property.value, handle || key === undefined || loaderProperties.has(key), opaque, depth + 1);
        }
      }
    }
  };
  new Visitor({
    ArrowFunctionExpression: (node) => {
      for (const parameter of node.params) {
        markPattern(parameter);
      }
    },
    AssignmentExpression: (node) => {
      writes.push(node.left);
      if (node.left.type === 'Identifier') {
        addInitializer(node.left, node.right);
      }
    },
    ExportAllDeclaration: (node) => {
      if (node.exportKind === 'type') {
        erase(node);
        return;
      }
      const edge = edgeAt(node.source.value);
      closed &&= edge !== undefined && !nativeReexport(edge, []);
    },
    ExportNamedDeclaration: (node) => {
      if (node.exportKind === 'type') {
        erase(node);
        return;
      }
      if (node.source === null) {
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') {
            erase(specifier);
          }
        }
        return;
      }
      const edge = edgeAt(node.source.value);
      const runtime = node.specifiers.filter((specifier) => specifier.exportKind !== 'type');
      for (const specifier of node.specifiers) {
        if (specifier.exportKind === 'type') {
          erase(specifier);
        }
      }
      const names = runtime.flatMap((specifier) => {
        if (specifier.local.type === 'Identifier') {
          return [specifier.local.name];
        }
        if (Schema.is(Schema.String)(specifier.local.value)) {
          return [specifier.local.value];
        }
        closed = false;
        return [];
      });
      closed &&= edge !== undefined && (runtime.length === 0 || !nativeReexport(edge, names));
    },
    FunctionDeclaration: (node) => {
      if (node.id !== null) {
        const binding = module.bindings.find(
          (candidate) =>
            candidate.node === node.id && candidate.name === node.id?.name && candidate.kind === 'function',
        );
        if (binding === undefined) {
          closed = false;
        } else {
          declaredFunctions.add(binding.node);
        }
      }
      for (const parameter of node.params) {
        markPattern(parameter);
      }
    },
    FunctionExpression: (node) => {
      for (const parameter of node.params) {
        markPattern(parameter);
      }
    },
    ImportDeclaration: (node) => {
      erase(node);
      if (node.importKind === 'type') {
        return;
      }
      const edge = edgeAt(node.source.value);
      if (edge === undefined) {
        closed = false;
        return;
      }
      for (const specifier of node.specifiers) {
        importSchemaBinding(specifier, node.source.value, edge);
        importBinding(specifier, edge);
      }
    },
    ImportExpression: (node) => {
      if (node.source.type !== 'Literal' || !Schema.is(Schema.String)(node.source.value)) {
        closed = false;
        return;
      }
      const edge = edgeAt(node.source.value);
      closed &&= edge !== undefined && edge.kind !== nativeRootEdge && edge.kind !== nativeTypesEdge;
    },
    MemberExpression: (node) => {
      if (
        ['constructor', 'createRequire', 'getBuiltinModule'].includes(memberKey(node) ?? '') &&
        !hostCallees.has(node)
      ) {
        closed = false;
      }
      if (!node.computed) {
        erase(node.property);
      }
    },
    Property: (node) => {
      if (!node.computed && !node.shorthand) {
        erase(node.key);
      }
    },
    TSInterfaceDeclaration: erase,
    TSTypeAliasDeclaration: erase,
    TSTypeQuery: erase,
    TSTypeReference: erase,
    UnaryExpression: (node) => {
      if (node.operator === 'delete') {
        writes.push(node.argument);
      }
    },
    UpdateExpression: (node) => {
      writes.push(node.argument);
    },
    VariableDeclarator: (node) => {
      markPattern(node.id);
      if (node.id.type === 'Identifier' && node.init !== null) {
        addInitializer(node.id, node.init);
      }
    },
  }).visit(module.program);
  new Visitor({
    CallExpression: (node) => {
      const borrower = schemaMetadataBorrower(module, node, schemaNamespaces, schemaFactories);
      if (borrower !== undefined) {
        metadataBorrowers.add(borrower);
      }
      if (
        (!hostCallees.has(unwrap(node.callee)) &&
          forbiddenLoader(module, node.callee, initializers, opaqueProjections, declaredFunctions)) ||
        reflectiveLoaderKey(module, node.callee, node.arguments, initializers, declaredFunctions)
      ) {
        closed = false;
      }
      const reference = nativeReference(module, node.callee, nativeBindings);
      if (
        reference !== undefined &&
        !node.optional &&
        !node.arguments.some((argument) => argument.type === 'SpreadElement') &&
        parameterCall(reference, node.arguments.length)
      ) {
        allowed.push(reference.identifier);
      }
    },
    MemberExpression: (node) => {
      if (memberKey(node) === undefined && actualLoaderNamespace(module, node.object, initializers)) {
        closed = false;
      }
      const reference = nativeReference(module, node, nativeBindings);
      if (reference !== undefined && primitiveRead(reference) && !writes.some((write) => inside(write, node))) {
        allowed.push(reference.identifier);
      }
      if (
        reference?.role === 'root' &&
        reference.path.length > 0 &&
        reference.path[0] !== 'PgTypes' &&
        !writes.some((write) => inside(write, node))
      ) {
        allowed.push(reference.identifier);
      }
    },
    NewExpression: (node) => {
      if (forbiddenLoader(module, node.callee, initializers, opaqueProjections, declaredFunctions)) {
        closed = false;
      }
    },
  }).visit(module.program);
  new Visitor({
    Identifier: (node) => {
      if (erased.some((span) => inside(span, node))) {
        return;
      }
      const binding = bindingAt(module, node);
      if (binding === undefined && loaderNames.has(node.name) && !metadataBorrowers.has(node)) {
        closed = false;
      }
      if (binding !== undefined && loaderHandles.has(binding.node) && binding.node !== node) {
        closed = false;
      }
      if (binding !== undefined && nativeBindings.has(binding.node) && !allowed.some((span) => same(span, node))) {
        closed = false;
      }
    },
  }).visit(module.program);
  return closed;
};

/**
 * Registry custody only: callers must also prove the actual native client and no `config.types` override.
 * Canonical edges and lexical metadata must come from the same complete immutable runtime corpus.
 * Conditional edges retain every canonical source variant; no runtime/default branch is guessed.
 * `other-native` is the caller's existing canonical modeled-native premise (Node/Effect/Drizzle and
 * framework/auth/hash behavior), solely for registry custody. It grants no query, body or return-data authority.
 */
export const hasClosedNativePgDecoderRegistryCustody = (
  modules: readonly PgDecoderCustodyModule[],
  resolveImport: PgDecoderImportResolver,
): boolean => {
  const files = new Set(modules.map((module) => module.file));
  return (
    modules.length > 0 &&
    files.size === modules.length &&
    modules.every((module) => moduleCustody(module, files, resolveImport))
  );
};
