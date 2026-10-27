import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseSync } from 'oxc-parser';

// The proof models closed data construction, not total mathematical purity: native codecs may
// reject malformed data and Object.freeze may freeze a data graph. Neither supplies executable
// behavior or an environmental dependency. Unknown operations and executable payloads fail closed.
type Node = Record<string, any>;
type FieldKey = string | symbol;
interface Model {
  readonly filename: string;
  readonly imports: Map<string, { source: string; imported: string; typeOnly?: boolean }>;
  readonly values: Map<string, Node>;
  readonly types: Map<string, Node>;
  readonly exports: Map<string, string>;
  readonly program: Node;
  readonly executableInitialization: boolean;
}
interface Value {
  readonly kind:
    | 'bad'
    | 'data'
    | 'json'
    | 'array'
    | 'record'
    | 'set'
    | 'schema'
    | 'function'
    | 'native'
    | 'transform'
    | 'getter'
    | 'hash'
    | 'sql'
    | 'policy'
    | 'table'
    | 'column'
    | 'column-builder'
    | 'pg-schema'
    | 'sequence'
    | 'constraint'
    | 'index-builder'
    | 'index'
    | 'relations'
    | 'metadata-union'
    | 'option'
    | 'result'
    | 'error-constructor'
    | 'invariant-error';
  readonly fields?: ReadonlyMap<FieldKey, Value>;
  readonly optionalFields?: ReadonlySet<FieldKey>;
  readonly prototype?: 'object' | 'null';
  // Array elements or possible own dictionary values; an index signature never guarantees presence.
  readonly element?: Value;
  readonly items?: readonly Value[];
  readonly empty?: boolean;
  readonly open?: boolean;
  readonly payload?: Value;
  readonly node?: Node;
  readonly model?: Model;
  readonly env?: ReadonlyMap<string, Value>;
  readonly native?: string;
  readonly apply?: (args: readonly Value[]) => Value;
  readonly literal?: unknown;
  // Mutating native metadata methods require construction in the current call graph.
  readonly fresh?: boolean;
  readonly optionalSql?: boolean;
  readonly failure?: Value;
  readonly optionalKey?: boolean;
}
const BAD: Value = { kind: 'bad' };
const DATA: Value = { kind: 'data' };
const NUMBER: Value = { kind: 'data', native: 'number' };
// Keep native temporal provenance: formatters must never accept an arbitrary DTO
// merely because it has similarly named fields or executable conversion hooks.
const DATETIME: Value = { kind: 'data', native: 'datetime' };
const SQL: Value = { kind: 'sql' };
const UNDEFINED: Value = { kind: 'data', literal: undefined };
// As with the native operations below, fresh object literals use the standard intrinsic
// prototype. Enumerate its own keys without invoking getters; unknown prototypes fail closed.
const objectPrototypeKeys = new Set(Reflect.ownKeys(Object.prototype));
const objectPrototypeIsRoot = Object.getPrototypeOf(Object.prototype) === null;
const inheritedField = (value: Value, name: FieldKey): Value =>
  value.prototype === 'null' ||
  (value.prototype === 'object' && objectPrototypeIsRoot && !objectPrototypeKeys.has(name))
    ? UNDEFINED
    : BAD;
// Own-property projection (joins and spreads) excludes inherited values; optionalFields and
// dictionary elements track possible absence separately. Ordinary lookup and destructuring must
// include inheritance unless a named own field is required, even on a closed data record.
const ownRecordField = (value: Value, name: FieldKey): Value =>
  value.fields?.get(name) ?? value.element ?? (value.open ? BAD : UNDEFINED);
const recordField = (value: Value, name: FieldKey): Value => {
  const field = value.fields?.get(name);
  if (field !== undefined && !value.optionalFields?.has(name)) return field;
  const possibleOwn = field ?? value.element ?? (value.open ? BAD : UNDEFINED);
  return merge([possibleOwn, inheritedField(value, name)]);
};
const array = (element: Value, empty = false, items?: readonly Value[]): Value => ({
  kind: 'array',
  element,
  empty,
  items,
});
const record = (
  fields: ReadonlyMap<FieldKey, Value>,
  open = false,
  element?: Value,
  optionalFields?: ReadonlySet<FieldKey>,
  prototype?: Value['prototype'],
): Value => ({
  kind: 'record',
  fields,
  open,
  element,
  optionalFields,
  prototype,
});
const schema = (payload: Value): Value => ({ kind: 'schema', payload });
const native = (name: string): Value => ({ kind: 'native', native: name });
const isData = (value: Value): boolean =>
  value.kind === 'data' ||
  (value.kind === 'array' && isData(value.element ?? BAD)) ||
  (value.kind === 'record' &&
    (value.element === undefined || isData(value.element)) &&
    [...(value.fields?.values() ?? [])].every(isData));
const isClosedData = (value: Value): boolean =>
  value.kind === 'data' ||
  (value.kind === 'array' && isClosedData(value.element ?? BAD)) ||
  (value.kind === 'record' &&
    value.open !== true &&
    (value.element === undefined || isClosedData(value.element)) &&
    [...(value.fields?.values() ?? [])].every(isClosedData));
// Metadata is not ordinary data: never erase its provenance into a string/DTO or admit its
// executable methods via the generic data operations. Only the native operations below consume it.
const isFactoryData = (value: Value, closed = false): boolean =>
  value.kind === 'data' ||
  (value.kind === 'metadata-union' && (value.items ?? []).every((part) => isFactoryData(part, closed))) ||
  ['sql', 'policy', 'table', 'column', 'sequence', 'pg-schema', 'constraint', 'index-builder', 'index', 'relations'].includes(value.kind) ||
  (value.kind === 'option' && isFactoryData(value.payload ?? BAD, closed)) ||
  (value.kind === 'result' && !closed && isFactoryData(value.payload ?? BAD, closed) &&
    (value.failure?.kind === 'invariant-error' || isClosedData(value.failure ?? BAD))) ||
  (value.kind === 'array' && isFactoryData(value.element ?? BAD, closed)) ||
  (value.kind === 'record' &&
    (!closed || value.open !== true) &&
    (value.element === undefined || isFactoryData(value.element, closed)) &&
    [...(value.fields?.values() ?? [])].every((field) => isFactoryData(field, closed)));
const isClosedFactoryData = (value: Value): boolean => isFactoryData(value, true);
const isSqlChunk = (value: Value): boolean =>
  value.kind === 'data' ||
  ['sql', 'table', 'column'].includes(value.kind) ||
  (value.kind === 'array' && isSqlChunk(value.element ?? BAD));
