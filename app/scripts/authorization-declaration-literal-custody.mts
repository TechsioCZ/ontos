/// <reference types="node" />

import nodePath from 'node:path';
import { Predicate } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, Node, ObjectExpression, Program } from 'oxc-parser';

import { nativeModuleSourceReferences } from '../tools/oxlint/anti-slop/effect/rules/registered-tooling-package-proof.ts';
import { bindingShadows } from './scoped-proof-custody.mts';

type Identifier = Extract<Node, { readonly type: 'Identifier' }>;

const moduleDirectoryOf = (file: string): string | null =>
  /^(?:apps|verticals|packages)\/[^/]+\//u.exec(file)?.[0] ?? null;

/** Existing catalog import boundary: one relative TypeScript leaf in this exact deployment. */
export const ownerLocalTarget = (file: string, specifier: string): string | null => {
  const owner = moduleDirectoryOf(file);
  if (owner === null || !/^\.\.?\//u.test(specifier) || !specifier.endsWith('.ts')) {
    return null;
  }
  const target = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(file), specifier));
  return target.startsWith(owner) ? target : null;
};

const productionSource = (file: string): boolean =>
  !/(?:^|\/)(?:tests|fixtures|node_modules|\.output|dist[^/]*)(?:\/|$)/u.test(file);

const unwrap = (expression: Expression): Expression => {
  let current = expression;
  for (let depth = 0; depth < 16; depth += 1) {
    if (current.type !== 'TSAsExpression' && current.type !== 'TSSatisfiesExpression') {
      break;
    }
    current = current.expression;
  }
  return current;
};

const propertyName = (node: Node): string | undefined => {
  if (node.type === 'Identifier') {
    return node.name;
  }
  return node.type === 'Literal' && Predicate.isString(node.value) ? node.value : undefined;
};

const plainProperty = (property: ObjectExpression['properties'][number]) =>
  property.type === 'Property' &&
  property.kind === 'init' &&
  !property.computed &&
  !property.method &&
  !property.shorthand;

const finitePrimitive = (node: Extract<Node, { readonly type: 'Literal' }>): boolean =>
  node.value === null ||
  Predicate.isString(node.value) ||
  Predicate.isBoolean(node.value) ||
  (Predicate.isNumber(node.value) && Number.isFinite(node.value));

/** Shape proof only; the existing catalog LiteralParser remains the single literal decoder. */
const pureLiteralData = (node: Node, depth = 0): boolean => {
  if (depth >= 16) {
    return false;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return pureLiteralData(node.expression, depth + 1);
  }
  if (node.type === 'Literal') {
    return finitePrimitive(node);
  }
  if (node.type === 'ArrayExpression') {
    return (
      node.elements.length <= 64 &&
      node.elements.every((item) => item !== null && item.type !== 'SpreadElement' && pureLiteralData(item, depth + 1))
    );
  }
  if (node.type !== 'ObjectExpression' || node.properties.length > 32) {
    return false;
  }
  const keys = new Set<string>();
  for (const property of node.properties) {
    if (property.type !== 'Property' || !plainProperty(property)) {
      return false;
    }
    const key = propertyName(property.key);
    if (key === undefined || key === '__proto__' || keys.has(key) || !pureLiteralData(property.value, depth + 1)) {
      return false;
    }
    keys.add(key);
  }
  return true;
};

const parseProgram = (file: string, source: string): Program | undefined => {
  const parsed = parseSync(file, source, { sourceType: 'module' });
  return parsed.errors.length === 0 ? parsed.program : undefined;
};

const closedDescriptorProperties = (descriptor: ObjectExpression): boolean =>
  descriptor.properties.every(
    (property) => property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method,
  );

const nativeDeclarationUses = (program: Program): ReadonlyMap<string, ReadonlySet<Identifier>> => {
  const factories = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      statement.source.value !== '@app/core-runtime'
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        specifier.imported.type === 'Identifier' &&
        ['defineRead', 'defineAction'].includes(specifier.imported.name) &&
        !bindingShadows(program, specifier.local.name)
      ) {
        factories.add(specifier.local.name);
      }
    }
  }
  const uses = new Map<string, Set<Identifier>>();
  new Visitor({
    CallExpression: (call) => {
      const [descriptor] = call.arguments;
      if (
        call.callee.type !== 'Identifier' ||
        !factories.has(call.callee.name) ||
        descriptor?.type !== 'ObjectExpression' ||
        !closedDescriptorProperties(descriptor)
      ) {
        return;
      }
      const declarations = descriptor.properties.filter(
        (property) =>
          property.type === 'Property' && !property.computed && propertyName(property.key) === 'accessDeclaration',
      );
      const [property] = declarations;
      if (
        declarations.length !== 1 ||
        property?.type !== 'Property' ||
        property.kind !== 'init' ||
        property.method ||
        property.shorthand
      ) {
        return;
      }
      const value = unwrap(property.value);
      if (value.type !== 'Identifier') {
        return;
      }
      const names = uses.get(value.name) ?? new Set<Identifier>();
      names.add(value);
      uses.set(value.name, names);
    },
  }).visit(program);
  return uses;
};

