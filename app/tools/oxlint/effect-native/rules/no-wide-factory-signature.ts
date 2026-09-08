/**
 * effect-native/no-wide-factory-signature
 *
 * Audit B4: wide named factory signatures and dependency-shaped bags in Effect programs.
 * Factory identity includes statically computed string/template keys and TS-wrapped functions.
 * Effect bodies require scope-resolved import/member calls, including aliases and point-free
 * forms; comments, text literals and unrelated Node stream .pipe are not evidence.
 * Proven local scalar/data parameter shapes are excluded: B4 is dependency vocabulary, not
 * a ban on URL builders or CRUD request options. Unknown/imported types and untyped wide
 * signatures remain heuristic; this AST-only rule cannot prove all such parameters are services.
 * Configurable naming and width controls intentionally cover only part of B4. Report only.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

import {
  keyName as staticKeyName,
  parentOf,
  unwrapBinding,
} from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import {
  booleanOption,
  compile,
  positiveInteger,
  stringList,
} from '../shared/options.ts';
import {
  isScriptFile,
  isTestFile,
  matchesGlobs,
  scopePath,
} from '../shared/paths.ts';

type AnyNode = ESTree.Node;

const DEFAULT_FACTORY_NAME_PATTERN = '^(make|create|build|define)[A-Z]';
const DEFAULT_MAX_POSITIONAL_PARAMS = 2;
const DEFAULT_OPTION_BAG_TYPE_PATTERN = '(Options|Dependencies|Deps|Config)$';
const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
];
const DEFAULT_IGNORE: readonly string[] = [];
const DEFAULT_IGNORE_NAMES: readonly string[] = [];

/** Expression wrappers between a function expression and the declaration that names it. */
const VALUE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
]);

/** Declarations that name a function-like held as their `value`. */
const NAMED_MEMBERS = new Set([
  'AccessorProperty',
  'MethodDefinition',
  'Property',
  'PropertyDefinition',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
]);

/** Type wrappers that never change which named type a parameter is annotated with. */
const TYPE_WRAPPERS = new Set([
  'TSParenthesizedType',
  'TSTypeOperator',
  'TSArrayType',
  'TSOptionalType',
  'TSRestType',
]);

interface RuleOptions {
  readonly factoryNamePattern: RegExp;
  readonly flagOptionBags: boolean;
  readonly ignore: readonly string[];
  readonly ignoreNames: ReadonlySet<string>;
  readonly includePaths: readonly string[];
  readonly includeScripts: boolean;
  readonly includeTests: boolean;
  readonly includeTypeSignatures: boolean;
  readonly maxPositionalParams: number;
  readonly optionBagTypePattern: RegExp;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Record<string, unknown>;
  const includePaths = stringList(given.includePaths, DEFAULT_INCLUDE_PATHS);
  return {
    factoryNamePattern: compile(
      given.factoryNamePattern,
      DEFAULT_FACTORY_NAME_PATTERN
    ),
    flagOptionBags: booleanOption(given.flagOptionBags, true),
    ignore: stringList(given.ignore, DEFAULT_IGNORE),
    ignoreNames: new Set(stringList(given.ignoreNames, DEFAULT_IGNORE_NAMES)),
    includePaths:
      includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS,
    includeScripts: booleanOption(given.includeScripts, false),
    includeTests: booleanOption(given.includeTests, false),
    includeTypeSignatures: booleanOption(given.includeTypeSignatures, true),
    maxPositionalParams: positiveInteger(
      given.maxPositionalParams,
      DEFAULT_MAX_POSITIONAL_PARAMS,
      0
    ),
    optionBagTypePattern: compile(
      given.optionBagTypePattern,
      DEFAULT_OPTION_BAG_TYPE_PATTERN
    ),
  };
}

function keyName(key: AnyNode, computed: boolean): string | null {
  return staticKeyName(key, computed, {
    templates: true,
    rawTemplates: false,
    singleQuasi: false,
  });
}

/**
 * Number of *value* parameters written in the signature. Defaults, rest elements, destructuring
 * patterns and parameter properties each count once — a default argument hides a collaborator, it
 * does not remove it. A TypeScript `this` parameter is a type annotation, not an argument.
 */
function countPositionalParameters(params: readonly AnyNode[]): number {
  let count = 0;
  for (const param of params) {
    const binding = unwrapBinding(param);
    if (
      binding.type === 'Identifier' &&
      (binding as { name: string }).name === 'this'
    )
      continue;
    count += 1;
  }
  return count;
}

