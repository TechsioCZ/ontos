import { fileURLToPath } from 'node:url';

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
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { keyName as staticKeyName, parentOf, unwrapBinding } from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import { compile, stringList } from '../shared/options.ts';
import { isTestFile, matchesGlobs, rootedScopePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

const DEFAULT_AMBIENT_KEYS: readonly string[] = ['correlationId', 'traceId', 'traceparent'];
// Source-verified boundary/value declarations, not an exemption for their nested operations.
const DEFAULT_WIRE_TYPE_NAMES =
  '(Problem|Headers|Payload|Response|Request|Schema)$|^(OutboxClaim|requireCorrelationId|safeCorrelationId)$';
const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE: readonly string[] = [];

/** Type members are only inspected inside a real object-type body. */
const MEMBER_CONTAINERS = new Set(['TSInterfaceBody', 'TSTypeLiteral']);

/** Type wrappers that never change which members an object type declares. */
const TYPE_WRAPPERS = new Set(['TSParenthesizedType', 'TSTypeOperator', 'TSArrayType', 'TSOptionalType']);

interface RuleOptions {
  readonly ambientKeys: ReadonlySet<string>;
  readonly ignore: readonly string[];
  readonly includePaths: readonly string[];
  readonly includeTests: boolean;
  readonly wireTypeNames: RegExp;
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
  return rootedScopePath(filename, fileURLToPath(new URL('../../../../', import.meta.url)));
}

/** Private fields are accepted here in addition to the shared static-key policy. */
function keyName(key: AnyNode, computed: boolean): string | null {
  if (!computed && key.type === 'PrivateIdentifier') return key.name;
  return staticKeyName(key, computed);
}

const NAMED_DECLARATIONS = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSDeclareFunction',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'VariableDeclarator',
]);
const KEYED_DECLARATIONS = new Set([
  'AccessorProperty',
  'MethodDefinition',
  'Property',
  'PropertyDefinition',
  'TSMethodSignature',
  'TSPropertySignature',
]);

function declarationName(node: AnyNode): string | null {
  if (NAMED_DECLARATIONS.has(node.type)) {
    const id = (node as { id?: AnyNode | null }).id;
    return id?.type === 'Identifier' ? id.name : null;
  }
  if (!KEYED_DECLARATIONS.has(node.type)) return null;
  const holder = node as unknown as { key: AnyNode; computed: boolean };
  return keyName(holder.key, holder.computed);
}

function stopsOwnerSearch(node: AnyNode): boolean {
  if (node.type === 'BlockStatement') return true;
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') return false;
  const parent = parentOf(node);
  return !parent || !['VariableDeclarator', 'Property', 'MethodDefinition'].includes(parent.type);
}

/**
 * Nearest named declaration owning `node`; function bodies and unrelated callbacks stop the walk.
 * Used to name the candidate and apply the explicit boundary-name convention.
 */
function enclosingNames(node: AnyNode): readonly string[] {
  let current: AnyNode | null = parentOf(node);
  for (let guard = 0; guard < 32 && current !== null; guard += 1) {
    const name = declarationName(current);
    if (name !== null) return [name];
    if (stopsOwnerSearch(current)) return [];
    current = parentOf(current);
  }
  return [];
}

/** Keys declared by an inline object type on a destructured parameter, so they report only once. */
function inlineMemberKeys(annotation: AnyNode | null | undefined, depth = 0): ReadonlySet<string> {
  const keys = new Set<string>();
  if (annotation === null || annotation === undefined || depth > 4) return keys;
  const node =
    annotation.type === 'TSTypeAnnotation' ? (annotation as { typeAnnotation: AnyNode }).typeAnnotation : annotation;
  for (const child of inlineTypeChildren(node)) {
    for (const key of inlineMemberKeys(child, depth + 1)) keys.add(key);
  }
  addInlinePropertyNames(node, keys);
  return keys;
}

function addInlinePropertyNames(node: AnyNode, keys: Set<string>): void {
  if (node.type === 'TSTypeLiteral') {
    for (const member of node.members) {
      if (member.type !== 'TSPropertySignature') continue;
      const name = keyName(member.key, member.computed);
      if (name !== null) keys.add(name);
    }
  }
}

function inlineTypeChildren(node: AnyNode): readonly (AnyNode | null | undefined)[] {
  if (TYPE_WRAPPERS.has(node.type)) {
    const wrapper = node as { typeAnnotation?: AnyNode; elementType?: AnyNode };
    return [wrapper.typeAnnotation ?? wrapper.elementType];
  }
  if (node.type === 'TSUnionType' || node.type === 'TSIntersectionType') return node.types;
  if (node.type !== 'TSTypeLiteral') return [];
  return node.members.flatMap((member) => (member.type === 'TSPropertySignature' ? [member.typeAnnotation] : []));
}

