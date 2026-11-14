import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { parseSync } from 'oxc-parser';

// The proof models closed data construction, not total mathematical purity: native codecs may
// reject malformed data and Object.freeze may freeze a data graph. Neither supplies executable
// behavior or an environmental dependency. Unknown operations and executable payloads fail closed.
type Node = Record<string, any>;
export interface PublicDataCodecContext {
  readonly filename: string;
  readonly ownerPath: string;
  readonly sources: ReadonlyMap<string, string>;
  /** Native allocation/initialization only; this never supplies callable-body authority. */
  readonly isImmutableContractSource: (filename: string, exportedName?: string) => boolean;
}

/** Parsed initialization provenance only; this is not row-decoder or runtime authority. */
export interface NativeColumnInitializationEvidence {
  readonly scope: 'initialization-only';
  readonly filename: string;
  readonly source: string;
  readonly program: Node;
  readonly tableLocalName: string;
  readonly tableDeclaration: Node;
  readonly tableInitializer: Node;
  readonly tableCall: Node;
  readonly field: string;
  readonly builder: Node;
  readonly nativeRoot: {
    readonly kind: string;
    readonly argumentCount: number;
    readonly localName: string;
    readonly call: Node;
    readonly captures: ReadonlyMap<string, Node>;
  };
  readonly builderMethods: readonly { readonly name: string; readonly argumentCount: number; readonly call: Node; readonly captures: ReadonlyMap<string, Node> }[];
  readonly factoryCalls: readonly { readonly call: Node; readonly declaration: Node; readonly captures: ReadonlyMap<string, Node> }[];
}

interface NativeColumnTrace {
  root: NativeColumnInitializationEvidence['nativeRoot'] | null;
  readonly methods: { readonly name: string; readonly argumentCount: number; readonly call: Node; readonly captures: ReadonlyMap<string, Node> }[];
  readonly factories: { readonly call: Node; readonly declaration: Node; readonly captures: ReadonlyMap<string, Node> }[];
}

interface Model {
  readonly filename: string;
  readonly imports: Map<string, { source: string; imported: string; typeOnly?: boolean }>;
  readonly values: Map<string, Node>;
  /** Static object bindings retain their complete initializer so its work is proved before projection. */
  readonly projections: Map<string, string>;
  readonly types: Map<string, Node>;
  readonly exports: Map<string, string>;
  readonly program: Node;
  readonly executableInitialization: boolean;
}
interface Value {
  readonly metadataTaint?: boolean;
  readonly opaqueMetadata?: boolean;
  readonly possiblyAbsent?: boolean;
  readonly astTag?: string;
  readonly astOpaque?: boolean;
  readonly defaultEquivalenceKind?: 'string' | 'literal' | 'struct';
  readonly defaultEquivalenceOptional?: boolean;
  readonly defaultEquivalenceChecks?: readonly string[];
  readonly astChecks?: readonly Value[];
  readonly astElement?: Value;
  readonly astMembers?: readonly Value[];
  readonly astRequiredElement?: boolean;
  readonly astFields?: ReadonlyMap<string, Value>;
  readonly reflectionSource?: Value;
  readonly schemaAst?: Value;
  readonly metadataEntries?: ReadonlyMap<Value, Value>;
  readonly ownDescriptors?: ReadonlyMap<string, Value>;
  readonly kind:
    | 'bad'
    | 'metadata'
    | 'data'
    | 'array'
    | 'record'
    | 'schema'
    | 'function'
    | 'native'
    | 'transform'
    | 'hash'
    | 'codec-effect'
    | 'getter'
    | 'matcher'
    | 'weakset';
  readonly fields?: ReadonlyMap<string, Value>;
  readonly element?: Value;
  readonly empty?: boolean;
  readonly open?: boolean;
  readonly payload?: Value;
  readonly encoded?: Value;
  readonly node?: Node;
  readonly model?: Model;
  readonly env?: ReadonlyMap<string, Value>;
  readonly native?: string;
  readonly apply?: (args: readonly Value[]) => Value;
  readonly literal?: unknown;
  readonly arrayOwner?: symbol;
  readonly wire?: boolean;
  readonly wireBoundary?: boolean;
  readonly failureOnly?: boolean;
  readonly truthyWire?: boolean;
  readonly falsyWire?: boolean;
  readonly inputOrigin?: symbol;
  /** A finite erased Pick of modeled primitive fields; its runtime record remains open. */
  readonly projectionData?: boolean;
  /** Own properties excluded by an actual rest projection, including on an open record. */
  readonly omittedFields?: ReadonlySet<string>;
  readonly validationInputs?: readonly Value[];
  /**
   * `true`: data a native String/Trim/NonEmptyString schema or a closed template literal decodes to, and combinators
   * that keep the decoded value (brand, filters, decodeTo onto such a target, a one-member Union, fromJsonString)
   * carry it unchanged. `false`: a nullable or optional wrapper may yield null or undefined, which vetoes any string
   * evidence, a string literal included. Only `isClosedString` reads it.
   */
  readonly stringData?: boolean;
}
type Completion = 'bad' | 'falls' | 'returns';
/** Closed string data: a string literal, or data a native string schema or closed template literal produced. */
const isClosedString = (value: Value): boolean =>
  !metadataOnly(value) && value.kind === 'data' && value.stringData !== false &&
  (value.stringData === true || ('literal' in value && typeof value.literal === 'string'));
/** The same data without string evidence: a nullable or optional wrapper may yield null or undefined instead. */
const possiblyAbsentString = (value: Value | undefined): Value | undefined =>
  value !== undefined && isClosedString(value) ? { ...value, stringData: false } : value;
/** A schema whose decoded and encoded values are both closed strings. */
const isClosedStringSchema = (value: Value): boolean =>
  value.kind === 'schema' && isClosedString(value.payload ?? BAD) && isClosedString(value.encoded ?? value.payload ?? BAD);
const isFactoryResult = (value: Value): boolean =>
  isClosedData(value) || (value.kind === 'codec-effect' && isClosedData(value.payload ?? BAD));
const BAD: Value = { kind: 'bad' };
const DATA: Value = { kind: 'data' };
/** A `let` local: it only ever holds closed data and every read sees opaque data, never a literal. */
const MUTABLE: Value = { kind: 'data', native: 'mutable' };
const array = (element: Value, empty = false): Value => ({ kind: 'array', element, empty });
const record = (fields: ReadonlyMap<string, Value>, open = false): Value => ({ kind: 'record', fields, open });
const schema = (payload: Value, encoded: Value = payload): Value => ({ kind: 'schema', payload, encoded });
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
const metadataOnly = (value: Value): boolean => value.metadataTaint === true || ['schema-filter-callback', 'schema-ast', 'native-schema-prototype', 'native-schema-copy', 'descriptor-map', 'own-descriptor', 'opaque-schema-descriptor', 'opaque-native-metadata', 'schema-object-prototype'].includes(value.native ?? '');
const isData = (value: Value): boolean => !metadataOnly(value) && (
  value.kind === 'data' ||
  (value.kind === 'array' && isData(value.element ?? BAD)) ||
  (value.kind === 'record' && [...(value.fields?.values() ?? [])].every(isData) && (value.element === undefined || isData(value.element))));
const isClosedData = (value: Value): boolean => !metadataOnly(value) && (
  value.kind === 'data' ||
  (value.kind === 'array' && isClosedData(value.element ?? BAD)) ||
  (value.kind === 'record' && value.open !== true && [...(value.fields?.values() ?? [])].every(isClosedData) && (value.element === undefined || isClosedData(value.element))));
const openData = (value: Value): Value =>
  value.kind === 'record'
    ? { ...record(new Map([...(value.fields ?? [])].map(([name, field]) => [name, openData(field)])), true), ...(value.projectionData === true ? { projectionData: true } : {}) }
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
const mergeBase = (values: readonly Value[]): Value => {
  if (values.length === 0) return DATA;
  if (values.length === 1) return values[0];
  if (values.some((value) => value.kind === 'bad')) return BAD;
  if (values.every((value) => value.kind === 'data') && values.some(metadataOnly)) return { kind: 'data', metadataTaint: true, ...(values.every((value) => 'literal' in value && value.literal === values[0].literal) ? { literal: values[0].literal } : {}) };
  if (values.every((value) => value.kind === 'native' && metadataOnly(value) && value.native === values[0].native)) return values[0];
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
    if (values.some(metadataOnly)) return { ...merged, ...(shared === undefined ? {} : { native: shared }), metadataTaint: true };
    if (shared === undefined) return merged;
    return shared === 'set' || shared === 'map'
      ? { ...merged, native: shared, payload: merge(values.map((value) => value.payload ?? BAD)) }
      : { ...merged, native: shared };
  }
  if (values.every((value) => value.kind === 'codec-effect'))
    return { kind: 'codec-effect', payload: merge(values.map((value) => value.payload ?? BAD)) };
  if (values.every((value) => value.kind === 'schema'))
    return schema(
      merge(values.map((value) => value.payload ?? BAD)),
      merge(values.map((value) => value.encoded ?? value.payload ?? BAD)),
    );
  if (values.every((value) => value.kind === 'array')) {
    const keys = [...(values[0].fields?.keys() ?? [])];
    const positional =
      keys.length > 0 &&
      values.every((value) => value.fields?.size === keys.length && keys.every((key) => value.fields?.has(key)));
    return {
      ...(values.some(metadataOnly) ? { metadataTaint: true } : {}),
      ...array(
        merge(values.filter((value) => !value.empty).map((value) => value.element ?? BAD)),
        values.every((value) => value.empty),
      ),
      ...(positional
        ? { fields: new Map(keys.map((key) => [key, merge(values.map((value) => value.fields?.get(key) ?? BAD))])) }
        : {}),
    };
  }
  if (values.every((value) => value.kind === 'data' && 'literal' in value && value.literal === values[0].literal))
    return values[0];
  if (
    values.every(isClosedData) &&
    values.some((value) => value.kind === 'record') &&
    values.every((value) => value.kind === 'record' || value.kind === 'data')
  ) {
    const records = values.filter((value) => value.kind === 'record');
    const shape = merge(records);
    return { ...shape, native: 'union-data' };
  }
  // Erasing heterogeneous shapes is safe only after their entire payload is known closed.
  return values.every(isClosedData) ? DATA : BAD;
};
const hasStaticWire = (value: Value, depth = 0): boolean => depth < 64 && (value.wire === true ||
  [...(value.fields?.values() ?? []), ...(value.element === undefined ? [] : [value.element]),
    ...(value.payload === undefined ? [] : [value.payload])].some((child) => hasStaticWire(child, depth + 1)));
