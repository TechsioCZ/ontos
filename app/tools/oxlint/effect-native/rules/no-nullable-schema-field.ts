/**
 * Audit findings: **A2** — "Make Schema the sole authority for contracts and domain models" and
 * **B5** — "Adopt Effect's ADTs and temporal model consistently"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A2 states the target verbatim: "Model absence and outcomes with `Option`, `Result`,
 * `Schema.OptionFromNullOr`, or typed failures as appropriate." B5 names the highest-value targets:
 * "service outcomes, persistence absence, closed status vocabularies, timestamps, pagination".
 * A raw nullable decoded model can force callers to re-derive absence. A nullable *encoded* side
 * of an explicit Option transformation does not: preserve that codec rather than double-wrapping it.
 * Option replacements change the decoded contract and can normalize missing/null/undefined on encode.
 * Review the boundary and choose its None encoding explicitly; never promise unchanged wire output.
 *
 * What is detected
 * - A **call** to `NullOr(...)`, `UndefinedOr(...)` or `NullishOr(...)` (always), and to
 *   `optional(...)` / `optionalKey(...)` when `includeOptionalKeys` is enabled. The reported node is
 *   the whole call, wherever it appears: a `Schema.Struct` field, a shared
 *   `const XSchema = Schema.NullOr(...)`, a nested Struct, an HttpApi payload, a `Schema.TaggedError`
 *   field bag, a `Schema.Class` field bag, a decorator argument.
 * - A **bare reference** to one of those combinators used as a value (`pipe(x, Schema.UndefinedOr)`,
 *   `Schema.String.pipe(Schema.NullOr)`, `const wrap = Schema.NullOr`), which is the point-free
 *   spelling of the same decode — including the reflective spellings `Schema.NullOr.call(...)`,
 *   `.apply(...)` and `.bind(...)`.
 * - The combinator is resolved through the real import bindings and scope, so every spelling of the
 *   same decode is covered:
 *   `import { Schema } from "effect"`, `import { Schema as S } from "effect"`,
 *   `import * as Schema from "effect/Schema"`, `import * as Effect from "effect"` →
 *   `Effect.Schema.NullOr(...)`, **named combinator imports**
 *   (`import { NullOr } from "effect/Schema"` → `NullOr(x)`), **namespace re-binding**
 *   (`const S = Schema; S.NullOr(x)`, `const { Schema } = Effect`), **combinator destructuring**
 *   (`const { NullOr } = Schema; NullOr(x)`), computed access (`Schema["NullOr"](...)` and the
 *   no-substitution template spelling ``Schema[`NullOr`](...)``, at both the namespace and the member
 *   level), optional chaining (`Schema?.NullOr(...)`), casts (`(Schema.NullOr as F)(x)`), and the
 *   Modern.js BFF barrels that re-export `effect/Schema` verbatim (`reexportModules`, default
 *   `@modern-js/plugin-bff/effect-client` and friends — how every `shared/api.ts` contract in this
 *   repository imports `Schema`). A local shadow of any of those identifiers (a parameter, a
 *   block-scoped `const Schema = ...`) resolves to the shadow and is **not** reported: every lexical
 *   match is confirmed against the binding it actually resolves to.
 * - `.ts` and `.tsx` alike; tests are in scope by default (`ignoreTests: false`) because test
 *   fixtures encode the same contracts.
 *
 * What is deliberately allowed
 * - Everything already Option-shaped: `Schema.OptionFromNullOr`, `OptionFromNullishOr`,
 *   `OptionFromUndefinedOr`, `OptionFromOptional`, `OptionFromOptionalKey`,
 *   `OptionFromOptionalNullOr` — and a nullable combinator that is the **immediate argument** of one
 *   of them (`Schema.OptionFromOptionalKey(Schema.NullOr(X))` reports nothing: that field's absence
 *   is already an `Option`). Suppression is deliberately **one hop only**: in
 *   `Schema.OptionFromNullOr(Schema.Array(Schema.NullOr(X)))` the outer combinator encodes the
 *   absence of the *array*, while the array's *elements* still decode to `X | null`, so the inner
 *   call is reported exactly as it would be without the wrapper. `Schema.Option` /
 *   `Schema.OptionFromSelf` are Option **payload** codecs, not absence encodings, and therefore
 *   suppress nothing.
 * - **Presence flags**: `Schema.optionalKey(Schema.Literal(true))` / `Schema.optional(Schema.Literal(...))`.
 *   A single-literal optional key is a marker, not an absent value; wrapping it in an `Option`
 *   adds nothing. (`Schema.optionalKey(Schema.Literals([...]))` — a closed *vocabulary* — is still
 *   reported when `includeOptionalKeys` is on, because B5 names closed status vocabularies as a
 *   high-value Option/Match target.)
 * - Anything that is the immediate argument of `Schema.Literal(...)` / `Schema.Literals(...)`.
 * - **Type positions**: `Schema.NullOr<Schema.String>` in a type annotation, a `declare`, a type-only
 *   import or a generated `.d.ts` is a type reference, never a call, and is never reported.
 * - `Schema.optional` / `Schema.optionalKey` by default (`includeOptionalKeys: false`). An optional
 *   key is a legitimate "field may be absent from the wire" statement in many contracts; turn the
 *   option on to pursue the full B5 target.
 * - Explicit `decodeTo(Option(...))` pipelines and the inverse `Option(...).pipe(encodeTo(nullable))`
 *   use a nullable encoded side, not a nullable decoded model. These codecs are preserved. Only
 *   immediate schema pipelines are followed; nested nullable payloads are still reported.
 * - Drizzle JSONB / HttpApi transport must retain their contracts. A diagnostic is a model review,
 *   not permission to change serialization; optional/nullish replacements need encoding decisions.
 * - Anything outside `include` (default `apps/** verticals/** packages/** scripts/**`), anything
 *   matched by `ignore` (the escape hatch for external ingestion contracts such as the ARES adapter,
 *   where a caller may genuinely prefer a raw nullable), and — with `ignoreTests` — test files.
 *
 * Known limitation: without type information the rule cannot tell a domain field from an
 * intentionally nullable external DTO; `ignore` is the lexical escape hatch. Report-only — this rule
 * never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import {
  keyName,
  memberName as staticMemberName,
  unwrapNode,
} from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import {
  collectEffectBindings,
  type EffectBindings,
} from '../shared/effect-imports.ts';
import { importDeclarations, importedName } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray } from '../shared/options.ts';
import { matchesGlobs } from '../shared/paths.ts';
import {
  acceptsRuleFile,
  ruleFilePolicyProperties,
} from '../shared/rule-file-policy.ts';

const SCHEMA_NAMESPACE = 'Schema';
const EFFECT_ROOT_MODULE = 'effect';
const SCHEMA_MODULE = 'effect/Schema';
const EFFECT_SOURCE = /^effect(?:\/.*)?$/u;

const DEFAULT_INCLUDE = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];
const DEFAULT_IGNORE: readonly string[] = [];

/**
 * Barrels that re-export Effect namespaces verbatim (`export * as Schema from "effect/Schema"`), so
 * `Schema` imported from them *is* Effect's `Schema`. The Modern.js BFF client/edge barrels are how
 * every shared BFF contract in this repository reaches Schema.
 */
