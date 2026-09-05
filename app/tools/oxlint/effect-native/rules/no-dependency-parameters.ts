/**
 * effect-native/no-dependency-parameters
 *
 * Audit B4/A1: syntactically dependency-shaped parameters and nested option bags compete
 * with the Context/Layer graph. Resolves real Effect and Modern.js effect-edge Layer imports,
 * local type aliases, transparent built-in utility wrappers, and inline service records.
 * A Layer used only once as ManagedRuntime.make's input is the A1 root composition target,
 * not hidden library dependency provisioning. Pure local Resolver callbacks are definition data.
 * Limitations: suffix matching is a heuristic for unknown/imported application types; no type
 * checker proves that every named Service/Repository is a collaborator. Local type expansion
 * is bounded at 12 levels; no cross-file aliases. Diagnostics describe syntax, not runtime fate.
 * Report only; no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { ESTree } from '@oxlint/plugins';

import { bindingsFor } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isScriptFile, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production `includePaths` defaults instead of
 * forcing the fixture config to loosen them (`run-on-repo.mts` reuses that config verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_DEPENDENCY_TYPE_PATTERN =
  '(Service|Repository|Gateway|Resolver|Dependencies|ServiceFactory)$';
const DEFAULT_ALLOW_TYPE_NAMES: readonly string[] = [];
const DEFAULT_SERVICE_INDEX_KEYS: readonly string[] = ['Service'];
const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** Wrappers between a written parameter and the binding it introduces. */
const PARAMETER_WRAPPERS = new Set(['AssignmentPattern', 'RestElement', 'TSParameterProperty']);

/** Type wrappers that never change what a type annotation ultimately denotes. */
const TYPE_WRAPPERS = new Set([
  'TSParenthesizedType',
  'TSTypeOperator',
  'TSArrayType',
  'TSOptionalType',
  'TSRestType',
]);

type MessageId =
  | 'dependencyParameter'
  | 'layerParameter'
  | 'inlineServiceRecord'
  | 'dependencyOptionBag';

interface Verdict {
  readonly messageId: MessageId;
  /** Rendered type as written, for the message. */
  readonly type: string;
  /** Best-effort Context tag to `yield*` instead. */
  readonly tagName: string;
  /** Member name when the dependency hides inside an option bag. */
  readonly member: string | null;
}