/** Named types referenced by a parameter's annotation, unwrapping arrays, unions and `readonly`. */
function typeReferenceNames(
  annotation: AnyNode | null | undefined,
  depth = 0
): readonly string[] {
  if (annotation === null || annotation === undefined || depth > 5) return [];
  const node =
    annotation.type === 'TSTypeAnnotation'
      ? (annotation as { typeAnnotation: AnyNode }).typeAnnotation
      : annotation;
  return namesInType(node, depth);
}

function namesInType(node: AnyNode, depth: number): readonly string[] {
  if (TYPE_WRAPPERS.has(node.type)) {
    const inner =
      (node as { typeAnnotation?: AnyNode }).typeAnnotation ??
      (node as { elementType?: AnyNode }).elementType;
    return inner === undefined ? [] : typeReferenceNames(inner, depth + 1);
  }
  if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
    const names: string[] = [];
    for (const member of (node as { types: readonly AnyNode[] }).types) {
      names.push(...typeReferenceNames(member, depth + 1));
    }
    return names;
  }
  if (node.type !== 'TSTypeReference') return [];
  return referenceLeafNames((node as { typeName: AnyNode }).typeName);
}

function referenceLeafNames(typeName: AnyNode): readonly string[] {
  if (typeName.type === 'Identifier') return [typeName.name];
  if (
    typeName.type === 'TSQualifiedName' &&
    typeName.right.type === 'Identifier'
  )
    return [typeName.right.name];
  return [];
}

interface FactoryName {
  readonly name: string;
  /** Node underlined by the diagnostic — the identifier that introduces the factory. */
  readonly node: AnyNode;
}

/**
 * Resolve the declared name of a function-like from its immediate declaration only. Returns `null`
 * for callbacks, IIFEs and computed keys — those have no factory identity to report.
 */
function declaredName(fn: AnyNode): FactoryName | null {
  const own = (fn as { id?: AnyNode | null }).id ?? null;
  if (own !== null && own.type === 'Identifier') {
    return { name: (own as { name: string }).name, node: own };
  }
  let child: AnyNode = fn;
  let parent = parentOf(fn);
  for (
    let guard = 0;
    guard < 4 && parent !== null && VALUE_WRAPPERS.has(parent.type);
    guard += 1
  ) {
    child = parent;
    parent = parentOf(parent);
  }
  if (parent === null) return null;
  return holderName(parent, child);
}

function assignmentName(left: AnyNode): FactoryName | null {
  if (left.type === 'Identifier') return { name: left.name, node: left };
  if (left.type !== 'MemberExpression') return null;
  const name = keyName(left.property, left.computed);
  return name === null ? null : { name, node: left.property };
}

function holderName(parent: AnyNode, child: AnyNode): FactoryName | null {
  if (parent.type === 'VariableDeclarator') {
    if (parent.init !== child || parent.id.type !== 'Identifier') return null;
    return { name: parent.id.name, node: parent.id };
  }
  if (parent.type === 'AssignmentExpression') {
    return parent.right === child ? assignmentName(parent.left) : null;
  }
  if (!NAMED_MEMBERS.has(parent.type)) return null;
  const holder = parent as unknown as {
    key: AnyNode;
    computed: boolean;
    value: AnyNode | null;
  };
  if (holder.value !== child) return null;
  const name = keyName(holder.key, holder.computed);
  return name === null ? null : { name, node: holder.key };
}

