/**
 * Audit A6 (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`) targets repeated request
 * identity inputs and asks for ambient services/references plus one instrumentation seam.
 *
 * Reports configured identity names in interface/type/class fields and function parameters,
 * including type-level ports, parameter wrappers and object destructuring up to one nested level.
 * Static string/template keys are recognized. Ordinary object values and member reads are not inputs.
 *
 * Boundary conventions are lexical, not semantic proof: only the nearest declaration's name is
 * matched against wireTypeNames, never a wire-named ancestor's unrelated nested operation. Defaults
 * preserve HTTP Problem/Headers/Payload/Response/Request/Schema declarations, source-verified durable
 * OutboxClaim data (core-runtime/src/outbox/repository.ts), requireCorrelationId's header validation
 * (contacts/api/read-server-support.ts) and safeCorrelationId's value sanitation
 * (contacts/src/integrations/ares/ares-subject.service.ts). A flat concise object projection with a
 * wire-named return type is treated as that serialization boundary. Persisted correlation must
 * survive the originating request; replacing that data with ambient request state would be wrong.
 *
 * Payloads of lexically resolved Effect Context.Service/Tag/Reference/GenericTag calls and inline
 * consumption casts/type predicates/satisfies types are allowed, as are tests/scripts by default.
 * Lookalike Context imports do not establish an ambient service. This rule has no type checker,
 * interprocedural producer/consumer inference or deep/array destructuring analysis; naming-based
 * exceptions and opaque service payload aliases are limitations, not validation of architecture.
 * Providing Context alone does not annotate logs/spans: the outer seam must read and annotate it.
 * Report-only, with no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import { fileURLToPath } from 'node:url';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the production `includePaths` defaults instead of
 * forcing the fixture config to loosen them (`run-on-repo.mts` reuses that config verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_AMBIENT_KEYS: readonly string[] = ['correlationId', 'traceId', 'traceparent'];
// Source-verified boundary/value declarations, not an exemption for their nested operations.
const DEFAULT_WIRE_TYPE_NAMES =
  '(Problem|Headers|Payload|Response|Request|Schema)$|^(OutboxClaim|requireCorrelationId|safeCorrelationId)$';
const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** Type members are only inspected inside a real object-type body. */
const MEMBER_CONTAINERS = new Set(['TSInterfaceBody', 'TSTypeLiteral']);

/** Wrappers between a written parameter and the binding it introduces. */
const PARAMETER_WRAPPERS = new Set(['AssignmentPattern', 'RestElement', 'TSParameterProperty']);

/** Type wrappers that never change which members an object type declares. */
const TYPE_WRAPPERS = new Set([
  'TSParenthesizedType',
  'TSTypeOperator',
  'TSArrayType',
  'TSOptionalType',
]);

interface RuleOptions {
  readonly ambientKeys: ReadonlySet<string>;
  readonly ignore: readonly string[];
  readonly includePaths: readonly string[];
  readonly includeTests: boolean;
  readonly wireTypeNames: RegExp;
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

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Record<string, unknown>;
  const ambientKeys = stringList(given.ambientKeys, DEFAULT_AMBIENT_KEYS);
  const includePaths = stringList(given.includePaths, DEFAULT_INCLUDE_PATHS);
  return {
    ambientKeys: new Set(ambientKeys.length > 0 ? ambientKeys : DEFAULT_AMBIENT_KEYS),
    ignore: stringList(given.ignore, DEFAULT_IGNORE),
    includePaths: includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS,
    includeTests: typeof given.includeTests === 'boolean' ? given.includeTests : false,
    wireTypeNames: compile(given.wireTypeNames, DEFAULT_WIRE_TYPE_NAMES),
  };
}

function scopePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture =
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u.exec(unified);
  if (fixture?.[1]) return fixture[1];
  const root = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/');
  return unified.startsWith(root)
    ? unified.slice(root.length)
    : normalisePath(unified).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Named or static string/template identity keys; dynamic computed keys are unknown. */
