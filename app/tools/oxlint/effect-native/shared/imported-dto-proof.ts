import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

type Node = Record<string, any>;
interface Module {
  readonly filename: string;
  readonly imports: Map<string, { source: string; name: string; typeOnly: boolean }>;
  readonly exports: Map<string, string>;
  readonly values: Map<string, Node>;
  readonly types: Map<string, Node>;
}
type Value =
  | { readonly kind: 'data' | 'bad' }
  | { readonly kind: 'api'; readonly member?: string }
  | { readonly kind: 'schema'; readonly data: boolean; readonly fields?: ReadonlyMap<string, Value> }
  | { readonly kind: 'fields'; readonly fields: ReadonlyMap<string, Value> }
  | { readonly kind: 'transform'; readonly target?: Value }
  | { readonly kind: 'function'; readonly node: Node; readonly module: Module };
const BAD: Value = { kind: 'bad' };
const DATA: Value = { kind: 'data' };
const SCALAR: Value = { kind: 'schema', data: true };
const OPAQUE: Value = { kind: 'schema', data: false };
const SCALAR_SCHEMAS = new Set([
  'String',
  'Trim',
  'Number',
  'Finite',
  'Int',
  'Boolean',
  'BigInt',
  'Null',
  'Undefined',
  'DateTimeUtc',
  'DateTimeUtcFromString',
]);
const propertyName = (node: Node | undefined): string | null =>
  node?.type === 'Identifier'
    ? node.name
    : node?.type === 'Literal' && typeof node.value === 'string'
      ? node.value
      : null;

/** Read-only, bounded DTO provenance. As in the existing factory proof, missing modules,
 * opaque operations and symbol cycles fail closed. Node's resolver additionally follows
 * first-party package exports; no imported application code is evaluated.
 */