interface RuleOptions {
  readonly allowTypeNames: ReadonlySet<string>;
  readonly dependencyTypePattern: RegExp;
  readonly expandLocalTypes: boolean;
  readonly flagInlineServiceRecords: boolean;
  readonly ignore: readonly string[];
  readonly includePaths: readonly string[];
  readonly includeScripts: boolean;
  readonly includeTests: boolean;
  readonly serviceIndexKeys: ReadonlySet<string>;
}

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function compile(value: unknown, fallback: string): RegExp {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  try {
    return new RegExp(source, 'u');
  } catch {
    return new RegExp(fallback, 'u');
  }
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Record<string, unknown>;
  const includePaths = stringList(given.includePaths, DEFAULT_INCLUDE_PATHS);
  const indexKeys = stringList(given.serviceIndexKeys, DEFAULT_SERVICE_INDEX_KEYS);
  return {
    allowTypeNames: new Set(stringList(given.allowTypeNames, DEFAULT_ALLOW_TYPE_NAMES)),
    dependencyTypePattern: compile(given.dependencyTypePattern, DEFAULT_DEPENDENCY_TYPE_PATTERN),
    expandLocalTypes: boolean(given.expandLocalTypes, true),
    flagInlineServiceRecords: boolean(given.flagInlineServiceRecords, true),
    ignore: stringList(given.ignore, DEFAULT_IGNORE),
    includePaths: includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS,
    includeScripts: boolean(given.includeScripts, false),
    includeTests: boolean(given.includeTests, false),
    serviceIndexKeys: new Set(indexKeys.length > 0 ? indexKeys : DEFAULT_SERVICE_INDEX_KEYS),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** `{ correlationId: … }` / `{ "id": … }` → the written key; computed keys → `null`. */
function keyName(key: AnyNode, computed: boolean): string | null {
  if (computed) return null;
  if (key.type === 'Identifier') return (key as { name: string }).name;
  if (key.type === 'Literal') {
    const value = (key as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** `AssignmentPattern` / `RestElement` / `TSParameterProperty` → the binding they wrap. */
function unwrapBinding(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 4; guard += 1) {
    if (!PARAMETER_WRAPPERS.has(current.type)) return current;
    const inner =
      (current as { left?: AnyNode }).left ??
      (current as { argument?: AnyNode }).argument ??
      (current as { parameter?: AnyNode }).parameter;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** `readonly`, parentheses, `T[]` and rest/optional wrappers never change what a type denotes. */
function unwrapType(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 8; guard += 1) {
    if (current.type === 'TSTypeAnnotation') {
      current = (current as unknown as { typeAnnotation: AnyNode }).typeAnnotation;
      continue;
    }
    if (!TYPE_WRAPPERS.has(current.type)) return current;
    const inner =
      (current as { typeAnnotation?: AnyNode }).typeAnnotation ??
      (current as { elementType?: AnyNode }).elementType;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** Last identifier of a (possibly qualified) type name: `Foo.BarService` → `BarService`. */
function lastTypeName(name: AnyNode): string | null {
  if (name.type === 'Identifier') return (name as { name: string }).name;
  if (name.type === 'TSQualifiedName') {
    const right = (name as unknown as { right: AnyNode }).right;
    return right.type === 'Identifier' ? (right as { name: string }).name : null;
  }
  return null;
}

/** Left-most identifier of a qualified type name: `Layer.Layer` → `Layer`; plain names → `null`. */
function qualifierName(name: AnyNode): string | null {
  if (name.type !== 'TSQualifiedName') return null;
  let left = (name as unknown as { left: AnyNode }).left;
  for (let guard = 0; guard < 8; guard += 1) {
    if (left.type === 'Identifier') return (left as { name: string }).name;
    if (left.type !== 'TSQualifiedName') return null;
    left = (left as unknown as { left: AnyNode }).left;
  }
  return null;
}

/** `(typeof CoreDatabase)` → `CoreDatabase`; `(typeof Ns.CoreDatabase)` → `CoreDatabase`. */
function typeQueryName(node: AnyNode): string | null {
  if (node.type !== 'TSTypeQuery') return null;
  return lastTypeName((node as unknown as { exprName: AnyNode }).exprName);
}

/** Members of an object type body, whichever container holds them. */
function membersOf(node: AnyNode): readonly AnyNode[] {
  if (node.type === 'TSTypeLiteral')
    return (node as unknown as { members: readonly AnyNode[] }).members;
  if (node.type === 'TSInterfaceBody')
    return (node as unknown as { body: readonly AnyNode[] }).body;
  if (node.type === 'TSInterfaceDeclaration') {
    const body = (node as unknown as { body: AnyNode }).body;
    return (body as unknown as { body: readonly AnyNode[] }).body;
  }
  return [];
}

/** The `Context.Service` tag to `yield*` instead of accepting the value positionally. */
function tagNameFor(typeName: string): string {
  const stripped = typeName.replace(/(?:ServiceFactory|Service|Dependencies)$/u, '');
  return stripped.length > 0 ? stripped : typeName;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B4/A1: detect dependency-shaped parameters and nested option bags using lexical Effect/Layer identity and bounded local type expansion. Unknown application type suffixes are a heuristic, not proof of runtime provisioning. Root ManagedRuntime inputs and pure local Resolver data are excluded.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b4-make-context-services-and-effectfn-the-default-dependency-vocabulary',
    },
    messages: {
      dependencyParameter:
        "Audit B4/A1: parameter '{{name}}' has dependency-shaped type '{{type}}'. Prefer Context.Service requirements for collaborators (yield* {{tagName}}); type naming alone cannot establish runtime use.",
      layerParameter:
        "Audit A1: parameter '{{name}}' receives Layer type '{{type}}' outside the recognized root ManagedRuntime input. Keep library dependencies transparent and compose them at the application root.",
      inlineServiceRecord:
        "Audit B4: parameter '{{name}}' explicitly contains Effect-returning operations ('{{type}}'). Prefer a Context.Service surface resolved with yield* {{tagName}} for first-party collaborators.",
      dependencyOptionBag:
        "Audit B4: parameter '{{name}}' carries dependency-shaped member '{{member}}: {{type}}'. Keep per-call configuration in the bag and express collaborators as Context.Service requirements.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowTypeNames: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Exact type names that match dependencyTypePattern but are plain data (default: none). The escape hatch for the known false-positive class: a DTO named `…Service`/`…Gateway`.',
          },
          dependencyTypePattern: {
            type: 'string',
            description:
              "Regex matched against the last identifier of a parameter's type reference (default: '(Service|Repository|Gateway|Resolver|Dependencies|ServiceFactory)$').",
          },
          expandLocalTypes: {
            type: 'boolean',
            description:
              "Also inspect the members of a same-module interface / type alias used as a parameter annotation, so B4's option bags are reported (default: true).",
          },
          flagInlineServiceRecords: {
            type: 'boolean',
            description:
              'Report a parameter annotated with an inline object type whose members are all Effect-returning function types (default: true).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs allowed to keep positional dependency injection (default: none — the audit wants every site reported until the Layer graph owns them).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeScripts: {
            type: 'boolean',
            description:
              'Also report inside scripts/** (default: false — B3 migrates only consequential scripts).',
          },
          includeTests: {
            type: 'boolean',
            description:
              "Also report inside test files (default: false — the audit's D tier blesses test fixtures).",
          },
          serviceIndexKeys: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Indexed-access keys over a `typeof Tag` query that denote a resolved service instance (default: ['Service']).",
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowTypeNames: [...DEFAULT_ALLOW_TYPE_NAMES],
        dependencyTypePattern: DEFAULT_DEPENDENCY_TYPE_PATTERN,
        expandLocalTypes: true,
        flagInlineServiceRecords: true,
        ignore: [...DEFAULT_IGNORE],
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        includeScripts: false,
        includeTests: false,
        serviceIndexKeys: [...DEFAULT_SERVICE_INDEX_KEYS],
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

    const bindings: EffectBindings = bindingsFor(context);

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
    const importedPath = (node: any): string | null => {
      if (node.type === 'TSQualifiedName' || node.type === 'MemberExpression') {
        const left = importedPath(node.left ?? node.object);
        const right = node.right ?? node.property;
        const name = right.name ?? right.value;
        return left && typeof name === 'string' ? `${left}.${name}` : null;
      }
      if (node.type !== 'Identifier') return null;
      const variable = variableFor(node, node.name);
      const def = variable?.defs.find((d: any) => d.type === 'ImportBinding');
      if (!def) return null;
      const source = def.parent?.source?.value;
      if (
        source !== 'effect' &&
        source !== '@modern-js/plugin-bff/effect-edge' &&
        !source?.startsWith('effect/')
      )
        return null;
      const imported = def.node.imported?.name ?? def.node.imported?.value;
      return source === 'effect' || source === '@modern-js/plugin-bff/effect-edge'
        ? (imported ?? 'root')
        : `${source.split('/').at(-1)}${imported ? `.${imported}` : ''}`;
    };
    const localType = (node: any): any => {
      if (node.type !== 'Identifier') return null;
      return (
        variableFor(node, node.name)?.defs.find((d: any) =>
          ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(d.node.type),
        )?.node ?? null
      );
    };

    /** Same-module `type X = …` / `interface X { … }`, collected up front so order never matters. */
    const localTypes = new Map<string, AnyNode>();
    for (const statement of context.sourceCode.ast.body as readonly AnyNode[]) {
      const declaration =
        statement.type === 'ExportNamedDeclaration'
          ? ((statement as unknown as { declaration?: AnyNode | null }).declaration ?? null)
          : statement;
      if (declaration === null) continue;
      if (declaration.type === 'TSTypeAliasDeclaration') {
        const alias = declaration as unknown as { id: AnyNode; typeAnnotation: AnyNode };
        if (alias.id.type === 'Identifier')
          localTypes.set((alias.id as { name: string }).name, alias.typeAnnotation);
      } else if (declaration.type === 'TSInterfaceDeclaration') {
        const declared = declaration as unknown as { id: AnyNode };
        if (declared.id.type === 'Identifier')
          localTypes.set((declared.id as { name: string }).name, declaration);
      }
    }

    /** A `TSFunctionType` / `TSMethodSignature` whose return type is `Effect.Effect<…>`. */
    const returnsEffect = (annotation: AnyNode | null | undefined): boolean => {
      if (annotation === null || annotation === undefined) return false;
      const node = unwrapType(annotation);
      if (node.type !== 'TSTypeReference') return false;
      const typeName = (node as unknown as { typeName: AnyNode }).typeName;
      if (lastTypeName(typeName) !== 'Effect') return false;
      return /^(?:root\.)?Effect(?:\.Effect)?$/u.test(importedPath(typeName) ?? '');
    };

    /** Members are *all* `() => Effect.Effect<…>`: B4's symbol-slotted operation record. */
    const isServiceRecord = (node: AnyNode): boolean => {
      const members = membersOf(node);
      if (members.length === 0) return false;
      return members.every((member) => {
        if (member.type === 'TSMethodSignature') {
          return returnsEffect((member as unknown as { returnType: AnyNode | null }).returnType);
        }
        if (member.type !== 'TSPropertySignature') return false;
        const annotation = (member as unknown as { typeAnnotation: AnyNode | null }).typeAnnotation;
        if (annotation === null) return false;
        const value = unwrapType(annotation);
        if (value.type !== 'TSFunctionType' && value.type !== 'TSConstructorType') return false;
        return returnsEffect((value as unknown as { returnType: AnyNode | null }).returnType);
      });
    };

    /**
     * Classify one type annotation. `depth` is 0 for a parameter's own annotation and 1 while
     * looking inside an option bag's members, which is as deep as the walk ever goes.
     */
    const classify = (annotation: AnyNode | null | undefined, depth: number): Verdict | null => {
      if (annotation === null || annotation === undefined || depth > 12) return null;
      const node = unwrapType(annotation);

      if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
        for (const member of (node as unknown as { types: readonly AnyNode[] }).types) {
          const verdict = classify(member, depth);
          if (verdict !== null) return verdict;
        }
        return null;
      }

      // (a) `(typeof CoreDatabaseService)['Service']` — a resolved Context.Service instance.
      if (node.type === 'TSIndexedAccessType') {
        const indexed = node as unknown as { objectType: AnyNode; indexType: AnyNode };
        const owner = typeQueryName(unwrapType(indexed.objectType));
        const index = unwrapType(indexed.indexType);
        const literal =
          index.type === 'TSLiteralType'
            ? (index as unknown as { literal: AnyNode }).literal
            : null;
        const key =
          literal !== null && literal.type === 'Literal'
            ? (literal as { value?: unknown }).value
            : undefined;
        if (owner !== null && typeof key === 'string' && options.serviceIndexKeys.has(key)) {
          return {
            member: null,
            messageId: 'dependencyParameter',
            tagName: owner,
            type: `(typeof ${owner})['${key}']`,
          };
        }
        return null;
      }

      if (node.type === 'TSTypeReference') {
        const typeName = (node as unknown as { typeName: AnyNode; typeArguments: AnyNode | null })
          .typeName;
        const name = lastTypeName(typeName);
        if (name === null) return null;
        const qualifier = qualifierName(typeName);

        // (b) `Layer.Layer<Service>` / `L.Layer<…>` / `import * as Layer from "effect/Layer"`,
        // plus the verbatim `Layer.Layer` spelling that reaches this repository through the
        // `@modern-js/plugin-bff/effect-edge` re-export barrel.
        if (/^(?:root\.)?Layer(?:\.Layer)?$/u.test(importedPath(typeName) ?? '')) {
          const args = (node as unknown as { typeArguments: AnyNode | null }).typeArguments;
          const first =
            args === null
              ? undefined
              : (args as unknown as { params: readonly AnyNode[] }).params[0];
          const provided =
            first === undefined
              ? null
              : lastTypeName(
                  unwrapType(first).type === 'TSTypeReference'
                    ? (unwrapType(first) as unknown as { typeName: AnyNode }).typeName
                    : unwrapType(first),
                );
          return {
            member: null,
            messageId: 'layerParameter',
            tagName: provided ?? 'TheService',
            type: qualifier === null ? 'Layer' : `${qualifier}.Layer`,
          };
        }

        // Effect's own namespaced types (`Effect.Service`, `Context.Tag`, `Schema.Codec`, …)
        // are library types, never injected application dependencies.
        if (importedPath(typeName) !== null) return null;

        // Transparent built-in utility wrappers and same-scope aliases preserve the dependency.
        if (
          qualifier === null &&
          ['Readonly', 'ReadonlyArray', 'Array', 'NonNullable'].includes(name) &&
          !variableFor(typeName, name)?.defs.length
        ) {
          const argument = (node as any).typeArguments?.params?.[0];
          return classify(argument, depth + 1);
        }
        const declaration = qualifier === null ? localType(typeName) : null;
        const local = declaration?.typeAnnotation;
        // B4 targets dependency injection, not pure per-definition Resolver callbacks.
        // Only exempt an explicitly synchronous local function alias; imported types remain unknown.
        if (name.endsWith('Resolver') && local?.type === 'TSFunctionType') {
          const result = local.returnType?.typeAnnotation;
          if (
            result &&
            !returnsEffect(local.returnType) &&
            !(
              result.type === 'TSTypeReference' &&
              ['Promise', 'PromiseLike'].includes(lastTypeName(result.typeName) ?? '')
            )
          )
            return null;
        }

        // (c) `ActionRepositoryService`, `ContactsGateway`, `OperationalScopeResolverService`, …
        if (!options.allowTypeNames.has(name) && options.dependencyTypePattern.test(name)) {
          return {
            member: null,
            messageId: 'dependencyParameter',
            tagName: tagNameFor(name),
            type: name,
          };
        }

        // (e) `options: ActionRuntimeOptions` — the same graph edge, hidden in an option bag.
        if (options.expandLocalTypes && declaration) {
          if (local) return classify(local, depth + 1);
          return inspectBag(declaration, depth + 1);
        }
        return null;
      }

      if (node.type === 'TSTypeLiteral') {
        // (d) an inline record of Effect-returning operations is a hand-passed service value.
        if (options.flagInlineServiceRecords && isServiceRecord(node)) {
          return {
            member: null,
            messageId: 'inlineServiceRecord',
            tagName: 'TheService',
            type: '{ … => Effect.Effect<…> }',
          };
        }
        return inspectBag(node, depth + 1);
      }
      return null;
    };

    /** First dependency-typed member of an object type: B4's option bag. */
    function inspectBag(container: AnyNode, depth: number): Verdict | null {
      for (const member of membersOf(container)) {
        if (member.type !== 'TSPropertySignature') continue;
        const signature = member as unknown as {
          key: AnyNode;
          computed: boolean;
          typeAnnotation: AnyNode | null;
        };
        const memberName = keyName(signature.key, signature.computed);
        if (memberName === null) continue;
        const verdict = classify(signature.typeAnnotation, depth);
        if (verdict === null) continue;
        return { ...verdict, member: memberName, messageId: 'dependencyOptionBag' };
      }
      return null;
    }

    /** How the offending parameter is written, for the message. */
    const parameterName = (param: AnyNode, binding: AnyNode): string => {
      if (binding.type === 'Identifier') {
        const name = (binding as { name: string }).name;
        return param.type === 'RestElement' ? `...${name}` : name;
      }
      if (binding.type === 'ObjectPattern') {
        const keys: string[] = [];
        for (const property of (binding as unknown as { properties: readonly AnyNode[] })
          .properties) {
          if (property.type !== 'Property') continue;
          const entry = property as unknown as { key: AnyNode; computed: boolean };
          const name = keyName(entry.key, entry.computed);
          if (name !== null) keys.push(name);
          if (keys.length === 3) break;
        }
        return keys.length === 0 ? '{ … }' : `{ ${keys.join(', ')} }`;
      }
      return '<destructured>';
    };

    // A1 explicitly composes a root Layer into ManagedRuntime.make. Exempt only the
    // precise parameter/member whose every value use is that construction, not a whole root file.
    const isRootLayerInput = (binding: any, verdict: Verdict): boolean => {
      if (
        verdict.messageId !== 'layerParameter' &&
        !(verdict.messageId === 'dependencyOptionBag' && verdict.type.endsWith('Layer'))
      )
        return false;
      if (binding.type !== 'Identifier') return false;
      const refs = variableFor(binding, binding.name)?.references ?? [];
      let uses = 0;
      for (const ref of refs) {
        if (!ref.isRead()) continue;
        let use = ref.identifier;
        if (verdict.member) {
          const parent = use.parent;
          if (parent?.type !== 'MemberExpression' || parent.object !== use) return false;
          const key = parent.property.name ?? parent.property.value;
          if (key !== verdict.member) continue;
          use = parent;
        }
        const call = use.parent;
        if (
          call?.type !== 'CallExpression' ||
          call.arguments[0] !== use ||
          !/^(?:root\.)?ManagedRuntime\.make$/u.test(importedPath(call.callee) ?? '')
        )
          return false;
        uses++;
      }
      return uses === 1;
    };

    const inspectParameters = (node: AnyNode): void => {
      for (const param of (node as { params?: readonly AnyNode[] }).params ?? []) {
        const binding = unwrapBinding(param);
        const annotation =
          (binding as { typeAnnotation?: AnyNode | null }).typeAnnotation ??
          (param as { typeAnnotation?: AnyNode | null }).typeAnnotation ??
          null;
        const verdict = classify(annotation, 0);
        if (verdict === null || isRootLayerInput(binding, verdict)) continue;
        context.report({
          data: {
            member: verdict.member ?? '',
            name: parameterName(param, binding),
            tagName: verdict.tagName,
            type: verdict.type,
          },
          messageId: verdict.messageId,
          node: param,
        });
      }
    };

    return {
      ArrowFunctionExpression: inspectParameters,
      FunctionDeclaration: inspectParameters,
      FunctionExpression: inspectParameters,
      TSCallSignatureDeclaration: inspectParameters,
      TSConstructorType: inspectParameters,
      TSConstructSignatureDeclaration: inspectParameters,
      TSDeclareFunction: inspectParameters,
      TSEmptyBodyFunctionExpression: inspectParameters,
      TSFunctionType: inspectParameters,
      TSMethodSignature: inspectParameters,
    };
  },
});