function keyName(key: AnyNode, computed: boolean): string | null {
  if (!computed && (key.type === 'Identifier' || key.type === 'PrivateIdentifier')) return key.name;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? null;
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

/**
 * Nearest named declaration owning `node`; function bodies and unrelated callbacks stop the walk.
 * Used to name the candidate and apply the explicit boundary-name convention.
 */
function enclosingNames(node: AnyNode): readonly string[] {
  const names: string[] = [];
  let current: AnyNode | null = parentOf(node);
  for (let guard = 0; guard < 32 && current !== null; guard += 1) {
    switch (current.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'TSDeclareFunction':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration': {
        const id = (current as { id?: AnyNode | null }).id ?? null;
        if (id !== null && id.type === 'Identifier') names.push((id as { name: string }).name);
        break;
      }
      case 'VariableDeclarator': {
        const id = (current as { id: AnyNode }).id;
        if (id.type === 'Identifier') names.push((id as { name: string }).name);
        break;
      }
      case 'AccessorProperty':
      case 'MethodDefinition':
      case 'Property':
      case 'PropertyDefinition':
      case 'TSMethodSignature':
      case 'TSPropertySignature': {
        const holder = current as unknown as { key: AnyNode; computed: boolean };
        const name = keyName(holder.key, holder.computed);
        if (name !== null) names.push(name);
        break;
      }
      default:
        break;
    }
    if (names.length > 0) return names;
    // Never inherit a wire-shaped ancestor through an unrelated anonymous callback/body.
    if (current.type === 'BlockStatement') return names;
    if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
      const parent = parentOf(current);
      if (
        parent?.type !== 'VariableDeclarator' &&
        parent?.type !== 'Property' &&
        parent?.type !== 'MethodDefinition'
      )
        return names;
    }
    current = parentOf(current);
  }
  return names;
}

/** Keys declared by an inline object type on a destructured parameter, so they report only once. */
function inlineMemberKeys(annotation: AnyNode | null | undefined, depth = 0): ReadonlySet<string> {
  const keys = new Set<string>();
  if (annotation === null || annotation === undefined || depth > 4) return keys;
  const node =
    annotation.type === 'TSTypeAnnotation'
      ? (annotation as { typeAnnotation: AnyNode }).typeAnnotation
      : annotation;
  if (TYPE_WRAPPERS.has(node.type)) {
    const inner =
      (node as { typeAnnotation?: AnyNode }).typeAnnotation ??
      (node as { elementType?: AnyNode }).elementType;
    if (inner !== undefined) for (const key of inlineMemberKeys(inner, depth + 1)) keys.add(key);
    return keys;
  }
  if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') {
    for (const member of (node as { types: readonly AnyNode[] }).types) {
      for (const key of inlineMemberKeys(member, depth + 1)) keys.add(key);
    }
    return keys;
  }
  if (node.type !== 'TSTypeLiteral') return keys;
  for (const member of (node as { members: readonly AnyNode[] }).members) {
    if (member.type !== 'TSPropertySignature') continue;
    const signature = member as unknown as {
      key: AnyNode;
      computed: boolean;
      typeAnnotation: AnyNode | null;
    };
    const name = keyName(signature.key, signature.computed);
    if (name !== null) keys.add(name);
    for (const nested of inlineMemberKeys(signature.typeAnnotation, depth + 1)) keys.add(nested);
  }
  return keys;
}