// Module constants are shared, even when first resolved while inspecting a factory invocation.
const sharedMetadata = (value: Value): Value => {
  if (['policy', 'table', 'column-builder', 'constraint', 'index-builder', 'index'].includes(value.kind))
    return { ...value, fresh: false };
  if (value.kind === 'array')
    return { ...array(sharedMetadata(value.element ?? BAD), value.empty, value.items?.map(sharedMetadata)), open: value.open };
  if (value.kind === 'record')
    return { ...value, fields: new Map([...(value.fields ?? [])].map(([name, field]) => [name, sharedMetadata(field)])),
      element: value.element === undefined ? undefined : sharedMetadata(value.element) };
  return value;
};
// Json validation preserves object identity, including nonenumerable and symbol-keyed callbacks.
// A codec may contain JSON, but only closed inputs or fresh JSON parsing prove its output closed.
const isCodecData = (value: Value): boolean =>
  value.kind === 'json' ||
  value.kind === 'data' ||
  (value.kind === 'option' && isCodecData(value.payload ?? BAD)) ||
  (value.kind === 'array' && isCodecData(value.element ?? BAD)) ||
  (value.kind === 'record' &&
    value.open !== true &&
    (value.element === undefined || isCodecData(value.element)) &&
    [...(value.fields?.values() ?? [])].every(isCodecData));
// `Schema.toType` consumes already decoded native Option fields as well as
// ordinary DTO values. This does not grant metadata or executable values input
// status, and codecData still proves closure of the decoder's actual output.
const isCodecInput = (value: Value): boolean =>
  value.kind === 'data' ||
  (value.kind === 'option' && isCodecInput(value.payload ?? BAD)) ||
  (value.kind === 'array' && isCodecInput(value.element ?? BAD)) ||
  (value.kind === 'record' &&
    (value.element === undefined || isCodecInput(value.element)) &&
    [...(value.fields?.values() ?? [])].every(isCodecInput));
const closeCodecJson = (value: Value): Value =>
  value.kind === 'json'
    ? DATA
    : value.kind === 'record'
      ? record(
          new Map([...(value.fields ?? [])].map(([name, field]) => [name, closeCodecJson(field)])),
          value.open,
          value.element === undefined ? undefined : closeCodecJson(value.element),
          value.optionalFields,
          value.prototype,
        )
      : value.kind === 'array'
        ? array(closeCodecJson(value.element ?? BAD), value.empty)
        : value;
const codecData = (payload: Value, input: Value): Value => {
  if (payload.kind === 'option') return { kind: 'option', payload: codecData(payload.payload ?? BAD, input) };
  if (isData(payload)) return payload;
  if (isClosedData(input)) return closeCodecJson(payload);
  if (payload.kind === 'record' && input.kind === 'record') {
    const fields = new Map<FieldKey, Value>();
    for (const [name, field] of payload.fields ?? []) {
      const source = recordField(input, name);
      // An omitted optional JSON-bearing field has no value whose closure needs proving.
      // Do not confuse absence with an open/inherited property or skip a supplied payload.
      if (payload.optionalFields?.has(name) && source.kind === 'data' &&
        'literal' in source && source.literal === undefined) continue;
      fields.set(name, codecData(field, source));
    }
    let element: Value | undefined;
    if (payload.element !== undefined) {
      for (const [name, field] of input.fields ?? [])
        if (!fields.has(name)) fields.set(name, codecData(payload.element, field));
      if (input.element !== undefined) element = codecData(payload.element, input.element);
      else if (input.open) return BAD;
    }
    return record(fields, false, element);
  }
  if (payload.kind === 'array' && input.kind === 'array')
    return array(codecData(payload.element ?? BAD, input.element ?? BAD), input.empty);
  return BAD;
};
const openData = (value: Value): Value =>
  value.kind === 'record'
    ? record(
        new Map([...(value.fields ?? [])].map(([name, field]) => [name, openData(field)])),
        true,
        value.element === undefined ? undefined : openData(value.element),
        value.optionalFields,
      )
    : value.kind === 'array'
      ? { ...array(openData(value.element ?? BAD), value.empty), open: true }
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
  // Null contributes no own fields to a spread. A property access on that alternative can only
  // throw; it cannot supply a callable property or a foreign prototype. Keep the non-null shape.
  const present = values.filter((value) => !(value.kind === 'data' && 'literal' in value && value.literal === null));
  if (present.length > 0 && present.length < values.length && present.every((value) => value.kind === 'record'))
    return merge(present);
  if (values.every((value) => value.kind === 'option'))
    return { kind: 'option', payload: merge(values.map((value) => value.payload ?? BAD)) };
  if (values.every((value) => value.kind === 'record')) {
    const names = new Set(values.flatMap((value) => [...(value.fields?.keys() ?? [])]));
    return record(
      new Map([...names].map((name) => [name, merge(values.map((value) => ownRecordField(value, name)))])),
      values.some((value) => value.open),
      values.some((value) => value.element !== undefined)
        ? merge(values.map((value) => value.element ?? (value.open ? BAD : UNDEFINED)))
        : undefined,
      new Set(
        [...names].filter((name) =>
          values.some(
            (value) => !value.fields?.has(name) || value.optionalFields?.has(name),
          ),
        ),
      ),
      values.every((value) => value.prototype === values[0].prototype) ? values[0].prototype : undefined,
    );
  }
  if (values.some((value) => value.kind === 'sql') && values.every((value) =>
    value.kind === 'sql' || (value.kind === 'data' && 'literal' in value && value.literal === undefined)))
    return { kind: 'sql', optionalSql: values.some((value) => value.kind !== 'sql' || value.optionalSql === true) };
  if (['column', 'table', 'policy'].includes(values[0].kind) &&
    values.every((value) => value.kind === values[0].kind)) {
    const fields = merge(values.map((value) => record(value.fields ?? new Map())));
    return { kind: values[0].kind, fields: fields.fields, fresh: values.every((value) => value.fresh === true) };
  }
  if (values.every((value) => value.kind === 'schema'))
    return schema(merge(values.map((value) => value.payload ?? BAD)));
  if (values.every((value) => value.kind === 'array'))
    return { ...array(
      merge(values.filter((value) => !value.empty).map((value) => value.element ?? BAD)),
      values.every((value) => value.empty),
    ), open: values.some((value) => value.open === true) };
  if (values.every((value) => value.kind === 'data' && 'literal' in value && value.literal === values[0].literal))
    return values[0];
  const metadata = values.flatMap((value) => value.kind === 'metadata-union' ? value.items ?? [BAD] : [value]);
  const isMetadata = (value: Value): boolean =>
    ['policy', 'constraint', 'index', 'table', 'column', 'sequence', 'pg-schema', 'relations'].includes(value.kind);
  if (metadata.some(isMetadata) && metadata.every((value) => isMetadata(value) ||
    (value.kind === 'data' && 'literal' in value && value.literal === undefined)))
    return { kind: 'metadata-union', items: metadata };
  // Erasing heterogeneous shapes is safe only after their entire payload is known closed.
  return values.every(isClosedData) ? DATA : BAD;
};
const generalizeData = (value: Value): Value =>
  value.kind === 'record'
    ? record(
        new Map([...(value.fields ?? [])].map(([name, field]) => [name, generalizeData(field)])),
        value.open,
        value.element === undefined ? undefined : generalizeData(value.element),
        value.optionalFields,
        value.prototype,
      )
    : value.kind === 'array'
      ? { ...array(generalizeData(value.element ?? BAD), value.empty), open: value.open }
      : value.kind === 'data'
        ? { kind: 'data', native: value.native }
        : BAD;