/** Every runtime reference is either its binding or the exact native descriptor property. */
const closedReferences = (program: Program, name: string, bindings: readonly Identifier[]): boolean => {
  const permitted = new Set([...bindings, ...(nativeDeclarationUses(program).get(name) ?? [])]);
  new Visitor({
    ExportSpecifier: (specifier) => {
      if (specifier.exported.type === 'Identifier') {
        permitted.add(specifier.exported);
      }
    },
    ImportSpecifier: (specifier) => {
      if (specifier.imported.type === 'Identifier') {
        permitted.add(specifier.imported);
      }
    },
    MemberExpression: (member) => {
      if (!member.computed && member.property.type === 'Identifier') {
        permitted.add(member.property);
      }
    },
    Property: (property) => {
      if (!property.computed && !property.shorthand && property.key.type === 'Identifier') {
        permitted.add(property.key);
      }
    },
  }).visit(program);
  let closed = true;
  new Visitor({
    Identifier: (identifier) => {
      if (
        (identifier.name === name && !permitted.has(identifier)) ||
        ['eval', 'Function', 'globalThis', 'global', 'window', 'self', 'Reflect'].includes(identifier.name)
      ) {
        closed = false;
      }
    },
    ImportExpression: () => {
      closed = false;
    },
    JSXIdentifier: (identifier) => {
      if (identifier.name === name) {
        closed = false;
      }
    },
    MemberExpression: (member) => {
      if (['constructor', '__proto__', 'getPrototypeOf'].includes(propertyName(member.property) ?? '')) {
        closed = false;
      }
    },
  }).visit(program);
  return closed;
};

interface LiteralBinding {
  readonly id: Identifier;
  readonly object: ObjectExpression;
}

const literalBinding = (program: Program, name: string, exported: boolean): LiteralBinding | undefined => {
  const matches = program.body.flatMap((statement): readonly LiteralBinding[] => {
    if (exported && (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type')) {
      return [];
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const' || declaration.declare === true) {
      return [];
    }
    return declaration.declarations.flatMap((binding): readonly LiteralBinding[] => {
      if (binding.id.type !== 'Identifier' || binding.id.name !== name || binding.init === null) {
        return [];
      }
      const expression = unwrap(binding.init);
      return expression.type === 'ObjectExpression' && pureLiteralData(expression)
        ? [{ id: binding.id, object: expression }]
        : [];
    });
  });
  const [found] = matches;
  return matches.length === 1 && found !== undefined && closedReferences(program, name, [found.id]) ? found : undefined;
};

interface ImportedDeclaration {
  readonly imported: string;
  readonly local: string;
  readonly target: string;
}

const importedDeclarations = (program: Program, file: string): readonly ImportedDeclaration[] =>
  program.body.flatMap((statement): readonly ImportedDeclaration[] => {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
      return [];
    }
    const target = ownerLocalTarget(file, statement.source.value);
    if (target === null || !productionSource(target)) {
      return [];
    }
    return statement.specifiers.flatMap((specifier): readonly ImportedDeclaration[] =>
      specifier.type === 'ImportSpecifier' &&
      specifier.importKind !== 'type' &&
      specifier.imported.type === 'Identifier'
        ? [{ imported: specifier.imported.name, local: specifier.local.name, target }]
        : [],
    );
  });

const ownPackageImport = (specifier: string, target: string): boolean => {
  const owner = moduleDirectoryOf(target)?.split('/')[1];
  return owner !== undefined && (specifier === `@app/${owner}` || specifier.startsWith(`@app/${owner}/`));
};

const opaqueOwnPackageAccess = (program: Program, origin: ImportedDeclaration): boolean =>
  program.body.some((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      !ownPackageImport(statement.source.value, origin.target)
    ) {
      return false;
    }
    return statement.specifiers.some(
      (specifier) =>
        specifier.type !== 'ImportSpecifier' ||
        (specifier.importKind !== 'type' && propertyName(specifier.imported) === origin.imported),
    );
  });

const resolvedOriginSpecifier = (specifier: string, file: string, origin: ImportedDeclaration): boolean => {
  if (specifier.startsWith('file:') || specifier.startsWith('/')) {
    return true;
  }
  if (!/^\.\.?\//u.test(specifier)) {
    return false;
  }
  if (/[\\%?#]/u.test(specifier)) {
    return true;
  }
  const target = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(file), specifier));
  const extensions = new Map([
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
    ['.cjs', '.cts'],
  ]);
  const extension = nodePath.posix.extname(target);
  const sourceExtension = extensions.get(extension);
  const emittedTarget = sourceExtension === undefined ? target : target.slice(0, -extension.length) + sourceExtension;
  return emittedTarget === origin.target || `${target}.ts` === origin.target || `${target}/index.ts` === origin.target;
};