function contextBinding(
  context: Context,
  node: AnyNode,
  seen = new Set<Variable>(),
): string | null {
  if (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
      'ChainExpression',
    ].includes(node.type)
  )
    return contextBinding(context, (node as unknown as { expression: AnyNode }).expression, seen);
  if (node.type === 'CallExpression') return contextBinding(context, node.callee, seen);
  if (node.type === 'MemberExpression') {
    const base = contextBinding(context, node.object, seen);
    const key = keyName(node.property, node.computed);
    return base === null || key === null ? null : base === '$root' ? key : `${base}.${key}`;
  }
  if (node.type !== 'Identifier') return null;
  let scope: Scope | null = context.sourceCode.getScope(node);
  let variable: Variable | undefined;
  while (scope) {
    variable = scope.set.get(node.name);
    if (variable) break;
    scope = scope.upper;
  }
  if (!variable || seen.has(variable)) return null;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type === 'ImportBinding') {
    const declaration = definition.parent;
    if (declaration?.type !== 'ImportDeclaration') return null;
    const specifier = definition.node;
    if (
      declaration.importKind === 'type' ||
      (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
    )
      return null;
    const source = declaration.source.value;
    if (source === 'effect/Context')
      return specifier.type === 'ImportSpecifier'
        ? `Context.${keyName(specifier.imported, false)}`
        : 'Context';
    if (source !== 'effect' && source !== '@modern-js/plugin-bff/effect-edge') return null;
    return specifier.type === 'ImportNamespaceSpecifier'
      ? '$root'
      : specifier.type === 'ImportSpecifier'
        ? keyName(specifier.imported, false)
        : null;
  }
  if (
    definition?.type !== 'Variable' ||
    definition.node.type !== 'VariableDeclarator' ||
    !definition.node.init ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  )
    return null;
  return contextBinding(context, definition.node.init, seen);
}

