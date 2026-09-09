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

import { typeNameSegments } from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import { optionRecord } from '../shared/options.ts';
import { booleanOption as boolean, stringArray, stringOption, safeRegExp } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

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

const DEFAULT_SERVICE_NAME_PATTERN = '(Service|Repository|Gateway|Resolver|Access|Store|Port|Contract)$';
const DEFAULT_DATA_TYPE_PATTERN = '(Input|Output|Options|Config|Record|Row|Payload|Result|Error|Problem)$';
const DEFAULT_EFFECT_TYPES = ['Effect'];
const DEFAULT_PROMISE_TYPES = ['Promise', 'PromiseLike'];
const DEFAULT_TAG_MEMBERS = ['Service', 'Reference', 'Tag', 'GenericTag'];
const DEFAULT_TAG_NAMESPACES = ['Context', 'Effect'];
const DEFAULT_LAYER_MEMBERS = ['effect', 'succeed', 'sync', 'scoped', 'scopedDiscard', 'effectDiscard'];

const TSX_FILE = /\.[cm]?[jt]sx$/u;
/** Depth cap for the generic type-subtree walk; deep enough for nested generics, cheap enough to run per member. */
const MAX_TYPE_DEPTH = 12;

type AnyNode = ESTree.Node & { readonly parent?: ESTree.Node | null };

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
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
    serviceNamePattern: stringOption(record.serviceNamePattern, DEFAULT_SERVICE_NAME_PATTERN, false),
    dataTypePattern: stringOption(record.dataTypePattern, DEFAULT_DATA_TYPE_PATTERN, false),
    effectTypes: stringArray(record.effectTypes, DEFAULT_EFFECT_TYPES),
    promiseTypes: stringArray(record.promiseTypes, DEFAULT_PROMISE_TYPES),
    tagMembers: stringArray(record.tagMembers, DEFAULT_TAG_MEMBERS),
    tagNamespaces: stringArray(record.tagNamespaces, DEFAULT_TAG_NAMESPACES),
    layerMembers: stringArray(record.layerMembers, DEFAULT_LAYER_MEMBERS),
    allowNames: stringArray(record.allowNames, []),
  };
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

/** Type arguments from the two call layers surrounding a tag callee. */
function tagConstructionArguments(callee: AnyNode): readonly unknown[] {
  const typeArgs: unknown[] = [];
  let current: AnyNode = callee;
  for (let hop = 0; hop < 2; hop += 1) {
    const parent = current.parent;
    if (!parent || !['CallExpression', 'NewExpression'].includes(parent.type)) break;
    const args = (parent as { readonly typeArguments?: unknown }).typeArguments;
    if (args != null) typeArgs.push(args);
    current = parent;
  }
  return typeArgs;
}

function firstResult<T>(values: readonly T[], visit: (value: T) => string | null): string | null {
  for (const value of values) {
    const found = visit(value);
    if (found !== null) return found;
  }
  return null;
}

function immutableVariable(def: any, variable: any): boolean {
  return (
    def.type === 'Variable' &&
    def.parent?.kind === 'const' &&
    !variable.references.some((reference: any) => reference.isWrite() && !reference.init)
  );
}

function importDefinitionPath(def: any): string | null {
  const source = def.parent?.source?.value;
  if (!/^effect(?:\/|$)/u.test(source ?? '')) return null;
  const name = def.node.imported?.name ?? def.node.imported?.value;
  if (source === 'effect') return name ?? 'root';
  return `${source.split('/').at(-1)}${name ? `.${name}` : ''}`;
}

