/**
 * effect-native/require-context-service-for-service-interface
 *
 * Audit B4: exported service-shaped contracts need an explicit Context tag/Layer connection.
 * Recognizes effectful returns, nested operation records, index signatures, local type aliases,
 * separate exports and utility-wrapped ReturnType aliases. Real import identity and lexical scope
 * distinguish actual tag construction from type-only/bare member references or shadows.
 * Each contract must be named by a construction, an alias/factory return, or a supplied value's
 * explicit satisfies/type annotation. An unrelated Layer or opaque Reference does not suppress
 * the module. Data callbacks that merely accept Effects do not become Effect-returning services.
 * Limitations: no cross-file type checker or inferred structural contract equivalence; opaque
 * tags require explicit local evidence. Naming and ReturnType detection are service heuristics,
 * not proof that values never enter a runtime. Report only; no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/** Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  'tools/**',
  '**/*.d.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/module-federation.config.ts',
  '**/scripts/**',
];

const DEFAULT_SERVICE_NAME_PATTERN =
  '(Service|Repository|Gateway|Resolver|Access|Store|Port|Contract)$';
const DEFAULT_DATA_TYPE_PATTERN =
  '(Input|Output|Options|Config|Record|Row|Payload|Result|Error|Problem)$';
const DEFAULT_EFFECT_TYPES = ['Effect'];
const DEFAULT_PROMISE_TYPES = ['Promise', 'PromiseLike'];
const DEFAULT_TAG_MEMBERS = ['Service', 'Reference', 'Tag', 'GenericTag'];
const DEFAULT_TAG_NAMESPACES = ['Context', 'Effect'];
const DEFAULT_LAYER_MEMBERS = [
  'effect',
  'succeed',
  'sync',
  'scoped',
  'scopedDiscard',
  'effectDiscard',
];

const TSX_FILE = /\.[cm]?[jt]sx$/u;
/** Depth cap for the generic type-subtree walk; deep enough for nested generics, cheap enough to run per member. */
const MAX_TYPE_DEPTH = 12;

type AnyNode = ESTree.Node & { readonly parent?: ESTree.Node | null };

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly includeTsx: boolean;
  readonly exportedOnly: boolean;
  readonly includeReturnTypeAliases: boolean;
  readonly includePromiseMembers: boolean;
  readonly allowLayerConstruction: boolean;
  readonly requireTagPerContract: boolean;
  readonly serviceNamePattern: string;
  readonly dataTypePattern: string;
  readonly effectTypes: readonly string[];
  readonly promiseTypes: readonly string[];
  readonly tagMembers: readonly string[];
  readonly tagNamespaces: readonly string[];
  readonly layerMembers: readonly string[];
  readonly allowNames: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    includeTests: boolean(record.includeTests, false),
    includeTsx: boolean(record.includeTsx, false),
    exportedOnly: boolean(record.exportedOnly, true),
    includeReturnTypeAliases: boolean(record.includeReturnTypeAliases, true),
    includePromiseMembers: boolean(record.includePromiseMembers, true),
    allowLayerConstruction: boolean(record.allowLayerConstruction, true),
    requireTagPerContract: boolean(record.requireTagPerContract, true),
    serviceNamePattern: text(record.serviceNamePattern, DEFAULT_SERVICE_NAME_PATTERN),
    dataTypePattern: text(record.dataTypePattern, DEFAULT_DATA_TYPE_PATTERN),
    effectTypes: stringArray(record.effectTypes, DEFAULT_EFFECT_TYPES),
    promiseTypes: stringArray(record.promiseTypes, DEFAULT_PROMISE_TYPES),
    tagMembers: stringArray(record.tagMembers, DEFAULT_TAG_MEMBERS),
    tagNamespaces: stringArray(record.tagNamespaces, DEFAULT_TAG_NAMESPACES),
    layerMembers: stringArray(record.layerMembers, DEFAULT_LAYER_MEMBERS),
    allowNames: stringArray(record.allowNames, []),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function safeRegExp(pattern: string, fallback: string): RegExp {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return new RegExp(fallback, 'u');
  }
}

/** Flatten `Effect.Effect` / `Promise` type names into their dotted segments. */
function typeNameSegments(name: ESTree.TSTypeName): readonly string[] | null {
  if (name.type === 'Identifier') return [name.name];
  if (name.type === 'TSQualifiedName') {
    const left = typeNameSegments(name.left);
    return left === null ? null : [...left, name.right.name];
  }
  return null;
}