/** Ambient service payloads and consumption-only casts declare no threaded operation input. */
function isAmbientOrReadType(context: Context, from: AnyNode): boolean {
  let node = parentOf(from);
  while (node) {
    if (
      ['TSAsExpression', 'TSTypeAssertion', 'TSTypePredicate', 'TSSatisfiesExpression'].includes(
        node.type,
      )
    )
      return true;
    if (
      node.type === 'CallExpression' &&
      /^Context\.(?:Tag|Reference|GenericTag|Service)$/u.test(contextBinding(context, node) ?? '')
    )
      return true;
    if (
      [
        'BlockStatement',
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'TSInterfaceDeclaration',
        'TSTypeAliasDeclaration',
      ].includes(node.type)
    )
      return false;
    node = parentOf(node);
  }
  return false;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A6: detect identity-named fields and parameters that may thread request identity through internal operations. Use ambient Context plus one outer annotation seam. This AST-only check uses nearest-owner wire/durable/value naming conventions and recognizes imported Context payloads; it cannot prove producer/consumer roles or trace identity dataflow.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a6-activate-real-observability-at-the-runtime-roots',
    },
    messages: {
      threadedField:
        "Audit A6: identity-named field '{{key}}' in '{{owner}}' matches an internal threading candidate. For ambient request identity, provide a `Context.Reference` / `Context.Service` once and have the outer instrumentation seam read and annotate it. Preserve genuine wire/persisted identity data; this name-based check cannot prove the field's role.",
      threadedParameter:
        "Audit A6: identity-named parameter '{{key}}' in '{{owner}}' matches an internal threading candidate. Read ambient request identity from Context inside operations instead of forwarding and re-annotating it. Preserve genuine ingress/value transformations; this name-based check cannot prove the parameter's role.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ambientKeys: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Identity keys that must be ambient rather than threaded (default: correlationId, traceId, traceparent).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs allowed to keep threading request identity (default: none — the audit wants every site reported until identity is a Context.Reference).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeTests: {
            type: 'boolean',
            description:
              "Also report inside test files (default: false — the audit's D tier blesses fixture transport bags).",
          },
          wireTypeNames: {
            type: 'string',
            description:
              'Regex for the nearest owner or a concise projection return type; a lexical boundary exemption, not inferred transport semantics. Defaults include HTTP suffixes plus exact OutboxClaim, requireCorrelationId and safeCorrelationId names.',
          },
        },
      },
    ],
    defaultOptions: [
      {
        ambientKeys: [...DEFAULT_AMBIENT_KEYS],
        ignore: [...DEFAULT_IGNORE],
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        includeTests: false,
        wireTypeNames: DEFAULT_WIRE_TYPE_NAMES,
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.includePaths)) return {};
    if (
      /\.d\.[cm]?ts$/u.test(path) ||
      /(?:^|\/)(?:dist(?:-[^/]+)?|build|\.output|node_modules)\//u.test(path)
    )
      return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (/(?:^|\/)scripts\//u.test(path)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    /** The HTTP/transport edge the audit blesses: a wire-named enclosing declaration. */
    const isWireEdge = (names: readonly string[]): boolean =>
      names.some((name) => options.wireTypeNames.test(name));

    /**
     * `node` is what gets underlined; `from` is where the enclosing-declaration walk starts, so a
     * key never names itself as its own owner.
     */
    const report = (
      node: AnyNode,
      from: AnyNode,
      messageId: 'threadedField' | 'threadedParameter',
      key: string,
    ): void => {
      const names = enclosingNames(from);
      if (isWireEdge(names)) return;
      if (messageId === 'threadedField') {
        if (isAmbientOrReadType(context, from)) return;
        // A flat inline row input projected to a known durable/wire type is the same
        // serialization boundary as that type, not ambient identity carried inward.
        let owner = parentOf(from);
        while (
          owner &&
          ![
            'BlockStatement',
            'TSPropertySignature',
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
          ].includes(owner.type)
        ) {
          if (
            owner.type === 'ArrowFunctionExpression' ||
            owner.type === 'FunctionDeclaration' ||
            owner.type === 'FunctionExpression'
          ) {
            const output = owner.returnType?.typeAnnotation;
            if (
              owner.type === 'ArrowFunctionExpression' &&
              owner.body.type === 'ObjectExpression' &&
              output?.type === 'TSTypeReference' &&
              output.typeName.type === 'Identifier' &&
              options.wireTypeNames.test(output.typeName.name)
            )
              return;
            break;
          }
          owner = parentOf(owner);
        }
      }
      context.report({ data: { key, owner: names[0] ?? '<anonymous>' }, messageId, node });
    };

    /** Report every ambient key destructured by a parameter pattern (top level + one nesting). */
    const inspectPattern = (pattern: AnyNode, skip: ReadonlySet<string>, depth: number): void => {
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of (pattern as { properties: readonly AnyNode[] }).properties) {
        if (property.type !== 'Property') continue;
        const entry = property as unknown as { key: AnyNode; computed: boolean; value: AnyNode };
        const name = keyName(entry.key, entry.computed);
        if (name !== null && options.ambientKeys.has(name) && !skip.has(name)) {
          report(entry.key, property, 'threadedParameter', name);
        }
        if (depth < 1) inspectPattern(unwrapBinding(entry.value), skip, depth + 1);
      }
    };

    const inspectParameters = (node: AnyNode): void => {
      const params = (node as { params?: readonly AnyNode[] }).params ?? [];
      for (const param of params) {
        const binding = unwrapBinding(param);
        if (binding.type === 'Identifier') {
          const name = (binding as { name: string }).name;
          if (options.ambientKeys.has(name)) report(binding, binding, 'threadedParameter', name);
          continue;
        }
        // An inline object type on the pattern declares the same keys; let the member visitor
        // report those so `({ correlationId }: { readonly correlationId: string })` counts once.
        const skip = inlineMemberKeys(
          (binding as { typeAnnotation?: AnyNode | null }).typeAnnotation,
        );
        inspectPattern(binding, skip, 0);
      }
    };

    /** A class holding the identity as a field is the same threaded channel as an interface member. */
    const inspectClassField = (node: AnyNode): void => {
      const field = node as unknown as { key: AnyNode; computed: boolean };
      const name = keyName(field.key, field.computed);
      if (name === null || !options.ambientKeys.has(name)) return;
      report(field.key, node, 'threadedField', name);
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
      AccessorProperty: inspectClassField,
      PropertyDefinition: inspectClassField,
      TSAbstractPropertyDefinition: inspectClassField,
      TSAbstractAccessorProperty: inspectClassField,
      TSPropertySignature(node) {
        const signature = node as unknown as { key: AnyNode; computed: boolean };
        const parent = parentOf(node as unknown as AnyNode);
        if (parent === null || !MEMBER_CONTAINERS.has(parent.type)) return;
        const name = keyName(signature.key, signature.computed);
        if (name === null || !options.ambientKeys.has(name)) return;
        report(signature.key, node as unknown as AnyNode, 'threadedField', name);
      },
    };
  },
});
