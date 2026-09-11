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

import { keyName as staticKeyName, unwrapBinding, unwrapType as unwrapSharedType } from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import { booleanOption as boolean, compile, stringList } from '../shared/options.ts';
import { isSourceRuleInScope } from '../shared/source-rule-scope.ts';

type AnyNode = ESTree.Node;

const DEFAULT_DEPENDENCY_TYPE_PATTERN = '(Service|Repository|Gateway|Resolver|Dependencies|ServiceFactory)$';
const DEFAULT_ALLOW_TYPE_NAMES: readonly string[] = [];
const DEFAULT_SERVICE_INDEX_KEYS: readonly string[] = ['Service'];
const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** Type wrappers that never change what a type annotation ultimately denotes. */
const TYPE_WRAPPERS = new Set([
  'TSTypeAnnotation',
  'TSParenthesizedType',
  'TSTypeOperator',
  'TSArrayType',
  'TSOptionalType',
  'TSRestType',
]);

type MessageId = 'dependencyParameter' | 'layerParameter' | 'inlineServiceRecord' | 'dependencyOptionBag';

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

/** Computed option keys are deliberately excluded, including static strings. */
function keyName(key: AnyNode, computed: boolean): string | null {
  return computed ? null : staticKeyName(key, false, { templates: false });
}