const DEFAULT_REEXPORT_MODULES = [
  '@modern-js/plugin-bff/effect',
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-client-runtime',
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-edge/*',
  '@modern-js/plugin-bff/effect-server',
];

/** Combinators that decode absence into `null` / `undefined` instead of an `Option`. */
const NULLABLE_REPLACEMENTS = new Map<string, string>([
  ['NullOr', 'OptionFromNullOr'],
  ['NullishOr', 'OptionFromNullishOr'],
  ['UndefinedOr', 'OptionFromUndefinedOr'],
]);

/** Optional-key combinators: the same absence question, opt-in via `includeOptionalKeys`. */
const OPTIONAL_REPLACEMENTS = new Map<string, string>([
  ['optional', 'OptionFromOptional'],
  ['optionalKey', 'OptionFromOptionalKey'],
]);

/** `Schema.optional(Schema.NullOr(X))` collapses into one combinator. */
const OPTIONAL_NULL_REPLACEMENT = 'OptionFromOptionalNullOr';

/**
 * Combinators that encode *the absence of their immediate argument* as an `Option`. Only a direct
 * argument of one of these is already Option-shaped — see the one-hop rule in the header. `Option`
 * and `OptionFromSelf` are payload codecs (`Schema.Option(Schema.NullOr(X))` still decodes to
 * `Option<X | null>`) and are deliberately absent.
 */
const OPTION_ABSENCE_CONSTRUCTORS = new Set([
  'OptionFromNullOr',
  'OptionFromNullishOr',
  'OptionFromOptional',
  'OptionFromOptionalKey',
  'OptionFromOptionalNullOr',
  'OptionFromUndefinedOr',
]);

/** Closed-literal constructors: their arguments are literal values, never nested schemas. */
const LITERAL_CONSTRUCTORS = new Set(['Literal', 'Literals']);

/** `Function.prototype` methods: `Schema.NullOr.call(null, X)` builds the same nullable schema. */
const FUNCTION_METHODS = new Set(['apply', 'bind', 'call']);

const UNWRAPPABLE = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
  readonly includeOptionalKeys: boolean;
  readonly reexportModules: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: record.ignoreTests === true,
    include: stringArray(record.include, DEFAULT_INCLUDE),
    includeOptionalKeys: record.includeOptionalKeys === true,
    reexportModules: stringArray(
      record.reexportModules,
      DEFAULT_REEXPORT_MODULES
    ),
  };
}

function unwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { wrappers: UNWRAPPABLE, maxDepth: 16 });
}

/** Static computed keys allow cooked templates and the rule's exact wrapper policy. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed)
    return node.property.type === 'Identifier' ? node.property.name : null;
  return staticMemberName(node, {
    templates: true,
    unwrap: { wrappers: UNWRAPPABLE, maxDepth: 16 },
  });
}

/** A binding's declaration sites, recorded as source offsets of the declaring identifiers. */
type DeclarationSites = Map<string, Set<number>>;

interface DirectBinding {
  readonly member: string;
  readonly declarations: Set<number>;
}

interface SchemaLocals {
  /** Locals that stand for the `Schema` namespace itself (`Schema`, `S`, `const S = Schema`). */
  readonly schema: DeclarationSites;
  /** Locals that stand for the whole `effect` barrel (`import * as Effect from "effect"`). */
  readonly barrel: DeclarationSites;
  /** Locals bound directly to a Schema export (`import { NullOr } from "effect/Schema"`). */
  readonly direct: Map<string, DirectBinding>;
}

function emptyLocals(): SchemaLocals {
  return { barrel: new Map(), direct: new Map(), schema: new Map() };
}

function addDeclaration(
  sites: DeclarationSites,
  name: string,
  start: number
): boolean {
  const existing = sites.get(name);
  if (existing === undefined) {
    sites.set(name, new Set([start]));
    return true;
  }
  if (existing.has(start)) return false;
  existing.add(start);
  return true;
}

function addDirect(
  locals: SchemaLocals,
  name: string,
  member: string,
  start: number
): boolean {
  const existing = locals.direct.get(name);
  if (existing === undefined) {
    locals.direct.set(name, { declarations: new Set([start]), member });
    return true;
  }
  if (existing.member !== member || existing.declarations.has(start))
    return false;
  existing.declarations.add(start);
  return true;
}

/**
 * Import-derived locals. `collectEffectBindings` is the authority on which local stands for which
 * Effect namespace; this pass adds the declaration offsets (used to reject shadows), the
 * `effect/Schema` named-combinator locals, and the BFF re-export barrels.
 */
function collectSchemaLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  reexportModules: readonly string[]
): SchemaLocals {
  const locals = emptyLocals();
  const accepts = (source: string): boolean =>
    EFFECT_SOURCE.test(source) || matchesGlobs(source, reexportModules);
  for (const statement of importDeclarations(program, accepts, {
    valueOnly: true,
  })) {
    const source = statement.source.value;
    const isBarrel =
      matchesGlobs(source, reexportModules) || source === EFFECT_ROOT_MODULE;
    for (const specifier of statement.specifiers) {
      collectSchemaSpecifier(locals, bindings, specifier, source, isBarrel);
    }
  }
  return locals;
}

