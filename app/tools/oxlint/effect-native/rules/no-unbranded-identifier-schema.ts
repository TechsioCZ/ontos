/**
 * Audit finding: **A2** — "Make Schema the sole authority for contracts and domain models"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`). A2 measures **zero branded identifiers** and
 * asks explicitly to "Introduce `Schema.brand` for tenant, principal, legal-entity, module, action,
 * customer, contact, deployment, IČO, and idempotency identifiers". Today every identifier is a bare
 * `Schema.String` (sometimes `.check(Schema.isUUID())`), so a `tenantId` is structurally assignable to
 * a `principalId`, a `moduleId`, or any other identifier — the type system provides no protection at
 * the exact seams (authorization, tenancy, ownership) where confusion is most damaging.
 *
 * What is detected
 * 1. A **field-bag property** whose key looks like an identifier (`identifierKeyPattern`, default
 *    `*Id` / `*Ids` / `*Key` / `*Keys` / `ico` / `dic` — a collection of identifiers is the same defect
 *    as a single one) and whose value is *string-rooted*. Field bags are the object literals that
 *    define a Schema's fields:
 *      - the object arguments of `Schema.Struct(...)`, `Schema.TaggedStruct('T', ...)`,
 *        `Schema.TaggedError<E>()('T', ...)`, `Schema.TaggedRequest<R>()('T', ...)`,
 *        `Schema.Class<C>('T')({...})`, `Schema.TaggedClass<C>()('T', {...})`, `Schema.ErrorClass`,
 *        `Schema.Record({ ... })` — resolved through the real `effect` import bindings, so aliases
 *        (`import { Schema as S }`), submodule namespace imports (`import * as Schema from
 *        "effect/Schema"`), root barrel imports (`import * as Effect from "effect"` →
 *        `Effect.Schema.Struct`), computed access (`Schema["Struct"]`), optional chaining and the
 *        Modern.js BFF barrels that re-export `effect/Schema` verbatim (`reexportModules`, default
 *        `@modern-js/plugin-bff/effect-client` and friends — how every `shared/api.ts` contract in this
 *        repository imports `Schema`) all work;
 *      - a module-level `const *Fields` / `const *fields` object that is spread (`...apiKeyStatusFields`)
 *        into another object literal somewhere in the same file — the repository's dominant way of
 *        sharing field bags between `Schema.Struct` union members and `Schema.TaggedError`s.
 * 2. A module-level **`const <Name>Schema`** whose name matches `identifierSchemaNamePattern`
 *    (default `(?:Ids?|Ico|Keys?)Schema$`) and whose initialiser is string-rooted — the shared
 *    "identifier schema" that *should* have carried the brand for every consumer.
 *
 * Both the constructors and the leaves are also recognised when they are bound *directly* rather than
 * through the namespace — `import { Struct, String as SchemaString } from "effect/Schema"` and
 * `const { Struct, String: Str } = Schema` — so dropping the `Schema.` prefix is not a way out. Named
 * imports from the root `effect` barrel are deliberately **not** treated this way: `effect`'s `Struct`
 * is `effect/Struct` (record utilities), not `Schema.Struct`.
 *
 * "String-rooted" (`isStringRooted`) is true for `Schema.String`, `Schema.NonEmptyString`,
 * `Schema.Trim`, `Schema.UUID`, `Schema.ULID`, ... ; for `.check(...)`, `.annotate(...)`,
 * `.pipe(...)` chains on a string-rooted object; for `Schema.NullOr` / `UndefinedOr` / `NullishOr` /
 * `optional` / `optionalKey` / `Array` / `NonEmptyArray` / `mutable` wrapping a string-rooted
 * argument; and for a bare identifier that resolves to an in-file `const` with a string-rooted
 * initialiser (so `const uuid = Schema.String.check(Schema.isUUID()); { principalId: uuid }` is caught).
 *
 * What is deliberately allowed
 * - Anything branded: `Schema.String.pipe(Schema.brand('TenantId'))`, `pipe(Schema.String,
 *   Schema.brand('TenantId'))`, `Schema.String.brand('TenantId')`, or a brand applied through a
 *   project helper named in `brandHelpers`. A brand anywhere in the chain makes the whole chain valid.
 * - Identifier fields whose value is an **imported** Schema (`{ tenantId: TenantIdSchema }` where
 *   `TenantIdSchema` comes from another module): the brand belongs to the owning module, and this rule
 *   reports it there. Only in-file definitions are followed.
 * - Non-string identifiers (`Schema.Number`, `Schema.Literals([...])`, `Schema.UUIDFromSelf`-style
 *   opaque types, nested Structs) and non-identifier keys (`name`, `reason`, `createdAt`, bare `key`).
 * - The declaration/usage pair is reported **once**: when a field's value resolves to an in-file
 *   declarator that this rule already reports, only the declarator is reported. Fixing the shared
 *   schema fixes every consumer.
 * - Everything outside `include` (default `apps/** verticals/** packages/** scripts/**`) or matched by
 *   `ignore`. Tests are in scope by default (`ignoreTests: false`) because test fixtures encode the
 *   same contracts; set `ignoreTests: true` to narrow.
 *
 * A pipe is only string-rooted when every step is a known Schema-preserving operation or a
 * syntactically identity helper. Unknown transforms (including decodeTo) may produce branded or
 * non-string values: the encoded string alone is not evidence of an unbranded decoded identifier.
 * This narrows the earlier specification's blanket pipe traversal to avoid false positives.
 * Known limitation: unknown helper bodies, imported schemas, and cross-file aliases are not evaluated.
 * Report-only; this rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

const SCHEMA_NAMESPACE = 'Schema';
const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_SCHEMA_MODULE = /^effect\/(?:.*\/)?Schema$/u;

/** Fixture files mirror repo paths under `tests/fixtures/<rule>/{valid,invalid}/`; strip that prefix. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];
const DEFAULT_IGNORE: string[] = [];
const DEFAULT_KEY_PATTERN = '^(?:.*(?:Ids?|Keys?)|ico|dic)$';
const DEFAULT_SCHEMA_NAME_PATTERN = '(?:Ids?|Ico|Keys?)Schema$';
const DEFAULT_BRAND_HELPERS: string[] = [];

/**
 * Barrels that re-export Effect namespaces verbatim. `@modern-js/plugin-bff/effect-client` re-exports
 * `effect/Schema` as `Schema` and is how the BFF contracts (`apps/*​/shared/api.ts`,
 * `verticals/*​/shared/**`) import it — nearly a third of all `Schema` imports in the repository.
 */