function unwrapType(node: AnyNode): AnyNode {
  return unwrapSharedType(node, {
    wrappers: TYPE_WRAPPERS,
    maxDepth: 8,
    elementTypeFallback: true,
  });
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
  if (node.type === 'TSTypeLiteral') return (node as unknown as { members: readonly AnyNode[] }).members;
  if (node.type === 'TSInterfaceBody') return (node as unknown as { body: readonly AnyNode[] }).body;
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
            description: 'Also report inside scripts/** (default: false — B3 migrates only consequential scripts).',
          },
          includeTests: {
            type: 'boolean',
            description: "Also report inside test files (default: false — the audit's D tier blesses test fixtures).",
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
    if (!isSourceRuleInScope(context.filename, options)) return {};

    const variableFor = (node: AnyNode, name: string): any => resolveVariable(context, name, node);
    const importSourcePath = (def: any): string | null => {
      const source = def.parent?.source?.value;
      const isRoot = ['effect', '@modern-js/bff-effect/effect-edge'].includes(source);
      if (!isRoot && !source?.startsWith('effect/')) return null;
      const imported = def.node.imported?.name ?? def.node.imported?.value;
      if (isRoot) return imported ?? 'root';
      return `${source.split('/').at(-1)}${imported ? `.${imported}` : ''}`;
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
      return importSourcePath(def);
    };
    const localType = (node: any): any => {
      if (node.type !== 'Identifier') return null;
      return (
        variableFor(node, node.name)?.defs.find((d: any) =>
          ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(d.node.type),
        )?.node ?? null
      );
    };

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

    function classifyIndexed(node: AnyNode): Verdict | null {
      const indexed = node as unknown as {
        objectType: AnyNode;
        indexType: AnyNode;
      };
      const owner = typeQueryName(unwrapType(indexed.objectType));
      const index = unwrapType(indexed.indexType);
      const literal = index.type === 'TSLiteralType' ? (index as unknown as { literal: AnyNode }).literal : null;
      const key = literal !== null && literal.type === 'Literal' ? (literal as { value?: unknown }).value : undefined;
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

    function classifyLayer(node: AnyNode, qualifier: string | null): Verdict {
      const args = (node as unknown as { typeArguments: AnyNode | null }).typeArguments;
      const first = args === null ? undefined : (args as unknown as { params: readonly AnyNode[] }).params[0];
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

    function isSynchronousResolver(name: string, local: any): boolean {
      if (!name.endsWith('Resolver') || local?.type !== 'TSFunctionType') return false;
      const result = local.returnType?.typeAnnotation;
      if (!result || returnsEffect(local.returnType)) return false;
      return !(
        result.type === 'TSTypeReference' && ['Promise', 'PromiseLike'].includes(lastTypeName(result.typeName) ?? '')
      );
    }

    function expandDeclaration(declaration: any, depth: number): Verdict | null {
      if (!options.expandLocalTypes || !declaration) return null;
      if (declaration.typeAnnotation) return classify(declaration.typeAnnotation, depth + 1);
      return inspectBag(declaration, depth + 1);
    }

    function classifyApplicationReference(
      node: AnyNode,
      typeName: AnyNode,
      name: string,
      qualifier: string | null,
      depth: number,
    ): Verdict | null {
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
      if (isSynchronousResolver(name, local)) return null;

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
      return expandDeclaration(declaration, depth);
    }

    function classifyReference(node: AnyNode, depth: number): Verdict | null {
      const typeName = (node as any).typeName;
      const name = lastTypeName(typeName);
      if (name === null) return null;
      const qualifier = qualifierName(typeName);
      const origin = importedPath(typeName);
      if (/^(?:root\.)?Layer(?:\.Layer)?$/u.test(origin ?? '')) return classifyLayer(node, qualifier);
      if (origin !== null) return null;
      return classifyApplicationReference(node, typeName, name, qualifier, depth);
    }

    function classifyRecord(node: AnyNode, depth: number): Verdict | null {
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

    function classifyMembers(members: readonly AnyNode[], depth: number): Verdict | null {
      for (const member of members) {
        const verdict = classify(member, depth);
        if (verdict !== null) return verdict;
      }
      return null;
    }

    /** Expand aliases and nested option bags with a bounded recursion depth. */
    function classify(annotation: AnyNode | null | undefined, depth: number): Verdict | null {
      if (annotation === null || annotation === undefined || depth > 12) return null;
      const node = unwrapType(annotation);
      if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
        return classifyMembers((node as any).types, depth);
      }
      if (node.type === 'TSIndexedAccessType') return classifyIndexed(node);
      if (node.type === 'TSTypeReference') return classifyReference(node, depth);
      if (node.type === 'TSTypeLiteral') return classifyRecord(node, depth);
      return null;
    }

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
        return {
          ...verdict,
          member: memberName,
          messageId: 'dependencyOptionBag',
        };
      }
      return null;
    }

    function objectParameterName(binding: AnyNode): string {
      const keys: string[] = [];
      for (const property of (binding as unknown as { properties: readonly AnyNode[] }).properties) {
        if (property.type !== 'Property') continue;
        const entry = property as unknown as {
          key: AnyNode;
          computed: boolean;
        };
        const name = keyName(entry.key, entry.computed);
        if (name !== null) keys.push(name);
        if (keys.length === 3) break;
      }
      return keys.length === 0 ? '{ … }' : `{ ${keys.join(', ')} }`;
    }

    /** How the offending parameter is written, for the message. */
    const parameterName = (param: AnyNode, binding: AnyNode): string => {
      if (binding.type === 'Identifier') {
        const name = (binding as { name: string }).name;
        return param.type === 'RestElement' ? `...${name}` : name;
      }
      if (binding.type === 'ObjectPattern') {
        return objectParameterName(binding);
      }
      return '<destructured>';
    };

    function isRuntimeInput(use: any): boolean {
      const call = use.parent;
      return (
        call?.type === 'CallExpression' &&
        call.arguments[0] === use &&
        /^(?:root\.)?ManagedRuntime\.make$/u.test(importedPath(call.callee) ?? '')
      );
    }

    function isLayerVerdict(verdict: Verdict): boolean {
      return (
        verdict.messageId === 'layerParameter' ||
        (verdict.messageId === 'dependencyOptionBag' && verdict.type.endsWith('Layer'))
      );
    }

    function rootInputUsage(identifier: any, verdict: Verdict): 'valid' | 'invalid' | 'skip' {
      let use = identifier;
      if (verdict.member) {
        const parent = use.parent;
        if (parent?.type !== 'MemberExpression' || parent.object !== use) return 'invalid';
        const key = parent.property.name ?? parent.property.value;
        if (key !== verdict.member) return 'skip';
        use = parent;
      }
      return isRuntimeInput(use) ? 'valid' : 'invalid';
    }

    // A1 explicitly composes a root Layer into ManagedRuntime.make. Exempt only the
    // precise parameter/member whose every value use is that construction, not a whole root file.
    const isRootLayerInput = (binding: any, verdict: Verdict): boolean => {
      if (!isLayerVerdict(verdict)) return false;
      if (binding.type !== 'Identifier') return false;
      const refs = variableFor(binding, binding.name)?.references ?? [];
      let uses = 0;
      for (const ref of refs) {
        if (!ref.isRead()) continue;
        const usage = rootInputUsage(ref.identifier, verdict);
        if (usage === 'invalid') return false;
        if (usage === 'skip') continue;
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