/** The type-level declaration that owns a signature node (`TSMethodSignature` / `TSPropertySignature`). */
function signatureName(node: AnyNode): FactoryName | null {
  const holder = node as unknown as {
    key?: AnyNode;
    computed?: boolean;
    id?: AnyNode | null;
  };
  if (holder.key !== undefined) {
    const name = keyName(holder.key, holder.computed === true);
    return name === null ? null : { name, node: holder.key };
  }
  const id = holder.id ?? null;
  if (id !== null && id.type === 'Identifier')
    return { name: (id as { name: string }).name, node: id };
  return null;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B4: detect wide named factories and option-bag factories containing scope-resolved Effect calls. Proven local data-only signatures are excluded; unknown types and untyped parameters remain a naming/width heuristic, not proof of collaborator injection.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b4-make-context-services-and-effectfn-the-default-dependency-vocabulary',
    },
    messages: {
      optionBagFactory:
        "Audit B4: factory '{{name}}' uses an Effect call and a '{{type}}' bag not proven to be local data. Express collaborators through Context/Layer while retaining genuine per-call data; imported bag semantics are not inferred.",
      wideSignature:
        "Audit B4: factory '{{name}}' has {{count}} positional parameters (max {{max}}), not all proven data. Prefer Context/Layer for collaborators; width alone does not prove these parameters are dependencies.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          factoryNamePattern: {
            type: 'string',
            description:
              "Regex a declaration name must match to be treated as a factory (default: '^(make|create|build|define)[A-Z]').",
          },
          flagOptionBags: {
            type: 'boolean',
            description:
              'Also report a within-limit factory whose parameter type matches optionBagTypePattern and whose body is Effect code (default: true).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs exempted from the rule (default: none).',
          },
          ignoreNames: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Exact factory names allowed to keep a wide signature — the explicit allowlist for genuine wide data constructors (default: none).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeScripts: {
            type: 'boolean',
            description:
              'Also report inside scripts/** (default: false — one-shot programs, no Layer graph).',
          },
          includeTests: {
            type: 'boolean',
            description:
              "Also report inside test files (default: false — the audit's D tier blesses fixture builders).",
          },
          includeTypeSignatures: {
            type: 'boolean',
            description:
              'Also report type-level factory ports: interface methods, `readonly makeX: (...) => T` members and `declare function` (default: true — the port is where the positional shape is fixed).',
          },
          maxPositionalParams: {
            type: 'number',
            description:
              'Maximum positional parameters a factory may declare (default: 2).',
          },
          optionBagTypePattern: {
            type: 'string',
            description:
              "Regex matched against a parameter's declared type name to recognise an option bag (default: '(Options|Dependencies|Deps|Config)$').",
          },
        },
      },
    ],
    defaultOptions: [
      {
        factoryNamePattern: DEFAULT_FACTORY_NAME_PATTERN,
        flagOptionBags: true,
        ignore: [...DEFAULT_IGNORE],
        ignoreNames: [...DEFAULT_IGNORE_NAMES],
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        includeScripts: false,
        includeTests: false,
        includeTypeSignatures: true,
        maxPositionalParams: DEFAULT_MAX_POSITIONAL_PARAMS,
        optionBagTypePattern: DEFAULT_OPTION_BAG_TYPE_PATTERN,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.includePaths)) return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (!options.includeScripts && isScriptFile(path)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    // Resolve actual lexical imports and immutable aliases; raw text (including comments and
    // Node stream .pipe calls) is never evidence that a body constructs an Effect.
    const resolve = (node: any, seen = new Set<any>()): string | null => {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (VALUE_WRAPPERS.has(node.type) || node.type === 'ChainExpression')
        return resolve(node.expression, seen);
      if (node.type === 'MemberExpression') {
        const object = resolve(node.object, seen);
        const key = keyName(node.property, node.computed);
        return object && key ? `${object}.${key}` : null;
      }
      if (node.type !== 'Identifier') return null;
      const variable = lookupVariable(context, node);
      if (!variable) return null;
      return resolveDefinitions(variable, seen);
    };
    const importIdentity = (def: any): string | null => {
      const source = def.parent?.source?.value;
      if (source !== 'effect' && source !== 'effect/Effect') return null;
      const imported = def.node.imported?.name ?? def.node.imported?.value;
      if (source === 'effect/Effect')
        return imported ? `Effect.${imported}` : 'Effect';
      return imported ?? 'root';
    };
    const resolveDefinitions = (
      variable: import('@oxlint/plugins').Variable,
      seen: Set<any>
    ): string | null => {
      for (const def of variable.defs as any[]) {
        if (def.type === 'ImportBinding') return importIdentity(def);
        if (def.type !== 'Variable' || def.parent?.kind !== 'const') continue;
        if (!variable.references.some((r) => r.isWrite() && !r.init))
          return resolve(def.node.init, seen);
      }
      return null;
    };
    const someNode = (
      node: any,
      predicate: (node: any) => boolean
    ): boolean => {
      if (!node || typeof node !== 'object') return false;
      if (Array.isArray(node))
        return node.some((child) => someNode(child, predicate));
      if (typeof node.type !== 'string') return false;
      if (predicate(node)) return true;
      return Object.entries(node).some(
        ([key, value]) => key !== 'parent' && someNode(value, predicate)
      );
    };
    const bodyIsEffectProgram = (fn: AnyNode): boolean =>
      someNode(
        (fn as any).body,
        (node) =>
          node.type === 'CallExpression' &&
          /^(?:root\.)?Effect\./u.test(resolve(node.callee) ?? '')
      );

    // Only proven local scalar/data shapes are exempt. Unknown/imported annotations stay
    // conservative; AST-only analysis cannot establish their runtime role.
    const dataType = (node: any, seen = new Set<any>()): boolean => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return classifyDataType(node, seen);
    };
    const classifyDataType = (node: any, seen: Set<any>): boolean => {
      if (['TSTypeAnnotation', 'TSTypeOperator'].includes(node.type))
        return dataType(node.typeAnnotation, seen);
      if (
        [
          'TSStringKeyword',
          'TSNumberKeyword',
          'TSBooleanKeyword',
          'TSLiteralType',
          'TSNullKeyword',
          'TSUndefinedKeyword',
        ].includes(node.type)
      )
        return true;
      if (['TSUnionType', 'TSIntersectionType'].includes(node.type))
        return node.types.every((t: any) => dataType(t, new Set(seen)));
      if (node.type === 'TSArrayType') return dataType(node.elementType, seen);
      if (
        node.type === 'TSTypeLiteral' ||
        node.type === 'TSInterfaceDeclaration'
      ) {
        return dataMembers(node, seen);
      }
      if (
        node.type !== 'TSTypeReference' ||
        node.typeName.type !== 'Identifier'
      )
        return false;
      return dataReference(node.typeName, seen);
    };
    const dataMembers = (node: any, seen: Set<any>): boolean => {
      const members = node.members ?? node.body.body;
      return (
        members.every(
          (m: any) =>
            m.type === 'TSPropertySignature' &&
            dataType(m.typeAnnotation, new Set(seen))
        ) &&
        (node.extends ?? []).every((e: any) =>
          dataType(
            { type: 'TSTypeReference', typeName: e.expression },
            new Set(seen)
          )
        )
      );
    };
    const dataReference = (name: AnyNode, seen: Set<any>): boolean => {
      const variable = lookupVariable(context, name);
      const declaration: any = variable?.defs.find((d: any) =>
        ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(
          d.node.type
        )
      )?.node;
      return declaration
        ? dataType(declaration.typeAnnotation ?? declaration, seen)
        : false;
    };

    const optionBagType = (params: readonly AnyNode[]): string | null => {
      for (const param of params) {
        const binding = unwrapBinding(param);
        const annotation =
          (binding as { typeAnnotation?: AnyNode | null }).typeAnnotation ??
          null;
        for (const name of typeReferenceNames(annotation)) {
          if (options.optionBagTypePattern.test(name) && !dataType(annotation))
            return name;
        }
      }
      return null;
    };

    const inspect = (
      fn: AnyNode,
      identity: FactoryName | null,
      hasBody: boolean
    ): void => {
      if (identity === null) return;
      if (!options.factoryNamePattern.test(identity.name)) return;
      if (options.ignoreNames.has(identity.name)) return;
      const params = (fn as { params?: readonly AnyNode[] }).params ?? [];
      const count = countPositionalParameters(params);
      if (
        count > options.maxPositionalParams &&
        !params.every((param) =>
          dataType((unwrapBinding(param) as any).typeAnnotation)
        )
      ) {
        context.report({
          data: {
            count: String(count),
            max: String(options.maxPositionalParams),
            name: identity.name,
          },
          messageId: 'wideSignature',
          node: identity.node,
        });
        return;
      }
      inspectOptionBag(fn, identity, hasBody, params, count);
    };
    const inspectOptionBag = (
      fn: AnyNode,
      identity: FactoryName,
      hasBody: boolean,
      params: readonly AnyNode[],
      count: number
    ): void => {
      if (!options.flagOptionBags || !hasBody || count === 0) return;
      const bagType = optionBagType(params);
      if (bagType === null) return;
      if (!bodyIsEffectProgram(fn)) return;
      context.report({
        data: { name: identity.name, type: bagType },
        messageId: 'optionBagFactory',
        node: identity.node,
      });
    };

    const inspectValue = (node: AnyNode): void => {
      inspect(node, declaredName(node), true);
    };

    const inspectSignature = (node: AnyNode): void => {
      if (!options.includeTypeSignatures) return;
      inspect(node, signatureName(node), false);
    };

    /** `readonly makeX: (a, b, c) => T` — the function type carries the parameters, the member the name. */
    const inspectPropertySignature = (node: AnyNode): void => {
      if (!options.includeTypeSignatures) return;
      const holder = node as unknown as { typeAnnotation?: AnyNode | null };
      const annotation = holder.typeAnnotation ?? null;
      if (annotation === null) return;
      const type =
        annotation.type === 'TSTypeAnnotation'
          ? (annotation as { typeAnnotation: AnyNode }).typeAnnotation
          : annotation;
      if (type.type !== 'TSFunctionType' && type.type !== 'TSConstructorType')
        return;
      inspect(type, signatureName(node), false);
    };

    return {
      ArrowFunctionExpression: inspectValue,
      FunctionDeclaration: inspectValue,
      FunctionExpression: inspectValue,
      TSDeclareFunction: inspectSignature,
      TSEmptyBodyFunctionExpression: inspectValue,
      TSMethodSignature: inspectSignature,
      TSPropertySignature: inspectPropertySignature,
    };
  },
});