function unwrapType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === 'TSParenthesizedType') current = current.typeAnnotation;
  return current;
}

interface Candidate {
  readonly node: ESTree.Node;
  readonly name: string;
  readonly messageId: string;
  readonly kind: string;
  readonly member: string;
  /** For `type X = ReturnType<typeof makeX>`: the factory name, so a tag on the same factory counts. */
  readonly factory: ESTree.Node | null;
}

/**
 * The type arguments of the call expressions wrapping a tag callee (`Context.Service<Tag, X>()(…)`),
 * plus the name the construction is bound to — the self reference (`class X extends
 * Context.Service<X, XService>`) names the tag, not the contract, so it must not count as wiring.
 */
function tagConstructionInfo(callee: AnyNode): {
  readonly typeArgs: readonly unknown[];
  readonly owner: string | null;
} {
  const typeArgs: unknown[] = [];
  let current: AnyNode | null = callee;
  let outermost: AnyNode = callee;
  // Two hops covers `Context.Service<A, B>()('id')` and `Context.GenericTag<B>('id')`.
  for (let hop = 0; hop < 2 && current !== null; hop += 1) {
    const parent: AnyNode | null = (current.parent as AnyNode | null | undefined) ?? null;
    if (parent === null) break;
    if (parent.type !== 'CallExpression' && parent.type !== 'NewExpression') break;
    const args = (parent as { readonly typeArguments?: unknown }).typeArguments;
    if (args !== null && args !== undefined) typeArgs.push(args);
    current = parent;
    outermost = parent;
  }
  const holder = (outermost.parent as AnyNode | null | undefined) ?? null;
  let owner: string | null = null;
  if (holder !== null) {
    if (
      (holder.type === 'ClassDeclaration' || holder.type === 'ClassExpression') &&
      holder.id !== null &&
      holder.id !== undefined
    ) {
      owner = holder.id.name;
    } else if (holder.type === 'VariableDeclarator' && holder.id.type === 'Identifier') {
      owner = holder.id.name;
    }
  }
  return { typeArgs, owner };
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B4: detect exported service-shaped contracts lacking an explicit local tag/Layer connection. Lexical declarations, local aliases and supplied-value annotations provide evidence; AST-only analysis cannot infer cross-file structural equivalence or prove runtime use.',
    },
    messages: {
      untaggedServiceContract:
        "Audit B4: '{{name}}' has effectful member '{{member}}' but no recognized local contract connection to a Context tag/Layer. Declare Context.Service<{{tag}}, {{name}}> or identify the supplied contract explicitly; runtime use is not inferred.",
      untaggedServiceAlias:
        "Audit B4: service-shaped alias '{{name}}' derives from '{{member}}' without a recognized local tag/Layer connection. Prefer an explicit Context.Service contract; this naming heuristic does not prove runtime provisioning.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeTsx: { type: 'boolean' },
          exportedOnly: { type: 'boolean' },
          includeReturnTypeAliases: { type: 'boolean' },
          includePromiseMembers: { type: 'boolean' },
          allowLayerConstruction: { type: 'boolean' },
          requireTagPerContract: { type: 'boolean' },
          serviceNamePattern: { type: 'string' },
          dataTypePattern: { type: 'string' },
          effectTypes: { type: 'array', items: { type: 'string' } },
          promiseTypes: { type: 'array', items: { type: 'string' } },
          tagMembers: { type: 'array', items: { type: 'string' } },
          tagNamespaces: { type: 'array', items: { type: 'string' } },
          layerMembers: { type: 'array', items: { type: 'string' } },
          allowNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        includeTests: false,
        includeTsx: false,
        exportedOnly: true,
        includeReturnTypeAliases: true,
        includePromiseMembers: true,
        allowLayerConstruction: true,
        requireTagPerContract: true,
        serviceNamePattern: DEFAULT_SERVICE_NAME_PATTERN,
        dataTypePattern: DEFAULT_DATA_TYPE_PATTERN,
        effectTypes: DEFAULT_EFFECT_TYPES,
        promiseTypes: DEFAULT_PROMISE_TYPES,
        tagMembers: DEFAULT_TAG_MEMBERS,
        tagNamespaces: DEFAULT_TAG_NAMESPACES,
        layerMembers: DEFAULT_LAYER_MEMBERS,
        allowNames: [],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeTsx && TSX_FILE.test(path)) return {};

    const program = context.sourceCode.ast;
    const variableFor = (node: any, name: string): any => {
      for (
        let scope: import('@oxlint/plugins').Scope | null = context.sourceCode.getScope(node);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(name);
        if (variable) return variable;
      }
      return null;
    };
    const localAlias = (node: any): any =>
      node?.type === 'Identifier'
        ? variableFor(node, node.name)?.defs.find(
            (d: any) => d.node.type === 'TSTypeAliasDeclaration',
          )?.node.typeAnnotation
        : null;
    const imported = (node: any, seen = new Set<any>()): string | null => {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (
        [
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSInstantiationExpression',
          'ChainExpression',
        ].includes(node.type)
      )
        return imported(node.expression, seen);
      if (node.type === 'MemberExpression' || node.type === 'TSQualifiedName') {
        const object = imported(node.object ?? node.left, seen);
        const p = node.property ?? node.right;
        const key = !node.computed
          ? p.name
          : p.type === 'Literal'
            ? p.value
            : p.type === 'TemplateLiteral' && !p.expressions.length
              ? p.quasis[0]?.value.cooked
              : null;
        return object && typeof key === 'string' ? `${object}.${key}` : null;
      }
      if (node.type !== 'Identifier') return null;
      const variable = variableFor(node, node.name);
      for (const def of variable?.defs ?? []) {
        if (def.type === 'ImportBinding') {
          const source = def.parent?.source?.value;
          if (!/^effect(?:\/|$)/u.test(source ?? '')) return null;
          const name = def.node.imported?.name ?? def.node.imported?.value;
          return source === 'effect'
            ? (name ?? 'root')
            : `${source.split('/').at(-1)}${name ? `.${name}` : ''}`;
        }
        if (
          def.type === 'Variable' &&
          def.parent?.kind === 'const' &&
          !variable.references.some((r: any) => r.isWrite() && !r.init)
        )
          return imported(def.node.init, seen);
      }
      return null;
    };
    const separateExports = new Set<any>();
    for (const statement of program.body)
      if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
        for (const spec of statement.specifiers)
          if (spec.local.type === 'Identifier')
            separateExports.add(variableFor(spec.local, spec.local.name));
      }
    const servicePattern = safeRegExp(options.serviceNamePattern, DEFAULT_SERVICE_NAME_PATTERN);
    const dataPattern = safeRegExp(options.dataTypePattern, DEFAULT_DATA_TYPE_PATTERN);
    const promiseTypes = new Set(options.promiseTypes);
    const tagMembers = new Set(options.tagMembers);
    const tagNamespaces = new Set(options.tagNamespaces);
    const layerMembers = new Set(options.layerMembers);
    const allowNames = new Set(options.allowNames);

    const candidates: Candidate[] = [];
    let moduleHasTag = false;
    /** Lexical declaration identity, never a module-wide spelling match. */
    const taggedDeclarations = new Set<any>();
    const taggedFactories = new Set<any>();
    const declarationsFor = (id: any): any[] =>
      id?.type === 'Identifier'
        ? (variableFor(id, id.name)?.defs ?? []).map((def: any) => def.node)
        : [];
    const collectContracts = (value: any, depth = 0): void => {
      if (!value || typeof value !== 'object' || depth > MAX_TYPE_DEPTH) return;
      if (Array.isArray(value)) {
        value.forEach((child) => collectContracts(child, depth + 1));
        return;
      }
      if (value.type === 'TSTypeReference')
        for (const declaration of declarationsFor(value.typeName))
          taggedDeclarations.add(declaration);
      if (value.type === 'TSTypeQuery')
        for (const declaration of declarationsFor(value.exprName)) taggedFactories.add(declaration);
      for (const [key, child] of Object.entries(value))
        if (key !== 'parent') collectContracts(child, depth + 1);
    };

    // ------------------------------------------------------------------ effect / promise types

    /** `Effect.Effect<…>`, `Eff.Effect<…>`, `E.Effect.Effect<…>` or a bare `Effect<…>` type import. */
    const isEffectTypeReference = (reference: ESTree.TSTypeReference): boolean => {
      const path = imported(reference.typeName);
      return path !== null && /^(?:root\.)?Effect(?:\.Effect)?$/u.test(path);
    };

    /** A global `Promise<…>` / `PromiseLike<…>`, unless the module declares its own type of that name. */
    const isPromiseTypeReference = (reference: ESTree.TSTypeReference): boolean => {
      if (!options.includePromiseMembers) return false;
      const segments = typeNameSegments(reference.typeName);
      if (!segments || segments.length !== 1 || !promiseTypes.has(segments[0]!)) return false;
      return !variableFor(reference.typeName, segments[0]!)?.defs.length;
    };
    const effectfulReference = (reference: ESTree.TSTypeReference): string | null => {
      if (isEffectTypeReference(reference)) return 'Effect';
      if (isPromiseTypeReference(reference)) return 'Promise';
      return null;
    };

    /** Any effectful type reference anywhere inside a *return type* subtree (unions, arrays, generics). */
    const returnTypeIsEffectful = (node: unknown, depth: number): string | null => {
      if (depth > MAX_TYPE_DEPTH || node === null || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const entry of node) {
          const found = returnTypeIsEffectful(entry, depth + 1);
          if (found !== null) return found;
        }
        return null;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.type !== 'string') return null;
      if (record.type === 'TSFunctionType' || record.type === 'TSConstructorType')
        return returnTypeIsEffectful(record.returnType, depth + 1);
      if (record.type === 'TSTypeReference') {
        const found = effectfulReference(node as ESTree.TSTypeReference);
        if (found !== null) return found;
        const alias = localAlias(record.typeName);
        if (alias) return returnTypeIsEffectful(alias, depth + 1);
      }
      for (const [key, value] of Object.entries(record)) {
        // `parent` back-references would make this walk cyclic.
        if (key === 'parent' || key === 'type' || value === null || typeof value !== 'object')
          continue;
        const found = returnTypeIsEffectful(value, depth + 1);
        if (found !== null) return found;
      }
      return null;
    };

    /** Effectfulness of a *member annotation*: function types are judged by their return type only. */
    const annotationIsEffectful = (type: ESTree.TSType, depth: number): string | null => {
      if (depth > MAX_TYPE_DEPTH) return null;
      const current = unwrapType(type);
      if (current.type === 'TSFunctionType' || current.type === 'TSConstructorType') {
        const returnType = (current as { readonly returnType?: ESTree.TSTypeAnnotation | null })
          .returnType;
        return returnType === null || returnType === undefined
          ? null
          : returnTypeIsEffectful(returnType.typeAnnotation, 0);
      }
      if (current.type === 'TSUnionType' || current.type === 'TSIntersectionType') {
        for (const member of current.types) {
          const found = annotationIsEffectful(member, depth + 1);
          if (found !== null) return found;
        }
        return null;
      }
      if (current.type === 'TSTypeLiteral') return firstEffectfulMember(current.members, depth + 1);
      if (current.type === 'TSTypeReference') {
        const direct = effectfulReference(current);
        if (direct) return direct;
        const alias = localAlias(current.typeName);
        return alias ? annotationIsEffectful(alias, depth + 1) : null;
      }
      return null;
    };

    const memberKeyName = (member: { readonly key?: ESTree.Node | null }): string => {
      const key = member.key ?? null;
      if (key === null) return 'a member';
      if (key.type === 'Identifier') return key.name;
      if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
      return 'a member';
    };

    /** The first effectful member of an interface body / type literal, described for the message. */
    const firstEffectfulMember = (members: readonly ESTree.Node[], depth = 0): string | null => {
      if (depth > MAX_TYPE_DEPTH) return null;
      for (const member of members) {
        if (member.type === 'TSMethodSignature') {
          const returnType = (member as ESTree.TSMethodSignature).returnType;
          if (returnType === null || returnType === undefined) continue;
          const wrapper = returnTypeIsEffectful(returnType.typeAnnotation, 0);
          if (wrapper !== null) return `${memberKeyName(member as never)}(): ${wrapper}`;
          continue;
        }
        if (member.type === 'TSPropertySignature' || member.type === 'TSIndexSignature') {
          const annotation = (member as ESTree.TSPropertySignature).typeAnnotation;
          if (annotation === null || annotation === undefined) continue;
          const wrapper = annotationIsEffectful(annotation.typeAnnotation, depth + 1);
          if (wrapper !== null) return `${memberKeyName(member as never)}: ${wrapper}`;
          continue;
        }
        if (
          member.type === 'TSCallSignatureDeclaration' ||
          member.type === 'TSConstructSignatureDeclaration'
        ) {
          const returnType = (member as { readonly returnType?: ESTree.TSTypeAnnotation | null })
            .returnType;
          if (returnType === null || returnType === undefined) continue;
          const wrapper = returnTypeIsEffectful(returnType.typeAnnotation, 0);
          if (wrapper !== null) return `the call signature returning ${wrapper}`;
        }
      }
      return null;
    };

    // ------------------------------------------------------------------ candidates

    const isExported = (node: AnyNode): boolean => {
      const parent = (node.parent as AnyNode | null | undefined) ?? null;
      if (separateExports.has(variableFor(node, (node as any).id?.name))) return true;
      if (parent === null) return false;
      return parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration';
    };

    const isServiceName = (name: string): boolean => {
      if (allowNames.has(name)) return false;
      if (dataPattern.test(name)) return false;
      return servicePattern.test(name);
    };

    const tagNameFor = (name: string): string =>
      name.endsWith('Service') && name.length > 'Service'.length
        ? name.slice(0, -'Service'.length)
        : `${name}Tag`;

    /** `ReturnType<typeof makeX>` — a factory-derived service contract. */
    const returnTypeAlias = (
      type: ESTree.TSType,
    ): { label: string; factory: ESTree.Node | null } | null => {
      const current = unwrapType(type);
      if (current.type !== 'TSTypeReference') return null;
      if (
        current.typeName.type === 'Identifier' &&
        ['Awaited', 'Readonly', 'NonNullable'].includes(current.typeName.name) &&
        !variableFor(current.typeName, current.typeName.name)?.defs.length
      ) {
        const inner = current.typeArguments?.params[0];
        return inner ? returnTypeAlias(inner) : null;
      }
      const segments = typeNameSegments(current.typeName);
      if (
        segments === null ||
        segments.length !== 1 ||
        segments[0] !== 'ReturnType' ||
        variableFor(current.typeName, 'ReturnType')?.defs.length
      )
        return null;
      const argument = current.typeArguments?.params?.[0];
      if (argument === undefined) return null;
      const inner = unwrapType(argument);
      if (inner.type !== 'TSTypeQuery') return null;
      const name = inner.exprName;
      if (name.type === 'Identifier')
        return { label: `ReturnType<typeof ${name.name}>`, factory: name };
      return { label: 'ReturnType<typeof …>', factory: null };
    };

    /** Only tag type arguments and explicitly supplied values identify a contract. */
    const recordTagConstruction = (callee: AnyNode): void => {
      for (const args of tagConstructionInfo(callee).typeArgs) collectContracts(args);
    };
    const resolveFactoryReturnContracts = (): void => {
      for (let round = 0; round < MAX_TYPE_DEPTH; round++) {
        const before = taggedDeclarations.size + taggedFactories.size;
        for (const declaration of taggedDeclarations)
          if (declaration.type === 'TSTypeAliasDeclaration')
            collectContracts(declaration.typeAnnotation);
        for (const declaration of taggedFactories) {
          if (declaration.type === 'FunctionDeclaration') collectContracts(declaration.returnType);
          if (declaration.type === 'VariableDeclarator') {
            // Only the function's return annotation, not its collaborator parameters.
            const type = declaration.id.typeAnnotation?.typeAnnotation;
            if (type?.type === 'TSFunctionType') collectContracts(type.returnType);
            collectContracts(declaration.init?.returnType);
          }
        }
        if (before === taggedDeclarations.size + taggedFactories.size) break;
      }
    };
    const isWired = (candidate: Candidate): boolean =>
      declarationsFor(candidate.node).some((declaration) => taggedDeclarations.has(declaration)) ||
      declarationsFor(candidate.factory).some((declaration) => taggedFactories.has(declaration));

    // Follow the provided value, not arbitrary nested assertions in construction arguments.
    const providedContract = (value: any, seen = new Set<any>()): void => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      if (['TSSatisfiesExpression', 'TSAsExpression', 'TSTypeAssertion'].includes(value.type)) {
        collectContracts(value.typeAnnotation);
        providedContract(value.expression, seen);
      } else if (
        ['TSNonNullExpression', 'TSInstantiationExpression', 'ChainExpression'].includes(value.type)
      ) {
        providedContract(value.expression, seen);
      } else if (value.type === 'Identifier') {
        const variable = variableFor(value, value.name);
        for (const def of variable?.defs ?? [])
          if (
            def.type === 'Variable' &&
            def.parent?.kind === 'const' &&
            !variable.references.some((ref: any) => ref.isWrite() && !ref.init)
          ) {
            collectContracts(def.node.id.typeAnnotation);
            providedContract(def.node.init, seen);
          }
      } else if (
        value.type === 'CallExpression' &&
        /^(?:root\.)?Effect\.(?:succeed|sync)$/u.test(imported(value.callee) ?? '')
      ) {
        providedContract(value.arguments[0], seen);
      } else if (['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) {
        collectContracts(value.returnType);
        if (value.body.type === 'BlockStatement') {
          for (const statement of value.body.body)
            if (statement.type === 'ReturnStatement') providedContract(statement.argument, seen);
        } else providedContract(value.body, seen);
      }
    };

    return {
      CallExpression(node) {
        const path = imported(node.callee);
        if (!path) return;
        const segments = path.replace(/^root\./u, '').split('.');
        const isTag =
          segments.length === 2 && tagNamespaces.has(segments[0]!) && tagMembers.has(segments[1]!);
        const isLayer =
          options.allowLayerConstruction &&
          segments[0] === 'Layer' &&
          layerMembers.has(segments[1]!);
        if (!isTag && !isLayer) return;
        moduleHasTag = true;
        if (isTag) recordTagConstruction(node.callee as AnyNode);
        let outer: any = node;
        while (outer.parent?.type === 'CallExpression' && outer.parent.callee === outer)
          outer = outer.parent;
        if (isLayer) providedContract(outer.arguments[1]);
        else {
          const config = outer.arguments[1];
          if (config?.type === 'ObjectExpression')
            for (const property of config.properties) {
              const key = property.computed ? property.key?.value : property.key?.name;
              if (property.type === 'Property' && ['effect', 'defaultValue'].includes(key))
                providedContract(property.value);
            }
        }
      },
      TSInterfaceDeclaration(node) {
        const name = node.id.name;
        if (!isServiceName(name)) return;
        if (options.exportedOnly && !isExported(node as unknown as AnyNode)) return;
        const member = firstEffectfulMember(node.body.body as unknown as readonly ESTree.Node[]);
        if (member === null) return;
        candidates.push({
          node: node.id as unknown as ESTree.Node,
          name,
          messageId: 'untaggedServiceContract',
          kind: 'interface',
          member,
          factory: null,
        });
      },
      TSTypeAliasDeclaration(node) {
        const name = node.id.name;
        if (!isServiceName(name)) return;
        if (options.exportedOnly && !isExported(node as unknown as AnyNode)) return;
        const annotation = unwrapType(node.typeAnnotation);
        if (annotation.type === 'TSTypeLiteral') {
          const member = firstEffectfulMember(
            annotation.members as unknown as readonly ESTree.Node[],
          );
          if (member === null) return;
          candidates.push({
            node: node.id as unknown as ESTree.Node,
            name,
            messageId: 'untaggedServiceContract',
            kind: 'type',
            member,
            factory: null,
          });
          return;
        }
        if (!options.includeReturnTypeAliases) return;
        const derived = returnTypeAlias(annotation);
        if (derived === null) return;
        candidates.push({
          node: node.id as unknown as ESTree.Node,
          name,
          messageId: 'untaggedServiceAlias',
          kind: 'type',
          member: derived.label,
          factory: derived.factory,
        });
      },
      'Program:exit'() {
        if (candidates.length === 0) return;
        if (!options.requireTagPerContract && moduleHasTag) return;
        resolveFactoryReturnContracts();

        for (const candidate of candidates) {
          if (options.requireTagPerContract && isWired(candidate)) continue;
          context.report({
            node: candidate.node,
            messageId: candidate.messageId,
            data: {
              name: candidate.name,
              member: candidate.member,
              kind: candidate.kind,
              tag: tagNameFor(candidate.name),
            },
          });
        }
      },
    };
  },
});
