import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseSync } from 'oxc-parser';

// The proof models closed data construction, not total mathematical purity: native codecs may
// reject malformed data and Object.freeze may freeze a data graph. Neither supplies executable
// behavior or an environmental dependency. Unknown operations and executable payloads fail closed.
type Node = Record<string, any>;
interface Model {
  readonly filename: string;
  readonly imports: Map<string, { source: string; imported: string }>;
  readonly values: Map<string, Node>;
  readonly types: Map<string, Node>;
  readonly exports: Map<string, string>;
  readonly program: Node;
  readonly executableInitialization: boolean;
}
interface Value {
  readonly kind: 'bad' | 'data' | 'array' | 'record' | 'schema' | 'function' | 'native' | 'transform' | 'hash';
  readonly fields?: ReadonlyMap<string, Value>;
  readonly element?: Value;
  readonly empty?: boolean;
  readonly open?: boolean;
  readonly payload?: Value;
  readonly node?: Node;
  readonly model?: Model;
  readonly env?: ReadonlyMap<string, Value>;
  readonly native?: string;
  readonly apply?: (args: readonly Value[]) => Value;
  readonly literal?: unknown;
  readonly arrayOwner?: symbol;
}
type Completion = 'bad' | 'falls' | 'returns';
const BAD: Value = { kind: 'bad' };
const DATA: Value = { kind: 'data' };
/** A `let` local: it only ever holds closed data and every read sees opaque data, never a literal. */
const MUTABLE: Value = { kind: 'data', native: 'mutable' };
const array = (element: Value, empty = false): Value => ({ kind: 'array', element, empty });
const record = (fields: ReadonlyMap<string, Value>, open = false): Value => ({ kind: 'record', fields, open });
const schema = (payload: Value): Value => ({ kind: 'schema', payload });
const native = (name: string): Value => ({ kind: 'native', native: name });
/** An Effect Result: the success and failure payloads it may carry, each absent when unreachable. */
const outcome = (success: Value | undefined, failure: Value | undefined): Value => ({
  ...record(
    new Map([
      ['_tag', DATA],
      ...(success === undefined ? [] : [['success', success] as const]),
      ...(failure === undefined ? [] : [['failure', failure] as const]),
    ]),
  ),
  native: 'result',
});
/** A Schema issue exposes only its rendered message. */
const ISSUE: Value = record(new Map([['message', DATA]]));
/** Pure byte functions: one data argument in, bytes out. */
const NOBLE_DATA_FUNCTIONS = new Set(['@noble/hashes/sha2.js:sha256', '@noble/hashes/utils.js:utf8ToBytes']);
/** Pure `effect/encoding` functions: one data argument in, a string out. */
const ENCODING_DATA_FUNCTIONS = new Set(['effect/encoding:Hex.encode', 'effect/encoding:Base64Url.encode']);
const isData = (value: Value): boolean =>
  value.kind === 'data' ||
  (value.kind === 'array' && isData(value.element ?? BAD)) ||
  (value.kind === 'record' && [...(value.fields?.values() ?? [])].every(isData));
const isClosedData = (value: Value): boolean =>
  value.kind === 'data' ||
  (value.kind === 'array' && isClosedData(value.element ?? BAD)) ||
  (value.kind === 'record' && value.open !== true && [...(value.fields?.values() ?? [])].every(isClosedData));
const openData = (value: Value): Value =>
  value.kind === 'record'
    ? record(new Map([...(value.fields ?? [])].map(([name, field]) => [name, openData(field)])), true)
    : value.kind === 'array'
      ? array(openData(value.element ?? BAD), value.empty)
      : value;
const unwrap = (input: Node): Node => {
  let node = input;
  while (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSInstantiationExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
      'ParenthesizedExpression',
      'ChainExpression',
    ].includes(node.type)
  )
    node = node.expression;
  return node;
};
const named = (node: Node | undefined): string | undefined => (node?.type === 'Identifier' ? node.name : undefined);
const key = (node: Node | undefined): string | undefined =>
  named(node) ?? (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined);
const fnNode = (node: Node): boolean =>
  ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type);
const merge = (values: readonly Value[]): Value => {
  if (values.length === 0) return DATA;
  if (values.some((value) => value.kind === 'bad')) return BAD;
  if (values.every((value) => value.kind === 'record')) {
    const names = new Set(values.flatMap((value) => [...(value.fields?.keys() ?? [])]));
    // A Set or Result keeps its native members only when every merged value is the same native;
    // mixing a native object with plain data keeps the result opaque to absent-field reads.
    const shared = values.every((value) => value.native === values[0].native) ? values[0].native : 'opaque';
    const merged = record(
      new Map(
        [...names].map((name) => [
          name,
          merge(values.map((value) => value.fields?.get(name)).filter((value): value is Value => value !== undefined)),
        ]),
      ),
      values.some((value) => value.open),
    );
    if (shared === undefined) return merged;
    return shared === 'set'
      ? { ...merged, native: shared, payload: merge(values.map((value) => value.payload ?? BAD)) }
      : { ...merged, native: shared };
  }
  if (values.every((value) => value.kind === 'schema'))
    return schema(merge(values.map((value) => value.payload ?? BAD)));
  if (values.every((value) => value.kind === 'array'))
    return array(
      merge(values.filter((value) => !value.empty).map((value) => value.element ?? BAD)),
      values.every((value) => value.empty),
    );
  if (values.every((value) => value.kind === 'data' && 'literal' in value && value.literal === values[0].literal))
    return values[0];
  // Erasing heterogeneous shapes is safe only after their entire payload is known closed.
  return values.every(isClosedData) ? DATA : BAD;
};
const generalizeData = (value: Value): Value =>
  value.kind === 'record'
    ? record(new Map([...(value.fields ?? [])].map(([name, field]) => [name, generalizeData(field)])), value.open)
    : value.kind === 'array'
      ? array(generalizeData(value.element ?? BAD), value.empty)
      : value.kind === 'data'
        ? { kind: 'data', native: value.native }
        : BAD;
const dataState = (value: Value, visited = new Set<Value>()): string => {
  if (visited.has(value)) return 'cycle';
  const next = new Set(visited).add(value);
  if (value.kind === 'record')
    return JSON.stringify([
      value.open,
      value.native,
      [...(value.fields ?? [])].map(([name, field]) => [name, dataState(field, next)]),
    ]);
  if (value.kind === 'array') return `array:${value.empty}:${dataState(value.element ?? BAD, next)}`;
  return JSON.stringify([
    value.kind,
    value.native,
    'literal' in value,
    typeof value.literal,
    String(value.literal),
    value.model?.filename,
    value.node?.start,
    [...(value.env ?? [])].map(([name, captured]) => [name, dataState(captured, next)]),
    value.payload === undefined ? null : dataState(value.payload, next),
  ]);
};