const relatedReexport = (statement: Program['body'][number], file: string, origin: ImportedDeclaration): boolean => {
  if (
    (statement.type !== 'ExportAllDeclaration' && statement.type !== 'ExportNamedDeclaration') ||
    statement.source === null ||
    statement.source === undefined ||
    statement.exportKind === 'type'
  ) {
    return false;
  }
  if (resolvedOriginSpecifier(statement.source.value, file, origin)) {
    return true;
  }
  return (
    ownPackageImport(statement.source.value, origin.target) &&
    (statement.type === 'ExportAllDeclaration' ||
      statement.specifiers.some((specifier) => propertyName(specifier.local) === origin.imported))
  );
};

const relevantModuleSpecifier = (specifier: string, file: string, origin: ImportedDeclaration): boolean =>
  ownPackageImport(specifier, origin.target) || resolvedOriginSpecifier(specifier, file, origin);

const opaqueNativeModuleSource = (source: string, origin: ImportedDeclaration): boolean =>
  /^(?:\.\.?\/|\/|file:)/u.test(source) || ownPackageImport(source, origin.target);

const nativeLoadsRemainClosed = (program: Program, file: string, origin: ImportedDeclaration): boolean => {
  const references = nativeModuleSourceReferences(program);
  return (
    references !== null &&
    references.every((reference) => {
      const specifier = reference.staticSpecifier;
      // A prefix cannot rule out suffix traversal or a dynamically selected owner package.
      if (reference.invalidBinding || specifier === null) {
        return false;
      }
      // A native loader with no proved importer base cannot resolve relative ownership from this file.
      if (
        reference.kind === 'native-loader' &&
        reference.base !== 'importer' &&
        opaqueNativeModuleSource(specifier, origin)
      ) {
        return false;
      }
      return !relevantModuleSpecifier(specifier, file, origin);
    })
  );
};

const programImportsRemainClosed = (program: Program, file: string, origin: ImportedDeclaration): boolean => {
  if (opaqueOwnPackageAccess(program, origin)) {
    return false;
  }
  for (const statement of program.body) {
    if (relatedReexport(statement, file, origin)) {
      return false;
    }
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      !resolvedOriginSpecifier(statement.source.value, file, origin)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') {
        return false;
      }
      if (
        specifier.importKind !== 'type' &&
        propertyName(specifier.imported) === origin.imported &&
        !closedReferences(program, specifier.local.name, [specifier.local])
      ) {
        return false;
      }
    }
  }
  return nativeLoadsRemainClosed(program, file, origin);
};

const ambientEvaluationClosed = (program: Program): boolean => {
  let closed = true;
  new Visitor({
    Identifier: (identifier) => {
      if (['eval', 'Function'].includes(identifier.name)) {
        closed = false;
      }
    },
    MemberExpression: (member) => {
      if (['eval', 'Function', 'constructor'].includes(propertyName(member.property) ?? '')) {
        closed = false;
      }
    },
  }).visit(program);
  return closed;
};

const importsRemainClosed = (origin: ImportedDeclaration, sources: ReadonlyMap<string, string>): boolean => {
  const owner = moduleDirectoryOf(origin.target);
  for (const [file, source] of sources) {
    if (moduleDirectoryOf(file) !== owner || !productionSource(file)) {
      continue;
    }
    const program = parseProgram(file, source);
    if (program === undefined) {
      return false;
    }
    if (!ambientEvaluationClosed(program) || !programImportsRemainClosed(program, file, origin)) {
      return false;
    }
  }
  return true;
};

const importedLiteralSource = (
  name: string,
  imports: readonly ImportedDeclaration[],
  sources: ReadonlyMap<string, string>,
): string | undefined => {
  const bindings = imports.filter((binding) => binding.local === name);
  const [binding] = bindings;
  const producerSource = binding === undefined ? undefined : sources.get(binding.target);
  if (
    bindings.length !== 1 ||
    binding === undefined ||
    producerSource === undefined ||
    !importsRemainClosed(binding, sources)
  ) {
    return undefined;
  }
  const producer = parseProgram(binding.target, producerSource);
  const literal = producer === undefined ? undefined : literalBinding(producer, binding.imported, true);
  return literal === undefined ? undefined : producerSource.slice(literal.object.start, literal.object.end);
};

/** One-hop same-owner literal declarations; aliases and arbitrary executable evaluation stay unresolved. */
export const closedAccessDeclarationLiteralSources = (
  source: string,
  file: string,
  moduleSources: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> => {
  if (!source.includes('accessDeclaration')) {
    return new Map();
  }
  const program = parseProgram(file, source);
  if (program === undefined) {
    return new Map();
  }
  const uses = nativeDeclarationUses(program);
  const sources = new Map([...moduleSources, [file, source]]);
  const imports = importedDeclarations(program, file);
  const literals = new Map<string, string>();
  for (const name of uses.keys()) {
    const own = importsRemainClosed({ imported: name, local: name, target: file }, sources)
      ? literalBinding(program, name, false)
      : undefined;
    const literalSource =
      own === undefined
        ? importedLiteralSource(name, imports, sources)
        : source.slice(own.object.start, own.object.end);
    if (literalSource !== undefined) {
      literals.set(name, literalSource);
    }
  }
  return literals;
};