const DEFAULT_REEXPORT_MODULES = [
  '@modern-js/plugin-bff/effect',
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-client-runtime',
  '@modern-js/plugin-bff/effect-edge',
  '@modern-js/plugin-bff/effect-edge/*',
  '@modern-js/plugin-bff/effect-server',
];

/** `Schema.<X>` combinators whose object arguments are field bags (`{ tenantId: ... }`). */
const FIELD_BAG_CONSTRUCTORS = new Set([
  'Class',
  'ErrorClass',
  'Struct',
  'TaggedClass',
  'TaggedError',
  'TaggedRequest',
  'TaggedStruct',
  'Record',
]);

/** `Schema.<X>` leaves whose encoded/decoded type is a plain, interchangeable string. */
const STRING_ROOTS = new Set([
  'Capitalize',
  'Char',
  'Lowercase',
  'NonEmptyString',
  'NonEmptyTrimmedString',
  'String',
  'Trim',
  'TrimmedString',
  'ULID',
  'Uncapitalize',
  'Uppercase',
  'UUID',
]);

/** `Schema.<X>(inner)` wrappers that keep the inner schema's identity (and therefore its brand-lessness). */
const TRANSPARENT_WRAPPERS = new Set([
  'Array',
  'NonEmptyArray',
  'NullishOr',
  'NullOr',
  'UndefinedOr',
  'mutable',
  'optional',
  'optionalKey',
  'ReadonlyArray',
]);