function collectSchemaSpecifier(
  locals: SchemaLocals,
  bindings: EffectBindings,
  specifier: ESTree.ImportDeclaration['specifiers'][number],
  source: string,
  isBarrel: boolean
): void {
  const local = specifier.local;
  if (specifier.type === 'ImportNamespaceSpecifier') {
    if (isBarrel) addDeclaration(locals.barrel, local.name, local.start);
    else if (bindings.namespaces.get(local.name) === SCHEMA_NAMESPACE)
      addDeclaration(locals.schema, local.name, local.start);
    return;
  }
  if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type')
    return;
  const imported = importedName(specifier);
  if (imported === SCHEMA_NAMESPACE)
    addDeclaration(locals.schema, local.name, local.start);
  else if (source === SCHEMA_MODULE)
    addDirect(locals, local.name, imported, local.start);
}

function soleDefinition(
  variable: Variable | null
): Variable['defs'][number] | undefined {
  return variable?.defs.length === 1 ? variable.defs[0] : undefined;
}

function isConstDeclaration(node: ESTree.VariableDeclarator): boolean {
  return (
    node.parent?.type === 'VariableDeclaration' && node.parent.kind === 'const'
  );
}

const NON_VALUE_PARENTS = new Set([
  'ExportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ImportSpecifier',
  'LabeledStatement',
  'MemberExpression',
]);
const OPTION_TARGETS = new Set([
  'Option',
  'OptionFromSelf',
  ...OPTION_ABSENCE_CONSTRUCTORS,
]);
const PIPE_PRESERVERS = new Set(['check', 'annotate', 'brand']);
const METHOD_PRESERVERS = new Set(['check', 'annotate', 'annotateKey']);

/** `const S = Schema` / `const { NullOr } = Schema`: resolved after the whole file is known. */
interface AliasCandidate {
  readonly local: ESTree.Node & {
    readonly name: string;
    readonly start: number;
  };
  readonly source: ESTree.Node;
  /** Property name for a destructuring candidate; `null` for a whole-namespace alias. */
  readonly key: string | null;
}

interface PendingReport {
  readonly kind: 'call' | 'identifier' | 'member';
  readonly node: ESTree.Node;
  readonly start: number;
}