class DataFactoryProof {
  readonly models = new Map<string, Model | null>();
  readonly resolving = new Set<string>();
  readonly typeResolving = new Set<string>();
  readonly calls = new Map<Node, readonly string[]>();
  readonly validatedCalls = new Set<Node>();
  readonly values = new Map<string, Value>();
  readonly initialized = new Map<string, boolean>();
  readonly arrayStates = new Map<Value, Value>();
  readonly invocations: { readonly node: Node; readonly model: Model; readonly token: symbol }[] = [];
  steps = 0;

  arrayState(value: Value): Value {
    let current = value;
    while (this.arrayStates.has(current)) current = this.arrayStates.get(current)!;
    return current;
  }

  load(filename: string): Model | null {
    if (this.models.has(filename)) return this.models.get(filename) ?? null;
    this.models.set(filename, null);
    try {
      const parsed = parseSync(filename, readFileSync(filename, 'utf8'), { sourceType: 'module' });
      if (parsed.errors.length !== 0) return null;
      let executableInitialization = false;
      const model: Model = {
        filename,
        executableInitialization: false,
        imports: new Map(),
        values: new Map(),
        types: new Map(),
        exports: new Map(),
        program: parsed.program as unknown as Node,
      };
      for (const original of model.program.body) {
        let node = original;
        if (node.type === 'ImportDeclaration') {
          if (node.specifiers.length === 0) return null;
          for (const specifier of node.specifiers) {
            if (specifier.type !== 'ImportSpecifier') return null;
            model.imports.set(specifier.local.name, { source: node.source.value, imported: key(specifier.imported)! });
          }
          continue;
        }
        const exported = node.type === 'ExportNamedDeclaration';
        if (exported) {
          if (node.source !== null) {
            for (const specifier of node.specifiers) {
              const local = `@reexport:${key(specifier.exported)}`;
              model.imports.set(local, { source: node.source.value, imported: key(specifier.local)! });
              model.exports.set(key(specifier.exported)!, local);
            }
            continue;
          }
          if (node.declaration === null) {
            for (const specifier of node.specifiers) model.exports.set(key(specifier.exported)!, key(specifier.local)!);
            continue;
          }
          node = node.declaration;
        }
        if (node.type === 'VariableDeclaration') {
          if (node.kind !== 'const') return null;
          for (const declaration of node.declarations) {
            const name = named(declaration.id);
            if (name === undefined || declaration.init === null || model.values.has(name)) return null;
            model.values.set(name, declaration.init);
            if (exported) model.exports.set(name, name);
          }
        } else if (node.type === 'FunctionDeclaration') {
          model.values.set(node.id.name, node);
          if (exported) model.exports.set(node.id.name, node.id.name);
        } else if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(node.type)) {
          model.types.set(node.id.name, node);
          if (exported) model.exports.set(node.id.name, node.id.name);
        } else if (node.type === 'ClassDeclaration') {
          // Classes are never data factory values. Their unrelated declarations need not invalidate
          // a reachable factory; executable module statements still invalidate the entire model.
          model.values.set(node.id.name, node);
          if (exported) model.exports.set(node.id.name, node.id.name);
        } else if (node.type === 'ExpressionStatement') executableInitialization = true;
        else if (!['EmptyStatement', 'TSDeclareFunction'].includes(node.type)) return null;
      }
      const complete = { ...model, executableInitialization };
      this.models.set(filename, complete);
      return complete;
    } catch {
      return null;
    }
  }

  safeInitialization(model: Model): boolean {
    const known = this.initialized.get(model.filename);
    if (known !== undefined) return known;
    this.initialized.set(model.filename, false);
    if (model.executableInitialization) return false;
    const originVisiting = new Set<string>();
    const deferredOrigin = (node: Node): string | null => {
      const current = unwrap(node);
      if (current.type === 'CallExpression') return deferredOrigin(current.callee);
      if (current.type === 'Identifier') {
        const local = model.values.get(current.name);
        if (local === undefined || originVisiting.has(current.name)) return null;
        originVisiting.add(current.name);
        const result = deferredOrigin(local);
        originVisiting.delete(current.name);
        return result;
      }
      if (current.type !== 'MemberExpression' || current.computed) return null;
      const property = current.property.name;
      if (current.object.type !== 'Identifier') {
        const origin = deferredOrigin(current.object);
        return origin === 'deferred-schema' && ['check', 'pipe'].includes(property) ? origin : null;
      }
      const imported = model.imports.get(current.object.name);
      if (imported?.source === 'effect') {
        if (imported.imported === 'Brand' && property === 'nominal') return 'nominal-brand';
        if (
          (imported.imported === 'Context' && property === 'Service') ||
          (imported.imported === 'Layer' && ['effect', 'succeed'].includes(property))
        )
          return 'deferred-runtime';
        if (imported.imported === 'Effect' && ['fn', 'fnUntraced'].includes(property)) return 'deferred-effect';
        if (imported.imported === 'Schema' && ['TaggedError', 'TaggedClass'].includes(property)) return 'schema-class';
        if (
          imported.imported === 'Schema' &&
          [
            'instanceOf',
            'is',
            'Defect',
            'toEquivalence',
            'Struct',
            'TaggedStruct',
            'Record',
            'Array',
            'Union',
            'Literal',
            'Literals',
            'fromJsonString',
            'decodeUnknownSync',
            'encodeSync',
            'String',
            'Trim',
            'NonEmptyString',
            'Number',
            'Boolean',
            'BigInt',
            'Finite',
            'Undefined',
            'Null',
            'Never',
            'Unknown',
            'tag',
            'optionalKey',
            'NullOr',
            'OptionFromNullOr',
            'UndefinedOr',
            'makeFilter',
            'brand',
            'isPattern',
            'isMinLength',
            'isMaxLength',
            'isInt',
            'isGreaterThan',
            'isBetween',
            'isFinite',
            'isTrimmed',
            'isUUID',
            'encodeResult',
            'decodeTo',
            'check',
          ].includes(property)
        )
          return 'deferred-schema';
      }
      if (['check', 'pipe'].includes(property))
        return deferredOrigin(current.object) === 'deferred-schema' ? 'deferred-schema' : null;
      return null;
    };
    const safe = (input: Node): boolean => {
      const node = unwrap(input);
      if (fnNode(node) || node.type === 'Identifier' || node.type === 'Literal') return true;
      if (node.type === 'MemberExpression') return safe(node.object) && (!node.computed || safe(node.property));
      if (node.type === 'ObjectExpression')
        return node.properties.every((property: Node) =>
          property.type === 'SpreadElement' ? safe(property.argument) : !property.computed && safe(property.value),
        );
      if (node.type === 'ArrayExpression')
        return node.elements.every((element: Node | null) => element === null || safe(element));
      if (node.type === 'ClassDeclaration') {
        if (node.superClass !== null && !safe(node.superClass)) return false;
        for (const member of node.body.body) {
          if (member.type === 'StaticBlock' || (member.computed && !safe(member.key))) return false;
          if (member.static && member.value !== null && member.value !== undefined && !safe(member.value)) return false;
        }
        return true;
      }
      if (node.type === 'CallExpression') {
        const origin = deferredOrigin(node);
        const callee = unwrap(node.callee);
        // Brand.nominal only constructs an identity function. Admit its declaration, not calls
        // through that function or arbitrary arguments/operations on a lookalike Brand object.
        if (origin === 'nominal-brand') {
          return callee.type === 'MemberExpression' && node.arguments.length === 0 && safe(callee.object);
        }
        const creation =
          callee.type === 'MemberExpression' ||
          callee.type === 'Identifier' ||
          (callee.type === 'CallExpression' &&
            ['deferred-effect', 'schema-class', 'deferred-runtime'].includes(origin ?? ''));
        if (origin !== null && creation) {
          const receiverSafe =
            callee.type === 'MemberExpression' ? safe(callee.object) : callee.type !== 'CallExpression' || safe(callee);
          return receiverSafe && node.arguments.every((argument: Node) => fnNode(unwrap(argument)) || safe(argument));
        }
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'Symbol' &&
        !model.values.has('Symbol') &&
        !model.imports.has('Symbol')
      ) {
        return node.arguments.every((argument: Node) => isData(this.expression(argument, model, new Map())));
      }
      return this.expression(node, model, new Map()).kind !== 'bad';
    };
    const result = [...model.values.values()].every(safe);
    this.initialized.set(model.filename, result);
    return result;
  }

  imported(model: Model, source: string): Model | null {
    if (!source.startsWith('./') && !source.startsWith('../')) return null;
    const base = path.resolve(path.dirname(model.filename), source);
    for (const filename of path.extname(base) === ''
      ? ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].map((ext) => base + ext)
      : [base]) {
      const result = this.load(filename);
      if (result !== null) return result;
    }
    return null;
  }

  value(name: string, model: Model, env: ReadonlyMap<string, Value>): Value {
    if (env.has(name)) return this.arrayState(env.get(name)!);
    const id = `${model.filename}:${name}`;
    if (this.values.has(id)) return this.values.get(id)!;
    if (this.resolving.has(id)) return BAD;
    this.resolving.add(id);
    let result = BAD;
    const imported = model.imports.get(name);
    if (imported !== undefined) {
      if (imported.source === 'effect' && ['Schema', 'Predicate', 'Result', 'Order'].includes(imported.imported)) {
        result = native(`effect:${imported.imported}`);
      } else if (imported.source === 'effect/encoding' && ['Hex', 'Base64Url'].includes(imported.imported))
        result = native(`effect/encoding:${imported.imported}`);
      else if (imported.source === 'node:crypto' && imported.imported === 'createHash')
        result = native('crypto:createHash');
      else if (NOBLE_DATA_FUNCTIONS.has(`${imported.source}:${imported.imported}`))
        result = native(`noble:${imported.imported}`);
      else {
        const owner = this.imported(model, imported.source);
        const exported = owner?.exports.get(imported.imported);
        if (owner !== null && exported !== undefined) {
          const declaration = owner.values.get(exported);
          if (declaration === undefined || !fnNode(declaration) || this.safeInitialization(owner))
            result = this.value(exported, owner, new Map());
        }
      }
    } else if (model.values.has(name)) result = this.expression(model.values.get(name)!, model, new Map());
    else if (name === 'undefined') result = DATA;
    else if (['Object', 'URL', 'Math'].includes(name)) result = native(`global:${name}`);
    this.resolving.delete(id);
    this.values.set(id, result);
    return result;
  }

  typeDeclaration(
    name: string,
    model: Model,
    visited = new Set<string>(),
  ): { readonly declaration: Node; readonly model: Model } | null {
    const id = `${model.filename}:${name}`;
    if (visited.has(id)) return null;
    visited.add(id);
    const declaration = model.types.get(name);
    if (declaration !== undefined) return { declaration, model };
    const imported = model.imports.get(name);
    if (imported === undefined) return null;
    const owner = this.imported(model, imported.source);
    const exported = owner?.exports.get(imported.imported);
    return owner === null || exported === undefined ? null : this.typeDeclaration(exported, owner, visited);
  }

  type(node: Node | undefined | null, model: Model, generics = new Map<string, Value>()): Value {
    if (node === undefined || node === null) return BAD;
    if (
      [
        'TSStringKeyword',
        'TSNumberKeyword',
        'TSBooleanKeyword',
        'TSBigIntKeyword',
        'TSUndefinedKeyword',
        'TSNullKeyword',
        'TSNeverKeyword',
        'TSLiteralType',
      ].includes(node.type)
    )
      return DATA;
    if (['TSTypeOperator', 'TSParenthesizedType', 'TSOptionalType'].includes(node.type))
      return this.type(node.typeAnnotation, model, generics);
    if (node.type === 'TSArrayType') return array(this.type(node.elementType, model, generics));
    if (node.type === 'TSUnionType') {
      const parts: Node[] = node.types;
      const present = parts.filter((part) => !['TSUndefinedKeyword', 'TSNullKeyword'].includes(part.type));
      const values = parts.map((part) => openData(this.type(part, model, generics)));
      const records = present.map((part) => openData(this.type(part, model, generics)));
      // Nullable input records keep their open shape; only explicit projection or a codec can close it.
      return present.length > 0 && present.length < parts.length && records.every((value) => value.kind === 'record')
        ? merge(records)
        : merge(values);
    }
    if (node.type === 'TSIntersectionType') {
      const parts = node.types.map((part: Node) => this.type(part, model, generics));
      return parts.every((part: Value) => part.kind === 'record')
        ? record(new Map(parts.flatMap((part: Value) => [...(part.fields ?? [])])))
        : BAD;
    }
    if (node.type === 'TSIndexedAccessType') {
      const owner = this.type(node.objectType, model, generics);
      if (node.indexType.type === 'TSNumberKeyword' && owner.kind === 'array') return owner.element ?? BAD;
      const name = node.indexType.literal?.value;
      return typeof name === 'string' ? (owner.fields?.get(name) ?? BAD) : BAD;
    }
    if (node.type === 'TSTypeQuery') {
      const names = this.qualified(node.exprName);
      if (names === null) return BAD;
      let value = this.value(names[0], model, new Map());
      for (const property of names.slice(1)) value = this.property(value, property, model);
      return value;
    }
    if (node.type === 'TSTypeLiteral') return this.typeFields(node.members, model, generics);
    if (node.type !== 'TSTypeReference') return BAD;
    const names = this.qualified(node.typeName);
    if (names === null) return BAD;
    const arguments_ = (node.typeArguments?.params ?? node.typeParameters?.params ?? []).map((argument: Node) =>
      this.type(argument, model, generics),
    );
    if (names.length > 1) {
      const root = model.imports.get(names[0]);
      if (root?.source === 'effect' && root.imported === 'Schema' && names.at(-1) === 'Type') {
        const argumentNode = node.typeArguments?.params?.[0] ?? node.typeParameters?.params?.[0];
        const input = this.type(argumentNode, model, generics);
        return input.kind === 'schema' ? (input.payload ?? BAD) : BAD;
      }
      return BAD;
    }
    const name = names[0];
    if (generics.has(name)) return generics.get(name)!;
    const builtin = !model.types.has(name) && !model.imports.has(name) && !model.values.has(name);
    if (builtin && ['ReadonlyArray', 'Array'].includes(name)) return array(arguments_[0] ?? BAD);
    if (builtin && ['Readonly', 'Partial', 'Required'].includes(name)) return arguments_[0] ?? BAD;
    if (builtin && ['Pick', 'Omit'].includes(name)) {
      const originNode = node.typeArguments?.params?.[0] ?? node.typeParameters?.params?.[0];
      const keysNode = node.typeArguments?.params?.[1] ?? node.typeParameters?.params?.[1];
      const keyNodes = keysNode?.types ?? [keysNode];
      if (
        keyNodes.some(
          (part: Node | undefined) => part?.type !== 'TSLiteralType' || typeof part.literal?.value !== 'string',
        )
      )
        return BAD;
      const selected = new Set(keyNodes.map((part: Node) => part.literal.value));
      // Evaluate only the selected fields: a DTO projection can legitimately omit executable fields.
      return this.projectType(originNode, model, generics, (field) =>
        name === 'Pick' ? selected.has(field) : !selected.has(field),
      );
    }
    const resolved = this.typeDeclaration(name, model);
    if (resolved === null) return BAD;
    const { declaration, model: owner } = resolved;
    const id = `${owner.filename}:${declaration.id.name}`;
    if (this.typeResolving.has(id)) return BAD;
    this.typeResolving.add(id);
    const next = new Map<string, Value>();
    for (const [index, parameter] of (declaration.typeParameters?.params ?? []).entries()) {
      next.set(
        named(parameter.name) ?? parameter.name,
        arguments_[index] ?? this.type(parameter.default ?? parameter.constraint, owner, generics),
      );
    }
    const result =
      declaration.type === 'TSInterfaceDeclaration'
        ? this.interfaceType(declaration, owner, next)
        : this.type(declaration.typeAnnotation, owner, next);
    this.typeResolving.delete(id);
    return result;
  }

  projectType(
    node: Node | undefined,
    model: Model,
    generics: Map<string, Value>,
    include: (name: string) => boolean,
  ): Value {
    if (node?.type === 'TSTypeReference') {
      const name = named(node.typeName);
      const resolved = name === undefined ? null : this.typeDeclaration(name, model);
      if (resolved?.declaration.type === 'TSInterfaceDeclaration') {
        const { declaration, model: owner } = resolved;
        const args = node.typeArguments?.params ?? node.typeParameters?.params ?? [];
        const next = new Map<string, Value>();
        for (const [index, parameter] of (declaration.typeParameters?.params ?? []).entries()) {
          next.set(
            named(parameter.name) ?? parameter.name,
            this.type(args[index] ?? parameter.default ?? parameter.constraint, model, generics),
          );
        }
        const inherited = this.interfaceType(declaration, owner, next);
        return inherited.kind === 'record'
          ? record(new Map([...(inherited.fields ?? [])].filter(([name]) => include(name))))
          : BAD;
      }
    }
    const origin = this.type(node, model, generics);
    return origin.kind === 'record'
      ? record(new Map([...(origin.fields ?? [])].filter(([name]) => include(name))))
      : BAD;
  }

  interfaceType(declaration: Node, model: Model, generics: Map<string, Value>): Value {
    const fields = this.typeFields(declaration.body.body, model, generics);
    if (fields.kind !== 'record') return BAD;
    const result = new Map(fields.fields);
    for (const extension of declaration.extends ?? []) {
      const inherited = this.type(
        { ...extension, type: 'TSTypeReference', typeName: extension.expression },
        model,
        generics,
      );
      if (inherited.kind !== 'record') return BAD;
      for (const [name, value] of inherited.fields ?? []) result.set(name, value);
    }
    return record(result);
  }

  typeFields(properties: readonly Node[], model: Model, generics: Map<string, Value>): Value {
    const fields = new Map<string, Value>();
    for (const property of properties) {
      const name = key(property.key);
      if (property.type !== 'TSPropertySignature' || name === undefined || property.computed) return BAD;
      fields.set(name, this.type(property.typeAnnotation?.typeAnnotation, model, generics));
    }
    return record(fields);
  }

  valueDeclaration(
    name: string,
    model: Model,
    visited = new Set<string>(),
  ): { readonly declaration: Node; readonly model: Model } | null {
    const id = `${model.filename}:${name}`;
    if (visited.has(id)) return null;
    visited.add(id);
    const declaration = model.values.get(name);
    if (declaration !== undefined) return { declaration, model };
    const imported = model.imports.get(name);
    if (imported === undefined) return null;
    const owner = this.imported(model, imported.source);
    const exported = owner?.exports.get(imported.imported);
    return owner === null || exported === undefined ? null : this.valueDeclaration(exported, owner, visited);
  }

  /**
   * Constructing a field-only `Schema.TaggedError` subclass yields its tag and data fields. Any class
   * member, another base class or a module with executable initialization fails closed.
   */
  taggedError(node: Node, model: Model, env: ReadonlyMap<string, Value>): Value {
    const name = named(node.callee);
    const resolved = name === undefined || env.has(name) ? null : this.valueDeclaration(name, model);
    const declaration = resolved?.declaration;
    if (
      resolved === null ||
      declaration?.type !== 'ClassDeclaration' ||
      declaration.body.body.length > 0 ||
      (declaration.decorators?.length ?? 0) > 0 ||
      node.arguments.length !== 1
    )
      return BAD;
    const base = unwrap(declaration.superClass ?? { type: 'Missing' });
    const factory = base.type === 'CallExpression' ? unwrap(base.callee) : undefined;
    const member = factory?.type === 'CallExpression' ? unwrap(factory.callee) : undefined;
    const schemaImport = member?.computed === false ? resolved.model.imports.get(named(member.object) ?? '') : undefined;
    if (
      schemaImport?.source !== 'effect' ||
      schemaImport.imported !== 'Schema' ||
      member?.property.name !== 'TaggedError' ||
      factory?.arguments.length !== 0 ||
      base.arguments.length !== 2 ||
      !this.safeInitialization(resolved.model)
    )
      return BAD;
    const tag = this.expression(base.arguments[0], resolved.model, new Map());
    const fields = this.expression(base.arguments[1], resolved.model, new Map());
    const input = this.expression(node.arguments[0], model, env);
    if (
      typeof tag.literal !== 'string' ||
      fields.kind !== 'record' ||
      ![...(fields.fields?.values() ?? [])].every((field) => field.kind === 'schema' && isData(field.payload ?? BAD)) ||
      input.kind !== 'record' ||
      !isClosedData(input)
    )
      return BAD;
    return { ...record(new Map([['_tag', tag], ...(input.fields ?? [])])), native: 'tagged-error' };
  }

  qualified(node: Node | undefined): string[] | null {
    if (node?.type === 'Identifier') return [node.name];
    if (node?.type !== 'TSQualifiedName') return null;
    const left = this.qualified(node.left);
    return left === null ? null : [...left, node.right.name];
  }

  bind(pattern: Node, input: Value, model: Model, env: Map<string, Value>): boolean {
    if (pattern.type === 'AssignmentPattern') {
      const fallback = this.expression(pattern.right, model, env);
      if (!isData(fallback)) return false;
      return this.bind(pattern.left, input.kind === 'bad' ? fallback : input, model, env);
    }
    if (pattern.type === 'Identifier') {
      env.set(pattern.name, input);
      return isData(input);
    }
    if (pattern.type === 'ArrayPattern') {
      if (input.kind !== 'array' || !isClosedData(input)) return false;
      for (const element of pattern.elements) {
        if (element !== null && !this.bind(element, input.element ?? BAD, model, env)) return false;
      }
      return true;
    }
    if (pattern.type === 'ObjectPattern' && (input.kind === 'data' || input.kind === 'array'))
      return pattern.properties.every(
        (property: Node) =>
          property.type === 'Property' &&
          !property.computed &&
          key(property.key) === 'length' &&
          this.bind(property.value, DATA, model, env),
      );
    if (pattern.type !== 'ObjectPattern' || input.kind !== 'record') return false;
    for (const property of pattern.properties) {
      const name = key(property.key);
      if (property.type !== 'Property' || name === undefined || property.computed || property.kind !== 'init')
        return false;
      if (!this.bind(property.value, input.fields?.get(name) ?? DATA, model, env)) return false;
    }
    return true;
  }

  invoke(function_: Value, args: readonly Value[]): Value {
    if (function_.apply !== undefined) return function_.apply(args);
    const node = function_.node;
    const model = function_.model;
    if (function_.kind !== 'function' || node === undefined || model === undefined || node.async || node.generator)
      return BAD;
    // Re-enter recursive bodies with generalized data so changing literal arguments cannot hide
    // a reachable branch. Only an already inspected abstract state may close the traversal cycle.
    const active = this.calls.get(node);
    if (active !== undefined && !args.every(isData)) return BAD;
    const inputs = active === undefined ? args : args.map(generalizeData);
    const state = JSON.stringify([
      inputs.map((value) => dataState(value)),
      [...(function_.env ?? [])].map(([name, captured]) => [name, dataState(captured)]),
    ]);
    if (active?.includes(state)) return merge(inputs);
    this.calls.set(node, [...(active ?? []), state]);
    const previouslyValidated = new Set(this.validatedCalls);
    const generics = new Map<string, Value>();
    for (const parameter of node.typeParameters?.params ?? []) {
      generics.set(named(parameter.name) ?? parameter.name, this.type(parameter.constraint, model));
    }
    const env = new Map(function_.env);
    let valid = true;
    for (const [index, parameter] of node.params.entries()) {
      const pattern = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
      const annotation = pattern.typeAnnotation?.typeAnnotation;
      const input =
        inputs[index] ?? (annotation === undefined ? BAD : openData(this.type(annotation, model, generics)));
      if (!isData(input)) valid = false;
      if (!this.bind(parameter, input, model, env)) valid = false;
    }
    this.invocations.push({ node, model, token: Symbol() });
    const result = valid
      ? node.body.type === 'BlockStatement'
        ? this.statements(node.body.body, model, env)
        : this.expression(node.body, model, env)
      : BAD;
    this.invocations.pop();
    if (active === undefined) this.calls.delete(node);
    else this.calls.set(node, active);
    if (!isData(result)) {
      for (const call of this.validatedCalls) if (!previouslyValidated.has(call)) this.validatedCalls.delete(call);
    }
    return result;
  }

  statements(statements: readonly Node[], model: Model, env: Map<string, Value>): Value {
    const returns: Value[] = [];
    const completion = this.block(statements, model, env, returns);
    if (completion === 'bad') return BAD;
    if (completion === 'falls') returns.push({ kind: 'data', literal: undefined });
    return merge(returns);
  }

  /**
   * Collects every reachable return value. A block that may complete without returning reports
   * `falls`; only its function body turns that into an `undefined` result.
   */
  block(statements: readonly Node[], model: Model, env: Map<string, Value>, returns: Value[]): Completion {
    const nested = (part: Node | null, scope: Map<string, Value>): Completion =>
      part === null
        ? 'falls'
        : this.block(part.type === 'BlockStatement' ? part.body : [part], model, scope, returns);
    for (const node of statements) {
      if (node.type === 'VariableDeclaration' && node.kind === 'const') {
        for (const declaration of node.declarations) {
          const value = this.expression(declaration.init, model, env);
          if (!this.bind(declaration.id, value, model, env)) return 'bad';
        }
      } else if (node.type === 'VariableDeclaration' && node.kind === 'let') {
        for (const declaration of node.declarations) {
          const name = named(declaration.id);
          if (name === undefined) return 'bad';
          if (declaration.init !== null && !isClosedData(this.expression(declaration.init, model, env))) return 'bad';
          env.set(name, MUTABLE);
        }
      } else if (node.type === 'ReturnStatement') {
        returns.push(node.argument === null ? { kind: 'data', literal: undefined } : this.expression(node.argument, model, env));
        return 'returns';
      } else if (node.type === 'ExpressionStatement') {
        if (!isData(this.expression(node.expression, model, env))) return 'bad';
      } else if (node.type === 'IfStatement') {
        if (!isData(this.expression(node.test, model, env))) return 'bad';
        const consequent = nested(node.consequent, new Map(env));
        const alternate = nested(node.alternate, new Map(env));
        if (consequent === 'bad' || alternate === 'bad') return 'bad';
        if (consequent === 'returns' && alternate === 'returns') return 'returns';
      } else if (
        node.type === 'ForOfStatement' &&
        node.await !== true &&
        node.left.type === 'VariableDeclaration' &&
        node.left.kind === 'const'
      ) {
        const iterable = this.expression(node.right, model, env);
        if (iterable.kind !== 'array') return 'bad';
        const loop = new Map(env);
        if (!this.bind(node.left.declarations[0].id, iterable.element ?? BAD, model, loop)) return 'bad';
        // The body may run zero times, so the loop itself always falls through; its returns still count.
        if (nested(node.body, loop) === 'bad') return 'bad';
      } else return 'bad';
    }
    return 'falls';
  }

  /** The ownership token of a literal created inside the current invocation, if any. */
  invocationOwner(node: Node, model: Model): symbol | undefined {
    const invocation = this.invocations.at(-1);
    // Only a literal created in this invocation can be accumulated transiently. Module-level,
    // captured, parameter and other-function collections never receive the current ownership token.
    return invocation?.model === model &&
      node.start >= invocation.node.body.start &&
      node.end <= invocation.node.body.end
      ? invocation.token
      : undefined;
  }

  /** The element array of a known array or Set; every other iterable fails closed. */
  iterable(input: Value): Value {
    const value = this.arrayState(input);
    if (value.kind === 'array') return array(value.element ?? BAD, value.empty);
    return value.kind === 'record' && value.native === 'set' ? (value.payload ?? BAD) : BAD;
  }

  spread(node: Node, model: Model, env: ReadonlyMap<string, Value>): Value {
    return this.iterable(this.expression(node.argument, model, env));
  }

  property(input: Value, name: string, model: Model): Value {
    const value = this.normalizeNative(input);
    if (value.kind === 'record' && value.native === 'set' && ['has', 'add'].includes(name))
      return { kind: 'native', native: `set:${name}`, payload: value };
    if (value.kind === 'record' && value.native === 'result' && name === 'pipe')
      return { kind: 'native', native: 'result:pipe', payload: value };
    if (value.kind === 'record') {
      const field = value.fields?.get(name) ?? value.element;
      if (field !== undefined) return field;
      // A closed plain-data record has no other own field. Inherited Object members and the members
      // of a native object behind a record stay unmodeled.
      return value.open !== true && value.native === undefined && !(name in Object.prototype)
        ? { kind: 'data', literal: undefined }
        : BAD;
    }
    if (value.kind === 'data' && value.native === 'regexp') return native(`regexp:${name}`);
    if (value.kind === 'schema') {
      if (name === 'Type') return value.payload ?? BAD;
      if (name === 'fields')
        return value.payload?.kind === 'record'
          ? record(new Map([...(value.payload.fields ?? [])].map(([field, payload]) => [field, schema(payload)])))
          : BAD;
      return { kind: 'native', native: `schema:${name}`, payload: value };
    }
    if (value.kind === 'native') return this.normalizeNative(native(`${value.native}.${name}`));
    if (name === 'length' && (value.kind === 'array' || value.kind === 'data')) return DATA;
    if (value.kind === 'array' || value.kind === 'data')
      return { kind: 'native', native: `data:${name}`, payload: value };
    if (value.kind === 'hash') return { kind: 'native', native: `hash:${name}`, payload: value };
    return BAD;
  }

  expression(input: Node | undefined | null, model: Model, env: ReadonlyMap<string, Value>): Value {
    if (input === undefined || input === null || ++this.steps > 30_000) return BAD;
    const node = unwrap(input);
    if (fnNode(node)) return { kind: 'function', node, model, env: new Map(env) };
    if (node.type === 'Identifier') return this.value(node.name, model, env);
    if (node.type === 'Literal')
      return node.regex === undefined ? { kind: 'data', literal: node.value } : { kind: 'data', native: 'regexp' };
    if (node.type === 'TemplateLiteral')
      return node.expressions.every((part: Node) => isData(this.expression(part, model, env))) ? DATA : BAD;
    if (node.type === 'ArrayExpression') {
      const elements: Value[] = [];
      for (const part of node.elements.filter(Boolean)) {
        const spread = part.type === 'SpreadElement' ? this.spread(part, model, env) : undefined;
        if (spread?.kind === 'bad') return BAD;
        if (spread?.empty !== true) elements.push(spread?.element ?? this.expression(part, model, env));
      }
      if (elements.some((element: Value) => element.kind === 'bad')) return BAD;
      const owner = this.invocationOwner(node, model);
      return { ...array(merge(elements), elements.length === 0), ...(owner === undefined ? {} : { arrayOwner: owner }) };
    }
    if (node.type === 'ObjectExpression') {
      const fields = new Map<string, Value>();
      let open = false;
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const value = this.expression(property.argument, model, env);
          if (value.kind !== 'record') return BAD;
          if (value.open) open = true;
          for (const [name, field] of value.fields ?? []) fields.set(name, field);
        } else {
          // A computed key is admitted only when it is a known string literal; any other key could
          // overwrite an arbitrary field.
          const computed = property.computed ? this.expression(property.key, model, env) : undefined;
          const name =
            computed === undefined ? key(property.key) : typeof computed.literal === 'string' ? computed.literal : undefined;
          if (property.kind !== 'init' || property.method || name === undefined) return BAD;
          const value = this.expression(property.value, model, env);
          if (value.kind === 'bad') return BAD;
          fields.set(name, value);
        }
      }
      return record(fields, open);
    }
    if (node.type === 'MemberExpression') {
      const owner = this.expression(node.object, model, env);
      if (!node.computed) return this.property(owner, node.property.name, model);
      if (node.property.type === 'Literal' && typeof node.property.value === 'string')
        return this.property(owner, node.property.value, model);
      if (node.property.type === 'Literal' && typeof node.property.value === 'number' && owner.kind === 'array')
        return owner.element ?? BAD;
      return BAD;
    }
    if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Set' &&
      !model.values.has('Set') &&
      !model.imports.has('Set') &&
      !env.has('Set')
    ) {
      const args = node.arguments.map((part: Node) => this.expression(part, model, env));
      if (args.length > 1 || !args.every(isData)) return BAD;
      const elements = args[0] === undefined ? array(DATA, true) : this.iterable(args[0]);
      if (elements.kind === 'bad') return BAD;
      const owner = this.invocationOwner(node, model);
      // A Set of data exposes only its size, membership, spread and owned insertion; every other
      // member fails closed. Its elements stay in the payload so a spread keeps their shape.
      return {
        ...record(new Map([['size', DATA]])),
        native: 'set',
        payload: elements,
        ...(owner === undefined ? {} : { arrayOwner: owner }),
      };
    }
    if (node.type === 'NewExpression') return this.taggedError(node, model, env);
    if (node.type === 'AssignmentExpression')
      return node.left.type === 'Identifier' &&
        env.get(node.left.name) === MUTABLE &&
        isClosedData(this.expression(node.right, model, env))
        ? DATA
        : BAD;
    if (node.type === 'ConditionalExpression') {
      const test = this.expression(node.test, model, env);
      if (!isData(test)) return BAD;
      if (typeof test.literal === 'boolean')
        return this.expression(test.literal ? node.consequent : node.alternate, model, env);
      return merge([this.expression(node.consequent, model, env), this.expression(node.alternate, model, env)]);
    }
    if (['BinaryExpression', 'LogicalExpression'].includes(node.type)) {
      const left = this.expression(node.left, model, env);
      const right = this.expression(node.right, model, env);
      if (!isData(left) || !isData(right)) return BAD;
      if (
        node.type === 'BinaryExpression' &&
        ['===', '!=='].includes(node.operator) &&
        'literal' in left &&
        'literal' in right
      ) {
        return {
          kind: 'data',
          literal: node.operator === '===' ? left.literal === right.literal : left.literal !== right.literal,
        };
      }
      if (node.type === 'LogicalExpression' && node.operator === '??' && (left.literal === undefined || left.literal === null) && 'literal' in left)
        return right;
      return node.type === 'LogicalExpression' ? merge([left, right]) : DATA;
    }
    if (node.type === 'UnaryExpression' && ['!', '-', '+', 'typeof', 'void'].includes(node.operator))
      return isData(this.expression(node.argument, model, env)) ? DATA : BAD;
    if (node.type !== 'CallExpression') return BAD;
    const callee = this.expression(node.callee, model, env);
    // Only variadic Math reductions accept spread arguments; a spread into any other call would
    // erase the positional parameters the proof binds.
    const variadic = callee.kind === 'native' && ['global:Math.max', 'global:Math.min'].includes(callee.native ?? '');
    const args: Value[] = [];
    for (const argument of node.arguments) {
      if (argument.type !== 'SpreadElement') args.push(this.expression(argument, model, env));
      else if (!variadic) return BAD;
      else {
        const spread = this.spread(argument, model, env);
        if (spread.kind === 'bad') return BAD;
        if (spread.empty !== true) args.push(spread.element ?? BAD);
      }
    }
    if (callee.kind === 'bad' || args.some((argument: Value) => argument.kind === 'bad')) return BAD;
    const result = callee.kind === 'native' ? this.nativeCall(callee, args) : this.invoke(callee, args);
    if (isData(result)) this.validatedCalls.add(node);
    return result;
  }

  nativeCall(callee: Value, args: readonly Value[]): Value {
    const name = callee.native ?? '';
    if (name === 'regexp:test' && args.every(isData)) return DATA;
    if (name === 'regexp:exec' && args.every(isData))
      return record(new Map([['groups', { kind: 'record', fields: new Map(), element: DATA }]]));
    if (name === 'set:has') return args.length === 1 && isData(args[0]) ? DATA : BAD;
    if (name === 'set:add') {
      const owner = callee.payload ?? BAD;
      if (
        owner.arrayOwner === undefined ||
        owner.arrayOwner !== this.invocations.at(-1)?.token ||
        args.length !== 1 ||
        !isClosedData(args[0])
      )
        return BAD;
      const elements = owner.payload ?? BAD;
      const next = {
        ...owner,
        payload: array(merge([...(elements.empty === true ? [] : [elements.element ?? BAD]), args[0]])),
      };
      this.arrayStates.set(owner, next);
      return next;
    }
    if (['global:Math.max', 'global:Math.min'].includes(name)) return args.every(isData) ? DATA : BAD;
    if (name === 'crypto:createHash') return args.every(isData) ? { kind: 'hash' } : BAD;
    if ((name.startsWith('noble:') || ENCODING_DATA_FUNCTIONS.has(name)) && args.length === 1 && isData(args[0]))
      return DATA;
    if (['hash:update', 'hash:digest'].includes(name))
      return args.every(isData) ? (name === 'hash:digest' ? DATA : { kind: 'hash' }) : BAD;
    if (name === 'global:Object.freeze') return args.length === 1 && isData(args[0]) ? args[0] : BAD;
    if (name === 'global:Object.values')
      return args[0]?.kind === 'record' && args[0].open !== true
        ? array(merge([...(args[0].fields?.values() ?? [])]))
        : args[0]?.kind === 'data'
          ? array(DATA)
          : BAD;
    if (name === 'global:URL.parse')
      return args.every(isData)
        ? {
            ...record(
              new Map(
                ['hostname', 'protocol', 'username', 'password', 'search', 'hash', 'pathname', 'origin', 'port'].map(
                  (field) => [field, DATA],
                ),
              ),
            ),
            native: 'url',
          }
        : BAD;
    if (name.startsWith('data:')) {
      const operation = name.slice(5);
      const owner = callee.payload ?? BAD;
      if (
        operation === 'push' &&
        owner.kind === 'array' &&
        owner.arrayOwner !== undefined &&
        owner.arrayOwner === this.invocations.at(-1)?.token &&
        isClosedData(owner) &&
        args.length > 0 &&
        args.every(isClosedData)
      ) {
        this.arrayStates.set(owner, {
          ...owner,
          element: merge([...(owner.empty ? [] : [owner.element ?? BAD]), ...args]),
          empty: false,
        });
        return { kind: 'data', native: 'number' };
      }
      if (operation === 'split' && owner.kind === 'data' && args.every(isData)) return array(DATA);
      if (operation === 'slice' && isData(owner) && args.every(isData)) return owner;
      if (operation === 'flatMap' && owner.kind === 'array' && args.length === 1) {
        const result = this.invoke(args[0], [owner.element ?? BAD]);
        return result.kind === 'array' ? result : BAD;
      }
      if (operation === 'map' && owner.kind === 'array' && args.length === 1)
        return array(this.invoke(args[0], [owner.element ?? BAD]));
      if (operation === 'filter' && owner.kind === 'array' && isData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, DATA, owner]))
          ? array(owner.element ?? BAD, owner.empty)
          : BAD;
      if (operation === 'find' && owner.kind === 'array' && isData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, DATA, owner]))
          ? merge([owner.element ?? BAD, { kind: 'data', literal: undefined }])
          : BAD;
      if (['some', 'every'].includes(operation) && owner.kind === 'array' && isData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, DATA, owner])) ? DATA : BAD;
      if (operation === 'toSorted' && owner.kind === 'array')
        return owner.empty ||
          args.length === 0 ||
          (args.length === 1 && isData(this.invoke(args[0], [owner.element ?? BAD, owner.element ?? BAD])))
          ? owner
          : BAD;
      if (
        [
          'includes',
          'endsWith',
          'startsWith',
          'repeat',
          'replaceAll',
          'localeCompare',
          'isWellFormed',
          'normalize',
          'toLowerCase',
          'join',
        ].includes(operation) &&
        isData(owner) &&
        args.every(isData)
      )
        return DATA;
      return BAD;
    }
    if (
      name.startsWith('effect:Predicate.') &&
      ['isObjectKeyword', 'isString', 'isNumber', 'isBoolean'].includes(name.split('.').at(-1)!) &&
      args.every(isData)
    )
      return DATA;
    if (name === 'effect:Result.getOrThrow' && args.every(isData)) return DATA;
    if (name.startsWith('effect:Result.')) return this.resultCall(name.slice('effect:Result.'.length), args);
    if (name === 'result:pipe') {
      let result = callee.payload ?? BAD;
      for (const argument of args) result = this.invoke(argument, [result]);
      return result;
    }
    if (name === 'effect:Order.mapInput' && args.length === 2 && args[0].kind === 'function')
      return {
        kind: 'function',
        apply: (values) =>
          this.invoke(
            args[0],
            values.map((value) => this.invoke(args[1], [value])),
          ),
      };
    if (
      name === 'effect:Order.Struct' &&
      args[0]?.kind === 'record' &&
      [...(args[0].fields?.values() ?? [])].every((field) => field.kind === 'function')
    ) {
      return {
        kind: 'function',
        apply: (values) => {
          if (!values.every(isData)) return BAD;
          for (const [field, compare] of args[0].fields ?? []) {
            const projected = values.map((value) => value.fields?.get(field) ?? BAD);
            if (!isData(this.invoke(compare, projected))) return BAD;
          }
          return DATA;
        },
      };
    }
    if (name === 'schema:pipe' || name === 'schema:check') {
      let result = callee.payload ?? BAD;
      for (const argument of args) {
        if (argument.kind !== 'transform' || argument.apply === undefined) return BAD;
        result = argument.apply([result]);
      }
      return result;
    }
    if (!name.startsWith('effect:Schema.')) return BAD;
    const operation = name.slice('effect:Schema.'.length);
    if (operation === 'decodeUnknownResult') {
      const value = args[0];
      if (value?.kind !== 'schema' || !isData(value.payload ?? BAD) || !args.slice(1).every(isData)) return BAD;
      return { kind: 'function', apply: (inputs) => (inputs.every(isData) ? outcome(value.payload, ISSUE) : BAD) };
    }
    if (['decodeUnknownSync', 'decodeSync', 'encodeSync', 'encodeResult'].includes(operation)) {
      const value = args[0];
      if (value?.kind !== 'schema' || !isData(value.payload ?? BAD) || !args.slice(1).every(isData)) return BAD;
      return {
        kind: 'function',
        apply: (inputs) =>
          inputs.every(isData)
            ? operation === 'encodeSync' || operation === 'encodeResult'
              ? DATA
              : (value.payload ?? BAD)
            : BAD,
      };
    }
    if (operation === 'Struct' && args.length === 1 && args[0]?.kind === 'record') {
      const fields = new Map<string, Value>();
      for (const [field, value] of args[0].fields ?? []) {
        if (value.kind !== 'schema') return BAD;
        fields.set(field, value.payload ?? BAD);
      }
      return schema(record(fields));
    }
    if (['Array', 'NonEmptyArray'].includes(operation) && args.length === 1 && args[0]?.kind === 'schema')
      return schema(array(args[0].payload ?? BAD));
    if (operation === 'Union' && args.length === 1 && args[0]?.kind === 'array') {
      const element = args[0].element;
      return element?.kind === 'schema' ? element : BAD;
    }
    if (operation === 'Literal' && args.length === 1 && isData(args[0])) return schema(args[0]);
    if (operation === 'Literals' && args.every(isData)) return schema(DATA);
    if (
      ['fromJsonString', 'optionalKey', 'NullOr', 'UndefinedOr'].includes(operation) &&
      args.length === 1 &&
      args[0]?.kind === 'schema'
    )
      return args[0];
    if (operation === 'makeFilter' && args.length === 1 && args[0]?.kind === 'function')
      return {
        kind: 'transform',
        apply: (values) => {
          const value = values[0];
          return value?.kind === 'schema' && isData(this.invoke(args[0], [value.payload ?? BAD])) ? value : BAD;
        },
      };
    if (
      [
        'brand',
        'isPattern',
        'isMinLength',
        'isMaxLength',
        'isInt',
        'isBetween',
        'isFinite',
        'isTrimmed',
        'isUUID',
        'isUnique',
      ].includes(operation) &&
      args.every(isData)
    )
      return { kind: 'transform', apply: (values) => (values[0]?.kind === 'schema' ? values[0] : BAD) };
    if (operation === 'decodeTo' && args.length === 1 && args[0]?.kind === 'schema')
      return { kind: 'transform', apply: (values) => (values[0]?.kind === 'schema' ? args[0] : BAD) };
    if (operation === 'check' && args.every((value) => value.kind === 'transform'))
      return {
        kind: 'transform',
        apply: (values) => {
          let result = values[0] ?? BAD;
          for (const argument of args) result = argument.apply?.([result]) ?? BAD;
          return result;
        },
      };
    return BAD;
  }

  /** Result constructors, guards and data-last combinators over the modeled success and failure. */
  resultCall(operation: string, args: readonly Value[]): Value {
    if (args.length !== 1) return BAD;
    const [argument] = args;
    if (operation === 'succeed') return outcome(argument, undefined);
    if (operation === 'fail') return outcome(undefined, argument);
    if (['isFailure', 'isSuccess'].includes(operation)) return argument.native === 'result' ? DATA : BAD;
    if (!['map', 'mapError', 'flatMap'].includes(operation) || argument.kind !== 'function') return BAD;
    return {
      kind: 'function',
      apply: (inputs) => {
        const input = inputs[0];
        if (inputs.length !== 1 || input?.native !== 'result') return BAD;
        const success = input.fields?.get('success');
        const failure = input.fields?.get('failure');
        if (operation === 'map') return outcome(success && this.invoke(argument, [success]), failure);
        if (operation === 'mapError') return outcome(success, failure && this.invoke(argument, [failure]));
        const next = success && this.invoke(argument, [success]);
        if (next !== undefined && next.native !== 'result') return BAD;
        return merge([...(next === undefined ? [] : [next]), outcome(undefined, failure)]);
      },
    };
  }

  normalizeNative(value: Value): Value {
    value = this.arrayState(value);
    if (value.kind !== 'native') return value;
    const name = value.native ?? '';
    if (name === 'effect:Schema.Unknown') return schema(BAD);
    if (/^effect:Schema\.(String|NonEmptyString|Number|Finite|Boolean|BigInt|Undefined|Null|Never)$/u.test(name))
      return schema(DATA);
    if (name === 'effect:Order.String' || name === 'effect:Order.Number')
      return { kind: 'function', apply: (args) => (args.every(isData) ? DATA : BAD) };
    return value;
  }
}