export function importedDtoProof() {
  const modules = new Map<string, Module | null>();
  const resolving = new Set<string>();
  let steps = 0;
  const resolveModule = (filename: string, source: string): string | null => {
    const relative = source.startsWith('./') || source.startsWith('../');
    const base = path.resolve(path.dirname(filename), source);
    const candidates = relative
      ? path.extname(base) === ''
        ? ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].map((extension) => base + extension)
        : [base]
      : [];
    if (!relative) {
      try {
        candidates.push(createRequire(path.resolve(filename)).resolve(source));
      } catch {
        return null;
      }
    }
    for (const candidate of candidates) {
      try {
        return realpathSync(candidate);
      } catch {
        /* Unknown owners remain unproved. */
      }
    }
    return null;
  };
  const load = (filename: string): Module | null => {
    if (modules.has(filename)) return modules.get(filename) ?? null;
    if (modules.size >= 32) return null;
    modules.set(filename, null);
    try {
      const source = readFileSync(filename, 'utf8');
      if (source.length > 1_000_000) return null;
      const parsed = parseSync(filename, source, { sourceType: 'module' });
      if (parsed.errors.length !== 0) return null;
      const module: Module = { filename, imports: new Map(), exports: new Map(), values: new Map(), types: new Map() };
      for (const statement of parsed.program.body as unknown as Node[]) {
        if (statement.type === 'ImportDeclaration') {
          for (const specifier of statement.specifiers) {
            const name =
              specifier.type === 'ImportSpecifier'
                ? propertyName(specifier.imported)
                : specifier.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : 'default';
            if (name !== null)
              module.imports.set(specifier.local.name, {
                source: statement.source.value,
                name,
                typeOnly: statement.importKind === 'type' || specifier.importKind === 'type',
              });
          }
          continue;
        }
        const exported = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration';
        if (exported && statement.source) {
          for (const specifier of statement.specifiers) {
            const name = propertyName(specifier.exported),
              original = propertyName(specifier.local);
            if (name === null || original === null) continue;
            const local = `@export:${name}`;
            module.imports.set(local, {
              source: statement.source.value,
              name: original,
              typeOnly: statement.exportKind === 'type' || specifier.exportKind === 'type',
            });
            module.exports.set(name, local);
          }
          continue;
        }
        if (exported && statement.declaration === null) {
          for (const specifier of statement.specifiers) {
            const name = propertyName(specifier.exported),
              local = propertyName(specifier.local);
            if (name !== null && local !== null) module.exports.set(name, local);
          }
          continue;
        }
        const node = exported ? statement.declaration : statement;
        if (node?.type === 'VariableDeclaration' && node.kind === 'const') {
          for (const declaration of node.declarations) {
            if (declaration.id.type !== 'Identifier' || declaration.init === null) continue;
            module.values.set(declaration.id.name, declaration.init);
            if (exported) module.exports.set(declaration.id.name, declaration.id.name);
          }
        } else if (node?.id?.type === 'Identifier') {
          if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(node.type))
            module.types.set(node.id.name, node);
          else if (node.type === 'FunctionDeclaration') module.values.set(node.id.name, node);
          if (exported)
            module.exports.set(statement.type === 'ExportDefaultDeclaration' ? 'default' : node.id.name, node.id.name);
        }
      }
      modules.set(filename, module);
      return module;
    } catch {
      return null;
    }
  };
  const imported = (module: Module, source: string): Module | null => {
    const filename = resolveModule(module.filename, source);
    return filename === null ? null : load(filename);
  };
  const guarded = <Result>(id: string, fallback: Result, evaluate: () => Result): Result => {
    if (++steps > 10_000 || resolving.has(id)) return fallback;
    resolving.add(id);
    try {
      return evaluate();
    } finally {
      resolving.delete(id);
    }
  };
  const schemaData = (value: Value, omitted: ReadonlySet<string> = new Set()): boolean =>
    value.kind === 'schema' &&
    (value.fields === undefined
      ? value.data
      : [...value.fields].every(([name, field]) => omitted.has(name) || schemaData(field)));
  const resolveValue = (name: string, module: Module, env: ReadonlyMap<string, Value>): Value => {
    if (env.has(name)) return env.get(name)!;
    return guarded<Value>(`${module.filename}:value:${name}`, BAD, () => {
      const initializer = module.values.get(name);
      if (initializer) return expression(initializer, module, env);
      const origin = module.imports.get(name);
      if (!origin) return name === 'undefined' ? DATA : BAD;
      if (origin.typeOnly) return BAD;
      if (origin.source === 'effect' && origin.name === 'Schema') return { kind: 'api' };
      if (origin.source === 'effect/Schema')
        return origin.name === '*'
          ? { kind: 'api' }
          : SCALAR_SCHEMAS.has(origin.name)
            ? SCALAR
            : { kind: 'api', member: origin.name };
      if (origin.source === 'effect' || origin.source.startsWith('effect/')) return BAD;
      const owner = imported(module, origin.source),
        exported = owner?.exports.get(origin.name);
      return owner !== null && exported !== undefined ? resolveValue(exported, owner, new Map()) : BAD;
    });
  };
  const fields = (node: Node, module: Module, env: ReadonlyMap<string, Value>): ReadonlyMap<string, Value> | null => {
    if (node.type !== 'ObjectExpression') return null;
    const result = new Map<string, Value>();
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = expression(property.argument, module, env);
        if (spread.kind !== 'fields') return null;
        for (const [name, value] of spread.fields) result.set(name, value);
      } else {
        const name = propertyName(property.key);
        if (name === null || property.computed || property.kind !== 'init' || property.method) return null;
        result.set(name, expression(property.value, module, env));
      }
    }
    return result;
  };
  const nativeSchema = (
    name: string,
    args: readonly Node[],
    module: Module,
    env: ReadonlyMap<string, Value>,
  ): Value => {
    if (name === 'Struct' && args.length === 1) {
      const members = fields(args[0]!, module, env);
      return members !== null && [...members.values()].every((value) => value.kind === 'schema')
        ? { kind: 'schema', data: true, fields: members }
        : BAD;
    }
    if (['declare', 'Opaque', 'Unknown', 'Any', 'instanceOf'].includes(name)) return OPAQUE;
    if (name === 'Literal') return args.length === 1 && args[0]?.type === 'Literal' ? SCALAR : BAD;
    if (name === 'Literals')
      return args.length === 1 &&
        args[0]?.type === 'ArrayExpression' &&
        args[0].elements.every((node: Node | null) => node?.type === 'Literal')
        ? SCALAR
        : BAD;
    if (name === 'brand') return { kind: 'transform' };
    if (name === 'decodeTo') return { kind: 'transform', target: args[0] ? expression(args[0], module, env) : BAD };
    if (
      ['Array', 'NullOr', 'UndefinedOr', 'OptionFromNullOr', 'optionalKey', 'optional', 'toEncoded', 'toType'].includes(
        name,
      )
    )
      return args.length === 1 && schemaData(expression(args[0]!, module, env)) ? SCALAR : OPAQUE;
    if (name === 'Record')
      return args.length === 2 && args.every((arg) => schemaData(expression(arg, module, env))) ? SCALAR : OPAQUE;
    if (name === 'Union' && args.length === 1 && args[0]?.type === 'ArrayExpression')
      return args[0].elements.every((node: Node | null) => node !== null && schemaData(expression(node, module, env)))
        ? SCALAR
        : OPAQUE;
    return BAD;
  };
  const expression = (input: Node, module: Module, env: ReadonlyMap<string, Value>): Value => {
    if (!input || ++steps > 10_000) return BAD;
    let node = input;
    while (
      [
        'TSAsExpression',
        'TSSatisfiesExpression',
        'TSNonNullExpression',
        'TSInstantiationExpression',
        'ParenthesizedExpression',
      ].includes(node.type)
    )
      node = node.expression;
    if (node.type === 'Identifier') return resolveValue(node.name, module, env);
    if (node.type === 'Literal' || node.type === 'TemplateLiteral') return DATA;
    if (['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(node.type))
      return { kind: 'function', node, module };
    if (node.type === 'MemberExpression' && !node.computed) {
      const owner = expression(node.object, module, env),
        name = propertyName(node.property);
      if (owner.kind === 'api' && owner.member === undefined && name !== null)
        return SCALAR_SCHEMAS.has(name) ? SCALAR : { kind: 'api', member: name };
      return owner.kind === 'schema' && name === 'fields' && owner.fields !== undefined
        ? { kind: 'fields', fields: owner.fields }
        : BAD;
    }
    if (node.type !== 'CallExpression') return BAD;
    if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const receiver = expression(node.callee.object, module, env),
        name = propertyName(node.callee.property);
      if (receiver.kind === 'schema' && name === 'check') return receiver;
      if (receiver.kind === 'schema' && name === 'pipe') {
        let result: Value = receiver;
        for (const argument of node.arguments) {
          const transform = expression(argument, module, env);
          if (transform.kind !== 'transform') return BAD;
          if (transform.target !== undefined) {
            // Both sides must be data: toEncoded can expose the source again.
            if (!schemaData(result) || !schemaData(transform.target)) return BAD;
            result = transform.target;
          }
        }
        return result;
      }
    }
    const callee = expression(node.callee, module, env);
    if (callee.kind === 'api' && callee.member !== undefined)
      return nativeSchema(callee.member, node.arguments, module, env);
    if (
      callee.kind !== 'function' ||
      callee.node.async ||
      callee.node.generator ||
      node.arguments.length !== callee.node.params.length
    )
      return BAD;
    const local = new Map<string, Value>();
    for (const [index, parameter] of callee.node.params.entries()) {
      if (parameter.type !== 'Identifier') return BAD;
      local.set(parameter.name, expression(node.arguments[index], module, env));
    }
    const body = callee.node.body;
    return guarded<Value>(`${callee.module.filename}:call:${callee.node.start}`, BAD, () =>
      body?.type === 'BlockStatement'
        ? body.body.length === 1 && body.body[0].type === 'ReturnStatement'
          ? expression(body.body[0].argument, callee.module, local)
          : BAD
        : expression(body, callee.module, local),
    );
  };
  const typeData = (node: Node, module: Module, omitted: ReadonlySet<string>): boolean => {
    if (!node || ++steps > 10_000) return false;
    if (['TSTypeAnnotation', 'TSTypeOperator', 'TSParenthesizedType'].includes(node.type))
      return typeData(node.typeAnnotation, module, omitted);
    if (
      [
        'TSStringKeyword',
        'TSNumberKeyword',
        'TSBooleanKeyword',
        'TSBigIntKeyword',
        'TSLiteralType',
        'TSNullKeyword',
        'TSUndefinedKeyword',
      ].includes(node.type)
    )
      return true;
    if (['TSUnionType', 'TSIntersectionType'].includes(node.type))
      return node.types.every((part: Node) => typeData(part, module, omitted));
    if (node.type === 'TSArrayType') return typeData(node.elementType, module, new Set());
    if (
      node.type === 'TSTypeQuery' &&
      node.exprName.type === 'TSQualifiedName' &&
      node.exprName.left.type === 'Identifier' &&
      node.exprName.right.name === 'Type'
    )
      return schemaData(resolveValue(node.exprName.left.name, module, new Map()), omitted);
    if (node.type === 'TSTypeLiteral' || node.type === 'TSInterfaceDeclaration') {
      const members = node.members ?? node.body.body;
      return (
        members.every(
          (member: Node) =>
            omitted.has(propertyName(member.key) ?? '') ||
            (member.type === 'TSPropertySignature' && typeData(member.typeAnnotation, module, new Set())),
        ) &&
        (node.extends ?? []).every((base: Node) =>
          typeData({ type: 'TSTypeReference', typeName: base.expression }, module, omitted),
        )
      );
    }
    if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier' || node.typeArguments?.params.length)
      return false;
    return namedType(node.typeName.name, module, omitted);
  };
  const namedType = (name: string, module: Module, omitted: ReadonlySet<string>): boolean =>
    guarded<boolean>(`${module.filename}:type:${name}`, false, () => {
      const declaration = module.types.get(name);
      if (declaration) return typeData(declaration.typeAnnotation ?? declaration, module, omitted);
      const origin = module.imports.get(name),
        owner = origin ? imported(module, origin.source) : null;
      const exported = origin ? owner?.exports.get(origin.name) : undefined;
      return owner !== null && exported !== undefined && namedType(exported, owner, omitted);
    });
  const ownerExport = (filename: string, source: string, name: string): { module: Module; exported: string } | null => {
    steps = 0;
    const target = resolveModule(filename, source),
      module = target === null ? null : load(target);
    const exported = module?.exports.get(name);
    return module !== null && exported !== undefined ? { module, exported } : null;
  };
  return {
    type(filename: string, source: string, name: string, omitted: ReadonlySet<string> = new Set()): boolean {
      const owner = ownerExport(filename, source, name);
      return owner !== null && namedType(owner.exported, owner.module, omitted);
    },
    schema(filename: string, source: string, name: string, omitted: ReadonlySet<string> = new Set()): boolean {
      const owner = ownerExport(filename, source, name);
      return owner !== null && schemaData(resolveValue(owner.exported, owner.module, new Map()), omitted);
    },
  };
}