export const rule = defineRule({
  meta: {
    defaultOptions: [
      {
        ignore: [...DEFAULT_IGNORE],
        ignoreTests: false,
        include: DEFAULT_INCLUDE,
        includeOptionalKeys: false,
        reexportModules: DEFAULT_REEXPORT_MODULES,
      },
    ],
    docs: {
      description:
        'Audit A2 + B5: review raw nullable decoded models for Option-based absence. Preserve explicit ' +
        'Option codecs and review null, undefined and omitted-key encoding at JSONB/HttpApi boundaries.',
    },
    messages: {
      nullableCall:
        'Review `Schema.{{member}}(…)` as a nullable decoded model (audit A2, B5). Consider ' +
        '`Schema.{{replacement}}(…)` for Option-based absence. Preserve intentional external codecs; ' +
        'choose None encoding explicitly and verify null/undefined/omitted-key round trips before changing the contract.',
      nullableReference:
        'Review point-free `Schema.{{member}}` for a nullable decoded model (audit A2, B5). Consider ' +
        '`Schema.{{replacement}}` for Option-based absence, preserving intentional external codecs and ' +
        'verifying None encoding and boundary round trips rather than assuming unchanged wire output.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          ...ruleFilePolicyProperties,
          includeOptionalKeys: { type: 'boolean' },
          reexportModules: { items: { type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
    ],
    type: 'problem',
  },
  create(context) {
    const options = readOptions(context);
    if (!acceptsRuleFile(context.filename, options)) return {};

    let locals: SchemaLocals = emptyLocals();
    let tracking = false;
    const aliases: AliasCandidate[] = [];
    const pending: PendingReport[] = [];

    /** `true` when this use of `name` resolves to one of the recorded declarations (no shadow). */
    const resolvesTo = (
      node: ESTree.Node,
      name: string,
      declarations: ReadonlySet<number>
    ): boolean => {
      const variable = resolveVariable(context, name, node);
      if (variable === null || variable.defs.length === 0) return true;
      if (
        variable.references.some(
          (reference) => reference.isWrite() && !reference.init
        )
      )
        return false;
      return variable.defs.some((definition) =>
        declarations.has(definition.name.start)
      );
    };

    const isBarrelIdentifier = (node: ESTree.Node): boolean => {
      if (node.type !== 'Identifier') return false;
      const declarations = locals.barrel.get(node.name);
      return (
        declarations !== undefined && resolvesTo(node, node.name, declarations)
      );
    };

    /** `Schema` / `S` / `Effect.Schema` / `Effect["Schema"]` — the Schema namespace object. */
    const isSchemaNamespace = (node: ESTree.Node): boolean => {
      const expression = unwrap(node);
      if (expression.type === 'Identifier') {
        const declarations = locals.schema.get(expression.name);
        return (
          declarations !== undefined &&
          resolvesTo(expression, expression.name, declarations)
        );
      }
      if (expression.type !== 'MemberExpression') return false;
      if (memberName(expression) !== SCHEMA_NAMESPACE) return false;
      return isBarrelIdentifier(unwrap(expression.object));
    };

    /** `Schema.NullOr` / `S["NullOr"]` / `` Effect.Schema[`NullOr`] `` → `"NullOr"`. */
    const schemaMember = (node: ESTree.Node): string | null => {
      const expression = unwrap(node);
      if (expression.type !== 'MemberExpression') return null;
      const member = memberName(expression);
      if (member === null) return null;
      return isSchemaNamespace(expression.object) ? member : null;
    };

    /** `NullOr` bound by `import { NullOr } from "effect/Schema"` or `const { NullOr } = Schema`. */
    const directMember = (node: ESTree.Node): string | null => {
      const expression = unwrap(node);
      if (expression.type !== 'Identifier') return null;
      const binding = locals.direct.get(expression.name);
      if (binding === undefined) return null;
      return resolvesTo(expression, expression.name, binding.declarations)
        ? binding.member
        : null;
    };

    /** The Schema export a node refers to, however it is spelled. */
    const combinatorMember = (node: ESTree.Node): string | null =>
      schemaMember(node) ?? directMember(node);

    /** The Schema export a call expression invokes, or `null`. */
    const calledMember = (node: ESTree.Node | undefined): string | null => {
      if (node === undefined) return null;
      const expression = unwrap(node);
      if (expression.type !== 'CallExpression') return null;
      return combinatorMember(expression.callee);
    };

    /** The nearest enclosing call this node is an *argument* of, skipping unwrappable nodes. */
    const enclosingCallArgument = (
      node: ESTree.Node
    ): ESTree.CallExpression | null => {
      let current: ESTree.Node = node;
      for (let guard = 0; guard < 16; guard += 1) {
        const parent = current.parent;
        if (parent === null || parent === undefined) return null;
        if (UNWRAPPABLE.has(parent.type)) {
          current = parent;
          continue;
        }
        if (parent.type !== 'CallExpression') return null;
        const inner = current;
        const isArgument = parent.arguments.some(
          (argument) =>
            argument === inner ||
            (argument.start === inner.start && argument.end === inner.end)
        );
        return isArgument ? parent : null;
      }
      return null;
    };

    /** The Schema export whose **immediate** argument this node is, or `null`. */
    const wrappingConstructor = (node: ESTree.Node): string | null => {
      const call = enclosingCallArgument(node);
      return call === null ? null : combinatorMember(call.callee);
    };

    /**
     * One hop only. `Schema.OptionFromNullOr(Schema.NullOr(X))` is already an `Option`, but
     * `Schema.OptionFromNullOr(Schema.Array(Schema.NullOr(X)))` still decodes elements to `X | null`.
     */
    const isImmediateArgumentOfAllowedConstructor = (
      node: ESTree.Node
    ): boolean => {
      const member = wrappingConstructor(node);
      if (member === null) return false;
      return (
        OPTION_ABSENCE_CONSTRUCTORS.has(member) ||
        LITERAL_CONSTRUCTORS.has(member)
      );
    };

    const firstArgument = (
      node: ESTree.CallExpression
    ): ESTree.Node | undefined => {
      const argument = node.arguments[0];
      if (argument === undefined || argument.type === 'SpreadElement')
        return undefined;
      return argument;
    };

    /** Walk out of casts/parens/chains to the node that actually sits in the parent slot. */
    const outermost = (node: ESTree.Node): ESTree.Node => {
      let current: ESTree.Node = node;
      for (let guard = 0; guard < 16; guard += 1) {
        const parent = current.parent;
        if (
          parent === null ||
          parent === undefined ||
          !UNWRAPPABLE.has(parent.type)
        )
          return current;
        current = parent;
      }
      return current;
    };

    /** A point-free *value* use of a combinator identifier — never a declaration or a type. */
    const isPointFreeValuePosition = (node: ESTree.Node): boolean => {
      const current = outermost(node);
      const parent = current.parent;
      if (parent === null || parent === undefined) return false;
      if (/^(?:TS|JSX)/u.test(parent.type)) return false;
      if (NON_VALUE_PARENTS.has(parent.type)) return false;
      switch (parent.type) {
        case 'CallExpression':
        case 'NewExpression':
          return parent.callee !== current;
        case 'Property':
          return parent.parent?.type !== 'ObjectPattern';
        case 'VariableDeclarator':
          return parent.init === current;
        default:
          return true;
      }
    };

    const reportCombinator = (
      node: ESTree.Node,
      member: string,
      replacement: string,
      messageId: string
    ): void => {
      context.report({ data: { member, replacement }, messageId, node });
    };

    /** A const schema alias can name the Option destination without changing its meaning. */
    const optionTarget = (node: ESTree.Node, depth = 0): boolean => {
      if (depth > 12) return false;
      const expression = unwrap(node);
      const member = calledMember(expression);
      if (member !== null && OPTION_TARGETS.has(member)) return true;
      if (expression.type !== 'Identifier') return false;
      const variable = resolveVariable(context, expression.name, expression);
      const definition = soleDefinition(variable);
      if (
        definition?.type !== 'Variable' ||
        definition.node.type !== 'VariableDeclarator'
      )
        return false;
      const declaration = definition.node;
      if (!isConstDeclaration(declaration) || declaration.init === null)
        return false;
      return optionTarget(declaration.init, depth + 1);
    };

    const decodeTargetIsOption = (call: ESTree.CallExpression): boolean => {
      const target = firstArgument(call);
      return target !== undefined && optionTarget(target);
    };

    const isImportedPipe = (callee: ESTree.Node): boolean => {
      if (callee.type !== 'Identifier') return false;
      const definition = soleDefinition(
        resolveVariable(context, callee.name, callee)
      );
      if (definition?.type !== 'ImportBinding') return false;
      if (
        definition.node.type !== 'ImportSpecifier' ||
        importedName(definition.node) !== 'pipe'
      )
        return false;
      return (
        definition.parent?.type === 'ImportDeclaration' &&
        ['effect', 'effect/Function'].includes(definition.parent.source.value)
      );
    };

    /** Undefined means all steps preserve the source, with no destination encountered. */
    const encodedPipeline = (
      steps: readonly ESTree.Node[],
      unwrapSteps: boolean
    ): boolean | undefined => {
      for (const argument of steps) {
        const step = unwrapSteps ? unwrap(argument) : argument;
        if (step.type !== 'CallExpression') return false;
        const member = combinatorMember(step.callee);
        if (member === 'decodeTo') return decodeTargetIsOption(step);
        if (member === null || !PIPE_PRESERVERS.has(member)) return false;
      }
      return undefined;
    };

    const encodedCallArgument = (
      parent: ESTree.CallExpression,
      depth: number
    ): boolean => {
      const callee = unwrap(parent.callee);
      if (
        callee.type === 'CallExpression' &&
        combinatorMember(callee.callee) === 'decodeTo'
      )
        return decodeTargetIsOption(callee);
      if (isImportedPipe(callee)) {
        const result = encodedPipeline(parent.arguments.slice(1), false);
        if (result !== undefined) return result;
      }
      const wrapper = combinatorMember(parent.callee);
      // encodeTo's argument is the encoded side, not the decoded destination.
      if (wrapper === 'encodeTo') return true;
      return (
        wrapper !== null &&
        OPTIONAL_REPLACEMENTS.has(wrapper) &&
        isEncodedSide(parent, depth + 1)
      );
    };

    const encodedMethodReceiver = (
      parent: ESTree.MemberExpression,
      depth: number
    ): boolean => {
      const call = parent.parent;
      if (call?.type !== 'CallExpression' || call.callee !== parent)
        return false;
      const method = memberName(parent);
      if (method === 'pipe')
        return (
          encodedPipeline(call.arguments, true) ??
          isEncodedSide(call, depth + 1)
        );
      return (
        method !== null &&
        METHOD_PRESERVERS.has(method) &&
        isEncodedSide(call, depth + 1)
      );
    };

    const encodedAlias = (
      declaration: ESTree.VariableDeclarator,
      depth: number
    ): boolean => {
      if (
        declaration.id.type !== 'Identifier' ||
        !isConstDeclaration(declaration)
      )
        return false;
      if (declaration.parent?.parent?.type === 'ExportNamedDeclaration')
        return false;
      const variable = resolveVariable(
        context,
        declaration.id.name,
        declaration.id
      );
      const reads =
        variable?.references.filter((reference) => reference.isRead()) ?? [];
      return (
        reads.length > 0 &&
        reads.every((reference) =>
          isEncodedSide(reference.identifier, depth + 1)
        )
      );
    };

    /** Follow only source schemas, never Array/Struct payload boundaries. */
    const isEncodedSide = (node: ESTree.Node, depth = 0): boolean => {
      if (depth > 12) return false;
      const current = outermost(node);
      const parent = current.parent;
      if (!parent) return false;
      if (parent.type === 'CallExpression' && parent.arguments[0] === current)
        return encodedCallArgument(parent, depth);
      if (parent.type === 'MemberExpression' && parent.object === current)
        return encodedMethodReceiver(parent, depth);
      if (parent.type === 'VariableDeclarator' && parent.init === current)
        return encodedAlias(parent, depth);
      return false;
    };

    const skipOptionalCall = (node: ESTree.CallExpression): boolean => {
      if (!options.includeOptionalKeys) return true;
      const innerMember = calledMember(firstArgument(node));
      // Presence flags and optional(nullable) report no separate optional diagnostic.
      return (
        innerMember === 'Literal' ||
        (innerMember !== null && NULLABLE_REPLACEMENTS.has(innerMember))
      );
    };

    const callReplacement = (
      node: ESTree.CallExpression,
      member: string
    ): string => {
      if (member === 'NullOr') {
        const outer = wrappingConstructor(node);
        if (outer !== null && OPTIONAL_REPLACEMENTS.has(outer))
          return OPTIONAL_NULL_REPLACEMENT;
      }
      return (
        NULLABLE_REPLACEMENTS.get(member) ??
        OPTIONAL_REPLACEMENTS.get(member) ??
        ''
      );
    };

    const evaluateCall = (node: ESTree.CallExpression): void => {
      const member = combinatorMember(node.callee);
      if (member === null) return;
      const isOptional = OPTIONAL_REPLACEMENTS.has(member);
      if (!NULLABLE_REPLACEMENTS.has(member) && !isOptional) return;
      if (isOptional && skipOptionalCall(node)) return;
      if (isImmediateArgumentOfAllowedConstructor(node) || isEncodedSide(node))
        return;
      reportCombinator(
        node,
        member,
        callReplacement(node, member),
        'nullableCall'
      );
    };

    const isMemberValuePosition = (node: ESTree.MemberExpression): boolean => {
      const current = outermost(node);
      const parent = current.parent;
      if (parent === null || parent === undefined) return false;
      if (parent.type === 'CallExpression' && parent.callee === current)
        return false;
      if (parent.type !== 'MemberExpression')
        return isPointFreeValuePosition(node);
      if (parent.object !== current) return true;
      const method = memberName(parent);
      return method !== null && FUNCTION_METHODS.has(method);
    };

    const evaluateMember = (node: ESTree.MemberExpression): void => {
      const member = schemaMember(node);
      if (member === null) return;
      const replacement = NULLABLE_REPLACEMENTS.get(member);
      if (replacement === undefined) return;
      if (!isMemberValuePosition(node)) return;
      if (isImmediateArgumentOfAllowedConstructor(node) || isEncodedSide(node))
        return;
      reportCombinator(node, member, replacement, 'nullableReference');
    };

    const evaluateIdentifier = (
      node: ESTree.Node & { readonly name: string }
    ): void => {
      const binding = locals.direct.get(node.name);
      if (binding === undefined) return;
      const replacement = NULLABLE_REPLACEMENTS.get(binding.member);
      if (replacement === undefined) return;
      if (binding.declarations.has(node.start)) return;
      if (!resolvesTo(node, node.name, binding.declarations)) return;
      if (!isPointFreeValuePosition(node)) return;
      if (isImmediateArgumentOfAllowedConstructor(node) || isEncodedSide(node))
        return;
      reportCombinator(node, binding.member, replacement, 'nullableReference');
    };

    const resolveAlias = (alias: AliasCandidate): boolean => {
      const source = unwrap(alias.source);
      const { name, start } = alias.local;
      if (alias.key === null) {
        if (isSchemaNamespace(source))
          return addDeclaration(locals.schema, name, start);
        if (isBarrelIdentifier(source))
          return addDeclaration(locals.barrel, name, start);
        return false;
      }
      if (isSchemaNamespace(source))
        return addDirect(locals, name, alias.key, start);
      if (alias.key === SCHEMA_NAMESPACE && isBarrelIdentifier(source))
        return addDeclaration(locals.schema, name, start);
      return false;
    };

    /** Bounded fixpoint: every alias must be visited even after an earlier one changes. */
    const resolveAliases = (): void => {
      for (let pass = 0; pass < 4; pass += 1) {
        let changed = false;
        for (const alias of aliases) changed = resolveAlias(alias) || changed;
        if (!changed) return;
      }
    };

    const collectPropertyAlias = (
      property: ESTree.ObjectPattern['properties'][number],
      source: ESTree.Node
    ): void => {
      if (property.type !== 'Property' || property.computed) return;
      if (property.value.type !== 'Identifier') return;
      const key = keyName(property.key, false, { templates: false });
      if (key !== null) aliases.push({ key, local: property.value, source });
    };

    return {
      Program(node) {
        locals = collectSchemaLocals(
          node,
          collectEffectBindings(node),
          options.reexportModules
        );
        tracking =
          locals.schema.size > 0 ||
          locals.barrel.size > 0 ||
          locals.direct.size > 0;
      },
      'Program:exit'() {
        if (!tracking) return;
        resolveAliases();
        pending.sort((left, right) => left.start - right.start);
        for (const entry of pending) {
          if (entry.kind === 'call')
            evaluateCall(entry.node as ESTree.CallExpression);
          else if (entry.kind === 'member')
            evaluateMember(entry.node as ESTree.MemberExpression);
          else
            evaluateIdentifier(
              entry.node as ESTree.Node & { readonly name: string }
            );
        }
      },
      VariableDeclarator(node) {
        if (!tracking || node.init === null) return;
        if (!isConstDeclaration(node)) return;
        const source = node.init;
        if (node.id.type === 'Identifier') {
          aliases.push({ key: null, local: node.id, source });
          return;
        }
        if (node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties)
          collectPropertyAlias(property, source);
      },
      CallExpression(node) {
        if (!tracking) return;
        // Aliased import/destructuring callees need not use the exported spelling.
        pending.push({ kind: 'call', node, start: node.start });
      },
      MemberExpression(node) {
        if (!tracking) return;
        const name = memberName(node);
        if (name === null || !NULLABLE_REPLACEMENTS.has(name)) return;
        pending.push({ kind: 'member', node, start: node.start });
      },
      Identifier(node) {
        if (!tracking) return;
        pending.push({ kind: 'identifier', node, start: node.start });
      },
    };
  },
});