/** Only calls reachable from verified concrete DTO factories may instantiate opaque generic data. */
export function provesDataFactoryImport(filename: string, source: string, importedName: string): boolean {
  const proof = new DataFactoryProof();
  const consumer = proof.load(filename);
  if (consumer === null) return false;
  const owner = proof.imported(consumer, source);
  const exported = owner?.exports.get(importedName);
  if (owner === null || exported === undefined || !proof.safeInitialization(owner)) return false;
  const target = proof.value(exported, owner, new Map());
  if (target.kind !== 'function' || target.node === undefined) return false;
  const direct = proof.invoke(target, []);
  if (isClosedData(direct)) return true;
  // A generic factory is checked with arguments propagated from each owning data factory. Any
  // escaped reference or unchecked use invalidates contextual admission.
  for (const local of consumer.exports.values()) {
    const candidate = proof.value(local, consumer, new Map());
    if (candidate.kind !== 'function') continue;
    const before = new Set(proof.validatedCalls);
    if (isClosedData(proof.invoke(candidate, []))) continue;
    for (const call of proof.validatedCalls) if (!before.has(call)) proof.validatedCalls.delete(call);
  }
  const locals = [...consumer.imports]
    .filter(([, imported]) => imported.source === source && imported.imported === importedName)
    .map(([local]) => local);
  let uses = 0;
  let valid = true;
  const visit = (node: Node, parent?: Node): void => {
    if (node.type === 'Identifier' && locals.includes(node.name)) {
      if (parent?.type === 'ImportSpecifier' || parent?.type === 'TSTypeReference') return;
      uses += 1;
      if (parent?.type !== 'CallExpression' || parent.callee !== node || !proof.validatedCalls.has(parent))
        valid = false;
    }
    for (const [field, value] of Object.entries(node)) {
      if (field === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string')
          visit(child as Node, node);
    }
  };
  visit(consumer.program);
  return uses > 0 && valid;
}