const merge = (values: readonly Value[]): Value => {
  const merged = mergeBase(values);
  const opaque = values.some((value) => value.opaqueMetadata === true) ? { ...merged, opaqueMetadata: true } : merged;
  const result = values.some((value) => value.possiblyAbsent === true) ? { ...opaque, possiblyAbsent: true } : opaque;
  return values.some((value) => hasStaticWire(value)) ? { ...result, wire: true } : result;
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
      value.projectionData,
      [...(value.omittedFields ?? [])],
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
  readonly initializationFactoryCallees = new Set<Node>();
  initializationColumnEvidence = false;
  readonly publicCodecs: boolean;

  readonly context: PublicDataCodecContext | undefined;
  readonly schemaExpansionPackages = new Set<string>();
  readonly importedExports = new Map<string, string>();
  readonly validatedInputs = new Set<symbol>();
  readonly metadataArgumentCache = new Map<Node, boolean>();
  readonly metadataAliasCache = new Map<Node, boolean>();
  metadataSteps = 0;
  erasedSchemaTypes = false;
  strictSchemaExports = false;
  defaultStructEquivalence = false;
  coreHashDepth = 0;
  initializationDepth = 0;
  readonly initializationBindingFacts = new Map<string, boolean>();
  readonly nativeMetadataFields = new Map<string, ReadonlySet<string>>();
  readonly initializationMemberFacts = new Map<Node, Map<string, boolean>>();
  readonly custodyFunctions = new Set<Node>();
  readonly capturedValues = new Map<Model, Set<string>>();
  constructor(publicCodecs = false, context?: PublicDataCodecContext) {
    this.publicCodecs = publicCodecs;
    this.context = context;
  }

  readonly models = new Map<string, Model | null>();
  readonly resolving = new Set<string>();
  readonly typeResolving = new Set<string>();
  readonly calls = new Map<Node, readonly string[]>();
  readonly validatedCalls = new Set<Node>();
  readonly validatedReflectionWrites = new Set<Node>();
  readonly values = new Map<string, Value>();
  readonly initialized = new Map<string, boolean>();
  readonly initializing = new Set<string>();
  readonly arrayStates = new Map<Value, Value>();
  readonly invocations: { readonly node: Node; readonly model: Model; readonly token: symbol }[] = [];
  steps = 0;

  metadataProjection(source: Value, result: Value): Value {
    return this.strictSchemaExports && metadataOnly(source) && result.kind !== 'schema' && result.kind !== 'bad' ? { ...result, metadataTaint: true, ...(source.opaqueMetadata === true ? { opaqueMetadata: true } : {}), ...(source.possiblyAbsent === true ? { possiblyAbsent: true } : {}) } : result;
  }

  controlData(value: Value): boolean {
    return isData(value) || this.strictSchemaExports && metadataOnly(value) && value.kind === 'data';
  }

  hasWire(value: Value, depth = 0): boolean {
    if (value.wireBoundary !== undefined) return value.wireBoundary;
    return depth < 64 && (value.wire === true ||
      (value.inputOrigin !== undefined && this.validatedInputs.has(value.inputOrigin)) ||
      [...(value.fields?.values() ?? []), ...(value.element === undefined ? [] : [value.element]),
        ...(value.payload === undefined ? [] : [value.payload])].some((child) => this.hasWire(child, depth + 1)));
  }

  wired(value: Value, depth = 0): Value {
    if (depth >= 64 || value.kind === 'bad') return BAD;
    return { ...value, wire: true, wireBoundary: true,
      ...(value.fields === undefined ? {} : { fields: new Map([...value.fields].map(([key, child]) => [key, this.wired(child, depth + 1)])) }),
      ...(value.element === undefined ? {} : { element: this.wired(value.element, depth + 1) }),
      ...(value.payload === undefined ? {} : { payload: this.wired(value.payload, depth + 1) }) };
  }

  generalizeCodecData(value: Value): Value {
    if (value.kind === 'array' || value.kind === 'record') return { ...value,
      ...(value.fields === undefined ? {} : { fields: new Map([...value.fields].map(([key, child]) => [key, this.generalizeCodecData(child)])) }),
      ...(value.element === undefined ? {} : { element: this.generalizeCodecData(value.element) }) };
    return value.kind === 'data' ? { kind: 'data', native: value.native, wire: value.wire, inputOrigin: value.inputOrigin } : this.coreHashDepth > 0 && ['weakset', 'function'].includes(value.kind) ? value : BAD;
  }

  arrayState(value: Value): Value {
    let current = value;
    while (this.arrayStates.has(current)) current = this.arrayStates.get(current)!;
    return current;
  }

  containsIdentity(input: Value, target: Value, seen = new Set<Value>(), depth = 0): boolean {
    const value = this.arrayState(input);
    if (value === target || depth >= 64) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return [
      ...(value.fields?.values() ?? []),
      ...(value.element === undefined ? [] : [value.element]),
      ...(value.payload === undefined ? [] : [value.payload]),
    ].some((child) => this.containsIdentity(child, target, seen, depth + 1));
  }

  transferFreshOwners(input: Value, from: symbol, to: symbol, seen = new Map<Value, Value>(), depth = 0): Value {
    const value = this.arrayState(input);
    if (depth >= 64) return BAD;
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const next = { ...value };
    seen.set(value, next);
    if (next.arrayOwner === from && next.native === 'map') Object.assign(next, { arrayOwner: to });
    if (value.fields !== undefined)
      Object.assign(next, {
        fields: new Map(
          [...value.fields].map(([key, child]) => [key, this.transferFreshOwners(child, from, to, seen, depth + 1)]),
        ),
      });
    if (value.element !== undefined)
      Object.assign(next, { element: this.transferFreshOwners(value.element, from, to, seen, depth + 1) });
    if (value.payload !== undefined)
      Object.assign(next, { payload: this.transferFreshOwners(value.payload, from, to, seen, depth + 1) });
    return next;
  }

  load(filename: string, source?: string): Model | null {
    if (this.models.has(filename)) return this.models.get(filename) ?? null;
    if (this.publicCodecs && this.models.size >= 128) return null;
    this.models.set(filename, null);
    try {
      const text = source ?? this.context?.sources.get(filename) ?? (this.publicCodecs ? undefined : readFileSync(filename, 'utf8'));
      if (text === undefined) return null;
      const parsed = parseSync(filename, text, { sourceType: 'module' });
      if (parsed.errors.length !== 0) return null;
      let executableInitialization = false;
      const model: Model = {
        filename,
        executableInitialization: false,
        imports: new Map(),
        values: new Map(),
        projections: new Map(),
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
        if (node.type === 'ExportAllDeclaration') {
          if (node.exportKind === 'type') continue;
          if (node.exported !== null && node.exported !== undefined) return null;
          const owner = this.imported(model, node.source.value);
          if (owner === null) return null;
          for (const name of owner.exports.keys()) {
            if (name === 'default') continue;
            if (model.exports.has(name)) {
              const identity = this.exportIdentity(owner, name);
              if (identity === null || this.exportIdentity(model, name) !== identity) return null;
              continue;
            }
            const local = `@reexport:${name}`;
            model.imports.set(local, { source: node.source.value, imported: name });
            model.exports.set(name, local);
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
            if (declaration.init === null) return null;
            const bindings =
              declaration.id.type === 'ObjectPattern'
                ? declaration.id.properties.map((property: Node) => {
                    const staticProperty =
                      property.type === 'Property' && !property.computed && property.kind === 'init';
                    return {
                      name: staticProperty ? named(property.value) : undefined,
                      property: staticProperty ? key(property.key) : undefined,
                    };
                  })
                : [{ name: named(declaration.id), property: undefined }];
            for (const binding of bindings) {
              if (
                binding.name === undefined ||
                model.values.has(binding.name) ||
                (declaration.id.type === 'ObjectPattern' && binding.property === undefined)
              )
                return null;
              model.values.set(binding.name, declaration.init);
              if (binding.property !== undefined) model.projections.set(binding.name, binding.property);
              if (exported) model.exports.set(binding.name, binding.name);
            }
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
            'TemplateLiteral',
            'Json',
            'fromJsonString',
            ...(this.publicCodecs ? ['suspend'] : []),
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
    const configMember = (input: Node, name: string): boolean => {
      const member = unwrap(input);
      if (
        member.type !== 'MemberExpression' ||
        member.computed ||
        member.optional ||
        member.property.name !== name ||
        member.object.type !== 'Identifier'
      )
        return false;
      const imported = model.imports.get(member.object.name);
      return imported?.source === 'effect' && imported.imported === 'Config' && !model.values.has(member.object.name);
    };
    const defaultConfig = (input: Node): boolean => {
      const node = unwrap(input);
      return (
        node.type === 'CallExpression' &&
        !node.optional &&
        configMember(node.callee, 'withDefault') &&
        node.arguments.length === 1 &&
        isClosedData(this.expression(node.arguments[0], model, new Map()))
      );
    };
    const configDescription = (input: Node): boolean => {
      const node = unwrap(input);
      if (node.type !== 'CallExpression' || node.optional) return false;
      if (configMember(node.callee, 'schema'))
        return (
          node.arguments.length === 2 &&
          this.expression(node.arguments[0], model, new Map()).kind === 'schema' &&
          isClosedData(this.expression(node.arguments[1], model, new Map()))
        );
      const member = unwrap(node.callee);
      return (
        member.type === 'MemberExpression' &&
        !member.computed &&
        !member.optional &&
        member.property.name === 'pipe' &&
        configDescription(member.object) &&
        node.arguments.every(defaultConfig)
      );
    };
    const safe = (input: Node): boolean => {
      const node = unwrap(input);
      if (this.publicCodecs && this.context !== undefined &&
        ((this.nativeMetadataAllocation(node, model) && this.safeMetadataArguments(node, model)) ||
          (['Identifier', 'MemberExpression'].includes(node.type) && this.metadataAlias(node, model))) &&
        this.context.isImmutableContractSource(model.filename, this.importedExports.get(model.filename))) return true;
      if (this.strictSchemaExports && ((this.nativeMetadataAllocation(node, model) && this.safeMetadataArguments(node, model)) || node.type === 'Identifier' && this.metadataAlias(node, model))) return true;
      if (configDescription(node)) return true;
      if (fnNode(node) || node.type === 'Literal') return true;
      if (node.type === 'Identifier' && this.publicCodecs)
        return this.expression(node, model, new Map()).kind !== 'bad';
      if (node.type === 'Identifier') return true;
      if (node.type === 'MemberExpression' && this.publicCodecs)
        return this.expression(node, model, new Map()).kind !== 'bad';
      if (node.type === 'MemberExpression') return safe(node.object) && (!node.computed || safe(node.property));
      if (node.type === 'ObjectExpression')
        return node.properties.every((property: Node) =>
          property.type === 'SpreadElement' ? safe(property.argument) :
            (!property.computed || this.publicCodecs && ['string', 'number'].includes(typeof this.expression(property.key, model, new Map()).literal)) &&
            (!this.publicCodecs || (property.kind === 'init' && !property.method)) && safe(property.value),
        );
      if (node.type === 'ArrayExpression')
        return node.elements.every((element: Node | null) => element === null || safe(this.publicCodecs && element.type === 'SpreadElement' ? element.argument : element));
      if (node.type === 'ClassDeclaration') {
        if (this.strictSchemaExports && (this.schemaMiddlewareClass(node, model) || this.schemaContextDescriptionClass(node, model))) return true;
        if (this.publicCodecs && (node.decorators?.length ?? 0) > 0) return false;
        if (node.superClass !== null && !safe(node.superClass)) return false;
        for (const member of node.body.body) {
          if (member.type === 'StaticBlock' || (this.publicCodecs && (member.decorators?.length ?? 0) > 0) || (member.computed && !safe(member.key))) return false;
          if (member.static && member.value !== null && member.value !== undefined && !safe(member.value)) return false;
        }
        return true;
      }
      if (node.type === 'CallExpression') {
        const origin = deferredOrigin(node);
        const callee = unwrap(node.callee);
        if (this.publicCodecs && origin === 'deferred-effect') return this.codecFunctionSyntax(node, model);
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
    this.initializationDepth += 1;
    this.initializing.add(model.filename);
    const result = [...model.values.values()].every(safe);
    this.initializing.delete(model.filename);
    this.initializationDepth -= 1;
    if (this.publicCodecs && this.context !== undefined)
      for (const id of this.values.keys()) if (id.startsWith(`${model.filename}:`)) this.values.delete(id);
    this.initialized.set(model.filename, result);
    return result;
  }

  metadataAlias(input: Node, model: Model, seen = new Set<Node>()): boolean {
    const known = this.metadataAliasCache.get(input);
    if (known !== undefined) return known;
    this.metadataAliasCache.set(input, false);
    const result = this.metadataAliasInner(input, model, seen);
    this.metadataAliasCache.set(input, result);
    return result;
  }

  metadataAliasInner(input: Node, model: Model, seen = new Set<Node>()): boolean {
    const node = unwrap(input);
    if (++this.metadataSteps > 100_000 || seen.size > 128 || seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'Identifier') {
      const own = model.values.get(node.name);
      if (own !== undefined) return this.safeMetadataArguments(own, model, new Set(seen));
      const imported = model.imports.get(node.name);
      if (imported === undefined || imported.typeOnly) return false;
      if (imported.source === 'effect') return ['Schema', 'SchemaGetter', 'Brand', 'DateTime', 'Option', 'Result', 'Predicate', 'Struct', 'Effect', 'Match', 'identity'].includes(imported.imported);
      if (imported.source === '@modern-js/bff-effect/effect-client') return ['Schema', 'HttpApi', 'HttpApiGroup', 'HttpApiEndpoint'].includes(imported.imported);
      if (imported.source === '@modern-js/bff-effect/microvertical-api') return ['MicroVerticalBuildMarkerSchema', 'MicroVerticalReadinessSchema'].includes(imported.imported);
      if (imported.source === 'effect/encoding') return ['Hex', 'Base64Url'].includes(imported.imported);
      if (NOBLE_DATA_FUNCTIONS.has(`${imported.source}:${imported.imported}`)) return true;
      const target = this.snapshotImport(model.filename, imported.source);
      const owner = target === null ? null : this.load(target);
      const exported = owner === null ? null : this.snapshotExport(owner, imported.imported);
      return exported !== null && this.safeMetadataArguments(exported.declaration.init, exported.model, new Set(seen));
    }
    return node.type === 'MemberExpression' && !node.computed && !node.optional &&
      !['constructor', '__proto__', 'prototype'].includes(node.property.name) && this.metadataAlias(node.object, model, new Set(seen));
  }

  safeMetadataArguments(node: Node, model: Model, seen = new Set<Node>()): boolean {
    const known = this.metadataArgumentCache.get(node);
    if (known !== undefined) return known;
    this.metadataArgumentCache.set(node, false);
    const result = this.safeMetadataArgumentsInner(node, model, seen);
    this.metadataArgumentCache.set(node, result);
    return result;
  }

  safeMetadataArgumentsInner(node: Node, model: Model, seen = new Set<Node>()): boolean {
    const value = unwrap(node);
    if (++this.metadataSteps > 100_000 || seen.size > 1024 || seen.has(value)) return false;
    seen.add(value);
    if (this.strictSchemaExports && value.type === 'ClassDeclaration' && this.schemaMiddlewareClass(value, model)) return true;
    if (fnNode(value) || value.type === 'Literal') return true;
    if (value.type === 'Identifier') {
      if (value.name === 'undefined') return true;
      if (model.imports.has(value.name)) return this.metadataAlias(value, model) || this.expression(value, model, new Map()).kind === 'schema';
      const own = model.values.get(value.name);
      return (own !== undefined && this.safeMetadataArguments(own, model, new Set(seen))) || this.expression(value, model, new Map()).kind === 'schema';
    }
    if (value.type === 'MemberExpression' && !value.computed && !value.optional)
      return this.safeMetadataArguments(value.object, model, new Set(seen));
    if (value.type === 'ArrayExpression') return value.elements.every((element: Node | null) => element !== null &&
      this.safeMetadataArguments(element.type === 'SpreadElement' ? element.argument : element, model, new Set(seen)));
    if (value.type === 'ObjectExpression') return value.properties.every((property: Node) => property.type === 'SpreadElement'
      ? this.safeMetadataArguments(property.argument, model, new Set(seen))
      : property.kind === 'init' && !property.method && !property.computed && this.safeMetadataArguments(property.value, model, new Set(seen)));
    if (value.type === 'CallExpression' && this.nativeMetadataAllocation(value, model))
      return value.arguments.every((argument: Node) => this.safeMetadataArguments(argument, model, new Set(seen)));
    return this.expression(value, model, new Map()).kind === 'schema';
  }

  nativeApiMetadataOrigin(input: Node, model: Model, seen = new Set<Node>()): string | null {
    if (!this.strictSchemaExports || seen.size >= 128) return null;
    const node = unwrap(input);
    if (seen.has(node)) return null;
    seen.add(node);
    if (node.type === 'Identifier') {
      const value = model.values.get(node.name);
      return value === undefined ? null : this.nativeApiMetadataOrigin(value, model, seen);
    }
    if (node.type !== 'CallExpression' || node.optional || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.optional) return null;
    const method = node.callee.property.name;
    const imported = model.imports.get(named(node.callee.object) ?? '');
    if (imported?.source === '@modern-js/bff-effect/effect-client' && imported.typeOnly !== true) {
      if (['HttpApi', 'HttpApiGroup'].includes(imported.imported) && method === 'make' && node.arguments.length === 1 && typeof node.arguments[0].value === 'string') return imported.imported;
      if (imported.imported === 'HttpApiEndpoint' && ['get', 'post', 'put', 'patch', 'del', 'delete', 'head', 'options'].includes(method) && node.arguments.length === 3 && node.arguments.slice(0, 2).every((value: Node) => value.type === 'Literal' && typeof value.value === 'string')) return 'HttpApiEndpoint';
    }
    const receiver = this.nativeApiMetadataOrigin(node.callee.object, model, new Set(seen));
    if (receiver === null) return null;
    if (method === 'add') return node.arguments.length > 0 && node.arguments.every((argument: Node) => this.nativeApiMetadataOrigin(argument, model, new Set(seen)) === (receiver === 'HttpApi' ? 'HttpApiGroup' : 'HttpApiEndpoint')) ? receiver : null;
    return ['middleware', 'annotate', 'prefix'].includes(method) && node.arguments.length > 0 ? receiver : null;
  }

  nativeMetadataAllocation(input: Node, model: Model): boolean {
    const node = unwrap(input);
    if (node.type !== 'CallExpression' || node.optional) return false;
    if (this.strictSchemaExports && this.nativeApiMetadataOrigin(node, model) !== null) return true;
    const callee = unwrap(node.callee);
    if (callee.type === 'Identifier') {
      const imported = model.imports.get(callee.name);
      if (imported?.source === '@modern-js/bff-effect/microvertical-api' && imported.imported === 'createMicroVerticalOperationContext' && imported.typeOnly !== true) return true;
      return !this.strictSchemaExports && imported?.typeOnly !== true && imported?.source === '@app/shared-contracts/problem-details' &&
        ['makeProblemDetailsSchema', 'makeRetryableProblemDetailsSchema'].includes(imported.imported) &&
        this.snapshotImport(model.filename, imported.source) !== null;
    }
    if (callee.type === 'CallExpression' && !callee.optional && callee.arguments.length === 0) {
      const factory = unwrap(callee.callee);
      const imported = factory.type === 'MemberExpression' && !factory.computed && !factory.optional
        ? model.imports.get(named(factory.object) ?? '') : undefined;
      return imported?.source === 'effect' && imported.imported === 'Schema' && imported.typeOnly !== true &&
        ['TaggedError', 'TaggedClass'].includes(factory.property.name) && node.arguments.length === 2;
    }
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) return false;
    if (callee.object.type === 'CallExpression')
      return ['add', 'addHttpApi', 'annotate', 'pipe', 'check', ...(this.strictSchemaExports ? ['middleware'] : [])].includes(callee.property.name) &&
        this.nativeMetadataAllocation(callee.object, model);
    if (['annotate', 'pipe', 'check'].includes(callee.property.name) && (this.strictSchemaExports ? this.expression(callee.object, model, new Map()).kind === 'schema' : this.metadataAlias(callee.object, model))) return true;
    if (named(callee.object) === 'Object' && callee.property.name === 'freeze' && !model.values.has('Object') && !model.imports.has('Object') && node.arguments.length === 1) return true;
    const imported = model.imports.get(named(callee.object) ?? '');
    return imported?.typeOnly !== true &&
      ((imported?.source === 'effect' && (imported.imported === 'Schema' || (imported.imported === 'SchemaGetter' && ['transform', 'transformOrFail'].includes(callee.property.name)))) ||
      (imported?.source === 'effect/http-api' && ['HttpApi', 'HttpApiEndpoint', 'HttpApiGroup'].includes(imported.imported)) ||
      (imported?.source === '@modern-js/bff-effect/effect-client' && ['Schema', 'HttpApi', 'HttpApiEndpoint', 'HttpApiGroup'].includes(imported.imported)));
  }

  runtimeReferences(node: Node, names: ReadonlySet<string>, parent?: Node): boolean {
    if (node.type === 'MemberExpression' && !node.computed && named(node.object) === 'globalThis' && names.has(node.property.name)) return true;
    if (node.type === 'Identifier' && names.has(node.name) &&
      !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) &&
      !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) return true;
    for (const [field, value] of Object.entries(node)) {
      if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field)) continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string' &&
          this.runtimeReferences(child as Node, names, node)) return true;
    }
    return false;
  }

  capturedDataArgument(node: Node, names: ReadonlySet<string>, model: Model): boolean {
    if (fnNode(node)) return false;
    if (node.type === 'NewExpression' && named(node.callee) === 'WeakSet' && node.arguments.length === 0 && !model.values.has('WeakSet') && !model.imports.has('WeakSet')) return false;
    if (node.type === 'CallExpression') {
      const callee = this.expression(node.callee, model, new Map());
      if (callee.kind === 'function' && callee.node !== undefined) return node.arguments.some((argument: Node) => this.capturedDataArgument(argument, names, model));
      if (callee.kind === 'native' && (['effect:Struct.omit', 'global:Object.entries', 'global:Object.fromEntries', 'global:Intl.supportedValuesOf'].includes(callee.native ?? '') ||
        /^effect:(?:Effect\.(?:map|flatMap|catchTag|mapError|fn)|Option\.(?:match|map|flatMap)|Schema\.(?:decodeEffect|decodeUnknownEffect|encodeEffect|encodeUnknownEffect))$/u.test(callee.native ?? '')))
        return node.arguments.some((argument: Node) => this.capturedDataArgument(argument, names, model));
    }
    if (node.type === 'Identifier') return names.has(node.name);
    return Object.entries(node).some(([field, value]) => !['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field) &&
      (Array.isArray(value) ? value : [value]).some((child) => child !== null && typeof child === 'object' &&
        typeof (child as Node).type === 'string' && this.capturedDataArgument(child as Node, names, model)));
  }

  closedPipeReceiver(node: Node, model: Model): boolean {
    const direct = this.expression(node, model, new Map());
    if (['schema', 'codec-effect', 'matcher', 'getter'].includes(direct.kind) ||
      (direct.kind === 'record' && ['result', 'option'].includes(direct.native ?? ''))) return true;
    if (this.metadataAlias(node, model)) return true;
    if (node.type !== 'CallExpression' || node.optional) return false;
    const callee = this.expression(node.callee, model, new Map());
    return (callee.kind === 'function' && ['schema-codec', 'schema-data-codec'].includes(callee.native ?? '')) ||
      (callee.kind === 'native' && ['effect:Effect.succeed', 'effect:Effect.fail', 'effect:Match.value'].includes(callee.native ?? ''));
  }

  capturedCallableReturn(input: Node, names: ReadonlySet<string>, model: Model): boolean {
    const node = unwrap(input);
    if (node.type === 'Identifier' && names.has(node.name)) { const value = this.value(node.name, model, new Map()); return ['function', 'native', 'bad'].includes(value.kind) || (!isClosedData(value) && !['schema', 'codec-effect'].includes(value.kind)); }
    if (node.type === 'MemberExpression') return this.runtimeReferences(node, names) &&
      ['function', 'native'].includes(this.expression(node, model, new Map()).kind);
    if (['ObjectExpression', 'ArrayExpression', 'Property', 'SpreadElement', 'ConditionalExpression', 'LogicalExpression'].includes(node.type))
      return Object.entries(node).some(([field, value]) => !['parent', 'key', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field) &&
        (Array.isArray(value) ? value : [value]).some((child) => child !== null && typeof child === 'object' &&
          typeof (child as Node).type === 'string' && this.capturedCallableReturn(child as Node, names, model)));
    return false;
  }

  closedCapturedDependencies(): boolean {
    this.initializationDepth += 1;
    try { return this.closedCapturedDependenciesInner(); }
    finally { this.initializationDepth -= 1; }
  }

  closedCapturedDependenciesInner(): boolean {
    for (const [model, captured] of this.capturedValues) {
      const names = new Set(captured);
      if (['Object', 'WeakSet', 'Array', 'Math', 'String', 'Number', 'URL', 'Intl'].some((name) => names.has(name))) {names.add('globalThis');names.add('global');names.add('self');names.add('window');}
      const importIdentities = [...captured].flatMap((name) => { const imported = model.imports.get(name); return imported === undefined ? [] : [imported]; });
      for (const [name, imported] of model.imports)
        if (imported.typeOnly !== true && importIdentities.some((identity) => identity.source === imported.source &&
          (identity.imported === imported.imported || imported.imported === '*'))) names.add(name);
      let valid = true;
      const visit = (node: Node, enclosing?: Node): void => {
        const functionScope = fnNode(node) ? node : enclosing;
        if (node.type === 'Identifier' && [...(this.strictSchemaExports ? [] : ['Reflect']), 'Function', 'eval'].includes(node.name) && !model.values.has(node.name) && !model.imports.has(node.name)) valid = false;
        if (node.type === 'MemberExpression' && ['constructor', '__proto__'].includes(node.computed ? node.property.value : node.property.name)) valid = false;
        if ((node.type === 'ReturnStatement' && node.argument !== null && this.capturedCallableReturn(node.argument, names, model)) ||
          (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement' && this.capturedCallableReturn(node.body, names, model))) valid = false;
        if (node.type === 'TaggedTemplateExpression' && this.runtimeReferences(node, names)) valid = false;
        if (node.type === 'WithStatement' || (['CallExpression', 'NewExpression'].includes(node.type) &&
          ['eval', 'Function'].includes(named(node.callee) ?? ''))) valid = false;
        if (node.type === 'VariableDeclarator' && node.init !== null &&
          ['Identifier', 'MemberExpression', 'ObjectExpression', 'ArrayExpression'].includes(unwrap(node.init).type) &&
          this.runtimeReferences(unwrap(node.init), names)) {
          const bind = (pattern: Node): void => {
            if (pattern.type === 'Identifier') names.add(pattern.name);
            else if (pattern.type === 'ArrayPattern') for (const child of pattern.elements.filter(Boolean)) bind(child);
            else if (pattern.type === 'ObjectPattern') for (const child of pattern.properties)
              bind(child.type === 'RestElement' ? child.argument : child.value);
          };
          bind(node.id);
        }
        if ((node.type === 'AssignmentExpression' && !this.validatedReflectionWrites.has(node) && (this.runtimeReferences(node.left, names) || this.runtimeReferences(node.right, names))) ||
          (node.type === 'UpdateExpression' && this.runtimeReferences(node.argument, names))) valid = false;
        if (['NewExpression', 'PropertyDefinition', 'AccessorProperty'].includes(node.type) &&
          ((node.value !== undefined && this.runtimeReferences(node.value, names)) ||
            (node.arguments ?? []).some((argument: Node) => this.capturedDataArgument(argument, names, model)))) valid = false;
        if (node.type === 'CallExpression' &&
          (this.runtimeReferences(node.callee, names) || node.arguments.some((argument: Node) => this.capturedDataArgument(argument, names, model)))) {
          const callee = this.expression(node.callee, model, new Map());
          const nativeName = callee.native ?? '';
          const allowed = (callee.kind === 'function' && ['schema-codec', 'schema-data-codec', 'codec-function-allocation'].includes(nativeName)) || (callee.kind === 'native' &&
            (this.strictSchemaExports && ['global:Object.getPrototypeOf', 'global:Object.getOwnPropertyDescriptor', 'global:Object.getOwnPropertyDescriptors', 'global:Reflect.ownKeys'].includes(nativeName) || /^effect:Schema\./u.test(nativeName) || this.strictSchemaExports && /^effect:SchemaAST\.is(?:AST|Any|BigInt|Symbol|UniqueSymbol|Undefined|Unknown|Void|ObjectKeyword|Declaration|Literal|Number|Arrays|Objects|Union|Suspend)$/u.test(nativeName) || /^schema:(?:check|pipe|annotate)$/u.test(nativeName) ||
              /^effect:Effect\.(?:fn|map|flatMap|catchTag|mapError|succeed|fail)$/u.test(nativeName) ||
              /^effect:Match\.(?:value|tag|tags)$/u.test(nativeName) ||
              /^effect:Predicate\.(?:isObject|isObjectKeyword|isString|isNumber|isBoolean|isBigInt|isDate|isFunction)$/u.test(nativeName) || this.strictSchemaExports && ['effect:Predicate.isMap', 'effect:Predicate.isSet'].includes(nativeName) ||
              ['effect:SchemaGetter.transform', 'effect:SchemaGetter.dateTimeUtcFromInput', 'effect:SchemaGetter.map', 'effect:Result.getOrThrow', 'effect:Result.getOrUndefined', 'effect:Option.isNone', 'effect:Option.isSome', 'effect:DateTime.Order'].includes(nativeName) ||
              [...(this.strictSchemaExports ? ['http:HttpApiSchema.asJson', 'http:HttpApiSchema.status'] : []), 'noble:sha256', 'noble:utf8ToBytes', 'effect/encoding:Hex.encode', 'effect/encoding:Base64Url.encode', 'effect:Struct.omit'].includes(nativeName)));
          const deferred = nativeName === 'effect:Effect.fnUntraced' && node.arguments.length === 1 && fnNode(node.arguments[0]);
          const pipe = node.callee.type === 'MemberExpression' && !node.callee.computed && !node.callee.optional &&
            node.callee.property.name === 'pipe' && this.closedPipeReceiver(node.callee.object, model);
          const callableNames = new Set([...names].filter((name) => {
            const value = this.value(name, model, new Map());
            return value.kind !== 'data' || !('literal' in value);
          }));
          const callableOnly = callee.kind === 'function' && (node.callee.type === 'Identifier' || fnNode(unwrap(node.callee))) &&
            !node.arguments.some((argument: Node) => this.capturedDataArgument(argument, callableNames, model));
          const closedCallable = callee.kind === 'function' && callee.model !== undefined &&
            this.snapshotPackage(callee.model.filename)?.directory === this.context?.ownerPath &&
            [...names].filter((name) => node.arguments.some((argument: Node) => this.capturedDataArgument(argument, new Set([name]), model)))
              .every((name) => isClosedData(this.value(name, model, new Map()))) &&
            isClosedData(this.invoke(callee, []));
          if (!allowed && !deferred && !pipe && !callableOnly && !closedCallable && !this.validatedCalls.has(node) &&
            !this.nativeMetadataAllocation(node, model) && functionScope !== undefined && !this.custodyFunctions.has(functionScope)) {
            this.custodyFunctions.add(functionScope);
            this.invoke(this.expression(functionScope, model, new Map()), []);
          }
          if (!allowed && !deferred && !pipe && !callableOnly && !closedCallable && !this.validatedCalls.has(node) && !this.nativeMetadataAllocation(node, model)) valid = false;
        }
        for (const [field, value] of Object.entries(node)) {
          if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field)) continue;
          for (const child of Array.isArray(value) ? value : [value])
            if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node, functionScope);
        }
      };
      for (let round = 0; round < 32; round += 1) {
        const size = names.size;
        visit(model.program);
        if (!valid) return false;
        if (size === names.size) break;
        if (round === 31) return false;
      }
    }
    return true;
  }

  codecFunctionSyntax(node: Node, model: Model): boolean {
    const factory = unwrap(node.callee);
    const member = factory.type === 'CallExpression' ? unwrap(factory.callee) : undefined;
    const imported = member?.type === 'MemberExpression' && !member.computed && !member.optional
      ? model.imports.get(named(member.object) ?? '') : undefined;
    return !node.optional && factory.type === 'CallExpression' && !factory.optional &&
      factory.arguments.length === 1 && factory.arguments[0].type === 'Literal' &&
      typeof factory.arguments[0].value === 'string' && node.arguments.length === 1 &&
      fnNode(unwrap(node.arguments[0])) && imported?.source === 'effect' &&
      imported.imported === 'Effect' && imported.typeOnly !== true &&
      !model.values.has(named(member?.object) ?? '') && member?.property.name === 'fn';
  }

  codecEffectCall(callee: Value, args: readonly Value[]): Value {
    const name = callee.native ?? '';
    if (name === 'codec:pipe') {
      let result = callee.payload ?? BAD;
      for (const argument of args) result = this.invoke(argument, [result]);
      return result.kind === 'codec-effect' && isClosedData(result.payload ?? BAD) ? result : BAD;
    }
    const operation = name.slice('effect:Effect.'.length);
    if (operation === 'fn' && args.length === 1 && typeof args[0].literal === 'string')
      return { kind: 'function', native: 'codec-function-allocation', apply: (values) => values.length === 1 && values[0]?.kind === 'function' &&
        values[0].node !== undefined && !values[0].node.async
        ? { ...values[0], native: 'codec-function' } : BAD };
    if (operation === 'gen' && args.length === 1 && args[0]?.kind === 'function' && args[0].node?.generator)
      return this.invoke({ ...args[0], native: 'codec-function' }, []);
    if (operation === 'succeed' && args.length === 1 && isClosedData(args[0]))
      return { kind: 'codec-effect', payload: args[0] };
    if (operation === 'fail' && args.length === 1 && args[0].native === 'tagged-error' && isClosedData(args[0]))
      return { kind: 'codec-effect', payload: DATA, failureOnly: true };
    if (operation === 'catchTag' && args.length === 2 && typeof args[0].literal === 'string' && args[1].kind === 'function')
      return { kind: 'function', apply: (values) => {
        const input = values[0];
        const failure = this.invoke(args[1], [ISSUE]);
        return values.length === 1 && input?.kind === 'codec-effect' && failure.kind === 'codec-effect' &&
          isClosedData(input.payload ?? BAD) && isClosedData(failure.payload ?? BAD)
          ? { kind: 'codec-effect', payload: merge([input.payload ?? BAD, failure.payload ?? BAD]),
            validationInputs: input.validationInputs } : BAD;
      } };
    if (['map', 'flatMap', 'mapError'].includes(operation) && args.length === 1 && args[0].kind === 'function')
      return { kind: 'function', apply: (values) => {
        const input = values[0];
        if (values.length !== 1 || input?.kind !== 'codec-effect') return BAD;
        const mapped = this.invoke(args[0], [operation === 'mapError' ? ISSUE : input.payload ?? BAD]);
        if (operation === 'flatMap') return mapped.kind === 'codec-effect' && isClosedData(mapped.payload ?? BAD) ? mapped : BAD;
        if (operation === 'mapError') return mapped.native === 'tagged-error' && isClosedData(mapped) ? input : BAD;
        return isClosedData(mapped) ? { kind: 'codec-effect', payload: mapped } : BAD;
      } };
    return BAD;
  }

  exportIdentity(model: Model, name: string, seen = new Set<string>()): string | null {
    const token = `${model.filename}:${name}`;
    if (seen.has(token)) return null;
    seen.add(token);
    const local = model.exports.get(name);
    if (local === undefined) return null;
    const imported = model.imports.get(local);
    if (imported === undefined) return model.values.has(local) ? `${model.filename}:${local}` : null;
    const owner = this.imported(model, imported.source);
    return owner === null ? null : this.exportIdentity(owner, imported.imported, seen);
  }

  snapshotPackage(filename: string): { readonly directory: string; readonly metadata: Node } | null {
    if (this.context === undefined) return null;
    const candidates = [...this.context.sources.keys()].filter((file) => file.endsWith('/package.json') &&
      filename.startsWith(file.slice(0, -'package.json'.length))).sort((left, right) => right.length - left.length);
    const [candidate] = candidates;
    if (candidate === undefined) return null;
    try {
      const metadata = JSON.parse(this.context.sources.get(candidate) ?? '');
      return metadata !== null && typeof metadata === 'object' && typeof metadata.name === 'string' && /^@app\/[a-z][a-z0-9-]*$/u.test(metadata.name)
        ? { directory: path.posix.dirname(candidate), metadata } : null;
    } catch { return null; }
  }

  snapshotImport(importer: string, source: string): string | null {
    if (this.context === undefined) return null;
    const own = this.snapshotPackage(importer);
    if (own === null) return null;
    if (source.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), source));
      return target.startsWith(`${own.directory}/`) && this.context.sources.has(target) ? target : null;
    }
    const matches = [...this.context.sources.entries()].flatMap(([file, text]) => {
      if (!file.endsWith('/package.json')) return [];
      try {
        const metadata = JSON.parse(text);
        if (metadata === null || typeof metadata.name !== 'string' || !/^@app\/[a-z][a-z0-9-]*$/u.test(metadata.name) ||
          (source !== metadata.name && !source.startsWith(`${metadata.name}/`))) return [];
        const key = source === metadata.name ? '.' : `.${source.slice(metadata.name.length)}`;
        const exported = metadata.exports?.[key];
        if (typeof exported !== 'string' || !exported.startsWith('./')) return [];
        const directory = path.posix.dirname(file);
        const target = path.posix.normalize(path.posix.join(directory, exported));
        return target.startsWith(`${directory}/`) && this.context!.sources.has(target) ? [target] : [];
      } catch { return []; }
    });
    return matches.length === 1 ? matches[0] : null;
  }

  snapshotExport(model: Model, name: string, seen = new Set<string>(), modules?: Set<Model>): { readonly model: Model; readonly declaration: Node } | null {
    modules?.add(model);
    const token = `${model.filename}:${name}`;
    if (seen.size >= 32 || seen.has(token)) return null;
    seen.add(token);
    const matches: { readonly model: Model; readonly declaration: Node }[] = [];
    for (const statement of model.program.body) {
      if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
      const declaration = statement.declaration;
      if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
        for (const binding of declaration.declarations)
          if (named(binding.id) === name) matches.push({ model, declaration: binding });
      }
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === 'type' || key(specifier.exported) !== name) continue;
        const imported = key(specifier.local);
        if (statement.source === null || imported === undefined) continue;
        const target = this.snapshotImport(model.filename, statement.source.value);
        const owner = target === null ? null : this.load(target);
        const resolved = owner === null ? null : this.snapshotExport(owner, imported, new Set(seen), modules);
        if (resolved !== null) matches.push(resolved);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /** An initialization-only own-data read. No runtime Value is constructed from this fact. */
  passiveImportedMember(model: Model, input: Node, suffix: readonly string[] = []): boolean {
    const key = JSON.stringify(suffix);
    const facts = this.initializationMemberFacts.get(input) ?? new Map<string, boolean>();
    const known = facts.get(key);
    if (known !== undefined) return known;
    facts.set(key, false);
    this.initializationMemberFacts.set(input, facts);
    const result = this.passiveMemberPath(model, input, suffix, new Set());
    facts.set(key, result);
    return result;
  }

  passiveMemberPath(model: Model, input: Node, suffix: readonly string[], seen: Set<string>, declaration?: Node): boolean {
    let root = unwrap(input);
    const parts = [...suffix];
    while (root.type === 'MemberExpression' && !root.computed && !root.optional) {
      if (['constructor', '__proto__'].includes(root.property.name)) return false;
      parts.unshift(root.property.name);
      root = unwrap(root.object);
    }
    if (parts.length === 0 || parts.some((part) => ['constructor', '__proto__'].includes(part))) return false;
    const token = `${model.filename}:${root.start}:${JSON.stringify(parts)}`;
    if (seen.size >= 64 || seen.has(token)) return false;
    seen.add(token);
    if (root.type === 'Identifier') {
      const own = model.values.get(root.name);
      if (own !== undefined) {
        const projected = model.projections.get(root.name);
        const variable = model.program.body.flatMap((statement: Node) => {
          const value = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
          return value?.type === 'VariableDeclaration' && value.kind === 'const' ? value.declarations : [];
        }).find((binding: Node) => named(binding.id) === root.name);
        return this.passiveMemberPath(model, own, projected === undefined ? parts : [projected, ...parts], seen, variable) &&
          this.initializationBindingCustody(model, root.name, variable?.start ?? root.start);
      }
      const imported = model.imports.get(root.name);
      if (imported === undefined || imported.typeOnly) return false;
      if (imported.source === 'effect' && ['Schema', 'Effect', 'Context', 'Layer'].includes(imported.imported)) return parts.length === 1;
      const target = this.snapshotImport(model.filename, imported.source);
      const owner = target === null ? null : this.load(target);
      const binding = owner === null ? null : this.snapshotExport(owner, imported.imported);
      return binding !== null && this.passiveMemberPath(binding.model, binding.declaration.init, parts, seen, binding.declaration) &&
        this.initializationBindingCustody(binding.model, named(binding.declaration.id) ?? '', binding.declaration.start);
    }
    if (root.type === 'ObjectExpression') {
      const own = root.properties.filter((property: Node) => property.type === 'Property' && key(property.key) === parts[0]);
      return own.length === 1 && own[0].kind === 'init' && !own[0].method && !own[0].computed &&
        root.properties.every((property: Node) => property.type === 'Property' && !property.computed && property.kind === 'init' && !property.method) &&
        (parts.length === 1 || this.passiveMemberPath(model, own[0].value, parts.slice(1), seen));
    }
    return declaration !== undefined && parts.length === 1 && this.nativeColumnInitialization(model, declaration, root, parts[0], new Set());
  }

  nativeColumnInitialization(model: Model, declaration: Node, input: Node, field: string, seen: Set<Node>, evidence?: (value: NativeColumnInitializationEvidence) => void): boolean {
    if (seen.size > 128 || seen.has(input)) return false;
    seen.add(input);
    const node = unwrap(input);
    const genuine = (name: string | undefined, imported: string): boolean => {
      const binding = model.imports.get(name ?? '');
      return binding?.source === 'drizzle-orm/pg-core' && binding.imported === imported && binding.typeOnly !== true && !model.values.has(name ?? '');
    };
    const wrapper = (value: Node): boolean => {
      if (!fnNode(value) || value.async || value.generator || value.params.length !== 1 || value.params[0].type !== 'Identifier') return false;
      const body = value.body.type === 'BlockStatement' && value.body.body.length === 1 && value.body.body[0].type === 'ReturnStatement'
        ? value.body.body[0].argument : value.body;
      return body?.type === 'CallExpression' && !body.optional && body.arguments.length === 0 && body.callee.type === 'MemberExpression' &&
        !body.callee.computed && !body.callee.optional && body.callee.object.type === 'Identifier' &&
        body.callee.object.name === value.params[0].name && body.callee.property.name === 'enableRLS';
    };
    if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' && node.arguments.length === 1) {
      const fn = model.values.get(node.callee.name);
      if (fn !== undefined && wrapper(fn) && this.initializationBindingCustody(model, node.callee.name, declaration.start, true))
        return this.nativeColumnInitialization(model, declaration, node.arguments[0], field, seen, evidence);
    }
    if (node.type !== 'CallExpression' || node.optional || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.optional ||
      node.callee.property.name !== 'table' || node.arguments.length < 2 || node.arguments.length > 3 ||
      node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string' || node.arguments[1].type !== 'ObjectExpression' ||
      (node.arguments[2] !== undefined && !fnNode(node.arguments[2]))) return false;
    const schemaName = named(node.callee.object);
    const allocation = model.values.get(schemaName ?? '');
    if (allocation?.type !== 'CallExpression' || allocation.optional || !genuine(named(allocation.callee), 'pgSchema') ||
      allocation.arguments.length !== 1 || !(allocation.arguments[0].type === 'Literal' && typeof allocation.arguments[0].value === 'string' ||
        allocation.arguments[0].type === 'Identifier' && model.values.get(allocation.arguments[0].name)?.type === 'Literal' &&
        typeof model.values.get(allocation.arguments[0].name)?.value === 'string') ||
      !this.initializationBindingCustody(model, named(allocation.callee) ?? '', declaration.start, true) ||
      !this.initializationBindingCustody(model, schemaName ?? '', declaration.start, true)) return false;
    const methods = new Set(['defaultRandom', 'primaryKey', 'notNull', 'references', '$type', 'default', 'defaultNow', 'unique', 'array', 'generatedAlwaysAsIdentity']);
    const roots = new Set(['uuid', 'text', 'timestamp', 'integer', 'bigint', 'boolean', 'jsonb']);
    const visiting = new Set<Node>();
    const factories = new Map<string, Node>();
    const passive = (value: Node, env: ReadonlyMap<string, Node>, depth = 0): boolean => {
      if (depth > 64) return false;
      const current = unwrap(value);
      if (fnNode(current) || current.type === 'Literal') return true;
      if (evidence !== undefined && current.type === 'TaggedTemplateExpression' && current.quasi.expressions.length === 0) {
        const imported = model.imports.get(named(current.tag) ?? '');
        return imported?.source === 'drizzle-orm' && imported.imported === 'sql' && imported.typeOnly !== true &&
          this.initializationBindingCustody(model, named(current.tag) ?? '', declaration.start, true);
      }
      if (current.type === 'Identifier' && env.has(current.name)) return passive(env.get(current.name)!, env, depth + 1);
      if (current.type === 'ObjectExpression') return current.properties.every((property: Node) => property.type === 'Property' &&
        property.kind === 'init' && !property.method && !property.computed && passive(property.value, env, depth + 1));
      if (current.type === 'ArrayExpression') return current.elements.every((element: Node | null) => element !== null && passive(element, env, depth + 1));
      return false;
    };
    const column = (value: Node, depth = 0, env: ReadonlyMap<string, Node> = new Map(), trace?: NativeColumnTrace): boolean => {
      if (depth > 64) return false;
      const current = unwrap(value);
      if (current.type !== 'CallExpression' || current.optional) return false;
      const callee = unwrap(current.callee);
      if (callee.type === 'MemberExpression') {
        const valid = !callee.computed && !callee.optional && methods.has(callee.property.name) &&
          column(callee.object, depth + 1, env, trace) && current.arguments.every((argument: Node) => passive(argument, env));
        if (valid) trace?.methods.push({name: callee.property.name, argumentCount: current.arguments.length, call: current, captures: new Map(env)});
        return valid;
      }
      if (callee.type !== 'Identifier' || env.has(callee.name)) return false;
      const nativeImport = model.imports.get(callee.name);
      if (nativeImport?.source === 'drizzle-orm/pg-core' && nativeImport.typeOnly !== true && roots.has(nativeImport.imported)) {
        const valid = this.initializationBindingCustody(model, callee.name, declaration.start, true) && current.arguments.every((argument: Node) => !fnNode(unwrap(argument)) && passive(argument, env));
        if (valid && trace !== undefined) trace.root = {kind: nativeImport.imported, argumentCount: current.arguments.length, localName: callee.name, call: current, captures: new Map(env)};
        return valid;
      }
      const fn = model.values.get(callee.name);
      if (fn === undefined || !fnNode(fn) || fn.async || fn.generator || current.arguments.length > fn.params.length || visiting.has(fn)) return false;
      const inputs = new Map(env);
      for (const [index, parameter] of fn.params.entries()) {
        const name = named(parameter.type === 'AssignmentPattern' ? parameter.left : parameter);
        const argument = current.arguments[index] ?? (parameter.type === 'AssignmentPattern' ? parameter.right : undefined);
        if (name === undefined || argument === undefined || !passive(argument, env)) return false;
        inputs.set(name, argument);
      }
      visiting.add(fn);
      const result = column(fn.body, depth + 1, inputs, trace);
      if (result) {
        trace?.factories.push({call: current, declaration: fn, captures: new Map(inputs)});
        if (evidence !== undefined) factories.set(callee.name, fn);
      }
      visiting.delete(fn);
      return result;
    };
    const fields = new Map<string, Node>();
    let selectedTrace: NativeColumnTrace | undefined;
    const fieldMap = (value: Node, depth = 0): boolean => {
      if (depth > 32) return false;
      const current = unwrap(value);
      if (current.type !== 'ObjectExpression') return false;
      for (const property of current.properties) {
        if (property.type === 'SpreadElement') {
          const call = unwrap(property.argument);
          const fn = call.type === 'CallExpression' && !call.optional && call.arguments.length === 0 ? model.values.get(named(call.callee) ?? '') : undefined;
          const priorTrace = selectedTrace;
          if (fn === undefined || !fnNode(fn) || fn.async || fn.generator || fn.params.length !== 0 || !fieldMap(fn.body, depth + 1)) return false;
          if (evidence !== undefined) {
            factories.set(named(call.callee) ?? '', fn);
            if (selectedTrace !== undefined && selectedTrace !== priorTrace) selectedTrace.factories.push({call, declaration: fn, captures: new Map()});
          }
          continue;
        }
        const name = key(property.key);
        const trace: NativeColumnTrace | undefined = name === field && evidence !== undefined ? {root: null, methods: [], factories: []} : undefined;
        if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed || name === undefined ||
          ['enableRLS', 'constructor', '__proto__'].includes(name) || fields.has(name) || !column(property.value, 0, new Map(), trace)) return false;
        fields.set(name, property.value);
        if (trace !== undefined) selectedTrace = trace;
      }
      return true;
    };
    if (!fieldMap(node.arguments[1]) || !fields.has(field)) return false;
    const binding = named(declaration.id);
    if (binding !== undefined) this.nativeMetadataFields.set(`${model.filename}:${binding}`, new Set(fields.keys()));
    if (evidence !== undefined) {
      const indexFactoryCalls = (value: Node): void => {
        if (value.start > declaration.start) return;
        if (value.type === 'CallExpression' && !value.optional && value.callee.type === 'Identifier') {
          const fn = factories.get(value.callee.name);
          if (fn !== undefined && value.arguments.length <= fn.params.length && value.arguments.every((argument: Node) => passive(argument, new Map())))
            this.initializationFactoryCallees.add(value.callee);
        }
        for (const [name, value_] of Object.entries(value)) {
          if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(name)) continue;
          for (const child of Array.isArray(value_) ? value_ : [value_])
            if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') indexFactoryCalls(child as Node);
        }
      };
      indexFactoryCalls(model.program);
      if ([...factories].some(([name]) => !this.initializationBindingCustody(model, name, declaration.start, true))) return false;
      const root = selectedTrace?.root;
      if (root === null || root === undefined || binding === undefined || !this.initializationBindingCustody(model, binding, declaration.start)) return false;
      evidence({scope: 'initialization-only', filename: model.filename, source: this.context?.sources.get(model.filename) ?? '', program: model.program,
        tableLocalName: binding, tableDeclaration: declaration, tableInitializer: declaration.init, tableCall: node, field, builder: fields.get(field)!,
        nativeRoot: root, builderMethods: selectedTrace!.methods, factoryCalls: selectedTrace!.factories});
    }
    return true;
  }

  initializationBindingCustody(model: Model, name: string, before: number, constructor = false): boolean {
    const key = `${model.filename}:${name}:${before}:${constructor}`;
    const known = this.initializationBindingFacts.get(key);
    if (known !== undefined) return known;
    this.initializationBindingFacts.set(key, false);
    const result = this.initializationBindingCustodyInner(model, name, before, constructor);
    this.initializationBindingFacts.set(key, result);
    return result;
  }

  initializationBindingCustodyInner(model: Model, name: string, before: number, constructor: boolean): boolean {
    const names = new Set([name]);
    const importedIdentity = model.imports.get(name);
    if (importedIdentity !== undefined) for (const [alias, binding] of model.imports)
      if (binding.typeOnly !== true && binding.source === importedIdentity.source && binding.imported === importedIdentity.imported) names.add(alias);
    let valid = true;
    const nativeCall = (callee: Node): boolean => {
      if (this.initializationFactoryCallees.has(callee)) return true;
      let value = unwrap(callee);
      while (value.type === 'CallExpression' || value.type === 'MemberExpression') {
        if (value.type === 'CallExpression') value = unwrap(value.callee);
        else if (!value.computed && !value.optional) value = unwrap(value.object);
        else return false;
      }
      const imported = model.imports.get(named(value) ?? '');
      if (imported?.typeOnly !== true && (imported?.source === 'drizzle-orm/pg-core' || imported?.source === 'drizzle-orm')) {
        const roots = imported.source === 'drizzle-orm' ? ['sql', 'defineRelations'] :
          ['pgSchema', 'uuid', 'text', 'timestamp', 'integer', 'bigint', 'boolean', 'jsonb', 'check', 'foreignKey', 'index', 'uniqueIndex', 'primaryKey', 'pgPolicy'];
        const methods = new Set(['defaultRandom', 'primaryKey', 'notNull', 'references', '$type', 'default', 'defaultNow', 'unique', 'array', 'on', 'where', 'onDelete', 'onUpdate', 'using', 'raw', 'join', 'identifier', 'empty']);
        let current = unwrap(callee);
        while (current.type === 'MemberExpression' || current.type === 'CallExpression') {
          if (current.type === 'MemberExpression') {
            if (current.computed || current.optional || !methods.has(current.property.name)) return false;
            current = unwrap(current.object);
          } else current = unwrap(current.callee);
        }
        return roots.includes(imported.imported) && (constructor || this.initializationBindingCustody(model, value.name, callee.start, true));
      }
      if (value.type === 'Identifier' && value.name === name && callee.type === 'MemberExpression' &&
        (callee.property.name === 'enableRLS' || constructor && ['table', 'sequence'].includes(callee.property.name))) return true;
      const allocation = value.type === 'Identifier' ? model.values.get(value.name) : undefined;
      const schemaImport = allocation?.type === 'CallExpression' ? model.imports.get(named(allocation.callee) ?? '') : undefined;
      if (callee.type === 'MemberExpression' && !callee.computed && !callee.optional && ['table', 'sequence'].includes(callee.property.name) &&
        schemaImport?.source === 'drizzle-orm/pg-core' && schemaImport.imported === 'pgSchema' && schemaImport.typeOnly !== true)
        return constructor || this.initializationBindingCustody(model, value.name, callee.start, true);
      const fn = value.type === 'Identifier' ? model.values.get(value.name) : undefined;
      return fn !== undefined && fnNode(fn) && fn.params.length === 1 && fn.params[0].type === 'Identifier' && fn.body.type === 'CallExpression' &&
        fn.body.callee.type === 'MemberExpression' && fn.body.callee.object.type === 'Identifier' && fn.body.callee.object.name === fn.params[0].name &&
        fn.body.callee.property.name === 'enableRLS' && fn.body.arguments.length === 0;
    };
    const parents = new Map<Node, Node>();
    const indexParents = (node: Node): void => {
      for (const [field, value] of Object.entries(node)) {
        if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field)) continue;
        for (const child of Array.isArray(value) ? value : [value]) if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') { parents.set(child as Node, node);indexParents(child as Node); }
      }
    };
    indexParents(model.program);
    const ownField = (binding: string, field: string, seen = new Set<string>(), sourceModel = model): 'data' | 'column' | 'method' | null => {
      const token = `${sourceModel.filename}:${binding}`;
      if (seen.size >= 32 || seen.has(token)) return null;
      seen.add(token);
      if (this.nativeMetadataFields.get(token)?.has(field)) return 'column';
      const initializer = sourceModel.values.get(binding);
      if (initializer === undefined) {
        const imported = sourceModel.imports.get(binding);
        const owner = imported === undefined || imported.typeOnly ? null : this.imported(sourceModel, imported.source);
        const target = owner === null || imported === undefined ? null : this.snapshotExport(owner, imported.imported);
        return target === null ? null : ownField(named(target.declaration.id) ?? '', field, seen, target.model);
      }
      const value = unwrap(initializer);
      if (value.type === 'Identifier') return ownField(value.name, field, seen, sourceModel);
      if (value.type === 'ObjectExpression') {
        const selected = value.properties.filter((property: Node) => property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed && key(property.key) === field);
        // A container member that transports a protected identity is not a column read. Its
        // unused projection form stays rejected rather than losing identity at the destination.
        return selected.length === 1 && isClosedData(this.expression(selected[0].value, sourceModel, new Map())) ? 'data' : null;
      }
      if (constructor && ['table', 'sequence'].includes(field) && value.type === 'CallExpression' && value.callee.type === 'Identifier') {
        const imported = sourceModel.imports.get(value.callee.name);
        if (imported?.source === 'drizzle-orm/pg-core' && imported.imported === 'pgSchema' && imported.typeOnly !== true) return 'method';
      }
      return null;
    };
    /** A table reference is a borrowed identity, not arbitrary passive data. Unknown positions fail closed. */
    const approvedReference = (reference: Node): boolean => {
      let current = reference;
      let parent = parents.get(current);
      if (parent === undefined) return false;
      if (parent.type === 'Property' && parent.shorthand && parent.key === current && parent.value !== current) return approvedReference(parent.value);
      if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent.type)) return true;
      if (parent.type === 'VariableDeclarator' && parent.id === current) return true;
      if (parent.type === 'ExportSpecifier' && parent.local === current) return true;
      if (parent.type === 'CallExpression' && parent.callee === current) return nativeCall(current);
      if (this.initializationColumnEvidence && parent.type === 'TaggedTemplateExpression' && parent.tag === current &&
        model.imports.get(reference.name)?.source === 'drizzle-orm' && model.imports.get(reference.name)?.imported === 'sql') return nativeCall(current);
      if (parent.type === 'MemberExpression' && parent.object === current) {
        if (this.initializationColumnEvidence && !parent.computed && !parent.optional &&
          model.imports.get(reference.name)?.source === 'drizzle-orm' && model.imports.get(reference.name)?.imported === 'sql' &&
          parents.get(parent)?.type === 'CallExpression' && parents.get(parent)?.callee === parent && nativeCall(parent)) return true;
        if (parent.computed || parent.optional || ['constructor', '__proto__', 'prototype'].includes(parent.property.name)) return false;
        const field = ownField(reference.name, parent.property.name);
        if (field === 'data') return true;
        if (field === null) return false;
        current = parent;parent = parents.get(current);
        if (field === 'method') return parent?.type === 'CallExpression' && parent.callee === current && nativeCall(current);
      }
      while (parent !== undefined) {
        if (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(parent.type) && parent.expression === current ||
          parent.type === 'Property' && parent.value === current && parent.kind === 'init' && !parent.method && !parent.computed ||
          parent.type === 'ObjectExpression' && parent.properties.includes(current) || parent.type === 'ArrayExpression' && parent.elements.includes(current)) {
          current = parent;parent = parents.get(current);continue;
        }
        if (parent.type === 'VariableDeclarator' && parent.init === current) {
          const declaration = parents.get(parent);
          return declaration?.type === 'VariableDeclaration' && declaration.kind === 'const';
        }
        if (parent.type === 'CallExpression' && parent.arguments.includes(current)) return nativeCall(parent.callee);
        return false;
      }
      return false;
    };
    const visit = (node: Node): void => {
      if (constructor && node.start > before) return;
      const parent = parents.get(node);
      if (node.type === 'Identifier' && names.has(node.name) &&
        !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) &&
        !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) &&
        !approvedReference(node)) valid = false;
      if (node.type === 'VariableDeclarator' && node.init !== null &&
        ['Identifier', 'MemberExpression', 'ObjectExpression', 'ArrayExpression'].includes(unwrap(node.init).type) && this.runtimeReferences(node.init, names)) {
        const bind = (pattern: Node): void => {
          if (pattern.type === 'Identifier') names.add(pattern.name);
          else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements.filter(Boolean)) bind(element);
          else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) bind(property.type === 'RestElement' ? property.argument : property.value);
          else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
        };
        bind(node.id);
      }
      if (node.type === 'UnaryExpression' && node.operator === 'delete' && this.runtimeReferences(node.argument, names)) valid = false;
      if ((node.type === 'AssignmentExpression' && (this.runtimeReferences(node.left, names) || this.runtimeReferences(node.right, names))) ||
        node.type === 'UpdateExpression' && this.runtimeReferences(node.argument, names)) valid = false;
      if (node.type === 'CallExpression' && (this.runtimeReferences(node.callee, names) || node.arguments.some((argument: Node) => this.runtimeReferences(argument, names))) && !nativeCall(node.callee)) valid = false;
      if (node.type === 'TaggedTemplateExpression' && this.runtimeReferences(node, names)) {
        const imported = model.imports.get(named(node.tag) ?? '');
        if (imported?.source !== 'drizzle-orm' || imported.imported !== 'sql' || imported.typeOnly === true) valid = false;
      }
      for (const [key, value] of Object.entries(node)) {
        if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(key)) continue;
        for (const child of Array.isArray(value) ? value : [value])
          if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node);
      }
    };
    for (let round = 0; round < 32; round += 1) {
      const size = names.size;
      visit(model.program);
      if (!valid) return false;
      if (names.size === size) return true;
    }
    return false;
  }

  /** Only local startup is checked here: known native constructors allocate deferred metadata.
   * The selected hash body and captured binding custody are still proved separately. */
  passiveHashModuleInitialization(model: Model): boolean {
    if (model.executableInitialization) return false;
    const origin = (input: Node, depth = 0): { namespace: string; method: string; calls: number } | null => {
      if (depth > 16) return null;
      const node = unwrap(input);
      if (node.type === 'CallExpression' && !node.optional) {
        const base = origin(node.callee, depth + 1);
        return base === null ? null : { ...base, calls: base.calls + 1 };
      }
      if (node.type !== 'MemberExpression' || node.computed || node.optional || node.object.type !== 'Identifier') return null;
      const imported = model.imports.get(node.object.name);
      return imported?.source === 'effect' && imported.typeOnly !== true && !model.values.has(node.object.name)
        ? { namespace: imported.imported, method: node.property.name, calls: 0 } : null;
    };
    const nativeAllocation = (node: Node): boolean => {
      const base = origin(node);
      if (base === null) return false;
      if (base.namespace === 'Schema') return base.calls === 1 && ['is', 'Struct', 'TaggedStruct', 'Union', 'Array', 'Record', 'Literal', 'Literals', 'fromJsonString', 'makeFilter', 'isMinLength', 'isMaxLength', 'isInt', 'isUUID'].includes(base.method) ||
        base.calls === 2 && ['TaggedError', 'TaggedClass'].includes(base.method);
      if (base.namespace === 'Effect') return base.calls === 1 && base.method === 'succeed' ||
        base.calls === 1 && ['fnUntraced', 'gen', 'sync'].includes(base.method) && node.arguments.length === 1 && fnNode(unwrap(node.arguments[0])) ||
        base.calls === 2 && base.method === 'fn' && node.arguments.length === 1 && fnNode(unwrap(node.arguments[0]));
      if (base.namespace === 'Context') return base.calls === 2 && base.method === 'Service';
      return base.namespace === 'Layer' && base.calls === 1 && ['effect', 'succeed', 'scoped'].includes(base.method);
    };
    const passive = (input: Node, depth = 0): boolean => {
      if (depth > 128) return false;
      const node = unwrap(input);
      if (fnNode(node) || node.type === 'Literal') return true;
      if (node.type === 'Identifier') return node.name === 'undefined' || (model.imports.has(node.name) && model.imports.get(node.name)?.typeOnly !== true) || model.values.has(node.name);
      if (node.type === 'MemberExpression') return !node.computed && !node.optional &&
        !['constructor', '__proto__'].includes(node.property.name) && this.passiveImportedMember(model, node);
      if (node.type === 'ObjectExpression') return node.properties.every((property: Node) => property.type === 'Property' &&
        property.kind === 'init' && !property.computed && !property.method && passive(property.value, depth + 1));
      if (node.type === 'ArrayExpression') return node.elements.every((element: Node | null) => element !== null && element.type !== 'SpreadElement' && passive(element, depth + 1));
      if (node.type === 'CallExpression') return nativeAllocation(node) && node.arguments.every((argument: Node) => passive(argument, depth + 1));
      if (node.type === 'ClassDeclaration') return node.superClass !== null && passive(node.superClass, depth + 1) &&
        node.body.body.every((member: Node) => member.type === 'MethodDefinition' && !member.static && !member.computed);
      return false;
    };
    return [...model.values].every(([name, value]) => model.projections.has(name)
      ? this.passiveImportedMember(model, value, [model.projections.get(name)!]) : passive(value));
  }

  canonicalEnvelope(input: Node, parameter: string): boolean {
    const properties = (node: Node, keys: readonly string[]): Map<string, Node> | null => {
      if (node.type !== 'ObjectExpression' || node.properties.length !== keys.length) return null;
      const found = new Map<string, Node>();
      for (const property of node.properties) {
        const name = key(property.key);
        if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method ||
          name === undefined || !keys.includes(name) || found.has(name)) return null;
        found.set(name, property.value);
      }
      return found;
    };
    const member = (node: Node | undefined, object: string, field: string): boolean => node?.type === 'MemberExpression' &&
      !node.computed && !node.optional && named(node.object) === object && named(node.property) === field;
    const fields = properties(input, ['actionKey', 'normalizedPayload', 'owningModuleKey', 'principal', 'schemaVersion', 'target']);
    if (fields === null) return false;
    for (const field of ['actionKey', 'normalizedPayload', 'owningModuleKey', 'schemaVersion', 'target'])
      if (!member(fields.get(field), parameter, field)) return false;
    const principal = properties(fields.get('principal')!, ['legalEntityId', 'principalId', 'tenantId']);
    return principal !== null && [...principal].every(([field, value]) => value.type === 'MemberExpression' &&
      !value.computed && !value.optional && named(value.property) === field && member(value.object, parameter, 'principal'));
  }

  genuineCoreHash(model: Model, source: string, exportName = 'computeCanonicalValueHash'): boolean {
    const target = this.snapshotImport(model.filename, source);
    const facade = target === null ? null : this.load(target);
    const owner = facade === null ? null : this.snapshotPackage(facade.filename);
    if (facade === null || owner?.metadata.name !== '@app/core-runtime') return false;
    const modules = new Set<Model>();
    const exported = this.snapshotExport(facade, exportName, new Set(), modules);
    if (![...modules].every((module) => this.passiveHashModuleInitialization(module))) return false;
    const fn = exported?.declaration.init;
    if (exported === null || exported.model.executableInitialization || named(exported.declaration.id) !== exportName ||
      this.snapshotPackage(exported.model.filename)?.directory !== owner.directory ||
      fn?.type !== 'ArrowFunctionExpression' || fn.async || fn.params.length !== 1) return false;
    const body = fn.body;
    const root = body.type === 'BlockStatement' && body.body.length === 2 && body.body[0].type === 'VariableDeclaration' &&
      body.body[0].kind === 'const' && body.body[0].declarations.length === 1 && body.body[1].type === 'ReturnStatement'
      ? unwrap(body.body[1].argument) : unwrap(body);
    const sha = root?.arguments?.[0];
    const bytes = sha?.arguments?.[0];
    const input = bytes?.arguments?.[0];
    const parameter = named(fn.params[0]);
    const envelope = input?.arguments?.[0]?.type === 'Identifier' && body.type === 'BlockStatement'
      ? body.body[0].declarations[0] : undefined;
    if (body.type === 'BlockStatement' && (envelope === undefined || named(envelope.id) !== named(input?.arguments?.[0]))) return false;
    const normalized = envelope?.init ?? input?.arguments?.[0];
    const normalizedInput = normalized?.arguments?.[0];
    const seen = normalized?.arguments?.[1];
    const member = root?.callee;
    const hexImport = member?.type === 'MemberExpression' && !member.computed && !member.optional
      ? exported.model.imports.get(named(member.object) ?? '') : undefined;
    const shaImport = exported.model.imports.get(named(sha?.callee) ?? '');
    const byteImport = exported.model.imports.get(named(bytes?.callee) ?? '');
    return parameter !== undefined && ![named(member?.object), named(sha?.callee), named(bytes?.callee), named(input?.callee)].includes(parameter) &&
      root.type === 'CallExpression' && !root.optional && root.arguments.length === 1 &&
      hexImport?.source === 'effect/encoding' && hexImport.imported === 'Hex' && hexImport.typeOnly !== true && member.property.name === 'encode' &&
      sha?.type === 'CallExpression' && !sha.optional && sha.arguments.length === 1 && shaImport?.source === '@noble/hashes/sha2.js' &&
      shaImport.imported === 'sha256' && shaImport.typeOnly !== true && bytes?.type === 'CallExpression' && !bytes.optional &&
      bytes.arguments.length === 1 && byteImport?.source === '@noble/hashes/utils.js' && byteImport.imported === 'utf8ToBytes' &&
      byteImport.typeOnly !== true && input?.type === 'CallExpression' && input.callee.type === 'Identifier' &&
      exported.model.values.get(input.callee.name)?.type === 'ArrowFunctionExpression' && input.arguments.length === 1 &&
      normalized?.type === 'CallExpression' && !normalized.optional && normalized.callee.type === 'Identifier' &&
      exported.model.values.get(normalized.callee.name)?.type === 'ArrowFunctionExpression' && normalized.arguments.length === 2 &&
      ((exportName === 'computeCanonicalValueHash' && named(normalizedInput) === parameter) ||
        (exportName === 'computeActionRequestHash' && this.canonicalEnvelope(normalizedInput, parameter))) && seen?.type === 'NewExpression' && named(seen.callee) === 'WeakSet' &&
      seen.arguments.length === 0 && !exported.model.values.has('WeakSet') && !exported.model.imports.has('WeakSet');
  }

  imported(model: Model, source: string): Model | null {
    if (this.publicCodecs) {
      const filename = this.snapshotImport(model.filename, source);
      return filename === null ? null : this.load(filename);
    }
    if (source.startsWith('@app/')) {
      try {
        return this.load(createRequire(model.filename).resolve(source));
      } catch {
        return null;
      }
    }
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
      if (imported.typeOnly === true) {
        this.resolving.delete(id);
        this.values.set(id, BAD);
        return BAD;
      }
      if (
        imported.source === 'effect' &&
        (['Schema', 'Predicate', 'Result', 'Order', 'DateTime', 'Option', 'SchemaGetter', 'Match', 'Struct', ...(this.strictSchemaExports ? ['SchemaAST'] : [])].includes(
          imported.imported,
        ) || (this.publicCodecs && (imported.imported === 'Effect' || (this.context !== undefined && imported.imported === 'Brand'))))
      ) {
        result = native(`effect:${imported.imported}`);
      } else if (imported.source === 'effect/encoding' && ['Hex', 'Base64Url'].includes(imported.imported))
        result = native(`effect/encoding:${imported.imported}`);
      else if (this.strictSchemaExports && imported.source === '@modern-js/bff-effect/effect-client' && ['Schema', 'HttpApi', 'HttpApiGroup', 'HttpApiEndpoint', 'HttpApiSchema'].includes(imported.imported)) result = native(imported.imported === 'Schema' ? 'effect:Schema' : `http:${imported.imported}`);
      else if (this.strictSchemaExports && imported.source === 'effect/http-api' && imported.imported === 'HttpApiMiddleware') result = native('http:HttpApiMiddleware');
      else if (!this.publicCodecs && imported.source === 'node:crypto' && imported.imported === 'createHash')
        result = native('crypto:createHash');
      else if (NOBLE_DATA_FUNCTIONS.has(`${imported.source}:${imported.imported}`))
        result = native(`noble:${imported.imported}`);
      else if (this.publicCodecs && imported.source === '@app/core-runtime/access/enforcement' &&
        ['computeCanonicalValueHash', 'computeActionRequestHash'].includes(imported.imported) && this.genuineCoreHash(model, imported.source, imported.imported))
        result = { kind: 'function', apply: (args) => {
          if (args.length !== 1 || !(imported.imported === 'computeActionRequestHash' ? isData(args[0]) : isClosedData(args[0]))) return BAD;
          const facade = this.imported(model, imported.source);
          const target = facade === null ? null : this.snapshotExport(facade, imported.imported);
          if (target === null) return BAD;
          this.coreHashDepth += 1;
          const output = this.invoke(this.expression(target.declaration.init, target.model, new Map()), args);
          this.coreHashDepth -= 1;
          return isClosedData(output) && this.hasWire(output) ? output : BAD;
        } };
      else {
        const owner = this.imported(model, imported.source);
        const exported = owner?.exports.get(imported.imported);
        if (owner !== null && exported !== undefined) {
          this.importedExports.set(owner.filename, imported.imported);
          const declaration = owner.values.get(exported);
          const ownerPackage = this.snapshotPackage(owner.filename)?.directory;
          const importingPackage = this.snapshotPackage(model.filename)?.directory;
          const foreign = this.publicCodecs && this.context !== undefined && ownerPackage !== this.context.ownerPath;
          const schemaExpansion = foreign && ownerPackage !== undefined && declaration !== undefined && !fnNode(declaration);
          const internalSchemaFactory = foreign && ownerPackage === importingPackage &&
            (this.schemaExpansionPackages.has(ownerPackage ?? '') || this.erasedSchemaTypes);
          const alreadyExpanding = ownerPackage !== undefined && this.schemaExpansionPackages.has(ownerPackage);
          if (schemaExpansion) this.schemaExpansionPackages.add(ownerPackage!);
          if ((!this.publicCodecs || this.erasedSchemaTypes || this.safeInitialization(owner)) &&
            (declaration === undefined || !fnNode(declaration) || this.erasedSchemaTypes || this.safeInitialization(owner)))
            result = this.value(exported, owner, new Map());
          if (schemaExpansion && !alreadyExpanding) this.schemaExpansionPackages.delete(ownerPackage!);
          if (foreign && !internalSchemaFactory && this.strictSchemaExports && result.kind === 'function' && !imported.source.startsWith('.')) {
            const factory = result;
            result = { kind: 'function', apply: (args) => {
              const expanding = ownerPackage !== undefined && this.schemaExpansionPackages.has(ownerPackage);
              if (ownerPackage !== undefined) this.schemaExpansionPackages.add(ownerPackage);
              const produced = this.invoke(factory, args);
              if (ownerPackage !== undefined && !expanding) this.schemaExpansionPackages.delete(ownerPackage);
              return produced.kind === 'schema' && isClosedData(produced.payload ?? BAD) && isClosedData(produced.encoded ?? produced.payload ?? BAD) ? produced : BAD;
            } };
          } else if (foreign && !internalSchemaFactory && result.kind !== 'schema' && !isClosedData(result)) result = BAD;
        }
      }
    } else if (model.values.has(name)) {
      const declaration = model.values.get(name)!;
      if (this.strictSchemaExports && declaration.type === 'ClassDeclaration' && this.schemaMiddlewareClass(declaration, model)) result = native('http:middleware-metadata');
      else if (this.publicCodecs && declaration.type === 'ClassDeclaration') {
        const shape = this.taggedErrorShape(name, model, false);
        result = isClosedData(shape) ? schema(shape) : BAD;
      } else result = this.expression(declaration, model, new Map());
      const projection = model.projections.get(name);
      if (projection !== undefined) result = this.property(result, projection, model);
    } else if (name === 'undefined') result = this.strictSchemaExports ? { kind: 'data', literal: undefined } : DATA;
    else if (['Object', 'URL', 'Math', 'String', 'Intl', 'Number', ...(this.strictSchemaExports ? ['Reflect'] : [])].includes(name) || (this.publicCodecs && name === 'Array')) result = native(`global:${name}`);
    this.resolving.delete(id);
    this.values.set(id, result);
    if (this.publicCodecs && (this.context !== undefined || this.defaultStructEquivalence) && this.initializationDepth === 0 && result.kind !== 'bad' &&
      (model.values.has(name) || model.imports.has(name) || result.native?.startsWith('global:'))) {
      const captured = this.capturedValues.get(model) ?? new Set<string>();
      captured.add(name);
      this.capturedValues.set(model, captured);
    }
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
      const rawValues = parts.map((part) => this.type(part, model, generics));
      if (this.publicCodecs && rawValues.some((value) => value.native === 'json') && rawValues.every(isClosedData))
        return { kind: 'data', native: 'json' };
      const values = rawValues.map(openData);
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
    const schemaImport = model.imports.get(names[0]);
    if (this.publicCodecs && schemaImport?.source === 'effect' && schemaImport.imported === 'Schema' &&
      ((names.length === 2 && names[1] === 'Type') || (names.length === 3 && names[1] === 'Schema' && names[2] === 'Type'))) {
      const argument = node.typeArguments?.params?.[0] ?? node.typeParameters?.params?.[0];
      // Erased type reconstruction cannot populate runtime proof caches or grant executable authority.
      const proof = this.erasedSchemaTypes ? this : new DataFactoryProof(true, this.context);
      proof.erasedSchemaTypes = true;
      const owner = proof === this ? model : proof.load(model.filename, this.context?.sources.get(model.filename));
      const input = owner === null ? BAD : proof.type(argument, owner, generics);
      return input.kind === 'schema' && isClosedData(input.payload ?? BAD) ? input.payload! : BAD;
    }
    const arguments_ = (node.typeArguments?.params ?? node.typeParameters?.params ?? []).map((argument: Node) =>
      this.type(argument, model, generics),
    );
    if (names.length > 1) {
      const root = model.imports.get(names[0]);
      if (this.publicCodecs && root?.source === 'effect' && root.imported === 'Schema' && names.length === 2 && names[1] === 'Json')
        return { kind: 'data', native: 'json' };
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
      const projection = this.projectType(originNode, model, generics, (field) =>
        name === 'Pick' ? selected.has(field) : !selected.has(field),
      );
      return this.publicCodecs && name === 'Pick' && projection.kind === 'record' &&
        [...(projection.fields?.values() ?? [])].every((value) => value.kind === 'data' && value.native !== 'json')
        ? { ...projection, projectionData: true } : projection;
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
  taggedErrorShape(name: string, model: Model, initialize = true): Value {
    const resolved = this.valueDeclaration(name, model);
    const declaration = resolved?.declaration;
    if (resolved !== null && this.coreHashDepth > 0 && declaration?.type === 'CallExpression' && this.nativeMetadataAllocation(declaration, resolved.model)) {
      const tag = this.expression(declaration.arguments[0], resolved.model, new Map());
      const fields = this.expression(declaration.arguments[1], resolved.model, new Map());
      return typeof tag.literal === 'string' && fields.kind === 'record' && [...(fields.fields?.values() ?? [])].every((field) => field.kind === 'schema' && isClosedData(field.payload ?? BAD))
        ? record(new Map([['_tag', tag], ...[...(fields.fields ?? [])].map(([name, value]) => [name, value.payload ?? BAD] as const)])) : BAD;
    }
    if (resolved === null || declaration?.type !== 'ClassDeclaration' || declaration.body.body.length > 0 ||
      (declaration.decorators?.length ?? 0) > 0) return BAD;
    const base = unwrap(declaration.superClass ?? { type: 'Missing' });
    const factory = base.type === 'CallExpression' ? unwrap(base.callee) : undefined;
    const member = factory?.type === 'CallExpression' ? unwrap(factory.callee) : undefined;
    if (this.publicCodecs && (base.optional || factory?.optional || member?.optional)) return BAD;
    const schemaImport = member?.computed === false ? resolved.model.imports.get(named(member.object) ?? '') : undefined;
    if (schemaImport?.source !== 'effect' || schemaImport.imported !== 'Schema' || member?.property.name !== 'TaggedError' ||
      factory?.arguments.length !== 0 || base.arguments.length !== 2 || (initialize && !(this.publicCodecs && this.initializing.has(resolved.model.filename)) && !this.safeInitialization(resolved.model))) return BAD;
    const tag = this.expression(base.arguments[0], resolved.model, new Map());
    const fields = this.expression(base.arguments[1], resolved.model, new Map());
    if (typeof tag.literal !== 'string' || fields.kind !== 'record' ||
      ![...(fields.fields?.values() ?? [])].every((field) => field.kind === 'schema' && isData(field.payload ?? BAD))) return BAD;
    return record(new Map([['_tag', tag], ...[...(fields.fields ?? [])].map(([name, value]) => [name, value.payload ?? BAD] as const)]));
  }

  taggedError(node: Node, model: Model, env: ReadonlyMap<string, Value>): Value {
    const name = named(node.callee);
    if (name === undefined || env.has(name) || node.arguments.length !== 1) return BAD;
    const shape = this.taggedErrorShape(name, model);
    const input = this.expression(node.arguments[0], model, env);
    const tag = shape.fields?.get('_tag');
    return shape.kind === 'record' && tag !== undefined && input.kind === 'record' && isClosedData(input)
      ? { ...record(new Map([['_tag', tag], ...(input.fields ?? [])])), native: 'tagged-error' } : BAD;
  }

  qualified(node: Node | undefined): string[] | null {
    if (node?.type === 'Identifier') return [node.name];
    if (node?.type !== 'TSQualifiedName') return null;
    const left = this.qualified(node.left);
    return left === null ? null : [...left, node.right.name];
  }

  bind(pattern: Node, input: Value, model: Model, env: Map<string, Value>, local = false): boolean {
    if (pattern.type === 'AssignmentPattern') {
      const fallback = this.expression(pattern.right, model, env);
      if (!isData(fallback)) return false;
      return this.bind(pattern.left, input.kind === 'bad' ? fallback : input, model, env);
    }
    if (pattern.type === 'Identifier') {
      if (this.strictSchemaExports && local && input.kind === 'function' && input.node !== undefined && input.model === model) {
        const captured = new Map(input.env);
        const recursive: Value = { ...input, env: captured };
        captured.set(pattern.name, recursive);
        env.set(pattern.name, recursive);
      } else env.set(pattern.name, input);
      // An immutable local may hold a modeled schema or deferred function. Parameters remain data-only,
      // and only a closed data result can admit the exported factory.
      return local ? input.kind !== 'bad' : isData(input);
    }
    if (pattern.type === 'ArrayPattern') {
      if (input.kind !== 'array' || !(isClosedData(input) || this.strictSchemaExports && this.schemaMetadataResult(input))) return false;
      for (const [index, element] of pattern.elements.entries()) {
        if (
          element !== null &&
          !this.bind(element, this.metadataProjection(input, input.fields?.get(String(index)) ?? input.element ?? BAD), model, env, local || this.strictSchemaExports)
        )
          return false;
      }
      return true;
    }
    if (pattern.type === 'ObjectPattern' && (input.kind === 'data' || input.kind === 'array'))
      return pattern.properties.every(
        (property: Node) =>
          property.type === 'Property' &&
          !property.computed &&
          key(property.key) === 'length' &&
          this.bind(property.value, this.metadataProjection(input, DATA), model, env, local || this.strictSchemaExports),
      );
    if (pattern.type !== 'ObjectPattern' || input.kind !== 'record') return false;
    const omitted = new Set<string>();
    for (const property of pattern.properties) {
      if (this.publicCodecs && property.type === 'RestElement' && property === pattern.properties.at(-1) &&
        named(property.argument) !== undefined && (isClosedData(input) || input.projectionData === true))
        return this.bind(property.argument, { ...record(new Map([...(input.fields ?? [])].filter(([name]) => !omitted.has(name))), input.open),
          ...(input.projectionData === true ? { projectionData: true } : {}), omittedFields: new Set([...(input.omittedFields ?? []), ...omitted]) }, model, env, local);
      const name = key(property.key);
      if (name !== undefined) omitted.add(name);
      if (property.type !== 'Property' || name === undefined || property.computed || property.kind !== 'init')
        return false;
      if (this.strictSchemaExports && metadataOnly(input) && !input.fields?.has(name)) return false;
      if (!this.bind(property.value, this.metadataProjection(input, input.fields?.get(name) ?? DATA), model, env, local || this.strictSchemaExports)) return false;
    }
    return true;
  }

  schemaContextDescriptionClass(node: Node, model: Model): boolean {
    if (!this.strictSchemaExports || node.type !== 'ClassDeclaration' || node.body.body.length !== 0 || (node.decorators?.length ?? 0) !== 0) return false;
    const base = node.superClass === null ? null : unwrap(node.superClass);
    const factory = base?.type === 'CallExpression' ? unwrap(base.callee) : null;
    const member = factory?.type === 'CallExpression' ? unwrap(factory.callee) : null;
    const imported = member?.type === 'MemberExpression' && !member.computed && !member.optional && member.property.name === 'Service' ? model.imports.get(named(member.object) ?? '') : undefined;
    return imported?.source === 'effect' && imported.imported === 'Context' && imported.typeOnly !== true && !base?.optional && !factory?.optional && factory?.arguments.length === 0 && base?.arguments.length === 1 && base.arguments[0].type === 'Literal' && typeof base.arguments[0].value === 'string';
  }

  schemaMiddlewareClass(node: Node, model: Model): boolean {
    if (!this.strictSchemaExports || node.type !== 'ClassDeclaration' || node.body.body.length !== 0 || (node.decorators?.length ?? 0) !== 0) return false;
    const base = node.superClass === null ? null : unwrap(node.superClass);
    const factory = base?.type === 'CallExpression' ? unwrap(base.callee) : null;
    const member = factory?.type === 'CallExpression' ? unwrap(factory.callee) : null;
    const imported = member?.type === 'MemberExpression' && !member.computed && !member.optional && member.property.name === 'Service' ? model.imports.get(named(member.object) ?? '') : undefined;
    if (base?.optional || factory?.optional || imported?.source !== 'effect/http-api' || imported.imported !== 'HttpApiMiddleware' || imported.typeOnly || factory?.arguments.length !== 0 || base?.arguments.length !== 2 || base.arguments[0].type !== 'Literal' || typeof base.arguments[0].value !== 'string') return false;
    const options = this.expression(base.arguments[1], model, new Map());
    const valid = options.kind === 'record' && options.fields?.size === 1 && options.fields.get('error')?.kind === 'schema';
    if (valid) {this.validatedCalls.add(base!);this.validatedCalls.add(factory!);}
    return valid;
  }

  /** Native schema metadata is available only in the schema-value proof, never codec data. */
  nativeSchemaFilter(operation: string, args: readonly Value[]): Value {
    const bound = ['isMinLength', 'isMaxLength', 'isGreaterThanOrEqualTo'].includes(operation);
    if (bound ? args.length !== 1 || typeof args[0].literal !== 'number' : !['isInt', 'isFinite'].includes(operation) || args.length !== 0) return BAD;
    const key = operation === 'isMinLength' ? 'minLength' : operation === 'isMaxLength' ? 'maxLength' : 'minimum';
    const callback = native('schema-filter-callback');
    const constraint = bound ? record(new Map([[key, args[0]], ...(operation === 'isGreaterThanOrEqualTo' ? [['order', callback] as const] : [])])) : record(new Map([['number', { kind: 'data', literal: operation === 'isInt' ? 'integer' : 'finite' }]]));
    const annotations = record(new Map([
      ['expected', DATA],
      ['representation', record(new Map([['id', { kind: 'data', literal: `effect/schema/${operation}` }], ['payload', bound ? record(new Map([[key, args[0]]])) : { kind: 'data', literal: null }]]))],
      ['toJsonSchema', callback], ['toCode', callback], ...(operation === 'isMinLength' || operation === 'isMaxLength' ? [['~structural', { kind: 'data', literal: true }] as const] : []), ['arbitraryConstraint', constraint],
    ]));
    return record(new Map([['_tag', { kind: 'data', literal: 'Filter' }], ['run', callback], ['annotations', annotations], ['aborted', { kind: 'data', literal: false }]]));
  }

  schemaAst(value: Value): Value {
    if (!this.strictSchemaExports || value.kind !== 'schema' || value.astOpaque === true || !isClosedData(value.payload ?? BAD)) return BAD;
    if (value.schemaAst !== undefined) return value.schemaAst;
    const payload = value.payload!;
    const tag = value.astTag;
    if (tag === undefined) return BAD;
    const fields = new Map<string, Value>([['_tag', { kind: 'data', literal: tag }], ['~effect/Schema', { kind: 'data', literal: '~effect/Schema' }], ...['annotations', 'context', 'encoding', 'checks'].map((name): [string, Value] => [name, { kind: 'data', literal: undefined }])]);
    if (['Arrays', 'Objects', 'Union'].includes(tag)) fields.set('encodingChecks', { kind: 'data', literal: undefined });
    if (tag === 'Union') fields.set('options', { kind: 'data', literal: undefined });
    if (tag === 'Arrays') fields.set('isMutable', { kind: 'data', literal: false });
    if (value.astChecks !== undefined) fields.set('checks', { ...array(merge(value.astChecks), value.astChecks.length === 0), fields: new Map(value.astChecks.map((check, index) => [String(index), check])) });
    if (tag === 'Literal') fields.set('literal', payload);
    if (tag === 'Union') {
      if (value.astMembers === undefined) return BAD;
      const children=value.astMembers.map((member)=>this.schemaAst(member));
      if (children.some((child)=>child.kind==='bad')) return BAD;
      fields.set('types', { ...array(merge(children),children.length===0), fields: new Map(children.map((child,index)=>[String(index),child])) });
    }
    if (tag === 'Arrays') {const child=this.schemaAst(value.astElement ?? BAD);if (child.kind === 'bad') return BAD;fields.set('elements', value.astRequiredElement ? { ...array(child), fields: new Map([['0', child]]) } : { ...array(DATA, true), fields: new Map() });fields.set('rest', { ...array(child), fields: new Map([['0', child]]) });}
    // PropertySignature metadata is not inferred from a DTO shape. Unknown native AST
    // categories remain unavailable until their complete own-data graph is modeled.
    if (tag === 'Objects') return BAD;
    return { ...record(fields), native: 'schema-ast', astTag: tag, reflectionSource: value };
  }

  ownsSchemaReflection(value: Value): boolean {
    return value.arrayOwner !== undefined && this.invocations.some((frame) => frame.token === value.arrayOwner);
  }

  schemaReflectionCall(name: string, args: readonly Value[]): Value | undefined {
    if (!this.strictSchemaExports) return undefined;
    const argument = args[0];
    if (['global:Object.entries', 'global:Object.values', 'global:Object.assign', 'global:Object.getOwnPropertyDescriptors', 'global:Object.getOwnPropertyDescriptor', 'global:Reflect.ownKeys'].includes(name) && args.some((value) => value?.native === 'native-schema-prototype' || value?.native === 'opaque-native-metadata' || value?.opaqueMetadata === true || value?.possiblyAbsent === true)) return BAD;
    const owned = (): symbol | undefined => this.invocations.at(-1)?.token;
    const descriptor = (value: Value): Value => ({ ...record(new Map([['value', value], ['enumerable', { kind: 'data', literal: true }], ['writable', DATA], ['configurable', DATA]])), native: 'own-descriptor', ...(owned() === undefined ? {} : { arrayOwner: owned() }) });
    if ((/^http:(?:HttpApi|HttpApiGroup|HttpApiEndpoint)\./u.test(name) || name.startsWith('http-metadata:')) && (this.initializationDepth === 0 || this.invocations.length > 0)) return BAD;
    if (/^http:(?:HttpApi|HttpApiGroup)\.make$/u.test(name) && args.length === 1 && typeof args[0].literal === 'string') return { kind: 'metadata', native: 'http-contract-metadata' };
    if (/^http:HttpApiEndpoint\.(?:get|post|put|patch|del|delete|head|options)$/u.test(name) && args.length === 3 && typeof args[0].literal === 'string' && typeof args[1].literal === 'string' && args[2].kind === 'record' && [...(args[2].fields?.values() ?? [])].every((value) => isClosedData(value) || this.schemaMetadataResult(value))) return { kind: 'metadata', native: 'http-contract-metadata' };
    if (name.startsWith('http-metadata:')) {
      const method = name.slice('http-metadata:'.length);
      const accepts = method === 'add' ? args.every((value) => value.native === 'http-contract-metadata') : method === 'middleware' ? args.every((value) => value.native === 'http:middleware-metadata') : ['prefix', 'annotate'].includes(method) && args.every(isClosedData);
      return args.length > 0 && accepts ? { kind: 'metadata', native: 'http-contract-metadata' } : BAD;
    }
    // Unknown native own values may be arrays, schemas, ASTs, functions or primitives. A
    // predicate cannot narrow them merely because their abstract carrier is a record.
    if (args.length === 1 && (argument.opaqueMetadata === true || argument.possiblyAbsent === true || argument.native === 'opaque-native-metadata') &&
      (name.startsWith('effect:SchemaAST.is') || name.startsWith('effect:Predicate.is') || name === 'effect:Schema.isSchema' || name === 'global:Array.isArray')) return DATA;
    if (name.startsWith('effect:SchemaAST.is') && args.length === 1) {
      const tag = name.slice('effect:SchemaAST.is'.length);
      const actual = argument?.native === 'schema-ast' ? argument.astTag : undefined;
      return { kind: 'data', literal: tag === 'AST' ? actual !== undefined : actual !== undefined && actual === tag };
    }
    if (name === 'effect:Schema.isSchema' && args.length === 1) return { kind: 'data', literal: argument.kind === 'schema' };
    if (name.startsWith('effect:Predicate.is') && args.length === 1) {
      if (argument.native === 'opaque-native-metadata') return DATA;
      const type = name.slice('effect:Predicate.is'.length);
      if (type === 'Function') return { kind: 'data', literal: argument.kind === 'function' || argument.native === 'schema-filter-callback' };
      if (type === 'ObjectKeyword') return { kind: 'data', literal: ['record', 'array', 'schema'].includes(argument.kind) };
      if (type === 'Map' || type === 'Set') return { kind: 'data', literal: argument.native === type.toLowerCase() };
      if (['String', 'Number', 'Boolean'].includes(type) && 'literal' in argument) return { kind: 'data', literal: typeof argument.literal === type.toLowerCase() };
      if (['String', 'Number', 'Boolean'].includes(type) && argument.kind === 'data' && metadataOnly(argument)) return DATA;
    }
    if (name === 'global:Array.isArray' && args.length === 1) return { kind: 'data', literal: argument.kind === 'array' };
    if (name === 'global:Object.getPrototypeOf' && args.length === 1) {
      if (argument.kind === 'schema' || argument.native === 'schema-ast' || argument.kind === 'array') return { ...record(new Map()), native: 'native-schema-prototype', reflectionSource: argument };
      if (argument.kind === 'record' && argument.native === undefined && !argument.open) return { kind: 'data', literal: 'intrinsic:Object.prototype', native: 'schema-object-prototype', reflectionSource: argument };
      return BAD;
    }
    if (name === 'global:Object.getOwnPropertyDescriptors' && args.length === 1) {
      if (argument.kind === 'array' && argument.fields === undefined && !argument.empty) return BAD;
      const fields = argument.kind === 'schema' ? new Map([['ast', this.schemaAst(argument)]]) : ['record', 'array'].includes(argument.kind) && !argument.open ? new Map(argument.fields ?? (argument.kind === 'array' && argument.empty ? [] : undefined)) : undefined;
      if (fields !== undefined && argument.kind === 'array') fields.set('length', argument.fields === undefined ? DATA : { kind: 'data', literal: argument.fields.size });
      if (fields === undefined || [...fields.values()].some((value) => value.kind === 'bad')) return BAD;
      const descriptors = new Map([...fields].map(([name, value]): [string, Value] => {
        let current = argument.ownDescriptors?.get(name) ?? descriptor(value);
        if (argument.kind === 'array' && name === 'length') current = { ...current, fields: new Map([...(current.fields ?? []), ['enumerable', { kind: 'data', literal: false }]]) };
        return [name, current];
      }));
      const opaque = descriptor({ ...record(new Map(), true), native: 'opaque-native-metadata', opaqueMetadata: true });
      const unknown = { ...opaque, native: 'opaque-schema-descriptor', possiblyAbsent: true, fields: new Map([...(opaque.fields ?? []), ['enumerable', DATA]]) };
      return { ...record(descriptors, argument.kind === 'schema'), native: 'descriptor-map', ...(argument.kind === 'schema' ? { element: unknown } : {}), reflectionSource: argument, ...(owned() === undefined ? {} : { arrayOwner: owned() }) };
    }
    if (name === 'global:Object.entries' && args.length === 1 && argument.kind === 'record' && (!argument.open || argument.native === 'descriptor-map')) {
      const pairs = [...(argument.fields ?? [])].map(([name, value]): Value => ({ ...array(merge([{ kind: 'data', literal: name }, value])), fields: new Map([['0', { kind: 'data', literal: name }], ['1', value]]) }));
      if (argument.open && argument.element !== undefined) pairs.push({ ...array(DATA), fields: new Map([['0', DATA], ['1', argument.element]]) });
      return { ...array(merge(pairs), pairs.length === 0), fields: new Map(pairs.map((pair, index) => [String(index), pair])) };
    }
    if (name === 'global:Object.getOwnPropertyDescriptor' && args.length === 2 && argument.kind === 'record' && !argument.open && typeof args[1].literal === 'string') {
      const value = argument.fields?.get(args[1].literal);
      return argument.ownDescriptors?.get(args[1].literal) ?? (value === undefined ? { kind: 'data', literal: undefined } : descriptor(value));
    }
    if (name === 'global:Reflect.ownKeys' && args.length === 1 && argument.kind === 'record' && !argument.open) {
      const values = [...(argument.fields?.keys() ?? [])].map((literal): Value => ({ kind: 'data', literal }));
      return { ...array(merge(values), values.length === 0), fields: new Map(values.map((value, index) => [String(index), value])) };
    }
    if (name === 'global:Object.create' && args.length === 1 && argument.literal === 'intrinsic:Object.prototype' && argument.reflectionSource?.kind === 'record' && owned() !== undefined) return { ...record(new Map()), arrayOwner: owned(), reflectionSource: argument.reflectionSource };
    if (name === 'global:Object.create' && args.length === 1 && argument.native === 'native-schema-prototype' && argument.reflectionSource !== undefined && owned() !== undefined)
      return { ...record(new Map()), native: 'native-schema-copy', reflectionSource: argument.reflectionSource, arrayOwner: owned() };
    if (name === 'global:Object.defineProperties' && args.length === 2 && this.ownsSchemaReflection(argument) && args[1].native === 'descriptor-map') {
      const descriptors = this.arrayState(args[1]);
      const fields = new Map<string, Value>();
      for (const [key, item] of descriptors.fields ?? []) {
        const current = this.arrayState(item);
        if (current.native !== 'own-descriptor') return BAD;
        const value = current.fields?.get('value');
        if (value === undefined || value.kind === 'bad') return BAD;
        fields.set(key, value);
      }
      const source = argument.reflectionSource;
      if (argument.kind === 'array' && descriptors.reflectionSource?.kind === 'array') {
        fields.delete('length');const values = [...fields.values()];const next = { ...array(merge(values), values.length === 0), fields, ownDescriptors: descriptors.fields, arrayOwner: argument.arrayOwner };this.arrayStates.set(argument, next);return next;
      }
      if (argument.native === 'native-schema-copy' && source?.kind === 'schema') {
        const ast = fields.get('ast');
        return descriptors.reflectionSource === source && fields.size === 1 && ast?.native === 'schema-ast' && ast.reflectionSource === source ? { ...source, schemaAst: ast } : BAD;
      }
      if (argument.native === 'native-schema-copy' && source?.native === 'schema-ast' && (fields.get('_tag')?.literal !== source.astTag || fields.get('~effect/Schema')?.literal !== '~effect/Schema')) return BAD;
      const next: Value = argument.native === 'native-schema-copy' && source?.native === 'schema-ast'
        ? { ...record(fields), native: 'schema-ast', astTag: source.astTag, reflectionSource: source.reflectionSource, arrayOwner: argument.arrayOwner }
        : argument.native === undefined ? { ...record(fields), ownDescriptors: descriptors.fields, arrayOwner: argument.arrayOwner } : BAD;
      if (next.kind !== 'bad') this.arrayStates.set(argument, next);
      return next;
    }
    if (name === 'global:Object.defineProperty' && args.length === 3 && argument.kind === 'record' && argument.native === undefined && this.ownsSchemaReflection(argument) && typeof args[1].literal === 'string' && args[2].kind === 'record') {
      const descriptor = this.arrayState(args[2]);
      if (![...(descriptor.fields?.keys() ?? [])].every((name) => ['value', 'enumerable', 'configurable', 'writable'].includes(name)) || !descriptor.fields?.has('value')) return BAD;
      const value = descriptor.fields.get('value')!;
      if (!isClosedData(value) && !this.schemaMetadataResult(value)) return BAD;
      this.arrayStates.set(argument, { ...argument, fields: new Map([...(argument.fields ?? []), [args[1].literal, value]]), ownDescriptors: new Map([...(argument.ownDescriptors ?? []), [args[1].literal, descriptor]]) });
      return argument;
    }
    return undefined;
  }

  schemaMetadataResult(value: Value, depth = 0): boolean {
    if (depth > 64) return false;
    if (this.strictSchemaExports && metadataOnly(value)) return value.kind !== 'bad';
    if (this.strictSchemaExports && value.kind === 'native' && value.native === 'schema-filter-callback') return true;
    if (this.strictSchemaExports && value.kind === 'record' && ['schema-ast', 'native-schema-prototype', 'native-schema-copy'].includes(value.native ?? '')) return value.reflectionSource !== undefined;
    if (value.kind === 'schema') return isClosedData(value.payload ?? BAD) && isClosedData(value.encoded ?? value.payload ?? BAD);
    const children = value.kind === 'record' ? [...(value.fields?.values() ?? [])] : value.kind === 'array' ? (this.strictSchemaExports && value.fields !== undefined ? [...value.fields.values()] : [value.element ?? BAD]) : [];
    return children.length > 0 && children.every((child) => isClosedData(child) || this.schemaMetadataResult(child, depth + 1) || this.strictSchemaExports && child.kind === 'function' && child.node !== undefined && !child.node.async && !child.node.generator && isClosedData(this.invoke(child, []))) &&
      children.some((child) => this.schemaMetadataResult(child, depth + 1));
  }

  codecSpecialization(function_: Value, args: readonly Value[]): boolean {
    if (!this.publicCodecs || this.context === undefined || function_.model === undefined || function_.node === undefined ||
      this.snapshotPackage(function_.model.filename)?.directory !== this.context.ownerPath || args.length !== 4 ||
      args[0].kind !== 'schema' || !isClosedData(args[0].payload ?? BAD) || !isData(args[1]) ||
      typeof args[2].literal !== 'string' ||
      function_.node.params.length !== 4) return false;
    const [schemaParameter, payloadParameter] = function_.node.params.map(named);
    if (schemaParameter === undefined || payloadParameter === undefined) return false;
    let decode = false;
    let encode = false;
    const visit = (node: Node): void => {
      if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'MemberExpression' &&
        !node.callee.optional && !node.callee.computed) {
        const imported = function_.model!.imports.get(named(node.callee.object) ?? '');
        if (imported?.source === 'effect' && imported.imported === 'Schema' && imported.typeOnly !== true &&
          named(node.arguments[0]) === schemaParameter) {
          if (node.callee.property.name === 'decodeUnknownEffect' && node.arguments.length === 2 &&
            node.arguments[1].type === 'ObjectExpression' && node.arguments[1].properties.length === 1 &&
            node.arguments[1].properties[0].type === 'Property' && node.arguments[1].properties[0].kind === 'init' &&
            !node.arguments[1].properties[0].method && !node.arguments[1].properties[0].computed &&
            node.arguments[1].properties[0].value.type === 'Literal' && key(node.arguments[1].properties[0].key) === 'onExcessProperty' &&
            node.arguments[1].properties[0].value.value === 'error') decode = true;
          if (node.callee.property.name === 'encodeEffect' && node.arguments.length === 1) encode = true;
        }
      }
      for (const [field, value] of Object.entries(node)) {
        if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field)) continue;
        for (const child of Array.isArray(value) ? value : [value])
          if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node);
      }
    };
    visit(function_.node.body);
    const callback = args[3].kind === 'function' && args[3].model === function_.model &&
      isClosedData(this.invoke(args[3], [args[0].payload ?? BAD]));
    const fourthType = function_.node.params[3]?.typeAnnotation?.typeAnnotation;
    const generic = fourthType?.type === 'TSTypeReference' ? (function_.node.typeParameters?.params ?? [])
      .find((parameter: Node) => named(parameter.name) === named(fourthType.typeName))?.constraint : fourthType;
    const version = typeof args[3].literal === 'string' && generic?.type === 'TSUnionType' && generic.types.length > 0 &&
      generic.types.every((part: Node) => part.type === 'TSLiteralType' && typeof part.literal.value === 'string') &&
      generic.types.some((part: Node) => part.literal.value === args[3].literal);
    return decode && encode && (callback || version);
  }

  invoke(function_: Value, args: readonly Value[], schemaTransform = false): Value {
    if (function_.apply !== undefined) return function_.apply(args);
    const node = function_.node;
    const model = function_.model;
    const specialization = this.codecSpecialization(function_, args);
    const schemaProducer = this.strictSchemaExports && args.every((value) => isClosedData(value) || this.schemaMetadataResult(value) || value.kind === 'function' && value.model === function_.model) || this.publicCodecs && args.some((value) => value.kind === 'schema') &&
      args.every((value) => isClosedData(value) || (value.kind === 'schema' && isClosedData(value.payload ?? BAD)));
    if (function_.kind !== 'function' || node === undefined || model === undefined || node.async ||
      (node.generator && !(this.publicCodecs && function_.native === 'codec-function')))
      return BAD;
    // Re-enter recursive bodies with generalized data so changing literal arguments cannot hide
    // a reachable branch. Only an already inspected abstract state may close the traversal cycle.
    const active = this.calls.get(node);
    if (active !== undefined && !args.every((value) => isData(value) || this.strictSchemaExports && (this.schemaMetadataResult(value) || value.kind === 'function' && value.model === model) || (this.coreHashDepth > 0 && ['weakset', 'function'].includes(value.kind)))) return BAD;
    const inputs = active === undefined || this.strictSchemaExports ? args : args.map((value) => this.publicCodecs ? this.generalizeCodecData(value) : generalizeData(value));
    const state = JSON.stringify([
      inputs.map((value) => dataState(value)),
      [...(function_.env ?? [])].map(([name, captured]) => [name, dataState(captured)]),
    ]);
    if (active?.includes(state)) return this.coreHashDepth > 0 ? DATA : merge(inputs);
    this.calls.set(node, [...(active ?? []), state]);
    const previouslyValidated = new Set(this.validatedCalls);
    const baselineInputValidation = new Set(this.validatedInputs);
    const generics = new Map<string, Value>();
    for (const parameter of node.typeParameters?.params ?? []) {
      generics.set(named(parameter.name) ?? parameter.name, this.type(parameter.constraint, model));
    }
    const env = new Map(function_.env);
    let valid = true;
    for (const [index, parameter] of node.params.entries()) {
      const pattern = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
      const annotation = pattern.typeAnnotation?.typeAnnotation;
      const originalInput: Value = inputs[index] ?? (this.strictSchemaExports && pattern.optional ? { kind: 'data', literal: undefined } satisfies Value : annotation === undefined ? BAD : openData(this.type(annotation, model, generics)));
      const input: Value = this.publicCodecs && originalInput.inputOrigin === undefined
        ? { ...originalInput, inputOrigin: Symbol() } : originalInput;
      if (!isData(input) && !((schemaTransform || specialization || schemaProducer) && (input.kind === 'schema' || this.strictSchemaExports && this.schemaMetadataResult(input))) && !((specialization || this.strictSchemaExports && input.model === model) && input.kind === 'function') && !(this.coreHashDepth > 0 && ['weakset', 'function'].includes(input.kind))) valid = false;
      if (!this.bind(parameter, input, model, env, schemaTransform || specialization || schemaProducer || this.coreHashDepth > 0)) valid = false;
    }
    this.invocations.push({ node, model, token: Symbol() });
    let result = valid
      ? node.body.type === 'BlockStatement'
        ? this.statements(node.body.body, model, env)
        : this.expression(node.body, model, env)
      : BAD;
    if (schemaProducer && !specialization && !schemaTransform && !this.schemaMetadataResult(result) && !(this.strictSchemaExports && isClosedData(result))) result = BAD;
    const frame = this.invocations.at(-1);
    const parent = this.invocations.at(-2);
    result = this.arrayState(result);
    if (frame !== undefined && parent !== undefined && (isClosedData(result) || this.strictSchemaExports && this.schemaMetadataResult(result)))
      result = this.transferFreshOwners(result, frame.token, parent.token);
    this.invocations.pop();
    if (active === undefined) this.calls.delete(node);
    else this.calls.set(node, active);
    if (this.publicCodecs && this.hasWire(result)) result = this.wired(result);
    if (this.publicCodecs && function_.native === 'codec-function')
      result = isClosedData(result) ? { kind: 'codec-effect', payload: result } : BAD;
    if (this.publicCodecs) {
      if (result.kind === 'codec-effect') result = { ...result, validationInputs: [
        ...(result.validationInputs ?? []),
        ...[...this.validatedInputs].filter((token) => !baselineInputValidation.has(token))
          .map((inputOrigin): Value => ({ kind: 'data', inputOrigin })),
      ] };
      this.validatedInputs.clear();
      for (const token of baselineInputValidation) this.validatedInputs.add(token);
    }
    if (!isData(result) && !(this.strictSchemaExports && this.schemaMetadataResult(result)) && !(result.kind === 'codec-effect' && isClosedData(result.payload ?? BAD)) && !(this.publicCodecs && result.kind === 'schema')) {
      for (const call of this.validatedCalls) if (!previouslyValidated.has(call)) this.validatedCalls.delete(call);
    }
    return result;
  }

  statements(statements: readonly Node[], model: Model, env: Map<string, Value>): Value {
    const returns: Value[] = [];
    const completion = this.block(statements, model, env, returns);
    if (completion === 'bad') return BAD;
    if (completion === 'falls') returns.push({ kind: 'data', literal: undefined });
    const result = merge(returns);
    return this.publicCodecs ? { ...result, wireBoundary: returns.length > 0 && returns.every((value) => value.failureOnly === true || this.hasWire(value)), failureOnly: returns.every((value) => value.failureOnly === true) } : result;
  }

  /**
   * Collects every reachable return value. A block that may complete without returning reports
   * `falls`; only its function body turns that into an `undefined` result.
   */
  block(statements: readonly Node[], model: Model, env: Map<string, Value>, returns: Value[]): Completion {
    const nested = (part: Node | null, scope: Map<string, Value>): Completion =>
      part === null ? 'falls' : this.block(part.type === 'BlockStatement' ? part.body : [part], model, scope, returns);
    for (const node of statements) {
      if (node.type === 'VariableDeclaration' && node.kind === 'const') {
        for (const declaration of node.declarations) {
          const value = this.expression(declaration.init, model, env);
          if (!this.bind(declaration.id, value, model, env, true)) return 'bad';
        }
      } else if (node.type === 'VariableDeclaration' && node.kind === 'let') {
        for (const declaration of node.declarations) {
          const name = named(declaration.id);
          if (name === undefined) return 'bad';
          if (declaration.init !== null && !isClosedData(this.expression(declaration.init, model, env))) return 'bad';
          env.set(name, MUTABLE);
        }
      } else if (node.type === 'ReturnStatement') {
        const returned = node.argument === null ? { kind: 'data', literal: undefined } satisfies Value : this.expression(node.argument, model, env);
        returns.push(this.publicCodecs ? { ...returned, wireBoundary: returned.failureOnly === true || this.hasWire(returned) } : returned);
        return 'returns';
      } else if (node.type === 'ExpressionStatement') {
        const expression = this.expression(node.expression, model, env);
        if (!isData(expression) && !(this.strictSchemaExports && this.schemaMetadataResult(expression))) return 'bad';
      } else if ((this.coreHashDepth > 0 || this.strictSchemaExports) && node.type === 'ThrowStatement') {
        const error = this.expression(node.argument, model, env);
        if (error.native !== 'tagged-error' || !isClosedData(error)) return 'bad';
        return 'returns';
      } else if (node.type === 'IfStatement') {
        const test = this.expression(node.test, model, env);
        if (!this.controlData(test)) return 'bad';
        if (this.publicCodecs && typeof test.literal === 'boolean') {
          const branch = nested(test.literal ? node.consequent : node.alternate, new Map(env));
          if (branch !== 'falls') return branch;
          continue;
        }
        const baselineValidation = new Set(this.validatedInputs);
        const consequentEnv = new Map(env);
        if (this.publicCodecs) this.refineJsonGuard(node.test, model, consequentEnv);
        const consequent = nested(node.consequent, consequentEnv);
        const consequentValidation = new Set(this.validatedInputs);
        this.validatedInputs.clear();
        for (const token of baselineValidation) this.validatedInputs.add(token);
        const alternate = nested(node.alternate, new Map(env));
        const alternateValidation = new Set(this.validatedInputs);
        this.validatedInputs.clear();
        for (const token of baselineValidation) this.validatedInputs.add(token);
        if (consequent === 'falls' && alternate === 'falls')
          for (const token of consequentValidation) if (alternateValidation.has(token)) this.validatedInputs.add(token);
        if (consequent === 'bad' || alternate === 'bad') return 'bad';
        if (consequent === 'returns' && alternate === 'returns') return 'returns';
      } else if (
        node.type === 'ForOfStatement' &&
        node.await !== true &&
        node.left.type === 'VariableDeclaration' &&
        node.left.kind === 'const'
      ) {
        const source = this.expression(node.right, model, env);
        if (this.strictSchemaExports && source.kind === 'array' && source.fields !== undefined && source.fields.size <= 256) {
          for (const element of source.fields.values()) {
            const loop = new Map(env);
            if (!this.bind(node.left.declarations[0].id, element, model, loop, true) || nested(node.body, loop) === 'bad') return 'bad';
          }
          continue;
        }
        const iterable = this.iterable(source);
        if (iterable.kind !== 'array') return 'bad';
        const loop = new Map(env);
        if (!this.bind(node.left.declarations[0].id, iterable.element ?? BAD, model, loop)) return 'bad';
        // The body may run zero times, so the loop itself always falls through; its returns still count.
        if (nested(node.body, loop) === 'bad') return 'bad';
      } else return 'bad';
    }
    return 'falls';
  }

  refineJsonGuard(node: Node, model: Model, env: Map<string, Value>): void {
    if (node.type !== 'CallExpression' || node.arguments.length !== 1 || node.arguments[0].type !== 'Identifier') return;
    const callee = this.expression(node.callee, model, env);
    const name = node.arguments[0].name;
    const value = env.get(name);
    if (!isClosedData(value ?? BAD)) return;
    if (callee.native === 'global:Array.isArray') env.set(name, array({ kind: 'data', native: 'json' }));
    if (this.coreHashDepth > 0 && ['effect:Predicate.isBigInt', 'effect:Predicate.isDate', 'effect:Predicate.isNumber', 'effect:Predicate.isBoolean', 'effect:Predicate.isString'].includes(callee.native ?? '')) env.set(name, DATA);
    if (callee.native === 'effect:Predicate.isObject' || (this.coreHashDepth > 0 && callee.native === 'effect:Predicate.isObjectKeyword')) env.set(name, { ...record(new Map()), native: 'json-object', element: { kind: 'data', native: 'json' } });
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
    if (value.kind === 'record' && value.native === 'map') return value.payload ?? BAD;
    return value.kind === 'record' && value.native === 'set' ? (value.payload ?? BAD) : BAD;
  }

  spread(node: Node, model: Model, env: ReadonlyMap<string, Value>): Value {
    return this.iterable(this.expression(node.argument, model, env));
  }

  property(input: Value, name: string, model: Model): Value {
    return this.metadataProjection(input, this.propertyInner(input, name, model));
  }

  propertyInner(input: Value, name: string, model: Model): Value {
    const value = this.normalizeNative(input);
    if (this.strictSchemaExports && value.native === 'http-contract-metadata' && ['add', 'middleware', 'prefix', 'annotate'].includes(name)) return native(`http-metadata:${name}`);
    if (this.coreHashDepth > 0 && value.kind === 'weakset' && ['has', 'add', 'delete'].includes(name))
      return { kind: 'native', native: `weakset:${name}`, payload: value };

    if (value.kind === 'record' && value.native === 'map' && ['has', 'get', 'set', 'delete', 'entries'].includes(name))
      return { kind: 'native', native: `map:${name}`, payload: value };
    if (value.kind === 'record' && value.native === 'set' && ['has', 'add'].includes(name))
      return { kind: 'native', native: `set:${name}`, payload: value };
    if (value.kind === 'record' && ['result', 'option'].includes(value.native ?? '') && name === 'pipe')
      return { kind: 'native', native: `${value.native}:pipe`, payload: value };
    if (value.kind === 'record') {
      if (value.omittedFields?.has(name)) return { kind: 'data', literal: undefined };
      // A record's element only stands for its own keys. An inherited Object member (`toString`,
      // `constructor`, `__proto__`, ...) is not one of them, so it falls through to the guard below.
      const field = value.fields?.get(name) ?? (name in Object.prototype ? undefined : value.element);
      if (field !== undefined) return field;
      // A closed plain-data record has no other own field. Inherited Object members and the members
      // of a native object behind a record stay unmodeled.
      return value.open !== true && value.native === undefined && !(name in Object.prototype)
        ? { kind: 'data', literal: undefined }
        : BAD;
    }
    if (value.kind === 'data' && value.native === 'regexp') return native(`regexp:${name}`);
    if (value.kind === 'schema') {
      if (this.strictSchemaExports && name === 'ast') return this.schemaAst(value);
      if (name === 'Type') return value.payload ?? BAD;
      if (name === 'Encoded') return value.encoded ?? value.payload ?? BAD;
      if (name === 'members') return array(value);
      if (name === 'literals') return array(DATA);
      if (name === 'fields' && this.defaultStructEquivalence)
        return value.defaultEquivalenceKind === 'struct' && value.astOpaque !== true && value.defaultEquivalenceOptional !== true &&
          value.astFields !== undefined ? record(new Map(value.astFields)) : BAD;
      if (name === 'fields')
        return value.payload?.kind === 'record'
          ? record(
              new Map(
                [...(value.payload.fields ?? [])].map(([field, payload]) => [
                  field,
                  schema(payload, value.encoded?.fields?.get(field) ?? payload),
                ]),
              ),
            )
          : BAD;
      return { kind: 'native', native: `schema:${name}`, payload: value };
    }
    if (value.kind === 'matcher' && name === 'pipe') return { kind: 'native', native: 'matcher:pipe', payload: value };
    if (this.publicCodecs && value.kind === 'codec-effect' && name === 'pipe')
      return { kind: 'native', native: 'codec:pipe', payload: value };
    if (value.kind === 'getter' && name === 'pipe') return { kind: 'native', native: 'getter:pipe', payload: value };
    if (value.kind === 'native') return this.normalizeNative(native(`${value.native}.${name}`));
    if (name === 'length' && (value.kind === 'array' || value.kind === 'data')) return DATA;
    if (value.kind === 'array' || value.kind === 'data')
      return { kind: 'native', native: `data:${name}`, payload: value };
    if (value.kind === 'hash') return { kind: 'native', native: `hash:${name}`, payload: value };
    return BAD;
  }

  expression(input: Node | undefined | null, model: Model, env: ReadonlyMap<string, Value>): Value {
    if (input === undefined || input === null || ++this.steps > (this.strictSchemaExports ? 64_000 : 30_000)) return BAD;
    const node = unwrap(input);
    if (fnNode(node)) return { kind: 'function', node, model, env: new Map(env) };
    if (this.publicCodecs && node.type === 'YieldExpression' && node.delegate === true) {
      const effect = this.expression(node.argument, model, env);
      if (effect.kind !== 'codec-effect' || !isClosedData(effect.payload ?? BAD)) return BAD;
      for (const value of effect.validationInputs ?? [])
        if (value.inputOrigin !== undefined) this.validatedInputs.add(value.inputOrigin);
      return effect.payload!;
    }
    if (node.type === 'Identifier') return this.value(node.name, model, env);
    if (node.type === 'Literal')
      return node.regex === undefined ? { kind: 'data', literal: node.value } : { kind: 'data', native: 'regexp' };
    if (node.type === 'TemplateLiteral') {
      const parts = node.expressions.map((part: Node) => this.expression(part, model, env));
      return parts.every(isData) ? (this.publicCodecs && parts.some((part: Value) => this.hasWire(part)) ? this.wired(DATA) : DATA) : BAD;
    }
    if (node.type === 'ArrayExpression') {
      const elements: Value[] = [];
      for (const part of node.elements.filter(Boolean)) {
        const spread = part.type === 'SpreadElement' ? this.spread(part, model, env) : undefined;
        if (spread?.kind === 'bad') return BAD;
        if (spread?.empty !== true) elements.push(spread?.element ?? this.expression(part, model, env));
      }
      if (elements.some((element: Value) => element.kind === 'bad')) return BAD;
      const owner = this.invocationOwner(node, model);
      const positions = node.elements.every((part: Node | null) => part !== null && part.type !== 'SpreadElement')
        ? new Map(elements.map((value, index) => [String(index), value]))
        : undefined;
      return {
        ...array(merge(elements), elements.length === 0),
        ...(positions === undefined ? {} : { fields: positions }),
        ...(owner === undefined ? {} : { arrayOwner: owner }),
      };
    }
    if (node.type === 'ObjectExpression') {
      const fields = new Map<string, Value>();
      const omittedFields = new Set<string>();
      let open = false;
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const value = this.expression(property.argument, model, env);
          if (value.kind !== 'record' || this.strictSchemaExports && metadataOnly(value) && value.native !== 'own-descriptor') return BAD;
          for (const name of [...omittedFields]) if (value.open && !value.omittedFields?.has(name)) omittedFields.delete(name);
          if (!open) for (const name of value.omittedFields ?? []) if (!fields.has(name)) omittedFields.add(name);
          if (value.open) open = true;
          for (const [name, field] of value.fields ?? []) {fields.set(name, field);omittedFields.delete(name);}
        } else {
          // A computed key is admitted only when it is a known string literal; any other key could
          // overwrite an arbitrary field.
          const computed = property.computed ? this.expression(property.key, model, env) : undefined;
          const name =
            computed === undefined
              ? key(property.key)
              : typeof computed.literal === 'string'
                ? computed.literal
                : undefined;
          if (property.kind !== 'init' || property.method || name === undefined) return BAD;
          const value = this.expression(property.value, model, env);
          if (value.kind === 'bad') return BAD;
          fields.set(name, value);
          omittedFields.delete(name);
        }
      }
      const owner = this.invocationOwner(node, model);
      return { ...record(fields, open), ...(this.strictSchemaExports && node.properties.some((property: Node) => property.type === 'SpreadElement' && metadataOnly(this.expression(property.argument, model, env))) ? { metadataTaint: true } : {}), ...(this.publicCodecs && omittedFields.size > 0 ? { omittedFields } : {}), ...(owner === undefined ? {} : { arrayOwner: owner }) };
    }
    if (node.type === 'MemberExpression') {
      const owner = this.expression(node.object, model, env);
      if (
        node.optional &&
        owner.kind === 'data' &&
        'literal' in owner &&
        (owner.literal === undefined || owner.literal === null)
      )
        return { kind: 'data', literal: undefined };
      if (!node.computed) return this.property(owner, node.property.name, model);
      if (node.property.type === 'Literal' && typeof node.property.value === 'string')
        return this.property(owner, node.property.value, model);
      if (['array', 'data'].includes(owner.kind) && this.expression(node.property, model, env).native === 'number')
        return this.metadataProjection(owner, owner.kind === 'array' ? (owner.element ?? BAD) : DATA);
      if (
        node.property.type === 'Literal' &&
        typeof node.property.value === 'number' &&
        ['array', 'data'].includes(owner.kind)
      )
        return this.metadataProjection(owner, owner.kind === 'array' ? (owner.fields?.get(String(node.property.value)) ?? owner.element ?? BAD) : DATA);
      return BAD;
    }
    if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Map' &&
      !model.values.has('Map') &&
      !model.imports.has('Map') &&
      !env.has('Map')
    ) {
      const args = node.arguments.map((part: Node) => this.expression(part, model, env));
      if (args.length > 1 || !args.every(isClosedData)) return BAD;
      const entries = args[0] === undefined ? array(DATA, true) : this.iterable(args[0]);
      const pair = entries.element;
      if (
        entries.kind !== 'array' ||
        (entries.empty !== true && (pair?.kind !== 'array' || pair.fields?.size !== 2 || !isClosedData(pair)))
      )
        return BAD;
      const owner = this.invocationOwner(node, model);
      return {
        ...record(new Map([['size', DATA]])),
        native: 'map',
        ...(this.strictSchemaExports && args.length === 0 ? { metadataEntries: new Map<Value, Value>() } : {}),
        payload: entries,
        ...(owner === undefined ? {} : { arrayOwner: owner }),
      };
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
    if (this.coreHashDepth > 0 && node.type === 'NewExpression' && named(node.callee) === 'WeakSet' &&
      !model.values.has('WeakSet') && !model.imports.has('WeakSet') && !env.has('WeakSet') && node.arguments.length === 0) {
      const owner = this.invocationOwner(node, model);
      const captured = this.capturedValues.get(model) ?? new Set<string>();
      captured.add('WeakSet');
      this.capturedValues.set(model, captured);
      return owner === undefined ? BAD : { kind: 'weakset', arrayOwner: owner };
    }
    if (this.strictSchemaExports && node.type === 'NewExpression' && named(node.callee) === 'TypeError' && !model.values.has('TypeError') && !model.imports.has('TypeError') && !env.has('TypeError') && node.arguments.length === 1 && isClosedData(this.expression(node.arguments[0], model, env))) return { kind: 'data', native: 'tagged-error' };
    if (node.type === 'NewExpression') return this.taggedError(node, model, env);
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const left = unwrap(node.left);
      if (left.type === 'MemberExpression' && !left.optional) {
        const owner = this.arrayState(this.expression(left.object, model, env));
        const field = left.computed
          ? left.property.type === 'Literal' && typeof left.property.value === 'string'
            ? left.property.value
            : undefined
          : named(left.property);
        const assigned = this.expression(node.right, model, env);
        if (this.strictSchemaExports && owner.native === 'own-descriptor' && field === 'value' && this.ownsSchemaReflection(owner) && (isClosedData(assigned) || this.schemaMetadataResult(assigned))) {
          this.arrayStates.set(owner, { ...owner, fields: new Map([...(owner.fields ?? []), [field, assigned]]) });
          this.validatedReflectionWrites.add(node);
          return assigned;
        }
        if (
          owner.kind !== 'record' ||
          owner.native !== undefined ||
          owner.open === true ||
          owner.arrayOwner === undefined ||
          (owner.arrayOwner !== this.invocations.at(-1)?.token && !(this.strictSchemaExports && this.ownsSchemaReflection(owner))) ||
          field === undefined ||
          ['__proto__', 'prototype', 'constructor'].includes(field) ||
          !isClosedData(owner) ||
          !isClosedData(assigned) ||
          this.containsIdentity(assigned, owner)
        )
          return BAD;
        this.arrayStates.set(owner, { ...owner, fields: new Map([...(owner.fields ?? []), [field, assigned]]) });
        return assigned;
      }
    }
    if (node.type === 'AssignmentExpression')
      return node.left.type === 'Identifier' &&
        env.get(node.left.name) === MUTABLE &&
        isClosedData(this.expression(node.right, model, env))
        ? DATA
        : BAD;
    if (node.type === 'ConditionalExpression') {
      const test = this.expression(node.test, model, env);
      if (!this.controlData(test)) return BAD;
      if (typeof test.literal === 'boolean') return this.expression(test.literal ? node.consequent : node.alternate, model, env);
      const baseline = new Set(this.validatedInputs);
      const consequent = this.expression(node.consequent, model, env);
      const consequentWire = consequent.failureOnly === true || this.hasWire(consequent);
      this.validatedInputs.clear();
      for (const token of baseline) this.validatedInputs.add(token);
      const alternate = this.expression(node.alternate, model, env);
      const alternateWire = alternate.failureOnly === true || this.hasWire(alternate);
      this.validatedInputs.clear();
      for (const token of baseline) this.validatedInputs.add(token);
      const result = merge([consequent, alternate]);
      if (!this.publicCodecs) return result;
      return this.hasWire(test) ? this.wired(result) : { ...result, wireBoundary: (consequentWire || test.truthyWire === true) && (alternateWire || test.falsyWire === true),
        failureOnly: consequent.failureOnly === true && alternate.failureOnly === true };
    }
    if (this.publicCodecs && node.type === 'LogicalExpression') {
      const left = this.expression(node.left, model, env);
      if (!this.controlData(left)) return BAD;
      const known = 'literal' in left ? Boolean(left.literal) : ['array', 'record'].includes(left.kind) ? true : undefined;
      const nullish = 'literal' in left ? left.literal === undefined || left.literal === null : ['array', 'record'].includes(left.kind) ? false : undefined;
      if ((node.operator === '||' && known === true) || (node.operator === '&&' && known === false) || (node.operator === '??' && nullish === false)) return left;
      const baseline = new Set(this.validatedInputs);
      const right = this.expression(node.right, model, env);
      this.validatedInputs.clear();
      for (const token of baseline) this.validatedInputs.add(token);
      if (!this.controlData(right)) return BAD;
      if ((node.operator === '||' && known === false) || (node.operator === '&&' && known === true) || (node.operator === '??' && nullish === true)) return right;
      const leftWire = this.hasWire(left);
      const rightWire = this.hasWire(right);
      const lt = leftWire || left.truthyWire === true;
      const lf = leftWire || left.falsyWire === true;
      const rt = rightWire || right.truthyWire === true;
      const rf = rightWire || right.falsyWire === true;
      return { ...merge([left, right]), wireBoundary: leftWire && rightWire,
        truthyWire: node.operator === '&&' ? lt || rt : node.operator === '||' ? lt && (lf || rt) : leftWire && rightWire,
        falsyWire: node.operator === '&&' ? lf && (lt || rf) : node.operator === '||' ? lf || rf : leftWire && rightWire };
    }
    if (['BinaryExpression', 'LogicalExpression'].includes(node.type)) {
      if (this.strictSchemaExports && node.operator === 'in') {
        const left = this.expression(node.left, model, env), right = this.expression(node.right, model, env);
        return this.metadataProjection(right, typeof left.literal === 'string' && right.kind === 'record' ? right.fields?.has(left.literal) ? { kind: 'data', literal: true } : DATA : BAD);
      }
      const left = this.expression(node.left, model, env);
      const right = this.expression(node.right, model, env);
      if (this.strictSchemaExports && ['===', '!=='].includes(node.operator)) {
        if ([left, right].some((value) => value.possiblyAbsent === true || value.opaqueMetadata === true)) return { kind: 'data', metadataTaint: true };
        if ('literal' in left && 'literal' in right) return { kind: 'data', ...(metadataOnly(left) || metadataOnly(right) ? { metadataTaint: true } : {}), literal: node.operator === '===' ? left.literal === right.literal : left.literal !== right.literal };
        const missing = (value: Value): boolean => value.kind === 'data' && 'literal' in value && value.literal === undefined;
        if (this.schemaMetadataResult(left) && missing(right) || this.schemaMetadataResult(right) && missing(left)) return { kind: 'data', metadataTaint: true, literal: node.operator === '!==' };
      }
      if (!this.controlData(left) || !this.controlData(right)) return BAD;
      if (this.publicCodecs && (this.hasWire(left) || this.hasWire(right))) return this.wired(DATA);
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
      if (
        node.type === 'LogicalExpression' &&
        node.operator === '??' &&
        (left.literal === undefined || left.literal === null) &&
        'literal' in left
      )
        return right;
      const numeric = (value: Value) => value.native === 'number' || typeof value.literal === 'number';
      if (
        node.type === 'BinaryExpression' &&
        ['+', '-', '*', '/', '%', '**'].includes(node.operator) &&
        numeric(left) &&
        numeric(right)
      )
        return { kind: 'data', native: 'number' };
      return node.type === 'LogicalExpression' ? merge([left, right]) : this.strictSchemaExports && (metadataOnly(left) || metadataOnly(right)) ? { ...DATA, metadataTaint: true } : DATA;
    }
    if (this.strictSchemaExports && node.type === 'UnaryExpression' && node.operator === '!') {
      const value = this.expression(node.argument, model, env);
      return this.metadataProjection(value, 'literal' in value ? { kind: 'data', literal: !value.literal } : this.controlData(value) ? DATA : BAD);
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
    let result = callee.kind === 'native' ? this.nativeCall(callee, args) : this.invoke(callee, args);
    if (this.strictSchemaExports && result.kind !== 'schema' && result.kind !== 'bad' && (metadataOnly(callee.payload ?? BAD) || args.some(metadataOnly))) result = { ...result, metadataTaint: true };
    if (isData(result) || (this.publicCodecs && (result.kind === 'schema' || this.strictSchemaExports && this.schemaMetadataResult(result) || (result.kind === 'codec-effect' && isClosedData(result.payload ?? BAD))))) this.validatedCalls.add(node);
    return result;
  }

  withoutDefaultEquivalence(value: Value): Value {
    if (value.kind === 'schema') return {...value, defaultEquivalenceKind: undefined, astOpaque: true};
    if (value.kind === 'transform' && value.apply !== undefined) {
      const apply = value.apply;
      return {...value, apply: (inputs) => this.withoutDefaultEquivalence(apply(inputs))};
    }
    return value;
  }

  nativeCall(callee: Value, args: readonly Value[]): Value {
    const result = this.nativeCallInner(callee, args);
    if (!this.defaultStructEquivalence) return result;
    const name = callee.native ?? '';
    return name.startsWith('effect:Schema.') && !['Struct', 'Literal', 'optionalKey', 'brand', 'check', 'isMinLength', 'isMaxLength', 'isUUID', 'isPattern'].includes(name.slice('effect:Schema.'.length))
      ? this.withoutDefaultEquivalence(result) : result;
  }

  nativeCallInner(callee: Value, args: readonly Value[]): Value {
    const name = callee.native ?? '';
    const reflected = this.schemaReflectionCall(name, args);
    if (reflected !== undefined) return reflected;
    if (this.publicCodecs && this.context !== undefined && name === 'effect:Brand.nominal' && args.length === 0)
      return { kind: 'function', apply: (values) => values.length === 1 && isClosedData(values[0]) ? values[0] : BAD };
    if (this.strictSchemaExports && ['http:HttpApiSchema.asJson', 'http:HttpApiSchema.status'].includes(name) && args.length === 1 && isClosedData(args[0])) return { kind: 'transform', apply: (values) => values.length === 1 && values[0].kind === 'schema' ? values[0] : BAD };
    if (this.strictSchemaExports && name === 'global:Object.assign' && args.length >= 1 && args[0].kind === 'record' && args[0].arrayOwner === this.invocations.at(-1)?.token) {
      const fields = new Map(args[0].fields);
      for (const argument of args.slice(1)) {
        if (argument.kind === 'data' && 'literal' in argument && (argument.literal === undefined || argument.literal === null)) continue;
        if (argument.kind !== 'record' || argument.open || ![...(argument.fields?.values() ?? [])].every((value) => isClosedData(value) || this.schemaMetadataResult(value))) return BAD;
        for (const [key, value] of argument.fields ?? []) fields.set(key, value);
      }
      return { ...args[0], fields };
    }
    if (this.publicCodecs && (name.startsWith('effect:Effect.') || name === 'codec:pipe'))
      return this.codecEffectCall(callee, args);
    if (
      ['effect:DateTime.formatIso', 'effect:DateTime.formatIsoDateUtc', 'effect:DateTime.makeUnsafe'].includes(name) &&
      args.length === 1 &&
      args.every(isData)
    )
      return DATA;
    if (name === 'effect:DateTime.make' && args.length === 1 && args.every(isData))
      return {
        ...record(
          new Map([
            ['_tag', DATA],
            ['value', DATA],
          ]),
        ),
        native: 'option',
      };
    if (name === 'effect:DateTime.Order' && args.length === 2 && args.every(isData)) return DATA;
    if (name === 'effect:DateTime.toEpochMillis' && args.length === 1 && args.every(isData)) return DATA;
    if (name === 'effect:DateTime.add' && args.length === 2 && args.every(isData)) return DATA;
    if (name === 'effect:Match.value' && args.length === 1 &&
      (isClosedData(args[0]) || (this.publicCodecs && isData(args[0])) || this.strictSchemaExports && this.schemaMetadataResult(args[0])))
      return { kind: 'matcher', payload: args[0] };
    if (
      name === 'effect:Match.tag' &&
      args.length >= 2 &&
      args.slice(0, -1).every(isClosedData) &&
      args.at(-1)?.kind === 'function'
    )
      return {
        kind: 'function',
        apply: (values) => {
          const matcher = values[0];
          if (values.length !== 1 || matcher?.kind !== 'matcher') return BAD;
          const tag = matcher.payload?.fields?.get('_tag');
          if (this.strictSchemaExports && typeof tag?.literal === 'string' && args.slice(0, -1).every((value) => typeof value.literal === 'string') && !args.slice(0, -1).some((value) => value.literal === tag.literal)) return matcher;
          const result = this.invoke(args.at(-1)!, [matcher.payload ?? BAD]);
          return (isClosedData(result) || (this.publicCodecs && isFactoryResult(result)) || this.strictSchemaExports && this.schemaMetadataResult(result))
            ? { ...matcher, element: matcher.element === undefined ? result : merge([matcher.element, result]) }
            : BAD;
        },
      };
    if (
      name === 'effect:Match.tags' &&
      args.length === 1 &&
      args[0]?.kind === 'record' &&
      [...(args[0].fields?.values() ?? [])].every((value) => value.kind === 'function')
    )
      return {
        kind: 'function',
        apply: (values) => {
          const matcher = values[0];
          if (values.length !== 1 || matcher?.kind !== 'matcher') return BAD;
          const results = [...(args[0].fields?.values() ?? [])].map((fn) => this.invoke(fn, [matcher.payload ?? BAD]));
          return results.every(isClosedData)
            ? { ...matcher, element: merge([...(matcher.element === undefined ? [] : [matcher.element]), ...results]) }
            : BAD;
        },
      };
    if (name === 'matcher:pipe') {
      let matcher = callee.payload ?? BAD;
      for (const arg of args) matcher = this.invoke(arg, [matcher]);
      return matcher;
    }
    if (
      name === 'effect:Struct.omit' &&
      args.length === 2 &&
      args[0]?.kind === 'record' &&
      args[0].open !== true &&
      args[1]?.kind === 'array' &&
      args[1].fields !== undefined
    ) {
      const keys = [...args[1].fields.values()];
      if (keys.some((value) => typeof value.literal !== 'string')) return BAD;
      const omitted = new Set(keys.map((value) => value.literal));
      return record(new Map([...(args[0].fields ?? [])].filter(([key]) => !omitted.has(key))));
    }
    if (
      ['global:Number.isSafeInteger', 'global:Number.isFinite'].includes(name) &&
      args.length === 1 &&
      args.every((value) => this.controlData(value))
    )
      return DATA;
    if (name === 'global:Number' && args.length === 1 && args.every(isData)) return { kind: 'data', native: 'number' };
    if (name === 'global:String' && args.length === 1 && args.every(isData)) return DATA;
    if (name === 'global:Intl.supportedValuesOf' && args.length === 1 && args.every(isData)) return array(DATA);
    if (name.startsWith('map:')) {
      const owner = callee.payload ?? BAD;
      const entries = owner.payload ?? BAD;
      const pair = entries.element;
      const key = pair?.fields?.get('0') ?? DATA;
      const value = pair?.fields?.get('1') ?? DATA;
      if (name === 'map:entries') return args.length === 0 ? entries : BAD;
      if (this.strictSchemaExports && owner.metadataEntries !== undefined && name === 'map:get' && args.length === 1) return owner.metadataEntries.get(args[0]) ?? { kind: 'data', literal: undefined };
      if (this.strictSchemaExports && owner.metadataEntries !== undefined && name === 'map:has' && args.length === 1) return { kind: 'data', literal: owner.metadataEntries.has(args[0]) };
      if (name === 'map:has') return args.length === 1 && args.every(isClosedData) ? DATA : BAD;
      if (name === 'map:get')
        return args.length === 1 && args.every(isClosedData)
          ? entries.empty === true
            ? { kind: 'data', literal: undefined }
            : value
          : BAD;
      if (
        owner.arrayOwner === undefined ||
        (owner.arrayOwner !== this.invocations.at(-1)?.token && !(this.strictSchemaExports && this.ownsSchemaReflection(owner))) ||
        args.some((arg) => (!isClosedData(arg) && !(this.strictSchemaExports && this.schemaMetadataResult(arg))) || this.containsIdentity(arg, owner))
      )
        return BAD;
      if (name === 'map:delete') return args.length === 1 ? DATA : BAD;
      if (name !== 'map:set' || args.length !== 2) return BAD;
      const nextKey = entries.empty === true ? args[0] : merge([key, args[0]]);
      const nextValue = entries.empty === true ? args[1] : merge([value, args[1]]);
      const nextPair = {
        ...array(merge([nextKey, nextValue])),
        fields: new Map([
          ['0', nextKey],
          ['1', nextValue],
        ]),
      };
      const next = { ...owner, payload: array(nextPair), ...(this.strictSchemaExports && owner.metadataEntries !== undefined ? { metadataEntries: new Map([...owner.metadataEntries, [args[0], args[1]]]) } : {}) };
      this.arrayStates.set(owner, next);
      return next;
    }
    if (name === 'regexp:test' && args.every(isData)) return DATA;
    if (name === 'regexp:exec' && args.every(isData))
      return record(new Map([['groups', { kind: 'record', fields: new Map(), element: DATA }]]));
    if (name === 'set:has') return args.length === 1 && (isData(args[0]) || this.strictSchemaExports && this.schemaMetadataResult(args[0])) ? DATA : BAD;
    if (name === 'set:add') {
      const owner = callee.payload ?? BAD;
      if (
        owner.arrayOwner === undefined ||
        (owner.arrayOwner !== this.invocations.at(-1)?.token && !(this.strictSchemaExports && this.ownsSchemaReflection(owner))) ||
        args.length !== 1 ||
        (!isClosedData(args[0]) && !(this.strictSchemaExports && this.schemaMetadataResult(args[0])))
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
    const nobleDataCall = this.publicCodecs
      ? ['noble:sha256', 'noble:utf8ToBytes'].includes(name)
      : name.startsWith('noble:');
    if ((nobleDataCall || ENCODING_DATA_FUNCTIONS.has(name)) && args.length === 1 && isData(args[0]))
      return this.publicCodecs && (name === 'noble:sha256' || this.hasWire(args[0])) ? this.wired(DATA) : DATA;
    if (['hash:update', 'hash:digest'].includes(name))
      return args.every(isData) ? (name === 'hash:digest' ? DATA : { kind: 'hash' }) : BAD;
    if (this.coreHashDepth > 0 && ['weakset:has', 'weakset:add', 'weakset:delete'].includes(name))
      return args.length === 1 && isClosedData(args[0]) && this.invocations.some((frame) => frame.token === callee.payload?.arrayOwner) ? DATA : BAD;
    if (this.coreHashDepth > 0 && name === 'global:Object.getPrototypeOf') return args.length === 1 && isClosedData(args[0]) ? DATA : BAD;
    if (this.coreHashDepth > 0 && name === 'global:Object.is') return args.length === 2 && args.every(isClosedData) ? DATA : BAD;
    if (this.coreHashDepth > 0 && ['effect:DateTime.isDateTime', 'effect:DateTime.isUtc'].includes(name)) return args.length === 1 && args.every(isClosedData) ? DATA : BAD;
    if (this.publicCodecs && name === 'global:Array.isArray' && args.length === 1 && isData(args[0])) return DATA;
    if (this.publicCodecs && name === 'effect:Predicate.isObject' && args.length === 1 && isData(args[0])) return DATA;
    if (this.publicCodecs && name === 'global:Object.entries' && args.length === 1 && args[0].kind === 'record' && args[0].open !== true) {
      const child: Value = args[0].native === 'json-object' ? { kind: 'data', native: 'json' } : merge([...(args[0].fields?.values() ?? [])]);
      const pair = { ...array(merge([DATA, child])), fields: new Map([['0', DATA], ['1', child]]) };
      return array(pair);
    }
    if (this.publicCodecs && name === 'global:Object.fromEntries' && args.length === 1 && args[0].kind === 'array' && isClosedData(args[0])) {
      const pair = args[0].element;
      return pair?.kind === 'array' && pair.fields?.size === 2 && isClosedData(pair.fields.get('1') ?? BAD)
        ? { ...record(new Map()), native: 'json-object', element: pair.fields.get('1') } : BAD;
    }
    if (name === 'global:Object.freeze') return args.length === 1 && (isData(args[0]) || this.strictSchemaExports && this.schemaMetadataResult(args[0])) ? args[0] : BAD;
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
      if (
        owner.kind === 'array' &&
        owner.empty === true &&
        args.length === 1 &&
        ['map', 'flatMap', 'filter', 'find', 'some', 'every'].includes(operation)
      ) {
        if (args[0]?.kind !== 'function') return BAD;
        return ['some', 'every'].includes(operation)
          ? DATA
          : operation === 'find'
            ? { kind: 'data', literal: undefined }
            : array(DATA, true);
      }
      if (operation === 'at' && owner.kind === 'array' && args.length === 1 && args.every(isData))
        return owner.empty === true ? { kind: 'data', literal: undefined } : (owner.element ?? BAD);
      if (
        operation === 'reduce' &&
        owner.kind === 'array' &&
        args.length === 2 &&
        args[0]?.kind === 'function' &&
        isClosedData(args[1])
      ) {
        let accumulator = generalizeData(args[1]);
        if (owner.empty === true) return accumulator;
        for (let step = 0; step < 16; step += 1) {
          const next = this.invoke(args[0], [
            accumulator,
            owner.element ?? BAD,
            { kind: 'data', native: 'number' },
            owner,
          ]);
          if (!isClosedData(next)) return BAD;
          const merged = generalizeData(merge([accumulator, next]));
          if (dataState(merged) === dataState(accumulator)) return merged;
          accumulator = merged;
        }
        return BAD;
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
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, { kind: 'data', native: 'number' }, owner]))
          ? array(owner.element ?? BAD, owner.empty)
          : BAD;
      if (operation === 'find' && owner.kind === 'array' && isData(owner) && args.length === 1)
        return isClosedData(this.invoke(args[0], [owner.element ?? BAD, { kind: 'data', native: 'number' }, owner]))
          ? merge([owner.element ?? BAD, { kind: 'data', literal: undefined }])
          : BAD;
      if (['some', 'every'].includes(operation) && owner.kind === 'array' && (isData(owner) || this.strictSchemaExports && this.schemaMetadataResult(owner)) && args.length === 1)
        {
        const predicate = this.invoke(args[0], [owner.element ?? BAD, { kind: 'data', native: 'number' }, owner]);
        return isClosedData(predicate) || this.strictSchemaExports && metadataOnly(predicate) && predicate.kind === 'data' ? DATA : BAD;
      }
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
          'replace',
          'localeCompare',
          'isWellFormed',
          'normalize',
          'toLowerCase',
          'toUpperCase',
          'trim',
          'padStart',
          ...(this.publicCodecs ? ['padEnd'] : []),
          'join',
          ...(this.coreHashDepth > 0 ? ['toString', 'toISOString'] : []),
        ].includes(operation) &&
        isData(owner) &&
        args.every(isData)
      )
        return DATA;
      return BAD;
    }
    if (
      name.startsWith('effect:Predicate.') &&
      ['isObjectKeyword', 'isString', 'isNumber', 'isBoolean', ...(this.coreHashDepth > 0 ? ['isBigInt', 'isDate', 'isFunction'] : [])].includes(name.split('.').at(-1)!) &&
      args.every(isData)
    )
      return DATA;
    if (name === 'effect:Result.getOrThrow' && args.every(isData)) return DATA;
    if (name.startsWith('effect:Result.')) return this.resultCall(name.slice('effect:Result.'.length), args);
    if (name.startsWith('effect:Option.')) return this.optionCall(name.slice('effect:Option.'.length), args);
    if (name === 'option:pipe' || name === 'result:pipe') {
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
    if (name === 'effect:SchemaGetter.transform' && args.length === 1 && args[0]?.kind === 'function')
      return { kind: 'getter', apply: (values) => this.invoke(args[0], values) };
    if (name === 'effect:SchemaGetter.dateTimeUtcFromInput' && args.length === 0)
      return { kind: 'getter', apply: (values) => (values.length === 1 && values.every(isData) ? DATA : BAD) };
    if (name === 'effect:SchemaGetter.map' && args.length === 1 && args[0]?.kind === 'function')
      return {
        kind: 'transform',
        apply: (values) =>
          values[0]?.kind === 'getter'
            ? { kind: 'getter', apply: (inputs) => this.invoke(args[0], [values[0].apply?.(inputs) ?? BAD]) }
            : BAD,
      };
    if (name === 'getter:pipe') {
      let result = callee.payload ?? BAD;
      for (const arg of args) {
        if (arg.kind !== 'transform') return BAD;
        result = arg.apply?.([result]) ?? BAD;
      }
      return result;
    }
    if (name === 'schema:annotate') return args.length === 1 && isClosedData(args[0]) ? (this.strictSchemaExports ? { ...(callee.payload ?? BAD), astOpaque: true } : callee.payload ?? BAD) : BAD;
    if (this.erasedSchemaTypes && name === 'schema:check') return callee.payload?.kind === 'schema' ? callee.payload : BAD;
    if (name === 'schema:pipe' || name === 'schema:check') {
      let result = callee.payload ?? BAD;
      for (const argument of args) {
        if (
          argument.kind === 'native' &&
          ['effect:Schema.toEncoded', 'effect:Schema.toType'].includes(argument.native ?? '')
        ) {
          result = this.nativeCall(argument, [result]);
          continue;
        }
        if (argument.kind === 'function' && name === 'schema:pipe') {
          const next = this.invoke(argument, [result], true);
          if (next.kind !== 'schema') return BAD;
          result = next;
          continue;
        }
        if (argument.kind !== 'transform' || argument.apply === undefined) return BAD;
        result = argument.apply([result]);
      }
      return this.strictSchemaExports && name === 'schema:check' && !args.every((value) => value.native === 'schema-filter-transform') ? { ...result, astOpaque: true } : result;
    }
    if (!name.startsWith('effect:Schema.')) return BAD;
    const operation = name.slice('effect:Schema.'.length);
    if (this.publicCodecs && operation === 'suspend' && args.length === 1 && args[0].kind === 'function')
      return { ...schema(BAD), native: 'deferred-schema' };
    if (operation === 'decodeUnknownEffect' || (this.publicCodecs && ['decodeEffect', 'encodeEffect', 'encodeUnknownEffect'].includes(operation))) {
      const value = args[0];
      if (value?.native === 'encoder-only-schema' && !['encodeResult', 'encodeSync', 'encodeEffect'].includes(operation)) return BAD;
      if (value?.kind !== 'schema' || !isClosedData(value.payload ?? BAD) || !args.slice(1).every(isData)) return BAD;
      return {
        kind: 'function',
        ...(this.publicCodecs ? { native: 'schema-codec' } : {}),
        apply: (inputs) => inputs.every(isData) ? { kind: 'codec-effect',
          payload: this.publicCodecs ? this.wired(['encodeEffect', 'encodeUnknownEffect'].includes(operation) ? value.encoded ?? value.payload ?? BAD : value.payload ?? BAD) : value.payload,
          ...(this.publicCodecs ? { validationInputs: inputs } : {}) } : BAD,
      };
    }
    if (operation === 'decodeUnknownResult' || (this.publicCodecs && operation === 'decodeResult')) {
      const value = args[0];
      if (value?.native === 'encoder-only-schema' && !['encodeResult', 'encodeSync', 'encodeEffect'].includes(operation)) return BAD;
      if (value?.kind !== 'schema' || !isData(value.payload ?? BAD) || !args.slice(1).every(isData)) return BAD;
      return { kind: 'function', ...(this.publicCodecs ? { native: 'schema-data-codec' } : {}), apply: (inputs) => (inputs.every(isData) ? outcome(value.payload, ISSUE) : BAD) };
    }
    if (['decodeUnknownSync', 'decodeSync', 'encodeSync', 'encodeResult'].includes(operation)) {
      const value = args[0];
      if (value?.native === 'encoder-only-schema' && !['encodeResult', 'encodeSync', 'encodeEffect'].includes(operation)) return BAD;
      if (value?.kind !== 'schema' || !isData(value.payload ?? BAD) || !args.slice(1).every(isData)) return BAD;
      return {
        kind: 'function',
        ...(this.publicCodecs ? { native: 'schema-data-codec' } : {}),
        apply: (inputs) =>
          inputs.every(isData)
            ? operation === 'encodeSync' || operation === 'encodeResult'
              ? DATA
              : (value.payload ?? BAD)
            : BAD,
      };
    }
    if (this.publicCodecs && operation === 'Record' && args.length === 2 && args.every((value) => value.kind === 'schema'))
      return schema({ ...record(new Map()), native: 'json-object', element: args[1].payload ?? BAD },
        { ...record(new Map()), native: 'json-object', element: args[1].encoded ?? args[1].payload ?? BAD });
    // In data-factory mode a record is admitted only when its key is a closed string schema and its value is closed
    // data both decoded and encoded. Soundness: a wrongly admitted record would let a factory hand out a function,
    // class instance or unknown value under a data-shaped type. Its element is exactly the value schema's payload and
    // must itself pass `isClosedData`, so an open, unknown, function or class-instance value (or one nested anywhere
    // inside a struct, array or record) stays unmodelled; the key must be a closed string, so numeric, symbol,
    // unknown and Json keys stay unmodelled too.
    if (!this.publicCodecs && operation === 'Record' && args.length === 2 && args[1]?.kind === 'schema') {
      const decoded = args[1].payload ?? BAD;
      const encoded = args[1].encoded ?? decoded;
      return isClosedStringSchema(args[0]) && isClosedData(decoded) && isClosedData(encoded)
        ? schema({ ...record(new Map()), native: 'json-object', element: decoded },
          { ...record(new Map()), native: 'json-object', element: encoded })
        : BAD;
    }
    // In data-factory mode a template literal is closed string data when every part is a string literal or a closed
    // string schema. Soundness: a wrongly admitted one would let an unknown or structured part be claimed as a plain
    // string; every part is checked individually from the literal array's own fields, and an array with a spread has
    // no fields, so it stays unmodelled.
    if (!this.publicCodecs && operation === 'TemplateLiteral' && args.length === 1 && args[0]?.kind === 'array' && args[0].fields !== undefined) {
      const parts = [...args[0].fields.values()];
      return parts.every((part) => (part.kind === 'data' && isClosedString(part)) || isClosedStringSchema(part))
        ? schema({ kind: 'data', stringData: true })
        : BAD;
    }
    if (operation === 'TaggedStruct' && args.length === 2 && isData(args[0]) && args[1]?.kind === 'record') {
      const fields = new Map<string, Value>([['_tag', args[0]]]);
      for (const [field, value] of args[1].fields ?? []) {
        if (value.kind !== 'schema') return BAD;
        fields.set(field, value.payload ?? BAD);
      }
      return { ...schema(record(fields)), ...(this.strictSchemaExports ? { astTag: 'Objects', astFields: args[1].fields } : {}) };
    }
    if (operation === 'is' || operation === 'toEquivalence')
      return args.length === 1 && args[0]?.kind === 'schema' && isClosedData(args[0].payload ?? BAD)
        ? { kind: 'function', ...(this.publicCodecs ? { native: 'schema-data-codec' } : {}), apply: (inputs) => (inputs.every(isData) ? DATA : BAD) }
        : BAD;
    if (operation === 'Struct' && args.length === 1 && args[0]?.kind === 'record') {
      const fields = new Map<string, Value>();
      const encoded = new Map<string, Value>();
      for (const [field, value] of args[0].fields ?? []) {
        if (value.kind !== 'schema') return BAD;
        fields.set(field, value.payload ?? BAD);
        encoded.set(field, value.encoded ?? value.payload ?? BAD);
      }
      return { ...schema(record(fields), record(encoded)), ...(this.strictSchemaExports ? { astTag: 'Objects', astFields: args[0].fields } : {}),
        ...(this.defaultStructEquivalence ? {defaultEquivalenceKind: 'struct'} : {}) };
    }
    if (['Array', 'NonEmptyArray'].includes(operation) && args.length === 1 && args[0]?.kind === 'schema')
      return { ...schema(array(args[0].payload ?? BAD), array(args[0].encoded ?? args[0].payload ?? BAD)), ...(this.strictSchemaExports ? { astTag: 'Arrays', astElement: args[0], astRequiredElement: operation === 'NonEmptyArray' } : {}) };
    if (this.publicCodecs && operation === 'Tuple' && args.length === 1 && args[0]?.kind === 'array') {
      const fields = args[0].fields;
      if (fields === undefined || ![...fields.values()].every((value) => value.kind === 'schema')) return BAD;
      const payload = { ...array(merge([...fields.values()].map((value) => value.payload ?? BAD))),
        fields: new Map([...fields].map(([key, value]) => [key, value.payload ?? BAD])) };
      const encoded = { ...array(merge([...fields.values()].map((value) => value.encoded ?? value.payload ?? BAD))),
        fields: new Map([...fields].map(([key, value]) => [key, value.encoded ?? value.payload ?? BAD])) };
      return schema(payload, encoded);
    }
    if (operation === 'Union' && args.length === 1 && args[0]?.kind === 'array') {
      const element = args[0].element;
      return element?.kind === 'schema' ? element : BAD;
    }
    if (operation === 'Literal' && args.length === 1 && isData(args[0])) return { ...schema(args[0]), ...(this.strictSchemaExports ? { astTag: 'Literal' } : {}),
      ...(this.defaultStructEquivalence && typeof args[0].literal === 'string' ? {defaultEquivalenceKind: 'literal'} : {}) };
    if (operation === 'Literals' && args.every(isData)) {
      if (!this.strictSchemaExports) return schema(DATA);
      const values = args.length === 1 && args[0].kind === 'array' && args[0].fields !== undefined ? [...args[0].fields.values()] : null;
      if (values === null) return { ...schema(DATA), astOpaque: true };
      const members = values.map((value): Value => ({ ...schema(value), astTag: 'Literal' }));
      return { ...schema(DATA), astTag: 'Union', astMembers: members };
    }
    if (operation === 'toEncoded' && args.length === 1 && args[0]?.kind === 'schema')
      return schema(args[0].encoded ?? args[0].payload ?? BAD);
    if (operation === 'toType' && args.length === 1 && args[0]?.kind === 'schema')
      return schema(args[0].payload ?? BAD);
    if (
      ['OptionFromNullOr', 'OptionFromOptionalNullOr'].includes(operation) &&
      args.length === 1 &&
      args[0]?.kind === 'schema'
    )
      return schema(
        {
          ...record(
            new Map([
              ['_tag', DATA],
              ['value', args[0].payload ?? BAD],
            ]),
          ),
          native: 'option',
        },
        args[0].encoded ?? args[0].payload ?? BAD,
      );
    if (this.defaultStructEquivalence && operation === 'optionalKey' && args.length === 1 && args[0]?.kind === 'schema')
      return {...args[0], defaultEquivalenceOptional: true};
    if (
      ['fromJsonString', ...(this.publicCodecs ? ['requiredKey'] : []), 'toEncoded', 'toType'].includes(operation) &&
      args.length === 1 &&
      args[0]?.kind === 'schema'
    )
      return args[0];
    if (
      ['optionalKey', 'optional', 'NullOr', 'OptionFromNullOr', 'OptionFromOptionalNullOr', 'UndefinedOr'].includes(operation) &&
      args.length === 1 &&
      args[0]?.kind === 'schema'
    ) {
      const payload = possiblyAbsentString(args[0].payload);
      const encoded = possiblyAbsentString(args[0].encoded);
      return payload === args[0].payload && encoded === args[0].encoded ? args[0] : { ...args[0], payload, encoded };
    }
    if (this.coreHashDepth > 0 && operation === 'fromJsonString' && args.length === 1 && args[0].native === 'encoder-only-schema') return args[0];
    if (this.defaultStructEquivalence && operation === 'brand')
      return args.length === 1 && typeof args[0]?.literal === 'string'
        ? {kind: 'transform', apply: (values) => values[0]?.kind === 'schema' ? values[0] : BAD} : BAD;
    if (this.defaultStructEquivalence && ['isMinLength', 'isMaxLength', 'isUUID', 'isPattern'].includes(operation)) {
      const valid = ['isMinLength', 'isMaxLength'].includes(operation) ? args.length === 1 && typeof args[0]?.literal === 'number'
        : operation === 'isUUID' ? args.length === 0 : args.length === 1 && args[0]?.native === 'regexp';
      return valid ? {kind: 'transform', native: 'schema-filter-transform', apply: (values) => values[0]?.kind === 'schema'
        ? {...values[0], defaultEquivalenceChecks: [...(values[0].defaultEquivalenceChecks ?? []), operation]} : BAD} : BAD;
    }
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
        'isGreaterThan',
        'isGreaterThanOrEqualTo',
        'isLessThan',
        'isLessThanOrEqualTo',
      ].includes(operation) &&
      args.every(isData)
    )
      return { kind: 'transform', ...(this.strictSchemaExports ? { native: 'schema-filter-transform' } : {}), apply: (values) => {
        const source = values[0];
        if (source?.kind !== 'schema') return BAD;
        if (!this.strictSchemaExports) return source;
        const check = this.nativeSchemaFilter(operation, args);
        if (check.kind === 'bad') return { ...source, astOpaque: true };
        return { ...source, astChecks: [...(source.astChecks ?? []), check] };
      } };
    if (operation === 'decode' && args.length === 1 && args[0]?.kind === 'record')
      return {
        kind: 'transform',
        apply: (values) => {
          const source = values[0];
          const decode = args[0].fields?.get('decode');
          const encode = args[0].fields?.get('encode');
          return source?.kind === 'schema' &&
            args[0].fields?.size === 2 &&
            decode?.kind === 'getter' &&
            encode?.kind === 'getter' &&
            isClosedData(decode.apply?.([source.payload ?? BAD]) ?? BAD) &&
            isClosedData(encode.apply?.([source.payload ?? BAD]) ?? BAD)
            ? source
            : BAD;
        },
      };
    if (operation === 'decodeTo' && args[0]?.kind === 'schema' && (args.length === 1 || args.length === 2)) {
      const target = args[0];
      const options = args[1];
      return {
        kind: 'transform',
        apply: (values) => {
          const source = values[0];
          if (source?.kind !== 'schema') return BAD;
          if (options === undefined) return target;
          if (options.kind !== 'record' || options.fields?.size !== 2) return BAD;
          const decode = options.fields.get('decode');
          const encode = options.fields.get('encode');
          return decode?.kind === 'getter' &&
            encode?.kind === 'getter' &&
            isClosedData(decode.apply?.([source.payload ?? BAD]) ?? BAD) &&
            isClosedData(encode.apply?.([target.payload ?? BAD]) ?? BAD)
            ? target
            : BAD;
        },
      };
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

  optionCall(operation: string, args: readonly Value[]): Value {
    if (this.publicCodecs && operation === 'contains' && args.length === 2 && args[0]?.native === 'option' && isData(args[1])) return DATA;
    const option = (value: Value): Value => ({
      ...record(
        new Map([
          ['_tag', DATA],
          ['value', value],
        ]),
      ),
      native: 'option',
    });
    const [argument] = args;
    if (operation === 'none') return args.length === 0 ? option(DATA) : BAD;
    if (args.length !== 1 || argument === undefined) return BAD;
    if (['some', 'fromNullishOr'].includes(operation)) return isClosedData(argument) ? option(argument) : BAD;
    if (['isSome', 'isNone'].includes(operation)) return argument.native === 'option' ? DATA : BAD;
    if (['getOrUndefined', 'getOrNull'].includes(operation))
      return argument.native === 'option' ? merge([argument.fields?.get('value') ?? BAD, DATA]) : BAD;
    if (!['map', 'flatMap'].includes(operation) || argument.kind !== 'function') return BAD;
    return {
      kind: 'function',
      apply: (inputs) => {
        const input = inputs[0];
        if (inputs.length !== 1 || input?.native !== 'option') return BAD;
        const next = this.invoke(argument, [input.fields?.get('value') ?? BAD]);
        return operation === 'map' ? (isClosedData(next) ? option(next) : BAD) : next.native === 'option' ? next : BAD;
      },
    };
  }

  normalizeNative(value: Value): Value {
    value = this.arrayState(value);
    if (value.kind !== 'native') return value;
    const name = value.native ?? '';
    if (
      [
        'effect:DateTime.formatIso',
        'effect:DateTime.formatIsoDateUtc',
        'effect:DateTime.makeUnsafe',
        'effect:DateTime.make',
        'effect:DateTime.add',
        'effect:DateTime.toEpochMillis',
        'effect:Option.getOrUndefined',
        'effect:Option.getOrNull',
      ].includes(name)
    )
      return { kind: 'function', apply: (args) => this.nativeCall(value, args) };
    if (this.strictSchemaExports && name === 'global:Object.prototype') return { kind: 'data', literal: 'intrinsic:Object.prototype', native: 'schema-object-prototype' };
    if (this.coreHashDepth > 0 && name === 'global:Object.prototype') return DATA;
    if (this.coreHashDepth > 0 && name === 'effect:Schema.Any') return { ...schema(DATA), native: 'encoder-only-schema' };
    if (name === 'global:Number.MAX_SAFE_INTEGER' || name === 'global:Number.MIN_SAFE_INTEGER')
      return { kind: 'data', native: 'number' };
    if (name === 'effect:Match.exhaustive')
      return {
        kind: 'function',
        apply: (values) =>
          values.length === 1 && values[0]?.kind === 'matcher' && values[0].element !== undefined
            ? values[0].element
            : BAD,
      };
    // A Json value is an acyclic tree of null, strings, booleans, finite numbers, arrays and plain (Object.prototype or
    // null-prototype) objects: effect's `SchemaAST.isJson` rejects functions, class instances, symbols, undefined and
    // bigints. `isClosedData` means "no function, class instance, unknown or open record reachable", which every such
    // tree satisfies, so the opaque data leaf models it soundly in every mode.
    if (name === 'effect:Schema.Json') return schema({ kind: 'data', native: 'json' });
    if (name === 'effect:Schema.Unknown') return schema(BAD);
    if (this.strictSchemaExports && ['effect:Schema.Finite', 'effect:Schema.Int'].includes(name)) return { ...schema(DATA), astTag: 'Number', astChecks: [this.nativeSchemaFilter(name.endsWith('.Int') ? 'isInt' : 'isFinite', [])] };
    if (
      /^effect:Schema\.(String|Trim|NonEmptyString|Number|Int|Finite|Boolean|BigInt|Undefined|Null|Never|DateTimeUtc|DateTimeUtcFromString)$/u.test(
        name,
      )
    )
      return { ...schema(/^effect:Schema\.(String|Trim|NonEmptyString)$/u.test(name) ? { kind: 'data', stringData: true } : DATA),
        ...(this.strictSchemaExports ? { astTag: name.slice('effect:Schema.'.length) } : {}),
        ...(this.defaultStructEquivalence && name === 'effect:Schema.String' ? {defaultEquivalenceKind: 'string'} : {}) };
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
  if (isFactoryResult(direct)) return true;
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

const publicCodecModel = (source: string, context?: PublicDataCodecContext, exportedName?: string, strictSchemaExports = false, defaultStructEquivalence = false): { readonly proof: DataFactoryProof; readonly model: Model } | null => {
  if (context !== undefined && (path.posix.normalize(context.filename) !== context.filename ||
    path.posix.normalize(context.ownerPath) !== context.ownerPath || context.ownerPath.startsWith('/') ||
    !context.filename.startsWith(`${context.ownerPath}/`) || context.sources.get(context.filename) !== source)) return null;
  const proof = new DataFactoryProof(true, context);
  proof.strictSchemaExports = strictSchemaExports;
  proof.defaultStructEquivalence = defaultStructEquivalence;
  const model = proof.load(context?.filename ?? 'public-data-codec.ts', source);
  if (context !== undefined && proof.snapshotPackage(context.filename)?.directory !== context.ownerPath) return null;
  if (context !== undefined && exportedName !== undefined) proof.importedExports.set(context.filename, exportedName);
  if (model === null || (context === undefined && ![...model.imports.values()].every((imported) => imported.typeOnly === true ||
    (imported.source === 'effect' && ['Effect', 'Match', 'Schema'].includes(imported.imported)) ||
    (imported.source === 'effect/encoding' && ['Hex', 'Base64Url'].includes(imported.imported)) ||
    NOBLE_DATA_FUNCTIONS.has(`${imported.source}:${imported.imported}`)))) return null;
  return proof.safeInitialization(model) ? { proof, model } : null;
};

/** A separate opt-in proof for published, service-free DTO wire codecs. */
export function provesPublicDataCodecExport(source: string, exportedName: string, context?: PublicDataCodecContext): boolean {
  const loaded = publicCodecModel(source, context, exportedName);
  if (loaded === null) return false;
  const { proof, model } = loaded;
  const local = model.exports.get(exportedName);
  if (local === undefined) return false;
  const callable = proof.value(local, model, new Map());
  if (callable.kind !== 'function') return false;
  const result = proof.invoke(callable, []);
  return isFactoryResult(result) && (context === undefined || (proof.closedCapturedDependencies() && result.failureOnly !== true &&
    proof.hasWire(result)));
}

/** This proves only the erased data type; it never approves importing or constructing a runtime class. */
export function provesPublicDataCodecTypeExport(source: string, exportedName: string, context?: PublicDataCodecContext): boolean {
  const loaded = publicCodecModel(source, context, exportedName);
  if (loaded === null) return false;
  const { proof, model } = loaded;
  const local = model.exports.get(exportedName);
  if (local === undefined) return false;
  const declaration = model.types.get(local);
  if (declaration !== undefined)
    return isClosedData(proof.type({ type: 'TSTypeReference', typeName: { type: 'Identifier', name: local } }, model));
  return isClosedData(proof.taggedErrorShape(local, model));
}

/** Proves a selected schema value, never an arbitrary DTO, factory or Effect service. */
export function provesServiceFreeSchemaExport(source: string, exportedName: string, context?: PublicDataCodecContext): boolean {
  const loaded = publicCodecModel(source, context, exportedName, true);
  if (loaded === null) return false;
  const { proof, model } = loaded;
  const local = model.exports.get(exportedName);
  if (local === undefined) return false;
  const value = proof.value(local, model, new Map());
  return value.kind === 'schema' && isClosedData(value.payload ?? BAD) && isClosedData(value.encoded ?? value.payload ?? BAD) &&
    proof.closedCapturedDependencies();
}

/** Default native nonempty-Struct comparator derivation only; never argument, decoder or hook safety. */
export function provesDefaultStructEquivalenceSchemaExport(source: string, exportedName: string, context?: PublicDataCodecContext): boolean {
  const loaded = publicCodecModel(source, context, exportedName, true, true);
  if (loaded === null) return false;
  const {proof, model} = loaded;
  const local = model.exports.get(exportedName);
  if (local === undefined) return false;
  const value = proof.value(local, model, new Map());
  return value.kind === 'schema' && value.defaultEquivalenceKind === 'struct' && value.defaultEquivalenceOptional !== true &&
    value.astOpaque !== true && value.astFields !== undefined && value.astFields.size > 0 &&
    [...value.astFields.values()].every((child) => child.kind === 'schema' && child.astOpaque !== true &&
      ['string', 'literal'].includes(child.defaultEquivalenceKind ?? '')) && proof.closedCapturedDependencies();
}

/** A selected native column's initialization provenance; consumers must prove decoder semantics separately. */
export function nativeColumnInitializationEvidence(source: string, tableExportName: string, fieldName: string,
  context: Pick<PublicDataCodecContext, 'filename' | 'ownerPath' | 'sources'>): NativeColumnInitializationEvidence | null {
  if (path.posix.normalize(context.filename) !== context.filename || path.posix.normalize(context.ownerPath) !== context.ownerPath ||
    context.ownerPath.startsWith('/') || !context.filename.startsWith(`${context.ownerPath}/`) || context.sources.get(context.filename) !== source) return null;
  const proof = new DataFactoryProof(true, {...context, isImmutableContractSource: () => false});
  proof.initializationColumnEvidence = true;
  const model = proof.load(context.filename, source);
  if (model === null || proof.snapshotPackage(context.filename)?.directory !== context.ownerPath) return null;
  const local = model.exports.get(tableExportName);
  const declarations = model.program.body.flatMap((statement: Node) => {
    const value = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return value?.type === 'VariableDeclaration' && value.kind === 'const' ? value.declarations : [];
  }).filter((declaration: Node) => named(declaration.id) === local && declaration.init === model.values.get(local ?? ''));
  if (local === undefined || declarations.length !== 1 || !fieldName || ['constructor', '__proto__', 'prototype'].includes(fieldName)) return null;
  const declaration = declarations[0];
  let result: NativeColumnInitializationEvidence | null = null;
  return proof.nativeColumnInitialization(model, declaration, declaration.init, fieldName, new Set(), (value) => {result = value;}) ? result : null;
}

/** Method-specific evidence only. This never approves a body, value, schema, service or constructor. */
export function hasClosedNativeObjectIntrinsicCustody(program: Node, methods: readonly string[]): boolean {
  return nativeIntrinsicCustody(program, methods, false);
}

/** Identity evidence only: callers must check every participating runtime module. */
export function hasClosedNativeArrayIteratorCustody(program: Node): boolean {
  return nativeIntrinsicCustody(program, [], true);
}

/** Global String [[Call]] binding identity only; argument/getter/coercion execution stays the caller's obligation.
 * Function properties and callback transport cannot rebind that native [[Call]]. */
export function hasClosedNativeStringConstructorCustody(program: Node): boolean {
  return nativeIntrinsicCustody(program, [], false, true);
}

/** Preserves an initially native Object.prototype's absent keys; callers must close the executed module cohort. */
export function hasClosedNativeObjectPrototypeKeyCustody(program: Node, keys: readonly string[]): boolean {
  const initiallyPresent = new Set(['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString']);
  if (keys.length === 0 || keys.length > 7 || new Set(keys).size !== keys.length ||
    keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || initiallyPresent.has(key))) return false;
  return nativeIntrinsicCustody(program, [], false, false, keys);
}

function nativeIntrinsicCustody(program: Node, methods: readonly string[], arrayIteration: boolean, stringConstructor = false, objectPrototypeKeys?: readonly string[]): boolean {
  const prototypeKeys = objectPrototypeKeys === undefined ? null : new Set(objectPrototypeKeys);
  if (program?.type !== 'Program' || !Array.isArray(program.body) || (!arrayIteration && !stringConstructor && prototypeKeys === null && methods.length === 0)) return false;
  const protectedMethods = new Set(methods);
  const nativeMethods = new Set(['assign', 'create', 'defineProperties', 'defineProperty', 'entries', 'freeze', 'fromEntries', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'getPrototypeOf', 'hasOwn', 'is', 'isExtensible', 'isFrozen', 'isSealed', 'keys', 'preventExtensions', 'seal', 'setPrototypeOf', 'values']);
  if (methods.some((method) => !nativeMethods.has(method))) return false;
  const aliases = new Map<string, string>([['Object', 'object'], ['globalThis', 'global'], ['global', 'global'], ['self', 'global'], ['window', 'global'], ['Reflect', 'reflect']]);
  if (arrayIteration) {aliases.set('Array', 'array-constructor');aliases.set('Symbol', 'symbol');}
  if (stringConstructor) aliases.set('String', 'string-constructor');
  const intrinsicNames = [...(arrayIteration ? ['Object', 'Reflect', 'Array', 'Symbol'] : ['Object', 'Reflect']), ...(stringConstructor ? ['String'] : [])];
  // Ordinary arrays and well-known symbol values carry no authority by themselves. Only
  // their native iteration receiver paths are protected; this is not a data-flow proof.
  const sensitive = (value: string): boolean => value !== '' &&
    (!arrayIteration || !['array-instance', 'iterator-key'].includes(value)) &&
    (!stringConstructor || value !== 'string-constructor');
  const initializers = new Map<string, (Node | null)[]>();
  const unknownBindings: Node[] = [];
  const registerInitializer = (name: string, value: Node | null): void => {
    const values = initializers.get(name) ?? [];
    if (!values.includes(value)) values.push(value);
    initializers.set(name, values);
  };
  const changedObjectMethods = new Set<string>();
  const changedReflectMethods = new Set<string>();
  let valid = true;
  const parents = prototypeKeys === null ? null : new Map<Node, Node>();
  const walk = (node: Node, visit: (node: Node) => void, parent?: Node): void => {
    if (parent !== undefined) parents?.set(node, parent);
    visit(node);
    for (const [field, value] of Object.entries(node)) {
      if (['parent', 'typeAnnotation', 'returnType', 'typeArguments', 'typeParameters'].includes(field)) continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child !== null && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, visit, node);
    }
  };
  const unknownBinding = (pattern: Node | null | undefined, unknownOrigin = true): void => {
    if (pattern === null || pattern === undefined) return;
    if (unknownOrigin) unknownBindings.push(pattern);
    const names = (value: Node): void => {
      if (value.type === 'Identifier') registerInitializer(value.name, null);
      else if (value.type === 'AssignmentPattern') names(value.left);
      else if (value.type === 'RestElement') names(value.argument);
      else if (value.type === 'ArrayPattern') for (const element of value.elements.filter(Boolean)) names(element);
      else if (value.type === 'ObjectPattern') for (const item of value.properties) names(item.type === 'RestElement' ? item.argument : item.value);
    };
    names(pattern);
  };
  walk(program, (node) => {
    if (fnNode(node)) for (const parameter of node.params) unknownBinding(parameter);
    if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) unknownBinding(node.id);
    if (node.type === 'CatchClause') unknownBinding(node.param);
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') for (const specifier of node.specifiers) if (specifier.importKind !== 'type') unknownBinding(specifier.local);
    if (node.type === 'VariableDeclarator' && node.init === null) unknownBinding(node.id);
    if (node.type === 'VariableDeclarator' && node.id.type !== 'Identifier') unknownBinding(node.id, node.init === null);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') registerInitializer(node.id.name, node.init);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') registerInitializer(node.left.name, node.operator === '=' ? node.right : null);
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') registerInitializer(node.argument.name, null);
    if (node.type === 'AssignmentPattern' && node.left.type === 'Identifier') registerInitializer(node.left.name, node.right);
    if (fnNode(node)) for (const parameter of node.params) if (parameter.type === 'Identifier') registerInitializer(parameter.name, null);
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.specifiers.some((specifier: Node) => specifier.importKind !== 'type' && intrinsicNames.includes(specifier.local.name))) valid = false;
    const bindsObject = (pattern: Node | null): boolean => pattern !== null && (pattern.type === 'Identifier' ? intrinsicNames.includes(pattern.name) : pattern.type === 'AssignmentPattern' ? bindsObject(pattern.left) : pattern.type === 'RestElement' ? bindsObject(pattern.argument) : pattern.type === 'ObjectPattern' ? pattern.properties.some((property: Node) => bindsObject(property.type === 'RestElement' ? property.argument : property.value)) : pattern.type === 'ArrayPattern' && pattern.elements.some((element: Node | null) => bindsObject(element)));
    if (node.type === 'VariableDeclarator' && bindsObject(node.id) || node.type === 'CatchClause' && bindsObject(node.param) || ['FunctionDeclaration', 'ClassDeclaration', 'FunctionExpression', 'ClassExpression'].includes(node.type) && intrinsicNames.includes(named(node.id) ?? '')) valid = false;
    if (fnNode(node) && node.params.some((parameter: Node) => bindsObject(parameter))) valid = false;
  });
  const property = (node: Node, depth = 0): string | null => {
    if (depth > 32) return null;
    const value = unwrap(node);
    if (value.type === 'Literal' && ['string', 'number'].includes(typeof value.value)) return String(value.value);
    if (arrayIteration && value.type === 'MemberExpression' && !value.optional &&
      (value.computed ? property(value.property, depth + 1) : value.property.name) === 'iterator' && origin(value.object, depth + 1) === 'symbol') return '@@iterator';
    if (arrayIteration && value.type === 'Identifier' && aliases.get(value.name) === 'iterator-key') return '@@iterator';
    if (value.type === 'Identifier' && initializers.has(value.name)) {
      const candidates = initializers.get(value.name)!;
      const values = candidates.map((candidate) => candidate === null ? null : property(candidate, depth + 1));
      return values.length > 0 && values[0] !== null && values.every((candidate) => candidate === values[0]) ? values[0] : null;
    }
    return null;
  };
  const memberOrigin = (base: string, field: string | null): string => {
    if (base === 'uncertain') return 'uncertain';
    if (prototypeKeys !== null) {
      if (base === 'object' && field === 'getPrototypeOf') return 'intrinsic-borrower';
      if (base === 'maybe' || field === '__proto__' || base === 'object-prototype' && field === 'constructor') return 'maybe';
      if (base === 'object-prototype' && ['__defineGetter__', '__defineSetter__'].includes(field ?? '')) return 'prototype-key-mutator';
      if (base === 'object-prototype' && field === null) return 'uncertain';
    }
    if (stringConstructor) {
      if (base === 'global' && field === 'String') return 'string-constructor';

    }
    if (arrayIteration) {
      // Extracting this borrower loses the direct native-call proof. It must not turn
      // an ordinary array into an untracked shared prototype through an alias call.
      if (base === 'object' && field === 'getPrototypeOf') return 'intrinsic-borrower';
      if (base === 'global' && ['Array', 'Symbol'].includes(field ?? '')) return field === 'Array' ? 'array-constructor' : 'symbol';
      if (base === 'symbol' && field === 'iterator') return 'iterator-key';
      if (base === 'array-constructor' && field === 'prototype') return 'array-prototype';
      if (base === 'array-instance' && field === 'constructor') return 'maybe';
      if (base === 'array-instance' && field === '__proto__') return 'maybe';
      if (['array-instance', 'array-prototype'].includes(base) && ['@@iterator', 'values', 'keys', 'entries'].includes(field ?? '')) return 'iterator-factory';
      if (base === 'array-prototype' && field === 'constructor') return 'array-constructor';
      if (['array-iterator', 'iterator-prototype'].includes(base) && field === '__proto__') return 'iterator-prototype';
      if (['array-iterator', 'iterator-prototype'].includes(base) && (field === null || ['next', '@@iterator', 'constructor'].includes(field))) return 'iterator-method';
      if (['iterator-factory', 'iterator-method'].includes(base)) return 'uncertain';
      if (['array-constructor', 'array-prototype', 'symbol'].includes(base) && field === null) return 'uncertain';
      if (base === 'maybe' || field === '__proto__') return 'maybe';
    }
    if (base === 'reflect') return 'reflect-method';
    if (base === 'global') return field === 'Object' ? 'object' : field === 'Reflect' ? 'reflect' : field === null ? 'uncertain' : '';
    if (base === 'object-prototype' && field === 'constructor') return 'object';
    if (field === 'constructor') return 'maybe';
    if (base === 'object' && field === 'prototype') return 'object-prototype';
    if (['object', 'maybe', 'container'].includes(base) && (field === null || protectedMethods.has(field))) return 'method';
    return base === 'container' ? 'container' : '';
  };
  const origin = (input: Node | null | undefined, depth = 0): string => {
    if (input === undefined || input === null) return '';
    if (depth > 64) return 'maybe';
    const node = unwrap(input);
    if (node.type === 'Identifier') {const value = aliases.get(node.name);return value === 'unknown' ? '' : value ?? '';}
    if (node.type === 'SpreadElement') return origin(node.argument, depth + 1);
    if (['AwaitExpression', 'YieldExpression'].includes(node.type)) return origin(node.argument, depth + 1);
    if (['ConditionalExpression', 'LogicalExpression', 'SequenceExpression'].includes(node.type)) {
      const values = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : node.type === 'LogicalExpression' ? [node.left, node.right] : node.expressions;
      const origins = values.map((value: Node) => origin(value, depth + 1)).filter(Boolean);
      return origins.length === 0 ? '' : origins.every((value: string) => value === origins[0]) ? origins[0] : 'uncertain';
    }
    if (node.type === 'MemberExpression') {
      const field = node.computed ? property(node.property) : node.property.name;
      if (field === 'constructor' && node.object.type === 'ObjectExpression') return prototypeKeys === null ? 'object' : 'maybe';
      if (arrayIteration && field === 'constructor' && node.object.type === 'ArrayExpression') return 'array-constructor';
      return memberOrigin(origin(node.object, depth + 1), field);
    }
    if (node.type === 'ObjectExpression') return node.properties.some((item: Node) => sensitive(origin(item.type === 'SpreadElement' ? item.argument : item.value, depth + 1))) ? 'container' : '';
    if (node.type === 'ArrayExpression') return node.elements.some((item: Node | null) => {
      if (item === null) return false;
      const value = origin(item, depth + 1);
      // A spread consumes the iterator; the fresh array does not retain its next/prototype identity.
      return sensitive(value) && !(arrayIteration && item.type === 'SpreadElement' && value === 'array-iterator');
    }) ? 'container' : arrayIteration ? 'array-instance' : '';
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const field = node.callee.computed ? property(node.callee.property) : node.callee.property.name;
      const namespace = origin(node.callee.object, depth + 1);
      if (arrayIteration && namespace === 'array-instance' && field === null) return 'maybe';
      if (arrayIteration && memberOrigin(namespace, field) === 'iterator-factory') return 'array-iterator';
      if (namespace === 'object' && changedObjectMethods.has(field ?? '') || namespace === 'reflect' && changedReflectMethods.has(field ?? '')) return 'uncertain';
      if ((arrayIteration || stringConstructor || prototypeKeys !== null) && namespace === 'reflect' && field === 'getOwnPropertyDescriptor' && sensitive(origin(node.arguments[0], depth + 1))) return 'container';
      if ((arrayIteration || prototypeKeys !== null) && namespace === 'reflect' && field === 'getPrototypeOf') {
        if (prototypeKeys !== null) return 'maybe';
        const target = origin(node.arguments[0], depth + 1);
        if (target === 'array-instance') return 'maybe';
        if (['array-iterator', 'iterator-prototype'].includes(target)) return 'iterator-prototype';
        return arrayIteration ? 'maybe' : sensitive(target) ? 'maybe' : '';
      }
      if (namespace === 'reflect' && field === 'get' && node.arguments.length >= 2) {
        const selected = property(node.arguments[1]);
        if (selected === 'constructor') return prototypeKeys === null && node.arguments[0].type === 'ObjectExpression' ? 'object' : 'maybe';
        return memberOrigin(origin(node.arguments[0], depth + 1), selected);
      }
      if (namespace === 'object') {
        if (['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'].includes(field) && origin(node.arguments[0], depth + 1)) return 'container';
        if (field === 'getPrototypeOf') {
          if (prototypeKeys !== null) return 'maybe';
          const target = origin(node.arguments[0], depth + 1);
          if (!target) return arrayIteration ? 'maybe' : '';
          if (arrayIteration && target === 'array-instance') return 'maybe';
          if (arrayIteration && ['array-iterator', 'iterator-prototype'].includes(target)) return 'iterator-prototype';
          return 'maybe';
        }
        if (field === 'create' && node.arguments[0] !== undefined && origin(node.arguments[0], depth + 1) === 'object') return 'maybe';
        if (['freeze', 'seal', 'preventExtensions', 'assign'].includes(field)) return origin(node.arguments[0], depth + 1) || (node.arguments.slice(1).some((argument: Node) => origin(argument, depth + 1)) ? 'container' : '');
        if (field === 'fromEntries' && node.arguments.some((argument: Node) => sensitive(origin(argument, depth + 1)))) return 'container';
      }
    }
    if (arrayIteration && node.type === 'CallExpression' && node.callee.type !== 'MemberExpression' && origin(node.callee, depth + 1) === 'iterator-factory') return 'array-iterator';
    return '';
  };
  const bind = (pattern: Node, source: string): void => {
    const next = source || 'unknown';
    if (pattern.type === 'Identifier') {
      const previous = aliases.get(pattern.name);
      // Ordinary array values may share names with unrelated values in another scope.
      // Keep only a possible-array receiver fact; it never authorizes a borrower/escape.
      const ordinaryArray = arrayIteration && [previous, next].every((value) => value === undefined || ['unknown', 'array-instance'].includes(value)) && [previous, next].includes('array-instance');
      aliases.set(pattern.name, ordinaryArray ? 'array-instance' : previous === undefined || previous === next ? next : 'uncertain');
    }
    else if (pattern.type === 'ObjectPattern') for (const item of pattern.properties) {
      if (item.type === 'RestElement') bind(item.argument, !sensitive(next === 'unknown' ? '' : next) ? '' : 'container');
      else bind(item.value, memberOrigin(next, item.computed ? property(item.key) : key(item.key) ?? null));
    }
    else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements.filter(Boolean)) {
      if (arrayIteration && next === 'array-instance') bind(item.type === 'RestElement' ? item.argument : item, item.type === 'RestElement' ? 'array-instance' : '');
      else bind(item, next === 'unknown' ? '' : 'container');
    }
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, next);
    else if (pattern.type === 'RestElement') bind(pattern.argument, next === 'unknown' ? '' : 'container');
  };
  const resolveAliases = (): boolean => {
  for (let round = 0; round < 32; round += 1) {
    const before = JSON.stringify([...aliases]);
    for (const binding of unknownBindings) bind(binding, '');
    walk(program, (node) => {
      if (node.type === 'VariableDeclarator' && node.init !== null) bind(node.id, origin(node.init));
      if (node.type === 'AssignmentExpression' && node.operator === '=') bind(node.left, origin(node.right));
      if (node.type === 'AssignmentPattern') bind(node.left, origin(node.right));
    });
    if (JSON.stringify([...aliases]) === before) return true;
  }
  return false;
  };
  if (!resolveAliases()) return false;
  const touches = (target: string, field: string | null): boolean => {
    if (prototypeKeys !== null) {
      if (target === 'object' && (field === null || field === 'prototype')) return true;
      if (['object-prototype', 'maybe'].includes(target) && (field === null || field === '__proto__' || prototypeKeys.has(field))) return true;
      if (target === 'prototype-key-mutator') return true;
    }
    if (stringConstructor && target === 'global' && (field === null || field === 'String')) return true;
    if (arrayIteration) {
      if (target === 'global' && ['Array', 'Symbol'].includes(field ?? '')) return true;
      if (target === 'array-constructor') return field === null || field === 'prototype';
      if (target === 'symbol') return field === null || field === 'iterator';
      if (target === 'array-instance') return false;
      if (target === 'array-prototype') return field === null || ['@@iterator', 'values', 'keys', 'entries', '__proto__', 'constructor'].includes(field);
      if (['array-iterator', 'iterator-prototype'].includes(target)) return field === null || ['next', '@@iterator', '__proto__'].includes(field);
      if (['iterator-factory', 'iterator-method'].includes(target)) return true;
      if (target === 'maybe') return true;
    }
    return target === 'uncertain' ? true : target === 'object' || target === 'maybe'
      ? field === null || protectedMethods.has(field) : target === 'global' ? field === null || field === 'Object' : ['method', 'container'].includes(target);
  };
  // Native borrowers are useful evidence only while their own method identity is intact.
  // Replacing an unrelated method alone is allowed; passing a protected namespace through
  // that replacement must be treated as an unknown escape, never a native operation.
  const invalidate = (target: string, field: string | null): void => {
    if (target === 'global' && (field === 'Reflect' || field === null)) {
      for (const method of ['get', 'set', 'defineProperty', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'setPrototypeOf', 'apply', 'construct', 'has', 'isExtensible', 'preventExtensions']) changedReflectMethods.add(method);
    }
    for (const [kind, changes] of [['object', changedObjectMethods], ['reflect', changedReflectMethods]] as const) {
      if (target !== kind && target !== 'uncertain') continue;
      if (field === null) for (const method of kind === 'reflect' ? ['get', 'set', 'defineProperty', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'setPrototypeOf', 'apply', 'construct', 'has', 'isExtensible', 'preventExtensions'] : nativeMethods) changes.add(method);
      else changes.add(field);
    }
  };
  walk(program, (node) => {
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type) || node.type === 'UnaryExpression' && node.operator === 'delete') {
      const target = unwrap(node.left ?? node.argument);
      if (target.type === 'MemberExpression') invalidate(origin(target.object), target.computed ? property(target.property) : target.property.name);
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const method = node.callee.computed ? property(node.callee.property) : node.callee.property.name;
    const namespace = origin(node.callee.object);
    if (!['object', 'reflect'].includes(namespace)) return;
    const target = origin(node.arguments[0]);
    if (['defineProperty', 'set', 'deleteProperty'].includes(method ?? '')) invalidate(target, node.arguments[1] === undefined ? null : property(node.arguments[1]));
    if (namespace === 'object' && ['assign', 'defineProperties'].includes(method ?? '')) for (const argument of node.arguments.slice(1)) {
      if (argument.type !== 'ObjectExpression') {invalidate(target, null);continue;}
      for (const item of argument.properties) invalidate(target, item.type === 'SpreadElement' ? null : item.computed ? property(item.key) : key(item.key) ?? null);
    }
  });
  if (!resolveAliases()) return false;
  walk(program, (node) => {
    if (prototypeKeys !== null) {
      if ((node.type === 'Property' && node.computed && sensitive(origin(node.key))) ||
        (node.type === 'MemberExpression' && node.computed && sensitive(origin(node.property)))) valid = false;
      const pattern = node.type === 'VariableDeclarator' ? node.id : ['AssignmentPattern', 'AssignmentExpression'].includes(node.type) ? node.left : undefined;
      const source = node.type === 'VariableDeclarator' ? node.init : node.right;
      if (pattern !== undefined && ['ObjectPattern', 'ArrayPattern'].includes(pattern.type) && ['object-prototype', 'maybe', 'container'].includes(origin(source))) {
        if (origin(source) !== 'object-prototype' || pattern.type !== 'ObjectPattern' || pattern.properties.some((item: Node) =>
          item.type !== 'Property' || item.kind !== 'init' || item.method || !prototypeKeys.has(item.computed ? property(item.key) ?? '' : key(item.key) ?? '') ||
          !['Identifier', 'AssignmentPattern'].includes(item.value.type))) valid = false;
      }
      if (node.type === 'SpreadElement' && parents?.get(node)?.type === 'ObjectExpression' &&
        ['object-prototype', 'maybe', 'container'].includes(origin(node.argument))) valid = false;
    }
    if (prototypeKeys !== null && node.type === 'MemberExpression') {
      const base = origin(node.object);
      const parent = parents?.get(node);
      const written = parent?.type === 'AssignmentExpression' && parent.left === node ||
        parent?.type === 'UpdateExpression' && parent.argument === node || parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === node;
      const field = node.computed ? property(node.property) : node.property.name;
      if (!written && ['object-prototype', 'maybe', 'container'].includes(base) && !(base === 'object-prototype' && field !== null && prototypeKeys.has(field))) valid = false;
    }
    if (['PropertyDefinition', 'AccessorProperty'].includes(node.type) && sensitive(origin(node.value)) || ['AwaitExpression', 'YieldExpression'].includes(node.type) && sensitive(origin(node.argument))) valid = false;
    if (node.type === 'ReturnStatement' && node.argument !== null && sensitive(origin(node.argument)) ||
      node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement' && sensitive(origin(node.body))) valid = false;
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.some((binding: Node) => binding.init !== null && sensitive(origin(binding.init)))) valid = false;
      if (node.source === null && (node.specifiers ?? []).some((specifier: Node) => sensitive(origin(specifier.local)))) valid = false;
    }
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type) || node.type === 'UnaryExpression' && node.operator === 'delete') {
      const left = unwrap(node.left ?? node.argument);
      if (left.type === 'Identifier' && sensitive(origin(left))) valid = false;
      if (prototypeKeys !== null && left.type === 'MemberExpression' && ['AssignmentExpression', 'UpdateExpression'].includes(node.type) &&
        ['object-prototype', 'maybe', 'container'].includes(origin(left.object))) valid = false;
      if (left.type === 'MemberExpression' && (touches(origin(left.object), left.computed ? property(left.property) : left.property.name) || node.type === 'AssignmentExpression' && sensitive(origin(node.right)))) valid = false;
    }
    if (node.type === 'TaggedTemplateExpression' && (sensitive(origin(node.tag)) || node.quasi.expressions.some((item: Node) => sensitive(origin(item))))) valid = false;
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    const callee = unwrap(node.callee);
    if (['eval', 'Function'].includes(named(callee) ?? '')) { valid = false; return; }
    const base = callee.type === 'MemberExpression' ? origin(callee.object) : '';
    const method = callee.type === 'MemberExpression' ? callee.computed ? property(callee.property) : callee.property.name : null;
    if (arrayIteration && base === 'array-instance' && method === null) {valid = false;return;}
    if (prototypeKeys !== null && ['object-prototype', 'maybe'].includes(base) && ['__defineGetter__', '__defineSetter__'].includes(method ?? '')) {valid = false;return;}
    const nativeObject = base === 'object' && method !== null && nativeMethods.has(method);
    const nativeReflect = callee.type === 'MemberExpression' && base === 'reflect';
    if ((nativeObject && changedObjectMethods.has(method!) || nativeReflect && changedReflectMethods.has(method!)) && node.arguments.some((argument: Node) => sensitive(origin(argument)))) {valid = false;return;}
    if (prototypeKeys !== null &&
      (nativeObject && ['defineProperty', 'getOwnPropertyDescriptor', 'hasOwn'].includes(method ?? '') ||
        nativeReflect && ['defineProperty', 'getOwnPropertyDescriptor', 'get', 'set', 'has', 'deleteProperty'].includes(method ?? '')) &&
      sensitive(origin(node.arguments[1]))) {valid = false;return;}
    if (prototypeKeys !== null && nativeObject && method === 'fromEntries' && node.arguments.some((argument: Node) => sensitive(origin(argument)))) {valid = false;return;}
    if (prototypeKeys !== null && ['object-prototype', 'maybe', 'container'].includes(origin(node.arguments[0])) &&
      (nativeObject && ['entries', 'values', 'assign'].includes(method ?? '') || nativeReflect && ['get', 'set'].includes(method ?? '') &&
        !(method === 'get' && origin(node.arguments[0]) === 'object-prototype' && prototypeKeys.has(node.arguments[1] === undefined ? '' : property(node.arguments[1]) ?? '')))) {valid = false;return;}
    if (nativeObject || nativeReflect && ['set', 'defineProperty', 'deleteProperty'].includes(method ?? '')) {
      const target = node.arguments[0] === undefined ? '' : origin(node.arguments[0]);
      if (['defineProperty', 'set', 'deleteProperty'].includes(method ?? '') && touches(target, node.arguments[1] === undefined ? null : property(node.arguments[1]))) valid = false;
      if (['defineProperty', 'set'].includes(method ?? '') && node.arguments.slice(2).some((argument: Node) => sensitive(origin(argument)))) valid = false;
      if (method === 'create' && node.arguments.slice(1).some((argument: Node) => sensitive(origin(argument)))) valid = false;
      if (['assign', 'defineProperties'].includes(method ?? '') && !target && node.arguments.slice(1).some((argument: Node) => sensitive(origin(argument)))) valid = false;
      if (['assign', 'defineProperties'].includes(method ?? '') && sensitive(target)) {
        for (const argument of node.arguments.slice(1)) {
          if (argument.type !== 'ObjectExpression' || argument.properties.some((item: Node) => item.type === 'SpreadElement' || touches(target, item.computed ? property(item.key) : key(item.key) ?? null))) valid = false;
        }
      }
      if (prototypeKeys !== null && method === 'setPrototypeOf' && sensitive(target)) valid = false;
      if (['setPrototypeOf', 'freeze', 'seal', 'preventExtensions'].includes(method ?? '') && sensitive(target) && target !== 'object-prototype') valid = false;
      return;
    }
    if ((arrayIteration || stringConstructor || prototypeKeys !== null) && nativeReflect && ['get', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'ownKeys', 'has', 'isExtensible'].includes(method ?? '')) return;
    if (stringConstructor && origin(callee) === 'string-constructor') return;
    if (origin(callee) === 'method') {
      if (node.arguments.some((argument: Node) => sensitive(origin(argument)))) valid = false;
      return;
    }
    if ((arrayIteration || prototypeKeys !== null) && sensitive(origin(callee)) && !['iterator-factory', 'iterator-method', 'array-constructor', 'symbol'].includes(origin(callee))) valid = false;
    if (['maybe', 'uncertain'].includes(origin(callee)) || node.arguments.some((argument: Node) => sensitive(origin(argument)))) valid = false;
  });
  return valid;
}