function importedContextBinding(definition: Variable['defs'][number]): string | null {
  const declaration = definition.parent;
  if (declaration?.type !== 'ImportDeclaration') return null;
  const specifier = definition.node;
  if (declaration.importKind === 'type') return null;
  if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return null;
  return contextImportName(declaration.source.value, specifier);
}

function contextImportName(source: string, specifier: AnyNode): string | null {
  if (source === 'effect/Context')
    return specifier.type === 'ImportSpecifier' ? `Context.${keyName(specifier.imported, false)}` : 'Context';
  if (source !== 'effect' && source !== '@modern-js/bff-effect/effect-edge') return null;
  if (specifier.type === 'ImportNamespaceSpecifier') return '$root';
  return specifier.type === 'ImportSpecifier' ? keyName(specifier.imported, false) : null;
}

function variableContextBinding(context: Context, node: AnyNode, seen: Set<Variable>): string | null {
  const variable = lookupVariable(context, node);
  if (!variable || seen.has(variable)) return null;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type === 'ImportBinding') return importedContextBinding(definition);
  if (definition?.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') return null;
  if (!definition.node.init) return null;
  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  return contextBinding(context, definition.node.init, seen);
}

function contextBinding(context: Context, node: AnyNode, seen = new Set<Variable>()): string | null {
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
  return variableContextBinding(context, node, seen);
}

/** Ambient service payloads and consumption-only casts declare no threaded operation input. */
function isAmbientOrReadType(context: Context, from: AnyNode): boolean {
  let node = parentOf(from);
  while (node) {
    if (['TSAsExpression', 'TSTypeAssertion', 'TSTypePredicate', 'TSSatisfiesExpression'].includes(node.type))
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

function isConciseWireProjection(owner: AnyNode, wireTypeNames: RegExp): boolean {
  if (owner.type !== 'ArrowFunctionExpression' || owner.body.type !== 'ObjectExpression') return false;
  const output = owner.returnType?.typeAnnotation;
  return (
    output?.type === 'TSTypeReference' &&
    output.typeName.type === 'Identifier' &&
    wireTypeNames.test(output.typeName.name)
  );
}

/** A flat inline row projection is the same serialization boundary as its wire return type. */
function isWireProjection(from: AnyNode, wireTypeNames: RegExp): boolean {
  let owner = parentOf(from);
  while (
    owner &&
    !['BlockStatement', 'TSPropertySignature', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(owner.type)
  ) {
    if (['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(owner.type))
      return isConciseWireProjection(owner, wireTypeNames);
    owner = parentOf(owner);
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
    if (/\.d\.[cm]?ts$/u.test(path) || /(?:^|\/)(?:dist(?:-[^/]+)?|build|\.output|node_modules)\//u.test(path))
      return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (/(?:^|\/)scripts\//u.test(path)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    /** The HTTP/transport edge the audit blesses: a wire-named enclosing declaration. */
    const isWireEdge = (names: readonly string[]): boolean => names.some((name) => options.wireTypeNames.test(name));

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
        if (isWireProjection(from, options.wireTypeNames)) return;
      }
      context.report({
        data: { key, owner: names[0] ?? '<anonymous>' },
        messageId,
        node,
      });
    };

    /** Report every ambient key destructured by a parameter pattern (top level + one nesting). */
    const inspectPattern = (pattern: AnyNode, skip: ReadonlySet<string>, depth: number): void => {
      if (pattern.type !== 'ObjectPattern') return;
      for (const property of (pattern as { properties: readonly AnyNode[] }).properties) {
        if (property.type !== 'Property') continue;
        const entry = property as unknown as {
          key: AnyNode;
          computed: boolean;
          value: AnyNode;
        };
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
        const skip = inlineMemberKeys((binding as { typeAnnotation?: AnyNode | null }).typeAnnotation);
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
        const signature = node as unknown as {
          key: AnyNode;
          computed: boolean;
        };
        const parent = parentOf(node as unknown as AnyNode);
        if (parent === null || !MEMBER_CONTAINERS.has(parent.type)) return;
        const name = keyName(signature.key, signature.computed);
        if (name === null || !options.ambientKeys.has(name)) return;
        report(signature.key, node as unknown as AnyNode, 'threadedField', name);
      },
    };
  },
});