const dataState = (value: Value, visited = new Set<Value>()): string => {
  if (visited.has(value)) return 'cycle';
  const next = new Set(visited).add(value);
  if (value.kind === 'record')
    return JSON.stringify([
      value.open,
      value.prototype,
      [...(value.optionalFields ?? [])],
      value.element === undefined ? null : dataState(value.element, next),
      [...(value.fields ?? [])].map(([name, field]) => [name, dataState(field, next)]),
    ]);
  if (value.kind === 'array') return `array:${value.empty}:${value.open}:${dataState(value.element ?? BAD, next)}`;
  return JSON.stringify([
    value.kind,
    value.native,
    value.fresh,
    value.optionalSql,
    [...(value.fields ?? [])].map(([name, field]) => [name, dataState(field, next)]),
    'literal' in value,
    typeof value.literal,
    String(value.literal),
    value.model?.filename,
    value.node?.start,
    [...(value.env ?? [])].map(([name, captured]) => [name, dataState(captured, next)]),
    value.payload === undefined ? null : dataState(value.payload, next),
    value.failure === undefined ? null : dataState(value.failure, next),
    value.items?.map((part) => dataState(part, next)),
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
  steps = 0;

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
            model.imports.set(specifier.local.name, {
              source: node.source.value,
              imported: key(specifier.imported)!,
              typeOnly: node.importKind === 'type' || specifier.importKind === 'type',
            });
          }
          continue;
        }
        const exported = node.type === 'ExportNamedDeclaration';
        if (exported) {
          if (node.source !== null) {
            for (const specifier of node.specifiers) {
              const local = `@reexport:${key(specifier.exported)}`;
              model.imports.set(local, {
                source: node.source.value,
                imported: key(specifier.local)!,
                typeOnly: node.exportKind === 'type' || specifier.exportKind === 'type',
              });
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
        } else if (node.type === 'TSExportAssignment') {
          model.values.set('@export=', node.expression);
          model.exports.set('export=', '@export=');
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
            'decodeUnknownResult',
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
            'isGreaterThanOrEqualTo',
            'isLessThanOrEqualTo',
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
      if (node.type === 'MemberExpression')
        return safe(node.object) && (!node.computed || safe(node.property)) &&
          this.expression(node, model, new Map()).kind !== 'bad';
      if (node.type === 'ObjectExpression')
        return node.properties.every((property: Node) =>
          property.type === 'SpreadElement' ? safe(property.argument) :
            property.kind === 'init' && (!property.computed || this.fieldKey(property, model, new Map()) !== undefined) &&
              safe(property.value),
        );
      if (node.type === 'ArrayExpression')
        return node.elements.every((element: Node | null) => element === null || safe(element));
      if (node.type === 'ClassDeclaration') {
        if (node.decorators?.length || (node.superClass !== null && !safe(node.superClass))) return false;
        for (const member of node.body.body) {
          if (member.decorators?.length || member.type === 'StaticBlock' || (member.computed && !safe(member.key))) return false;
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
    if (env.has(name)) return env.get(name)!;
    const id = `${model.filename}:${name}`;
    if (this.values.has(id)) return this.values.get(id)!;
    if (this.resolving.has(id)) return BAD;
    this.resolving.add(id);
    let result = BAD;
    const imported = model.imports.get(name);
    if (imported !== undefined && imported.typeOnly !== true) {
      if (imported.source === 'drizzle-orm' && ['sql', 'defineRelations'].includes(imported.imported))
        result = native(`drizzle:${imported.imported}`);
      else if (imported.source === 'drizzle-orm/pg-core' &&
        ['pgPolicy', 'pgTable', 'pgSchema', 'pgSequence', 'check', 'foreignKey', 'primaryKey', 'index', 'uniqueIndex',
          'text', 'uuid', 'integer', 'boolean', 'bigint', 'timestamp', 'jsonb'].includes(imported.imported))
        result = native(`drizzle:${imported.imported}`);
      else if (imported.source === 'effect' && ['Schema', 'SchemaGetter', 'DateTime', 'Predicate', 'Result', 'Option', 'Order'].includes(imported.imported)) {
        result = native(`effect:${imported.imported}`);
      } else if (imported.source === 'node:crypto' && imported.imported === 'createHash')
        result = native('crypto:createHash');
      else {
        const owner = this.imported(model, imported.source);
        const exported = owner?.exports.get(imported.imported);
        if (owner !== null && exported !== undefined) {
          if (this.safeInitialization(owner)) result = this.value(exported, owner, new Map());
        }
      }
    } else if (imported === undefined && model.values.has(name))
      result = sharedMetadata(this.expression(model.values.get(name)!, model, new Map()));
    else if (imported === undefined && name === 'undefined') result = UNDEFINED;
    else if (imported === undefined && ['Object', 'URL', 'Array', 'Symbol', 'Number', 'Error', 'TypeError', 'RangeError'].includes(name))
      result = native(`global:${name}`);
    this.resolving.delete(id);
    this.values.set(id, result);
    return result;
  }

  type(node: Node | undefined | null, model: Model, generics = new Map<string, Value>()): Value {
    if (node === undefined || node === null) return BAD;
    if (node.type === 'TSNumberKeyword') return NUMBER;
    if (node.type === 'TSNullKeyword') return { kind: 'data', literal: null };
    if (node.type === 'TSLiteralType') return this.expression(node.literal, model, new Map());
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
    if (node.type === 'TSUnionType')
      return merge(node.types.map((part: Node) => openData(this.type(part, model, generics))));
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
        name === 'Pick' ? typeof field === 'string' && selected.has(field) : typeof field !== 'string' || !selected.has(field),
      );
    }
    let owner = model;
    let declaration = model.types.get(name);
    const imported = model.imports.get(name);
    if (declaration === undefined && imported !== undefined) {
      const resolved = this.imported(model, imported.source);
      if (resolved === null) return BAD;
      owner = resolved;
      declaration = owner.types.get(owner.exports.get(imported.imported) ?? imported.imported);
    }
    if (declaration === undefined) return BAD;
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
    include: (name: FieldKey) => boolean,
  ): Value {
    if (node?.type === 'TSTypeReference') {
      const name = named(node.typeName);
      let owner = model;
      let declaration = name === undefined ? undefined : model.types.get(name);
      const imported = name === undefined ? undefined : model.imports.get(name);
      if (declaration === undefined && imported !== undefined) {
        const resolved = this.imported(model, imported.source);
        if (resolved === null) return BAD;
        owner = resolved;
        declaration = owner.types.get(owner.exports.get(imported.imported) ?? imported.imported);
      }
      if (declaration?.type === 'TSInterfaceDeclaration') {
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

  fieldKey(property: Node, model: Model, env: ReadonlyMap<string, Value>): FieldKey | undefined {
    if (!property.computed) return key(property.key);
    const value = this.expression(property.key, model, env);
    return value.kind === 'data' && (typeof value.literal === 'symbol' || typeof value.literal === 'string')
      ? value.literal : undefined;
  }

  typeFields(properties: readonly Node[], model: Model, generics: Map<string, Value>): Value {
    const fields = new Map<FieldKey, Value>();
    for (const property of properties) {
      const name = this.fieldKey(property, model, new Map());
      if (property.type !== 'TSPropertySignature' || name === undefined) return BAD;
      fields.set(name, this.type(property.typeAnnotation?.typeAnnotation, model, generics));
    }
    return record(fields);
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
      if (!isFactoryData(fallback)) return false;
      const defaulted =
        input.kind === 'data' && 'literal' in input && input.literal === undefined ? fallback : merge([input, fallback]);
      return this.bind(pattern.left, defaulted, model, env);
    }
    if (pattern.type === 'Identifier') {
      env.set(pattern.name, input);
      // Native sets may be queried locally, but are never a closed DTO result or factory input.
      return isFactoryData(input) || input.kind === 'set';
    }
    if (pattern.type === 'ArrayPattern') {
      if (input.kind !== 'array' || !isClosedFactoryData(input)) return false;
      for (const element of pattern.elements) {
        if (element !== null && !this.bind(element, input.element ?? BAD, model, env)) return false;
      }
      return true;
    }
    if (pattern.type !== 'ObjectPattern' || input.kind !== 'record') return false;
    for (const property of pattern.properties) {
      const name = key(property.key);
      if (property.type !== 'Property' || name === undefined || property.computed || property.kind !== 'init')
        return false;
      const field = recordField(input, name);
      if (!this.bind(property.value, field, model, env)) return false;
    }
    return true;
  }

  invoke(function_: Value, args: readonly Value[], inferParameters = false): Value {
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
        inputs[index] ?? (inferParameters
          ? annotation === undefined ? BAD : openData(this.type(annotation, model, generics))
          : UNDEFINED);
      if (!isFactoryData(input)) valid = false;
      if (!this.bind(parameter, input, model, env)) valid = false;
    }
    const result = valid
      ? node.body.type === 'BlockStatement'
        ? this.statements(node.body.body, model, env)
        : this.expression(node.body, model, env)
      : BAD;
    if (active === undefined) this.calls.delete(node);
    else this.calls.set(node, active);
    if (!isFactoryData(result)) {
      for (const call of this.validatedCalls) if (!previouslyValidated.has(call)) this.validatedCalls.delete(call);
    }
    return result;
  }

  statements(statements: readonly Node[], model: Model, env: Map<string, Value>): Value {
    const flow = this.statementReturns(statements, model, env);
    return flow === null ? BAD : merge([...flow.returns, ...(flow.fallsThrough ? [UNDEFINED] : [])]);
  }

  // A validation-only branch does not return a DTO. Keep its completion separate from actual
  // return values so a checked throw/freeze cannot erase the metadata provenance of a later return.
  statementReturns(
    statements: readonly Node[], model: Model, env: Map<string, Value>,
  ): { returns: Value[]; fallsThrough: boolean } | null {
    const returns: Value[] = [];
    let fallsThrough = true;
    for (const node of statements) {
      if (node.type === 'VariableDeclaration' && node.kind === 'const') {
        for (const declaration of node.declarations) {
          const value = this.expression(declaration.init, model, env);
          if (!this.bind(declaration.id, value, model, env)) return null;
        }
      } else if (node.type === 'ReturnStatement') {
        returns.push(node.argument === null ? UNDEFINED : this.expression(node.argument, model, env));
        fallsThrough = false;
      } else if (node.type === 'ThrowStatement') {
        const error = this.expression(node.argument, model, env);
        if (error.kind !== 'invariant-error' && !isClosedData(error)) return null;
        fallsThrough = false;
      } else if (node.type === 'ExpressionStatement') {
        if (!isFactoryData(this.expression(node.expression, model, env))) return null;
      } else if (node.type === 'IfStatement') {
        if (!isData(this.expression(node.test, model, env))) return null;
        let branchFallsThrough = false;
        for (const part of [node.consequent, node.alternate]) {
          if (part === null) { branchFallsThrough = true; continue; }
          const result = this.statementReturns(part.type === 'BlockStatement' ? part.body : [part], model, new Map(env));
          if (result === null) return null;
          returns.push(...result.returns);
          branchFallsThrough ||= result.fallsThrough;
        }
        fallsThrough &&= branchFallsThrough;
      } else if (node.type === 'BlockStatement') {
        const result = this.statementReturns(node.body, model, new Map(env));
        if (result === null) return null;
        returns.push(...result.returns);
        fallsThrough &&= result.fallsThrough;
      } else if (
        node.type === 'ForOfStatement' &&
        node.await !== true &&
        node.left.type === 'VariableDeclaration' &&
        node.left.kind === 'const'
      ) {
        const iterable = this.expression(node.right, model, env);
        if (iterable.kind !== 'array' || !isFactoryData(iterable)) return null;
        const loop = new Map(env);
        if (!this.bind(node.left.declarations[0].id, iterable.element ?? BAD, model, loop)) return null;
        const result = this.statementReturns(node.body.type === 'BlockStatement' ? node.body.body : [node.body], model, loop);
        if (result === null) return null;
        returns.push(...result.returns);
      } else return null;
    }
    return { returns, fallsThrough };
  }

  property(input: Value, name: FieldKey, model: Model): Value {
    const value = this.normalizeNative(input);
    if (value.kind === 'record') return recordField(value, name);
    if (typeof name !== 'string') return BAD;
    if (value.kind === 'result') return name === 'pipe' ? { ...native('result:pipe'), payload: value } : BAD;
    // A native Option can expose its checked payload. On None the concrete access
    // may lead to a rejected/throwing codec; it cannot introduce executable input.
    if (value.kind === 'option') return name === 'value' ? value.payload ?? BAD : BAD;
    if (value.kind === 'table')
      return name === 'enableRLS' && value.fresh === true
        ? { ...native('drizzle:table.enableRLS'), payload: value } : value.fields?.get(name) ?? BAD;
    if (['index-builder', 'index', 'constraint'].includes(value.kind))
      return value.fresh === true ? { ...native(`drizzle:${value.kind}.${name}`), payload: value } : BAD;
    if (value.kind === 'policy')
      return name === 'link' && value.fresh === true
        ? { ...native('drizzle:policy.link'), payload: value }
        : value.fields?.get(name) ?? BAD;
    if (value.kind === 'pg-schema')
      return name === 'table' ? native('drizzle:pgTable') : name === 'sequence' ? native('drizzle:pgSequence') : BAD;
    if (value.kind === 'column-builder')
      return value.fresh === true ? { ...native(`drizzle:column.${name}`), payload: value } : BAD;
    if (value.kind === 'set') return name === 'size' ? DATA : name === 'has' ? native('set:has') : BAD;
    if (value.kind === 'data' && value.native === 'regexp') return native(`regexp:${name}`);
    if (value.kind === 'schema') {
      if (name === 'Type') return value.payload ?? BAD;
      if (name === 'fields')
        return value.payload?.kind === 'record' && value.payload.element === undefined
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
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      // Empty subclasses inherit the verified native constructor. Any custom constructor,
      // initializer, decorator or method is executable behavior, not a data-only error.
      if (node.superClass === null || node.body.body.length !== 0 || node.decorators?.length) return BAD;
      const parent = this.expression(node.superClass, model, env);
      return parent.kind === 'error-constructor' ? parent : BAD;
    }
    if (node.type === 'Identifier') return this.value(node.name, model, env);
    if (node.type === 'Literal')
      return node.regex === undefined ? { kind: 'data', literal: node.value } : { kind: 'data', native: 'regexp' };
    if (node.type === 'TemplateLiteral')
      return node.expressions.every((part: Node) => isData(this.expression(part, model, env))) ? DATA : BAD;
    if (node.type === 'TaggedTemplateExpression') {
      const tag = this.expression(node.tag, model, env);
      return tag.kind === 'native' && tag.native === 'drizzle:sql' &&
        node.quasi.expressions.every((part: Node) => isSqlChunk(this.expression(part, model, env))) ? SQL : BAD;
    }
    if (node.type === 'ArrayExpression') {
      const elements: Value[] = [];
      let exact = true;
      for (const part of node.elements) {
        if (part === null) { elements.push(UNDEFINED); continue; }
        const value = this.expression(part.type === 'SpreadElement' ? part.argument : part, model, env);
        if (value.kind === 'bad') return BAD;
        if (part.type !== 'SpreadElement') elements.push(value);
        else {
          if (value.kind !== 'array' || !isFactoryData(value)) return BAD;
          if (value.items !== undefined) elements.push(...value.items);
          else { elements.push(value.element ?? BAD); exact = false; }
        }
      }
      return array(merge(elements), elements.length === 0, exact ? elements : undefined);
    }
    if (node.type === 'ObjectExpression') {
      const fields = new Map<FieldKey, Value>();
      const optionalFields = new Set<FieldKey>();
      let prototype: Value['prototype'] = 'object';
      let open = false;
      let element: Value | undefined;
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const value = this.expression(property.argument, model, env);
          if (value.kind !== 'record') return BAD;
          const previous = record(new Map(fields), open, element);
          const names = new Set([...fields.keys(), ...(value.fields?.keys() ?? [])]);
          for (const name of names) {
            // A spread may omit a key. Join its possible replacement with any earlier field,
            // dictionary entry, or open property rather than assuming a named field survives.
            const before = fields.has(name) || element !== undefined || open;
            const after = value.fields?.has(name) || value.element !== undefined || value.open;
            if (after)
              fields.set(
                name,
                before ? merge([ownRecordField(previous, name), ownRecordField(value, name)]) : ownRecordField(value, name),
              );
            const definiteBefore = previous.fields?.has(name) && !optionalFields.has(name);
            const definiteAfter = value.fields?.has(name) && !value.optionalFields?.has(name);
            if (definiteBefore || definiteAfter) optionalFields.delete(name);
            else optionalFields.add(name);
          }
          if (element !== undefined || value.element !== undefined)
            element = merge([
              element ?? (open ? BAD : UNDEFINED),
              value.element ?? (value.open ? BAD : UNDEFINED),
            ]);
          if (value.open) open = true;
        } else {
          const name = this.fieldKey(property, model, env);
          if (property.kind !== 'init' || property.method || name === undefined) return BAD;
          const value = this.expression(property.value, model, env);
          if (value.kind === 'bad') return BAD;
          // This object-literal syntax sets [[Prototype]], rather than creating an own field.
          // Arbitrary prototype graphs are outside the closed-data proof; null is fully known.
          if (name === '__proto__' && !property.shorthand && !property.computed) {
            if (value.kind !== 'data' || !('literal' in value) || value.literal !== null) return BAD;
            prototype = 'null';
            continue;
          }
          fields.set(name, value);
          optionalFields.delete(name);
        }
      }
      return record(fields, open, element, optionalFields, prototype);
    }
    if (node.type === 'MemberExpression') {
      const owner = this.expression(node.object, model, env);
      if (!node.computed) return this.property(owner, node.property.name, model);
      if (node.property.type === 'Literal' && typeof node.property.value === 'string')
        return this.property(owner, node.property.value, model);
      const index = this.expression(node.property, model, env);
      if (index.kind === 'data' && (typeof index.literal === 'symbol' || typeof index.literal === 'string'))
        return this.property(owner, index.literal, model);
      if (owner.kind === 'array' && index.kind === 'data' &&
        (index.native === 'number' || typeof index.literal === 'number'))
        return merge([owner.element ?? BAD, UNDEFINED]);
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
      return args.length === 0 || (args.length === 1 && args[0].kind === 'array' && isClosedData(args[0]))
        ? { kind: 'set' }
        : BAD;
    }
    if (node.type === 'NewExpression') {
      const constructor = this.expression(node.callee, model, env);
      const args: Value[] = node.arguments.map((part: Node) => this.expression(part, model, env));
      if (constructor.kind === 'native' &&
        ['global:Error', 'global:TypeError', 'global:RangeError'].includes(constructor.native ?? ''))
        return args.length <= 1 && args.every((argument) => argument.kind === 'data')
          ? { kind: 'invariant-error' } : BAD;
      if (constructor.kind === 'error-constructor' && args.length === 1 && args[0].kind === 'record' &&
        isClosedData(args[0]) && constructor.payload?.kind === 'record' &&
        [...(constructor.payload.fields ?? [])].every(([field, payload]) => payload.kind === 'bad' ||
          isClosedData(codecData(payload, ownRecordField(args[0], field)))))
        return { kind: 'invariant-error' };
      return BAD;
    }
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
      if (node.type === 'BinaryExpression' && ['+', '-', '*', '/', '%', '**'].includes(node.operator) &&
        [left, right].every((value) => value.native === 'number' || typeof value.literal === 'number')) return NUMBER;
      return node.type === 'LogicalExpression' ? merge([left, right]) : DATA;
    }
    if (node.type === 'UnaryExpression' && ['!', '-', '+', 'typeof', 'void'].includes(node.operator))
      return isData(this.expression(node.argument, model, env)) ? DATA : BAD;
    if (node.type !== 'CallExpression') return BAD;
    const callee = this.expression(node.callee, model, env);
    const args = node.arguments.map((argument: Node) => this.expression(argument, model, env));
    if (callee.kind === 'bad' || args.some((argument: Value) => argument.kind === 'bad')) return BAD;
    const result = callee.kind === 'native' ? this.nativeCall(callee, args) : this.invoke(callee, args);
    if (isFactoryData(result)) this.validatedCalls.add(node);
    return result;
  }

  nativeCall(callee: Value, args: readonly Value[]): Value {
    const name = callee.native ?? '';
    if (name === 'drizzle:sql.raw')
      return args.length === 1 && args[0].kind === 'data' ? SQL : BAD;
    if (name === 'drizzle:sql.join')
      return args.length >= 1 && args.length <= 2 && args[0].kind === 'array' && isSqlChunk(args[0]) &&
        (args.length === 1 || args[1].kind === 'sql') ? SQL : BAD;
    if (name === 'drizzle:pgPolicy') {
      const options = args[1];
      if (args.length !== 2 || args[0].kind !== 'data' || options.kind !== 'record' ||
        !isClosedFactoryData(options) || options.element !== undefined ||
        [...(options.fields?.keys() ?? [])].some((field) => typeof field !== 'string' || !['as', 'for', 'to', 'using', 'withCheck'].includes(field)))
        return BAD;
      const fields = new Map<FieldKey, Value>([['name', args[0]]]);
      for (const field of ['as', 'for', 'to', 'using', 'withCheck']) {
        const value = recordField(options, field);
        if (['using', 'withCheck'].includes(field)) {
          if (value.kind !== 'sql' && !(value.kind === 'data' && 'literal' in value && value.literal === undefined))
            return BAD;
        } else if (!isClosedData(value)) return BAD;
        fields.set(field, value);
      }
      return { kind: 'policy', fields, fresh: true };
    }
    if (name === 'drizzle:policy.link')
      return callee.payload?.kind === 'policy' && callee.payload.fresh === true &&
        args.length === 1 && args[0].kind === 'table' ? callee.payload : BAD;
    if (name === 'drizzle:pgSchema')
      return args.length === 1 && args[0].kind === 'data' ? { kind: 'pg-schema' } : BAD;
    if (name === 'drizzle:pgSequence')
      return args.length >= 1 && args.length <= 2 && args.every(isClosedData) ? { kind: 'sequence' } : BAD;
    if (name === 'drizzle:pgTable' || name === 'drizzle:pgTable.withRLS') {
      const columns = args[1];
      if (args.length < 2 || args.length > 3 || args[0].kind !== 'data' || columns.kind !== 'record' ||
        columns.open || columns.element !== undefined ||
        [...(columns.fields?.values() ?? [])].some((column) => column.kind !== 'column-builder' || column.fresh !== true)) return BAD;
      const table: Value = { kind: 'table', fresh: true,
        fields: new Map<FieldKey, Value>([...(columns.fields ?? [])].map(([field]) => [field, { kind: 'column' }])) };
      if (args.length === 3) {
        const config = this.invoke(args[2], [table]);
        const validConfig = (value: Value): boolean =>
          ['constraint', 'index', 'policy'].includes(value.kind) ||
          (value.kind === 'metadata-union' && (value.items ?? []).every(validConfig)) ||
          (value.kind === 'array' && (value.empty === true || validConfig(value.element ?? BAD)));
        if (!validConfig(config)) return BAD;
      }
      return table;
    }
    if (name === 'drizzle:table.enableRLS')
      return args.length === 0 && callee.payload?.fresh === true ? callee.payload : BAD;
    if (name === 'drizzle:check')
      return args.length === 2 && args[0].kind === 'data' && args[1].kind === 'sql'
        ? { kind: 'constraint', fresh: true } : BAD;
    if (name === 'drizzle:primaryKey' || name === 'drizzle:foreignKey') {
      const options = args[0];
      if (args.length !== 1 || options.kind !== 'record' || options.open || options.element !== undefined ||
        [...(options.fields?.keys() ?? [])].some((field) =>
          typeof field !== 'string' || !['columns', 'foreignColumns', 'name'].includes(field))) return BAD;
      for (const field of name === 'drizzle:foreignKey' ? ['columns', 'foreignColumns'] : ['columns']) {
        const columns = recordField(options, field);
        if (columns.kind !== 'array' || columns.element?.kind !== 'column') return BAD;
      }
      const label = recordField(options, 'name');
      return isClosedData(label) ? { kind: 'constraint', native: name, fresh: true } : BAD;
    }
    if (name === 'drizzle:constraint.onDelete' || name === 'drizzle:constraint.onUpdate')
      return callee.payload?.native === 'drizzle:foreignKey' && args.length === 1 && args[0].kind === 'data'
        ? callee.payload : BAD;
    if (name === 'drizzle:index' || name === 'drizzle:uniqueIndex')
      return args.length === 1 && args[0].kind === 'data' ? { kind: 'index-builder', fresh: true } : BAD;
    if (name === 'drizzle:index-builder.on')
      return args.length > 0 && args.every((value) => value.kind === 'column' || value.kind === 'sql')
        ? { kind: 'index', fresh: true } : BAD;
    if (name === 'drizzle:index.where')
      return args.length === 1 && args[0].kind === 'sql' ? callee.payload ?? BAD : BAD;
    if (name === 'drizzle:defineRelations') {
      const tables = args[0];
      // The actual graph declares no navigational relations. A callback API needs a separate
      // relation-helper proof rather than granting arbitrary methods on its context.
      return args.length === 1 && tables.kind === 'record' && !tables.open && tables.element === undefined &&
        [...(tables.fields?.values() ?? [])].every((table) => table.kind === 'table') ? { kind: 'relations' } : BAD;
    }
    if (/^drizzle:(text|uuid|integer|boolean|bigint|timestamp|jsonb)$/u.test(name))
      return args.length <= 2 && args.every(isClosedData) ? { kind: 'column-builder', fresh: true } : BAD;
    if (name.startsWith('drizzle:column.')) {
      const operation = name.slice('drizzle:column.'.length);
      if (operation === 'references') {
        const reference = args.length >= 1 && args.length <= 2 ? this.invoke(args[0], []) : BAD;
        return reference.kind === 'column' && (args.length === 1 || isClosedData(args[1])) ? callee.payload ?? BAD : BAD;
      }
      return (['notNull', 'primaryKey', 'unique', '$type', 'defaultNow', 'defaultRandom'].includes(operation) && args.length === 0) ||
        (operation === 'default' && args.length === 1 && (isClosedData(args[0]) || args[0].kind === 'sql'))
        ? callee.payload ?? BAD : BAD;
    }
    if (name === 'global:Symbol')
      return args.length <= 1 && args.every((value) => value.kind === 'data' && typeof value.literal === 'string')
        ? { kind: 'data', literal: Symbol(args[0]?.literal as string | undefined) } : BAD;
    if (name === 'global:Object.keys')
      return args.length === 1 && args[0].kind === 'record' && isClosedFactoryData(args[0]) ? array(DATA) : BAD;
    if (name === 'global:Object.hasOwn')
      return args.length === 2 && args[0].kind === 'record' && isClosedFactoryData(args[0]) && args[1].kind === 'data' ? DATA : BAD;
    if (name === 'global:Object.fromEntries') {
      const tuple = args[0]?.kind === 'array' ? args[0].element : undefined;
      const parts = tuple?.kind === 'array' ? tuple.items : undefined;
      if (args.length !== 1 || parts?.length !== 2 || parts[0].kind !== 'data' || !isClosedFactoryData(parts[1])) return BAD;
      const name = parts[0].literal;
      return typeof name === 'string' || typeof name === 'symbol'
        ? record(new Map([[name, parts[1]]]), false, undefined, undefined, 'object')
        : record(new Map(), false, parts[1], undefined, 'object');
    }
    if (name === 'global:Array.isArray')
      return args.length === 1 && isFactoryData(args[0]) ? DATA : BAD;
    if (name === 'set:has') return args.length === 1 && isClosedData(args[0]) ? DATA : BAD;
    if (name === 'global:Number')
      return args.length === 1 && args[0].kind === 'data' ? NUMBER : BAD;
    if (name === 'regexp:test' && args.every(isData)) return DATA;
    if (name === 'regexp:exec' && args.every(isData))
      return record(new Map([['groups', record(new Map(), false, DATA, undefined, 'null')]]));
    if (name === 'crypto:createHash') return args.every(isData) ? { kind: 'hash' } : BAD;
    if (['hash:update', 'hash:digest'].includes(name))
      return args.every(isData) ? (name === 'hash:digest' ? DATA : { kind: 'hash' }) : BAD;
    if (name === 'global:Object.freeze') return args.length === 1 && isFactoryData(args[0]) ? args[0] : BAD;
    if (name === 'global:Object.values')
      return args.length === 1 && args[0]?.kind === 'array' && args[0].open !== true && isClosedFactoryData(args[0])
        ? args[0]
        : args[0]?.kind === 'record' && args[0].open !== true
        ? array(
            merge([...(args[0].fields?.values() ?? []), ...(args[0].element === undefined ? [] : [args[0].element])]),
          )
        : args[0]?.kind === 'data'
          ? array(DATA)
          : BAD;
    if (name === 'global:URL.parse')
      return args.every(isData)
        ? record(
            new Map(
              ['hostname', 'protocol', 'username', 'password', 'search', 'hash', 'pathname', 'origin', 'port'].map((field) => [
                field,
                DATA,
              ]),
            ),
          )
        : BAD;
    if (name.startsWith('data:')) {
      const operation = name.slice(5);
      const owner = callee.payload ?? BAD;
      if (operation === 'replace' && owner.kind === 'data' && args.length === 2 && args.every(isClosedData)) return DATA;
      if (operation === 'split' && owner.kind === 'data' && args.every(isData)) return array(DATA);
      if (operation === 'slice' && isData(owner) && args.every(isData)) return owner;
      if (operation === 'flatMap' && owner.kind === 'array' && isFactoryData(owner) && args.length === 1) {
        const result = this.invoke(args[0], [owner.element ?? BAD, NUMBER, owner]);
        return result.kind === 'array' ? result : BAD;
      }
      if (operation === 'map' && owner.kind === 'array' && isFactoryData(owner) && args.length === 1)
        return array(this.invoke(args[0], [owner.element ?? BAD, NUMBER, owner]));
      if (operation === 'some' && owner.kind === 'array' && isFactoryData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, NUMBER, owner])) ? DATA : BAD;
      if (operation === 'every' && owner.kind === 'array' && isFactoryData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, NUMBER, owner])) ? DATA : BAD;
      if (operation === 'toSorted' && owner.kind === 'array')
        return owner.empty ||
          args.length === 0 ||
          (args.length === 1 && isData(this.invoke(args[0], [owner.element ?? BAD, owner.element ?? BAD])))
          ? owner
          : BAD;
      if (
        ['includes', 'endsWith', 'startsWith', 'repeat', 'replaceAll', 'localeCompare', 'isWellFormed'].includes(
          operation,
        ) &&
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
    if (name === 'effect:Option.getOrNull')
      return args.length === 1 && args[0].kind === 'option' && isClosedFactoryData(args[0].payload ?? BAD)
        ? merge([args[0].payload ?? BAD, { kind: 'data', literal: null }]) : BAD;
    if (name === 'effect:Option.isSome') return args.length === 1 && args[0].kind === 'option' ? DATA : BAD;
    if (name === 'effect:Option.contains') {
      const payload = args[0]?.payload, sought = args[1];
      // Default equality can invoke Equal/Hash protocols on objects. Admit only
      // the native string-codec case; arbitrary records and callbacks stay unknown.
      return args.length === 2 && args[0].kind === 'option' && payload?.kind === 'data' &&
        payload.native === 'string' && sought?.kind === 'data' &&
        (sought.native === 'string' || typeof sought.literal === 'string') ? DATA : BAD;
    }
    if (name === 'effect:DateTime.make' || name === 'effect:DateTime.makeUnsafe') {
      if (args.length !== 1 || args[0].kind !== 'data') return BAD;
      return name === 'effect:DateTime.make' ? { kind: 'option', payload: DATETIME } : DATETIME;
    }
    if (['effect:DateTime.formatIso', 'effect:DateTime.formatIsoDateUtc', 'effect:DateTime.toEpochMillis'].includes(name))
      return args.length === 1 && args[0].native === 'datetime'
        ? name === 'effect:DateTime.toEpochMillis' ? NUMBER : DATA : BAD;
    if (name === 'effect:DateTime.Order')
      return args.length === 2 && args.every((value) => value.native === 'datetime') ? NUMBER : BAD;
    if (name === 'effect:SchemaGetter.transform' && args.length === 1 &&
      ['function', 'native'].includes(args[0].kind))
      return { kind: 'getter', apply: (values) => args[0].kind === 'native'
        ? this.nativeCall(args[0], values) : this.invoke(args[0], values) };
    if (name === 'result:pipe') {
      let value = callee.payload ?? BAD;
      for (const transform of args) {
        if (transform.kind !== 'transform' || transform.apply === undefined) return BAD;
        value = transform.apply([value]);
      }
      return value;
    }
    if (name === 'effect:Result.mapError' && args.length === 1 && args[0].kind === 'function')
      return { kind: 'transform', apply: (values) => {
        const value = values[0];
        if (values.length !== 1 || value?.kind !== 'result') return BAD;
        const failure = this.invoke(args[0], [value.failure ?? BAD]);
        return failure.kind === 'invariant-error' || isClosedData(failure) ? { ...value, failure } : BAD;
      } };
    if (name === 'effect:Result.getOrThrow') {
      if (args.length === 1 && args[0].kind === 'result' && isFactoryData(args[0]) &&
        isClosedFactoryData(args[0].payload ?? BAD)) return args[0].payload ?? BAD;
      return BAD;
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
    if (operation === 'TaggedError' && args.length === 0)
      return {
        kind: 'function',
        apply: (values) => {
          const fields = values[1];
          if (values.length !== 2 || values[0].kind !== 'data' || fields.kind !== 'record' ||
            fields.open || fields.element !== undefined ||
            [...(fields.fields?.values() ?? [])].some((field) => field.kind !== 'schema'))
            return BAD;
          return { kind: 'error-constructor', payload: record(new Map(
            [...(fields.fields ?? [])].map(([field, value]) => [field, value.payload ?? BAD]),
          )) };
        },
      };
    if (operation === 'toType') return args.length === 1 && args[0].kind === 'schema' ? args[0] : BAD;
    if (['decodeUnknownSync', 'decodeUnknownResult', 'decodeResult', 'decodeSync', 'encodeSync', 'encodeResult'].includes(operation)) {
      const value = args[0];
      const payload = value?.payload ?? BAD;
      if (value?.kind !== 'schema' || !isCodecData(payload) || !args.slice(1).every(isData)) return BAD;
      return {
        kind: 'function',
        apply: (inputs) => {
          if (!inputs.every(isCodecInput)) return BAD;
          const result = codecData(payload, inputs[0] ?? BAD);
          if (!isClosedFactoryData(result)) return BAD;
          if (operation === 'decodeUnknownResult' || operation === 'decodeResult' || operation === 'encodeResult')
            return { kind: 'result', payload: operation === 'encodeResult' ? DATA : result, failure: DATA };
          return operation === 'encodeSync' ? DATA : result;
        },
      };
    }
    if (operation === 'Struct' && args.length === 1 && args[0]?.kind === 'record') {
      const fields = new Map<FieldKey, Value>();
      const optionalFields = new Set<FieldKey>();
      for (const [field, value] of args[0].fields ?? []) {
        if (value.kind !== 'schema') return BAD;
        fields.set(field, value.payload ?? BAD);
        if (value.optionalKey === true) optionalFields.add(field);
      }
      return schema(record(fields, false, undefined, optionalFields));
    }
    if (
      operation === 'Record' &&
      args.length === 2 &&
      args[0]?.kind === 'schema' &&
      isClosedData(args[0].payload ?? BAD) &&
      args[1]?.kind === 'schema' &&
      isCodecData(args[1].payload ?? BAD)
    )
      // The native decoder constructs a fresh ordinary object; openData drops this guarantee
      // for external values merely annotated with the schema's Type.
      return schema(record(new Map(), false, args[1].payload, undefined, 'object'));
    if (operation === 'Array' && args.length === 1 && args[0]?.kind === 'schema')
      return schema(array(args[0].payload ?? BAD));
    if (operation === 'Union' && args.length === 1 && args[0]?.kind === 'array') {
      const element = args[0].element;
      return element?.kind === 'schema' ? element : BAD;
    }
    if (operation === 'TemplateLiteral' && args.length === 1 && args[0]?.kind === 'array') {
      const parts = args[0].items;
      // Literal arrays may mix text with schemas; their merged element loses that distinction.
      return parts !== undefined &&
        parts.every((part) => (part.kind === 'schema' ? part.payload?.kind === 'data' : part.kind === 'data'))
        ? schema(DATA)
        : BAD;
    }
    if (operation === 'Literal' && args.length === 1 && isData(args[0])) return schema(args[0]);
    if (operation === 'Literals' && args.every(isData)) return schema(DATA);
    if (operation === 'OptionFromNullOr' && args.length === 1 && args[0].kind === 'schema')
      return schema({ kind: 'option', payload: args[0].payload ?? BAD });
    if (operation === 'optionalKey' && args.length === 1 && args[0].kind === 'schema')
      return { ...args[0], optionalKey: true };
    if (
      ['fromJsonString', 'NullOr', 'UndefinedOr'].includes(operation) &&
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
        'isGreaterThanOrEqualTo',
        'isLessThanOrEqualTo',
        'isBetween',
        'isFinite',
        'isTrimmed',
        'isUUID',
      ].includes(operation) &&
      args.every(isData)
    )
      return { kind: 'transform', apply: (values) => (values[0]?.kind === 'schema' ? values[0] : BAD) };
    if (operation === 'decodeTo' && args.length === 1 && args[0]?.kind === 'schema')
      return { kind: 'transform', apply: (values) => (values[0]?.kind === 'schema' ? args[0] : BAD) };
    if (operation === 'decodeTo' && args.length === 2 && args[0]?.kind === 'schema' &&
      args[1]?.kind === 'record' && !args[1].open && args[1].element === undefined &&
      args[1].fields?.size === 2) {
      const decode = args[1].fields.get('decode'), encode = args[1].fields.get('encode');
      if (decode?.kind !== 'getter' || encode?.kind !== 'getter') return BAD;
      return { kind: 'transform', apply: (values) => {
        const source = values[0];
        if (values.length !== 1 || source?.kind !== 'schema' ||
          !isCodecData(source.payload ?? BAD) || !isCodecData(args[0].payload ?? BAD)) return BAD;
        // Both callbacks run through the interpreter with actual codec payloads.
        // Schema target annotations alone cannot hide dependency calls or callbacks.
        const decoded = decode.apply?.([source.payload ?? BAD]) ?? BAD;
        const encoded = encode.apply?.([args[0].payload ?? BAD]) ?? BAD;
        return isCodecData(decoded) && isCodecData(encoded) ? args[0] : BAD;
      } };
    }
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

  normalizeNative(value: Value): Value {
    if (value.kind !== 'native') return value;
    const name = value.native ?? '';
    // Resolve the intrinsic's immutable numeric field, never a similarly named local object.
    if (name === 'global:Number.MAX_SAFE_INTEGER')
      return { kind: 'data', native: 'number', literal: Number.MAX_SAFE_INTEGER };
    if (name === 'effect:Schema.Unknown') return schema(BAD);
    if (name === 'effect:Schema.Json') return schema({ kind: 'json' });
    if (/^effect:Schema\.DateTimeUtc(?:FromString)?$/u.test(name)) return schema(DATETIME);
    if (/^effect:Schema\.(String|Trim|NonEmptyString)$/u.test(name)) return schema({ kind: 'data', native: 'string' });
    if (/^effect:Schema\.(Number|Int|Finite|Boolean|BigInt|Undefined|Null|Never)$/u.test(name))
      return schema(DATA);
    if (name === 'effect:Order.String' || name === 'effect:Order.Number')
      return { kind: 'function', apply: (args) => (args.every(isData) ? DATA : BAD) };
    return value;
  }
}

/** Prove closed DTO/native metadata construction; opaque generics require checked call sites. */
export function provesDataFactoryImport(filename: string, source: string, importedName: string): boolean {
  const proof = new DataFactoryProof();
  const consumer = proof.load(filename);
  if (consumer === null) return false;
  const owner = proof.imported(consumer, source);
  const exported = owner?.exports.get(importedName);
  if (owner === null || exported === undefined || !proof.safeInitialization(owner)) return false;
  const target = proof.value(exported, owner, new Map());
  if (target.kind !== 'function' || target.node === undefined) return false;
  const direct = proof.invoke(target, [], true);
  if (isClosedFactoryData(direct)) return true;
  // A generic factory is checked with arguments propagated from each owning data factory. Any
  // escaped reference or unchecked use invalidates contextual admission.
  for (const local of consumer.exports.values()) {
    const candidate = proof.value(local, consumer, new Map());
    if (candidate.kind !== 'function') continue;
    const before = new Set(proof.validatedCalls);
    if (isClosedFactoryData(proof.invoke(candidate, [], true))) continue;
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
