import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Context, Variable } from '@oxlint/plugins';

import { asNode, keyName, memberName, parentOf, unwrap } from './ast.ts';
import type { Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';

function walk(value: unknown, visit: (node: Syntax) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = asNode(value);
  if (node === null) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) if (key !== 'parent') walk(child, visit);
}

function immutable(variable: Variable | null): Syntax | null {
  if (variable?.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init))
    return null;
  const [definition] = variable.defs;
  const node = asNode(definition?.node);
  return definition?.type === 'Variable' &&
    node?.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    parentOf(node)?.kind === 'const'
    ? node
    : null;
}

function gitOwner(filename: string): { root: string; identity: string } | null {
  let directory = path.dirname(filename);
  for (let depth = 0; depth < 96; depth += 1) {
    const marker = path.join(directory, '.git');
    let info: ReturnType<typeof statSync> | undefined;
    try {
      info = statSync(marker);
    } catch (cause) {
      if (typeof cause !== 'object' || cause === null || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
    }
    if (info !== undefined) {
      if (!info.isDirectory() && (!info.isFile() || info.size > 8192)) throw new Error('Unresolved Git metadata');
      const pointer = info.isDirectory() ? marker : /^gitdir: (.+)\r?$/mu.exec(readFileSync(marker, 'utf8'))?.[1];
      if (pointer === undefined) throw new Error('Unresolved Git owner');
      const git = realpathSync(path.resolve(directory, pointer));
      let identity = git;
      try {
        const commonFile = path.join(git, 'commondir');
        const commonInfo = statSync(commonFile);
        if (!commonInfo.isFile() || commonInfo.size > 8192) throw new Error('Unresolved common Git owner');
        const common = readFileSync(commonFile, 'utf8').trim();
        if (common === '') throw new Error('Empty common Git owner');
        identity = realpathSync(path.resolve(git, common));
      } catch (cause) {
        // Missing commondir means an ordinary repository; unreadable/broken metadata proves nothing.
        if (typeof cause !== 'object' || cause === null || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
        try {
          statSync(path.join(git, 'commondir'));
        } catch (missing) {
          if (typeof missing !== 'object' || missing === null || !('code' in missing) || missing.code !== 'ENOENT')
            throw missing;
          return { identity, root: realpathSync(directory) };
        }
        throw cause;
      }
      return { identity, root: realpathSync(directory) };
    }
    const next = path.dirname(directory);
    if (next === directory) return null;
    directory = next;
  }
  throw new Error('Git owner search exceeded its bound');
}

/** No evaluation, package-name whitelist, or unresolved-path ownership inference. */
function foreignAsyncExport(
  filename: string,
  source: string,
  name: string,
  ownerOf: (filename: string) => ReturnType<typeof gitOwner>,
): boolean {
  if (!path.isAbsolute(source)) return false;
  try {
    const owner = ownerOf(realpathSync(path.resolve(filename)));
    const target = realpathSync(source);
    if (owner === null || target === owner.root || target.startsWith(owner.root + path.sep)) return false;
    if (ownerOf(target)?.identity === owner.identity) return false;
    const file = statSync(target);
    if (!file.isFile() || file.size > 1_000_000 || !/\.[cm]?[jt]sx?$/u.test(target)) return false;
    const text = readFileSync(target, 'utf8');
    if (text.length > 1_000_000) return false;
    const parsed = parseSync(target, text, { sourceType: 'module' });
    if (parsed.errors.length !== 0) return false;
    return parsed.program.body.some((statement) => {
      const node = asNode(statement);
      if (node?.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') return false;
      const declaration = asNode(node.declaration);
      if (declaration?.type === 'FunctionDeclaration')
        return declaration.id?.name === name && declaration.async === true;
      return (
        declaration?.type === 'VariableDeclaration' &&
        declaration.kind === 'const' &&
        declaration.declarations.some(
          (entry: Syntax) =>
            entry.id.type === 'Identifier' &&
            entry.id.name === name &&
            ['ArrowFunctionExpression', 'FunctionExpression'].includes(entry.init?.type) &&
            entry.init.async === true,
        )
      );
    });
  } catch {
    return false;
  }
}

/** Prove the entire local path from an external module decoder to converted Promise calls.
 * Only the proved member is exempt. Type/schema/value aliases, exports and unsupported
 * consumers fail closed instead of making Schema.declare an ownership escape hatch.
 */
export function foreignDecodedPortMembers(context: Context): ReadonlySet<Syntax> {
  const proved = new Set<Syntax>();
  const program = context.sourceCode.ast;
  const owners = new Map<string, ReturnType<typeof gitOwner>>();
  const exports = new Map<string, boolean>();
  const ownerOf = (filename: string) => {
    if (!owners.has(filename)) owners.set(filename, gitOwner(filename));
    return owners.get(filename) ?? null;
  };
  const foreignExport = (source: string, name: string) => {
    const key = `${source}\0${name}`;
    if (!exports.has(key)) exports.set(key, foreignAsyncExport(context.filename, source, name, ownerOf));
    return exports.get(key) === true;
  };
  const variable = (node: Syntax) => lookupVariable(context, node);
  const value = (raw: unknown, seen = new Set<Variable>()): Syntax | null => {
    const node = unwrap(raw);
    if (node?.type !== 'Identifier') return node;
    const binding = variable(node);
    const declaration = immutable(binding);
    if (binding === null || declaration === null || seen.has(binding)) return null;
    seen.add(binding);
    return value(declaration.init, seen);
  };
  const api = (raw: unknown, seen = new Set<Variable>()): string | null => {
    const node = unwrap(raw);
    if (node?.type === 'MemberExpression') {
      const host = api(node.object, seen);
      const name = memberName(node);
      return host === null || name === null ? null : host === '@effect' ? name : `${host}.${name}`;
    }
    if (node?.type !== 'Identifier') return null;
    const binding = variable(node);
    if (
      binding?.defs.length !== 1 ||
      seen.has(binding) ||
      binding.references.some((reference) => reference.isWrite() && !reference.init)
    )
      return null;
    seen.add(binding);
    // Passing an API namespace elsewhere or writing one of its members is not stable import evidence.
    for (const reference of binding.references.filter((entry) => entry.isRead())) {
      let use = asNode(reference.identifier);
      let parent = parentOf(use);
      while (parent?.type === 'MemberExpression' && parent.object === use) {
        use = parent;
        parent = parentOf(use);
      }
      if (
        (parent?.type === 'AssignmentExpression' && parent.left === use) ||
        parent?.type === 'UpdateExpression' ||
        (parent?.type === 'UnaryExpression' && parent.operator === 'delete')
      )
        return null;
      if (
        use === reference.identifier &&
        ((parent?.type === 'CallExpression' && parent.callee !== use) ||
          [
            'VariableDeclarator',
            'ReturnStatement',
            'Property',
            'ArrayExpression',
            'ExportSpecifier',
            'SpreadElement',
            'AssignmentExpression',
          ].includes(parent?.type ?? ''))
      )
        return null;
    }
    const [definition] = binding.defs;
    if (definition?.type !== 'ImportBinding') {
      const declaration = immutable(binding);
      return declaration === null ? null : api(declaration.init, seen);
    }
    const declaration = asNode(definition.parent);
    const specifier = asNode(definition.node);
    if (declaration?.importKind === 'type' || specifier?.importKind === 'type') return null;
    const source = declaration?.source.value;
    const imported = specifier?.type === 'ImportSpecifier' ? keyName(specifier.imported) : null;
    if (source === 'effect') return specifier?.type === 'ImportNamespaceSpecifier' ? '@effect' : imported;
    const module = /^effect\/(Effect|Schema|Predicate)$/u.exec(source ?? '')?.[1];
    return module === undefined
      ? null
      : specifier?.type === 'ImportNamespaceSpecifier'
        ? module
        : imported === null
          ? null
          : `${module}.${imported}`;
  };
  // Type queries can leak the inferred Promise surface too; retain every non-initializing reference.
  const reads = (binding: Variable): Syntax[] =>
    binding.references
      .filter((reference) => !reference.init || reference.isRead())
      .map((reference) => asNode(reference.identifier))
      .filter((node): node is Syntax => node !== null);
  const yieldedBinding = (call: Syntax): Variable | null => {
    const yielded = parentOf(call);
    const declaration = parentOf(yielded);
    if (
      yielded?.type !== 'YieldExpression' ||
      !yielded.delegate ||
      declaration?.type !== 'VariableDeclarator' ||
      declaration.init !== yielded ||
      declaration.id.type !== 'Identifier'
    )
      return null;
    const binding = variable(declaration.id);
    return immutable(binding) === declaration ? binding : null;
  };
  const body = (raw: unknown): Syntax | null => {
    const fn = unwrap(raw);
    if (!fn || !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn.type) || fn.generator) return null;
    let result = unwrap(fn.body);
    if (result?.type === 'BlockStatement')
      result =
        result.body.length === 1 && result.body[0].type === 'ReturnStatement' ? unwrap(result.body[0].argument) : null;
    return result?.type === 'AwaitExpression' ? unwrap(result.argument) : result;
  };
  const boundaryOfBody = (call: Syntax): Syntax | null => {
    let current = call;
    if (parentOf(current)?.type === 'AwaitExpression') current = parentOf(current)!;
    let fn = parentOf(current);
    if (fn?.type === 'ReturnStatement') fn = parentOf(parentOf(fn));
    if (fn === null || body(fn) !== call) return null;
    const property = parentOf(fn);
    const fields = parentOf(property);
    const boundary = parentOf(fields);
    const keys =
      fields?.type === 'ObjectExpression'
        ? fields.properties.map((entry: Syntax) =>
            entry.type === 'Property' && entry.kind === 'init' ? keyName(entry.key, entry.computed) : null,
          )
        : [];
    return property?.type === 'Property' &&
      property.kind === 'init' &&
      keyName(property.key, property.computed) === 'try' &&
      property.value === fn &&
      fields?.type === 'ObjectExpression' &&
      keys.every((key: string | null) => key === 'try' || key === 'catch') &&
      keys.length === new Set(keys).size &&
      boundary?.type === 'CallExpression' &&
      boundary.arguments.length === 1 &&
      boundary.arguments[0] === fields &&
      api(boundary.callee) === 'Effect.tryPromise'
      ? boundary
      : null;
  };
  const wrappedReceiver = (binding: Variable, name: string): boolean => {
    const references = reads(binding);
    return (
      references.length > 0 &&
      references.every((reference) => {
        const member = parentOf(reference);
        const invoke = parentOf(member);
        return (
          member?.type === 'MemberExpression' &&
          member.object === reference &&
          memberName(member) === name &&
          invoke?.type === 'CallExpression' &&
          invoke.callee === member &&
          boundaryOfBody(invoke) !== null
        );
      })
    );
  };
  const convertedResult = (binding: Variable, name: string): boolean => {
    const references = reads(binding);
    return (
      references.length > 0 &&
      references.every((reference) => {
        const call = parentOf(reference);
        if (
          call?.type !== 'CallExpression' ||
          call.arguments.length !== 1 ||
          call.arguments[0] !== reference ||
          api(call.callee) !== 'Effect.fromResult'
        )
          return false;
        const receiver = yieldedBinding(call);
        return receiver !== null && wrappedReceiver(receiver, name);
      })
    );
  };
  const importedDecoder = (reference: Syntax, name: string): boolean => {
    const decoder = parentOf(reference);
    const call = parentOf(decoder);
    if (
      decoder?.type !== 'CallExpression' ||
      decoder.arguments.length !== 1 ||
      decoder.arguments[0] !== reference ||
      api(decoder.callee) !== 'Schema.decodeUnknownResult' ||
      call?.type !== 'CallExpression' ||
      call.callee !== decoder ||
      call.arguments.length !== 1
    )
      return false;
    const argument = unwrap(call.arguments[0]);
    const imported = argument?.type === 'AwaitExpression' ? unwrap(argument.argument) : null;
    if (imported?.type !== 'ImportExpression') return false;
    const source = value(imported.source);
    if (source?.type !== 'Literal' || typeof source.value !== 'string' || !foreignExport(source.value, name))
      return false;
    const boundary = boundaryOfBody(call);
    const result = boundary === null ? null : yieldedBinding(boundary);
    return result !== null && convertedResult(result, name);
  };
  const indexedType = (raw: unknown): { binding: Variable; reference: Syntax; name: string } | null => {
    let type = asNode(raw);
    if (type?.type === 'TSTypeAnnotation') type = asNode(type.typeAnnotation);
    if (
      type?.type !== 'TSIndexedAccessType' ||
      type.objectType.type !== 'TSTypeReference' ||
      type.objectType.typeName.type !== 'Identifier' ||
      type.indexType.type !== 'TSLiteralType'
    )
      return null;
    const binding = variable(type.objectType.typeName);
    const name = keyName(type.indexType.literal);
    return binding === null || name === null ? null : { binding, name, reference: type.objectType };
  };
  const guard = (declaration: Syntax, type: ReturnType<typeof indexedType>): Syntax | null => {
    const fn = unwrap(declaration.arguments[0]);
    if (
      type === null ||
      declaration.arguments.length !== 1 ||
      fn === null ||
      !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn.type) ||
      fn.async ||
      fn.generator ||
      fn.params.length !== 1 ||
      fn.params[0].type !== 'Identifier'
    )
      return null;
    const predicate = asNode(fn.returnType?.typeAnnotation);
    const asserted = indexedType(predicate?.typeAnnotation);
    const check = body(fn);
    if (
      predicate?.type !== 'TSTypePredicate' ||
      predicate.asserts ||
      predicate.parameterName?.type !== 'Identifier' ||
      predicate.parameterName.name !== fn.params[0].name ||
      asserted?.binding !== type.binding ||
      asserted.name !== type.name ||
      check?.type !== 'CallExpression' ||
      api(check.callee) !== 'Predicate.isFunction' ||
      check.arguments.length !== 1 ||
      check.arguments[0].type !== 'Identifier' ||
      variable(check.arguments[0]) !== variable(fn.params[0])
    )
      return null;
    return asserted.reference;
  };
  walk(program, (declaration) => {
    if (declaration.type !== 'CallExpression' || api(declaration.callee) !== 'Schema.declare') return;
    const typeArguments = declaration.typeArguments;
    if (typeArguments === null || typeArguments === undefined || typeArguments.params.length !== 1) return;
    const type = indexedType(typeArguments.params[0]);
    const asserted = guard(declaration, type);
    if (type === null || asserted === null) return;
    const owner = type.binding.defs.length === 1 ? asNode(type.binding.defs[0]?.node) : null;
    if (
      owner?.type !== 'TSInterfaceDeclaration' ||
      (owner.extends ?? []).length !== 0 ||
      owner.typeParameters ||
      parentOf(owner)?.type !== 'Program' ||
      owner.body.body.length !== 1
    )
      return;
    const [member] = owner.body.body;
    if (member.type !== 'TSPropertySignature' || member.optional || keyName(member.key, member.computed) !== type.name)
      return;
    const permittedNames = new Set([owner.id, type.reference.typeName, asserted.typeName]);
    if (type.binding.references.some((reference) => !permittedNames.has(reference.identifier))) return;
    let onlyGuardTypes = true;
    walk(program, (node) => {
      if (
        node.type === 'TSTypeReference' &&
        node.typeName.type === 'Identifier' &&
        variable(node.typeName) === type.binding &&
        node !== type.reference &&
        node !== asserted
      )
        onlyGuardTypes = false;
      if (node.type === 'ExportSpecifier' && variable(node.local) === type.binding) onlyGuardTypes = false;
    });
    if (!onlyGuardTypes) return;
    const property = parentOf(declaration);
    const fields = parentOf(property);
    const struct = parentOf(fields);
    const bound = parentOf(struct);
    if (
      property?.type !== 'Property' ||
      property.value !== declaration ||
      keyName(property.key, property.computed) !== type.name ||
      fields?.type !== 'ObjectExpression' ||
      fields.properties.length !== 1 ||
      struct?.type !== 'CallExpression' ||
      api(struct.callee) !== 'Schema.Struct' ||
      struct.arguments.length !== 1 ||
      struct.arguments[0] !== fields ||
      bound?.type !== 'VariableDeclarator' ||
      bound.id.type !== 'Identifier' ||
      parentOf(parentOf(bound))?.type !== 'Program'
    )
      return;
    const schema = variable(bound.id);
    if (schema === null || immutable(schema) !== bound) return;
    const references = reads(schema);
    if (references.length > 0 && references.every((reference) => importedDecoder(reference, type.name)))
      proved.add(member);
  });
  return proved;
}