function importedMemberKey(node: any): unknown {
  const property = node.property ?? node.right;
  if (!node.computed) return property.name;
  if (property.type === 'Literal') return property.value;
  if (property.type === 'TemplateLiteral' && !property.expressions.length) return property.quasis[0]?.value.cooked;
  return null;
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
    const variableFor = (node: any, name: string): any => resolveVariable(context, name, node);
    const localAlias = (node: any): any =>
      node?.type === 'Identifier'
        ? variableFor(node, node.name)?.defs.find((d: any) => d.node.type === 'TSTypeAliasDeclaration')?.node
            .typeAnnotation
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
        return importedMember(node, seen);
      }
      if (node.type !== 'Identifier') return null;
      return importedIdentifier(node, seen);
    };
    const importedMember = (node: any, seen: Set<any>): string | null => {
      const object = imported(node.object ?? node.left, seen);
      const key = importedMemberKey(node);
      return object && typeof key === 'string' ? `${object}.${key}` : null;
    };
    const importedIdentifier = (node: any, seen: Set<any>): string | null => {
      const variable = variableFor(node, node.name);
      for (const def of variable?.defs ?? []) {
        if (def.type === 'ImportBinding') return importDefinitionPath(def);
        if (immutableVariable(def, variable)) return imported(def.node.init, seen);
      }
      return null;
    };
    const separateExports = new Set<any>();
    const collectSeparateExports = (): void => {
      for (const statement of program.body)
        if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
          for (const spec of statement.specifiers)
            if (spec.local.type === 'Identifier') separateExports.add(variableFor(spec.local, spec.local.name));
        }
    };
    collectSeparateExports();
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
      id?.type === 'Identifier' ? (variableFor(id, id.name)?.defs ?? []).map((def: any) => def.node) : [];
    const collectContracts = (value: any, depth = 0): void => {
      if (!value || typeof value !== 'object' || depth > MAX_TYPE_DEPTH) return;
      if (Array.isArray(value)) {
        value.forEach((child) => collectContracts(child, depth + 1));
        return;
      }
      collectContractReferences(value);
      for (const [key, child] of Object.entries(value)) if (key !== 'parent') collectContracts(child, depth + 1);
    };
    const collectContractReferences = (value: any): void => {
      if (value.type === 'TSTypeReference')
        for (const declaration of declarationsFor(value.typeName)) taggedDeclarations.add(declaration);
      if (value.type === 'TSTypeQuery')
        for (const declaration of declarationsFor(value.exprName)) taggedFactories.add(declaration);
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
      if (Array.isArray(node)) return firstResult(node, (entry) => returnTypeIsEffectful(entry, depth + 1));
      const record = node as Record<string, unknown>;
      if (typeof record.type !== 'string') return null;
      if (['TSFunctionType', 'TSConstructorType'].includes(record.type))
        return returnTypeIsEffectful(record.returnType, depth + 1);
      if (record.type === 'TSTypeReference') {
        const found = effectfulReference(node as ESTree.TSTypeReference);
        if (found !== null) return found;
        const alias = localAlias(record.typeName);
        if (alias) return returnTypeIsEffectful(alias, depth + 1);
      }
      return returnChildrenAreEffectful(record, depth);
    };
    const returnChildrenAreEffectful = (record: Record<string, unknown>, depth: number): string | null =>
      firstResult(Object.entries(record), ([key, value]) => {
        if (key === 'parent' || key === 'type' || value === null || typeof value !== 'object') return null;
        return returnTypeIsEffectful(value, depth + 1);
      });

    /** Effectfulness of a *member annotation*: function types are judged by their return type only. */
    const annotationIsEffectful = (type: ESTree.TSType, depth: number): string | null => {
      if (depth > MAX_TYPE_DEPTH) return null;
      const current = unwrapType(type);
      if (['TSFunctionType', 'TSConstructorType'].includes(current.type)) return signatureEffect(current);
      if (current.type === 'TSUnionType' || current.type === 'TSIntersectionType') {
        return firstResult(current.types, (member) => annotationIsEffectful(member, depth + 1));
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
      return firstResult(members, (member) => effectfulMember(member, depth));
    };
    const signatureEffect = (member: any): string | null => {
      const annotation = member.returnType;
      return annotation == null ? null : returnTypeIsEffectful(annotation.typeAnnotation, 0);
    };
    const effectfulMember = (member: ESTree.Node, depth: number): string | null => {
      if (member.type === 'TSMethodSignature') {
        const wrapper = signatureEffect(member);
        return wrapper === null ? null : `${memberKeyName(member as never)}(): ${wrapper}`;
      }
      if (member.type === 'TSPropertySignature' || member.type === 'TSIndexSignature') {
        const annotation = (member as ESTree.TSPropertySignature).typeAnnotation;
        if (annotation == null) return null;
        const wrapper = annotationIsEffectful(annotation.typeAnnotation, depth + 1);
        return wrapper === null ? null : `${memberKeyName(member as never)}: ${wrapper}`;
      }
      if (['TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration'].includes(member.type)) {
        const wrapper = signatureEffect(member);
        return wrapper === null ? null : `the call signature returning ${wrapper}`;
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
      name.endsWith('Service') && name.length > 'Service'.length ? name.slice(0, -'Service'.length) : `${name}Tag`;

    const isUtilityReference = (name: ESTree.TSTypeName): boolean =>
      name.type === 'Identifier' &&
      ['Awaited', 'Readonly', 'NonNullable'].includes(name.name) &&
      !variableFor(name, name.name)?.defs.length;

    const isReturnTypeReference = (name: ESTree.TSTypeName): boolean => {
      const segments = typeNameSegments(name);
      return (
        segments !== null &&
        segments.length === 1 &&
        segments[0] === 'ReturnType' &&
        !variableFor(name, 'ReturnType')?.defs.length
      );
    };

    /** `ReturnType<typeof makeX>` — a factory-derived service contract. */
    const returnTypeAlias = (type: ESTree.TSType): { label: string; factory: ESTree.Node | null } | null => {
      const current = unwrapType(type);
      if (current.type !== 'TSTypeReference') return null;
      if (isUtilityReference(current.typeName)) {
        const inner = current.typeArguments?.params[0];
        return inner ? returnTypeAlias(inner) : null;
      }
      if (!isReturnTypeReference(current.typeName)) return null;
      const argument = current.typeArguments?.params?.[0];
      if (argument === undefined) return null;
      const inner = unwrapType(argument);
      if (inner.type !== 'TSTypeQuery') return null;
      const name = inner.exprName;
      if (name.type === 'Identifier') return { label: `ReturnType<typeof ${name.name}>`, factory: name };
      return { label: 'ReturnType<typeof …>', factory: null };
    };

    /** Only tag type arguments and explicitly supplied values identify a contract. */
    const recordTagConstruction = (callee: AnyNode): void => {
      for (const args of tagConstructionArguments(callee)) collectContracts(args);
    };
    const collectDeclarationContract = (declaration: any): void => {
      if (declaration.type === 'TSTypeAliasDeclaration') collectContracts(declaration.typeAnnotation);
    };
    const collectFactoryContract = (declaration: any): void => {
      if (declaration.type === 'FunctionDeclaration') collectContracts(declaration.returnType);
      if (declaration.type !== 'VariableDeclarator') return;
      const type = declaration.id.typeAnnotation?.typeAnnotation;
      if (type?.type === 'TSFunctionType') collectContracts(type.returnType);
      collectContracts(declaration.init?.returnType);
    };
    const resolveFactoryReturnContracts = (): void => {
      for (let round = 0; round < MAX_TYPE_DEPTH; round++) {
        const before = taggedDeclarations.size + taggedFactories.size;
        for (const declaration of taggedDeclarations) collectDeclarationContract(declaration);
        for (const declaration of taggedFactories) collectFactoryContract(declaration);
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
      } else if (['TSNonNullExpression', 'TSInstantiationExpression', 'ChainExpression'].includes(value.type)) {
        providedContract(value.expression, seen);
      } else if (value.type === 'Identifier') {
        providedIdentifierContract(value, seen);
      } else if (
        value.type === 'CallExpression' &&
        /^(?:root\.)?Effect\.(?:succeed|sync)$/u.test(imported(value.callee) ?? '')
      ) {
        providedContract(value.arguments[0], seen);
      } else if (['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)) {
        providedFunctionContract(value, seen);
      }
    };
    const providedIdentifierContract = (value: any, seen: Set<any>): void => {
      const variable = variableFor(value, value.name);
      for (const def of variable?.defs ?? []) {
        if (!immutableVariable(def, variable)) continue;
        collectContracts(def.node.id.typeAnnotation);
        providedContract(def.node.init, seen);
      }
    };
    const providedFunctionContract = (value: any, seen: Set<any>): void => {
      collectContracts(value.returnType);
      if (value.body.type !== 'BlockStatement') {
        providedContract(value.body, seen);
        return;
      }
      for (const statement of value.body.body)
        if (statement.type === 'ReturnStatement') providedContract(statement.argument, seen);
    };
    const providedConfiguration = (config: any): void => {
      if (config?.type !== 'ObjectExpression') return;
      for (const property of config.properties) {
        const key = property.computed ? property.key?.value : property.key?.name;
        if (property.type === 'Property' && ['effect', 'defaultValue'].includes(key)) providedContract(property.value);
      }
    };
    const outerCall = (node: any): any => {
      let outer = node;
      while (outer.parent?.type === 'CallExpression' && outer.parent.callee === outer) outer = outer.parent;
      return outer;
    };

    return {
      CallExpression(node) {
        const path = imported(node.callee);
        if (!path) return;
        const segments = path.replace(/^root\./u, '').split('.');
        const isTag = segments.length === 2 && tagNamespaces.has(segments[0]!) && tagMembers.has(segments[1]!);
        const isLayer = options.allowLayerConstruction && segments[0] === 'Layer' && layerMembers.has(segments[1]!);
        if (!isTag && !isLayer) return;
        moduleHasTag = true;
        if (isTag) recordTagConstruction(node.callee as AnyNode);
        const outer = outerCall(node);
        if (isLayer) providedContract(outer.arguments[1]);
        else providedConfiguration(outer.arguments[1]);
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
          const member = firstEffectfulMember(annotation.members as unknown as readonly ESTree.Node[]);
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