/** Instance methods that refine/annotate without changing identity: `Schema.String.check(...)`. */
const TRANSPARENT_METHODS = new Set(['annotate', 'annotateKey', 'check', 'pipe']);

/** Anything named like this introduces a brand — `Schema.brand`, `Schema.Brand`, `.brand(...)`. */
const BRAND_MEMBERS = new Set(['brand', 'Brand', 'TaggedBrand']);

/**
 * Every `Schema.<member>` this rule understands. Used to decide whether a *named* import
 * (`import { Struct, String as SchemaString } from "effect/Schema"`) taken from a re-export barrel is
 * really the Schema member of that name. Imports straight from `effect/Schema` need no such gate.
 */
const KNOWN_SCHEMA_MEMBERS = new Set([
  ...FIELD_BAG_CONSTRUCTORS,
  ...STRING_ROOTS,
  ...TRANSPARENT_WRAPPERS,
  ...BRAND_MEMBERS,
]);

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
  readonly identifierKeyPattern: string;
  readonly identifierSchemaNamePattern: string;
  readonly brandHelpers: readonly string[];
  readonly reexportModules: readonly string[];
  readonly ignoreTests: boolean;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function stringOption(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    brandHelpers: stringArray(record.brandHelpers, DEFAULT_BRAND_HELPERS),
    identifierKeyPattern: stringOption(record.identifierKeyPattern, DEFAULT_KEY_PATTERN),
    identifierSchemaNamePattern: stringOption(
      record.identifierSchemaNamePattern,
      DEFAULT_SCHEMA_NAME_PATTERN,
    ),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreTests: record.ignoreTests === true,
    include: stringArray(record.include, DEFAULT_INCLUDE),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

function safeRegExp(source: string, fallback: string): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch {
    return new RegExp(fallback, 'u');
  }
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Non-computed `.Struct`, or computed `["Struct"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = node.property;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (let guard = 0; guard < 16; guard += 1) {
    if (!UNWRAPPABLE.has(current.type)) return current;
    const inner = (current as { expression?: ESTree.Node }).expression;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** A local that stands for one `Schema.<member>` rather than for the `Schema` namespace. */
interface MemberBinding {
  /** The `Schema.<member>` name this local is an alias of (`Struct`, `String`, `brand`, ...). */
  readonly member: string;
  /**
   * `null` when the local is an import binding (verified with `resolvesToImport`); otherwise the
   * `start` of the `VariableDeclarator` that destructured it (`const { Struct } = Schema`), so a later
   * shadow of the same name cannot be mistaken for it.
   */
  readonly declarator: number | null;
}

interface SchemaLocals {
  /** Locals that stand for the `Schema` namespace itself. */
  readonly schema: Set<string>;
  /** Locals that stand for the whole `effect` barrel (`import * as Effect from "effect"`). */
  readonly barrel: Set<string>;
  /** Locals bound by `import { brand } from "effect/Schema"`. */
  readonly brandDirect: Set<string>;
  /** Locals bound to `pipe` from `effect` / `effect/Function`. */
  readonly pipe: Set<string>;
  /** Locals bound to a Schema member directly: `import { Struct, String as S } from "effect/Schema"`. */
  readonly members: Map<string, MemberBinding>;
}

function collectSchemaLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  reexportModules: readonly string[],
): SchemaLocals {
  const schema = new Set<string>();
  const barrel = new Set<string>();
  const brandDirect = new Set<string>();
  const pipe = new Set<string>();
  const members = new Map<string, MemberBinding>();
  for (const [local, namespace] of bindings.namespaces) {
    if (namespace === SCHEMA_NAMESPACE) schema.add(local);
    if (namespace === 'pipe') pipe.add(local);
  }
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    const isReexport = matchesGlobs(source, reexportModules);
    if (source === EFFECT_ROOT_MODULE || isReexport) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') barrel.add(specifier.local.name);
      }
    }
    if (isReexport) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue;
        const imported = importedName(specifier);
        if (imported === SCHEMA_NAMESPACE) schema.add(specifier.local.name);
        if (imported === 'pipe') pipe.add(specifier.local.name);
        // A barrel also re-exports plain values; only names that really are Schema members count.
        if (KNOWN_SCHEMA_MEMBERS.has(imported)) {
          members.set(specifier.local.name, { declarator: null, member: imported });
        }
      }
    }
    // `import { Struct, String as SchemaString } from "effect/Schema"` — the members themselves.
    // The root `effect` barrel is deliberately excluded: its `Struct` is `effect/Struct`, not a Schema.
    if (EFFECT_SCHEMA_MODULE.test(source)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue;
        const imported = importedName(specifier);
        if (BRAND_MEMBERS.has(imported)) brandDirect.add(specifier.local.name);
        members.set(specifier.local.name, { declarator: null, member: imported });
      }
    }
  }
  return { barrel, brandDirect, members, pipe, schema };
}

function lookupVariable(context: Context, identifier: ESTree.Node, name: string): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Capitalised brand suggestion: `tenantId` → `TenantId`, `ContactsIcoSchema` → `ContactsIco`. */
function brandName(raw: string): string {
  const trimmed = raw.replace(/Schema$/u, '');
  const base = trimmed.length > 0 ? trimmed : raw;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

export const rule = defineRule({
  meta: {
    defaultOptions: [
      {
        brandHelpers: DEFAULT_BRAND_HELPERS,
        identifierKeyPattern: DEFAULT_KEY_PATTERN,
        identifierSchemaNamePattern: DEFAULT_SCHEMA_NAME_PATTERN,
        ignore: DEFAULT_IGNORE,
        ignoreTests: false,
        include: DEFAULT_INCLUDE,
        reexportModules: DEFAULT_REEXPORT_MODULES,
      },
    ],
    docs: {
      description:
        'Audit A2: identifier fields must be branded Schemas. A bare `Schema.String` identifier makes ' +
        '`tenantId`, `principalId`, `moduleId` and every other identifier mutually assignable; declare each ' +
        "one once as `Schema.String.pipe(Schema.brand('<Name>'))` and share it.",
    },
    messages: {
      unbrandedField:
        'Identifier field `{{key}}` is an unbranded string Schema, interchangeable with every other identifier ' +
        '(a `principalId` can be passed where a `tenantId` is expected). Declare it once as a shared branded ' +
        "Schema — `Schema.String.pipe(Schema.brand('{{brand}}'))` — and reference that schema here (audit A2).",
      unbrandedSchema:
        'Shared identifier Schema `{{name}}` is an unbranded string Schema, so every contract that uses it stays ' +
        'interchangeable with every other identifier. Brand it here — ' +
        "`Schema.String.pipe(Schema.brand('{{brand}}'))` — and derive the type from the Schema (audit A2).",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          brandHelpers: { items: { type: 'string' }, type: 'array' },
          identifierKeyPattern: { type: 'string' },
          identifierSchemaNamePattern: { type: 'string' },
          ignore: { items: { type: 'string' }, type: 'array' },
          ignoreTests: { type: 'boolean' },
          include: { items: { type: 'string' }, type: 'array' },
          reexportModules: { items: { type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
    ],
    type: 'problem',
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (options.ignoreTests && isTestFile(path)) return {};

    const keyPattern = safeRegExp(options.identifierKeyPattern, DEFAULT_KEY_PATTERN);
    const schemaNamePattern = safeRegExp(
      options.identifierSchemaNamePattern,
      DEFAULT_SCHEMA_NAME_PATTERN,
    );

    let bindings: EffectBindings = { importsEffect: false, namespaces: new Map() };
    let locals: SchemaLocals = {
      barrel: new Set(),
      brandDirect: new Set(),
      members: new Map(),
      pipe: new Set(),
      schema: new Set(),
    };

    const objects: ESTree.ObjectExpression[] = [];
    const declarators: ESTree.VariableDeclarator[] = [];
    const calls: ESTree.CallExpression[] = [];
    const spreadNames = new Set<string>();
    /** Identifiers handed straight to a field-bag constructor: `Schema.TaggedError<E>()('T', errorFields)`. */
    const bagIdentifierNames = new Set<string>();

    /** `true` when the namespace identifier still resolves to its `effect` import (no local shadow). */
    const resolvesToImport = (node: ESTree.Node, name: string): boolean => {
      const variable = lookupVariable(context, node, name);
      if (variable === null || variable.defs.length === 0) return true;
      return variable.defs.some((definition) => definition.type === 'ImportBinding');
    };

    /** The in-file `const` declarator an identifier resolves to, or `null` for imports/params/globals. */
    const localDeclarator = (node: ESTree.Node, name: string): ESTree.VariableDeclarator | null => {
      const variable = lookupVariable(context, node, name);
      if (variable === null || variable.defs.length !== 1) return null;
      const definition = variable.defs[0];
      if (definition === undefined || definition.type !== 'Variable') return null;
      const declarator = definition.node;
      return declarator.type === 'VariableDeclarator' ? declarator : null;
    };

    /**
     * A bare identifier that *is* a Schema member: `import { Struct } from "effect/Schema"` or
     * `const { Struct } = Schema`. Verified against the binding it was recorded from, so a local
     * shadow (a parameter, another `const`) does not resolve.
     */
    const destructuredMembers = new Map<number, Map<string, string>>();
    const memberOfIdentifier = (node: ESTree.Node, name: string): string | null => {
      const local = localDeclarator(node, name);
      const destructured =
        local === null ? undefined : destructuredMembers.get(local.start)?.get(name);
      if (destructured !== undefined) return destructured;
      const binding = locals.members.get(name);
      if (binding === undefined) return null;
      if (binding.declarator === null) return resolvesToImport(node, name) ? binding.member : null;
      const declarator = localDeclarator(node, name);
      return declarator !== null && declarator.start === binding.declarator ? binding.member : null;
    };

    /** `Schema.Struct` / `S.Struct` / `Effect.Schema.Struct` / `Schema["Struct"]` / bare `Struct` → `"Struct"`. */
    const schemaMember = (node: ESTree.Node): string | null => {
      if (node.type === 'Identifier') return memberOfIdentifier(node, node.name);
      if (node.type !== 'MemberExpression') return null;
      const member = memberName(node);
      if (member === null) return null;
      const object = unwrap(node.object);
      if (object.type === 'Identifier') {
        if (!locals.schema.has(object.name)) return null;
        return resolvesToImport(object, object.name) ? member : null;
      }
      if (object.type !== 'MemberExpression') return null;
      if (memberName(object) !== SCHEMA_NAMESPACE) return null;
      const root = unwrap(object.object);
      if (root.type !== 'Identifier') return null;
      if (!locals.barrel.has(root.name)) return null;
      return resolvesToImport(root, root.name) ? member : null;
    };

    /** `Schema.brand('X')`, bare `Schema.brand`, `import { brand }`, or a configured helper. */
    const isBrandExpression = (node: ESTree.Node): boolean => {
      const expression = unwrap(node);
      if (expression.type === 'CallExpression') {
        const callee = unwrap(expression.callee);
        if (callee.type === 'Identifier' && options.brandHelpers.includes(callee.name)) return true;
        return isBrandExpression(callee);
      }
      if (expression.type === 'Identifier') {
        if (
          locals.brandDirect.has(expression.name) &&
          resolvesToImport(expression, expression.name)
        )
          return true;
        if (options.brandHelpers.includes(expression.name)) return true;
        const member = memberOfIdentifier(expression, expression.name);
        return member !== null && BRAND_MEMBERS.has(member);
      }
      if (expression.type === 'MemberExpression') {
        const member = memberName(expression);
        if (member === null) return false;
        if (BRAND_MEMBERS.has(member) && schemaMember(expression) !== null) return true;
        return options.brandHelpers.includes(member);
      }
      return false;
    };

    /**
     * `const { Struct, String: Str } = Schema` / `const { Struct } = Effect.Schema` — namespace
     * destructuring binds the same members a named import would, so record them the same way.
     */
    const collectDestructuredMembers = (): void => {
      for (const declarator of declarators) {
        if (declarator.id.type !== 'ObjectPattern') continue;
        const init =
          declarator.init === null || declarator.init === undefined
            ? null
            : unwrap(declarator.init);
        if (init === null) continue;
        let isSchemaSource = false;
        if (init.type === 'Identifier') {
          isSchemaSource = locals.schema.has(init.name) && resolvesToImport(init, init.name);
        } else if (init.type === 'MemberExpression' && memberName(init) === SCHEMA_NAMESPACE) {
          const root = unwrap(init.object);
          isSchemaSource =
            root.type === 'Identifier' &&
            locals.barrel.has(root.name) &&
            resolvesToImport(root, root.name);
        }
        if (!isSchemaSource) continue;
        for (const property of declarator.id.properties) {
          if (property.type !== 'Property' || property.computed) continue;
          const key = property.key;
          const member =
            key.type === 'Identifier'
              ? key.name
              : key.type === 'Literal' && typeof key.value === 'string'
                ? key.value
                : null;
          if (member === null || property.value.type !== 'Identifier') continue;
          const members = destructuredMembers.get(declarator.start) ?? new Map<string, string>();
          members.set(property.value.name, member);
          destructuredMembers.set(declarator.start, members);
        }
      }
    };

    /** A pipe step must visibly preserve the string schema; arbitrary transforms may decode it
     * to a branded or non-string target. Do not infer their output from the encoded input. */
    const isTransparentStep = (node: ESTree.Node, depth = 0): boolean => {
      if (depth > 16) return false;
      const step = unwrap(node);
      const member = schemaMember(step.type === 'CallExpression' ? unwrap(step.callee) : step);
      if (member !== null) {
        return (
          TRANSPARENT_WRAPPERS.has(member) || (TRANSPARENT_METHODS.has(member) && member !== 'pipe')
        );
      }
      if (step.type === 'Identifier') {
        const declaration = localDeclarator(step, step.name);
        if (
          declaration?.parent?.type !== 'VariableDeclaration' ||
          declaration.parent.kind !== 'const'
        )
          return false;
        return declaration.init !== null && isTransparentStep(declaration.init, depth + 1);
      }
      // The one helper whose result is syntactically known: `(schema) => schema`.
      if (step.type !== 'ArrowFunctionExpression' && step.type !== 'FunctionExpression')
        return false;
      if (step.body === null) return false;
      if (step.params.length !== 1 || step.params[0]?.type !== 'Identifier') return false;
      const returned =
        step.body.type === 'BlockStatement'
          ? step.body.body.length === 1 && step.body.body[0]?.type === 'ReturnStatement'
            ? step.body.body[0].argument
            : null
          : step.body;
      return returned?.type === 'Identifier' && returned.name === step.params[0].name;
    };

    /**
     * A schema expression whose runtime identity is still "any string": no brand anywhere in the
     * chain. `seen` guards mutually-referential `const`s.
     */
    const isStringRooted = (
      node: ESTree.Node | null,
      seen: Set<number>,
      depth: number,
    ): boolean => {
      if (node === null || depth > 24) return false;
      const expression = unwrap(node);

      if (expression.type === 'MemberExpression') {
        const member = schemaMember(expression);
        return member !== null && STRING_ROOTS.has(member);
      }

      if (expression.type === 'Identifier') {
        // `import { String as SchemaString } from "effect/Schema"` — the leaf itself.
        const member = memberOfIdentifier(expression, expression.name);
        if (member !== null) return STRING_ROOTS.has(member);
        const declarator = localDeclarator(expression, expression.name);
        if (declarator === null || seen.has(declarator.start)) return false;
        seen.add(declarator.start);
        return isStringRooted(declarator.init, seen, depth + 1);
      }

      if (expression.type !== 'CallExpression') return false;
      const callee = unwrap(expression.callee);

      // `pipe(Schema.String, Schema.brand('X'))` — checked before member resolution so that a
      // `pipe` binding can never be mistaken for a Schema combinator of the same name.
      if (
        callee.type === 'Identifier' &&
        locals.pipe.has(callee.name) &&
        resolvesToImport(callee, callee.name)
      ) {
        if (expression.arguments.some((argument) => isBrandExpression(argument))) return false;
        if (!expression.arguments.slice(1).every((argument) => isTransparentStep(argument)))
          return false;
        const first = expression.arguments[0];
        if (first === undefined || first.type === 'SpreadElement') return false;
        return isStringRooted(first, seen, depth + 1);
      }

      // `Schema.NullOr(inner)`, `Schema.optionalKey(inner)`, `Schema.Array(inner)`, bare `NullOr(inner)`, ...
      const wrapper = schemaMember(callee);
      if (wrapper !== null) {
        if (BRAND_MEMBERS.has(wrapper)) return false;
        if (!TRANSPARENT_WRAPPERS.has(wrapper)) return false;
        const first = expression.arguments[0];
        if (first === undefined || first.type === 'SpreadElement') return false;
        return isStringRooted(first, seen, depth + 1);
      }

      // `inner.check(...)` / `inner.annotate(...)` / `inner.pipe(Schema.brand('X'))` / `inner.brand('X')`.
      if (callee.type === 'MemberExpression') {
        const method = memberName(callee);
        if (method === null) return false;
        if (BRAND_MEMBERS.has(method)) return false;
        if (!TRANSPARENT_METHODS.has(method)) return false;
        if (expression.arguments.some((argument) => isBrandExpression(argument))) return false;
        if (
          method === 'pipe' &&
          !expression.arguments.every((argument) => isTransparentStep(argument))
        )
          return false;
        return isStringRooted(callee.object, seen, depth + 1);
      }

      return false;
    };

    /** Is `node` an argument of a `Schema.Struct` / `Schema.TaggedError<E>()('T', ...)` style call? */
    const isSchemaConstructorArgument = (node: ESTree.Node): boolean => {
      const parent = node.parent;
      if (parent === null || parent === undefined) return false;
      if (parent.type !== 'CallExpression') return false;
      if (!parent.arguments.some((argument) => argument === node)) return false;
      // Walk the callee chain: `Schema.TaggedError<E>()` is a CallExpression callee.
      let callee: ESTree.Node = unwrap(parent.callee);
      for (let guard = 0; guard < 8; guard += 1) {
        const member = schemaMember(callee);
        if (member !== null) return FIELD_BAG_CONSTRUCTORS.has(member);
        if (callee.type !== 'CallExpression') return false;
        callee = unwrap(callee.callee);
      }
      return false;
    };

    /**
     * A `const someFields = { ... }` object that this file later hands to a Schema constructor —
     * either spread into another field bag (`...apiKeyStatusFields`) or passed directly
     * (`Schema.TaggedError<E>()('T', errorFields)`).
     */
    const isSpreadFieldBag = (node: ESTree.Node): boolean => {
      let current: ESTree.Node = node;
      // `{ ... } as const` keeps the declarator one level up.
      while (
        current.parent !== null &&
        current.parent !== undefined &&
        UNWRAPPABLE.has(current.parent.type)
      ) {
        current = current.parent;
      }
      const parent = current.parent;
      if (parent === null || parent === undefined) return false;
      if (parent.type !== 'VariableDeclarator' || parent.init !== current) return false;
      if (parent.id.type !== 'Identifier') return false;
      const name = parent.id.name;
      if (bagIdentifierNames.has(name)) return true;
      return /(?:Fields|fields)$/u.test(name) && spreadNames.has(name);
    };

    const isFieldBag = (node: ESTree.ObjectExpression): boolean => {
      let current: ESTree.Node = node;
      while (
        current.parent !== null &&
        current.parent !== undefined &&
        UNWRAPPABLE.has(current.parent.type)
      ) {
        current = current.parent;
      }
      return isSchemaConstructorArgument(current) || isSpreadFieldBag(node);
    };

    const propertyKey = (property: ESTree.ObjectProperty): string | null => {
      const key = property.key;
      if (!property.computed && key.type === 'Identifier') return key.name;
      if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
      return null;
    };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
        locals = collectSchemaLocals(node, bindings, options.reexportModules);
      },
      ObjectExpression(node) {
        objects.push(node);
      },
      CallExpression(node) {
        calls.push(node);
      },
      SpreadElement(node) {
        const argument = unwrap(node.argument);
        if (argument.type === 'Identifier') spreadNames.add(argument.name);
      },
      VariableDeclarator(node) {
        declarators.push(node);
      },
      'Program:exit'() {
        if (locals.schema.size === 0 && locals.barrel.size === 0 && locals.members.size === 0)
          return;
        collectDestructuredMembers();

        // A field bag handed to a constructor by name: `Schema.TaggedError<E>()('T', errorFields)`.
        for (const call of calls) {
          for (const argument of call.arguments) {
            const value = unwrap(argument);
            if (value.type !== 'Identifier') continue;
            if (isSchemaConstructorArgument(argument)) bagIdentifierNames.add(value.name);
          }
        }

        // Pass 1: shared identifier schemas (`const TenantIdSchema = Schema.String...`).
        const reportedDeclarators = new Set<number>();
        const reports: Array<{
          readonly node: ESTree.Node;
          readonly messageId: 'unbrandedField' | 'unbrandedSchema';
          readonly data: Record<string, string>;
          readonly start: number;
        }> = [];

        for (const declarator of declarators) {
          if (declarator.id.type !== 'Identifier') continue;
          const declaration = declarator.parent;
          if (declaration === null || declaration === undefined) continue;
          if (declaration.type !== 'VariableDeclaration') continue;
          const owner = declaration.parent;
          const moduleLevel =
            owner !== null &&
            owner !== undefined &&
            (owner.type === 'Program' || owner.type === 'ExportNamedDeclaration');
          if (!moduleLevel) continue;
          const name = declarator.id.name;
          if (!schemaNamePattern.test(name)) continue;
          if (!isStringRooted(declarator.init, new Set(), 0)) continue;
          reportedDeclarators.add(declarator.start);
          reports.push({
            data: { brand: brandName(name), name },
            messageId: 'unbrandedSchema',
            node: declarator.id,
            start: declarator.start,
          });
        }

        // Pass 2: identifier fields inside Schema field bags.
        for (const object of objects) {
          if (!isFieldBag(object)) continue;
          for (const property of object.properties) {
            if (property.type !== 'Property') continue;
            if (property.kind !== 'init' || property.method) continue;
            const key = propertyKey(property);
            if (key === null || !keyPattern.test(key)) continue;
            const value = unwrap(property.value);
            // A value that resolves to an in-file declarator this rule already reports is the
            // same defect: fixing the shared schema fixes the field. Report the source only.
            if (value.type === 'Identifier') {
              const declarator = localDeclarator(value, value.name);
              if (declarator !== null && reportedDeclarators.has(declarator.start)) continue;
            }
            if (!isStringRooted(property.value, new Set(), 0)) continue;
            reports.push({
              data: { brand: brandName(key), key },
              messageId: 'unbrandedField',
              node: property,
              start: property.start,
            });
          }
        }

        reports.sort((left, right) => left.start - right.start);
        for (const report of reports) {
          context.report({ data: report.data, messageId: report.messageId, node: report.node });
        }
      },
    };
  },
});
