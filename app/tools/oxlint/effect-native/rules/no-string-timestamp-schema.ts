import { optionRecord } from '../shared/options.ts';
/**
 * Audit findings: **A2** — "Make Schema the sole authority for contracts and domain models" — and
 * **B5** — "Adopt Effect's ADTs and temporal model consistently"
 * (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`).
 *
 * A2 asks explicitly to "Use `Schema.DateTimeUtc` and explicit date-only codecs instead of generic
 * strings and hand calendar arithmetic"; B5 lists timestamps among the highest-value targets for the
 * Effect temporal model. Today `createdAt` / `updatedAt` / `revokedAt` / `expiresAt` / `occurredAt`
 * are `Schema.String`, the Contacts contract regex-validates an ISO timestamp and hand-rolls a
 * leap-year date-only schema (`verticals/contacts/shared/apis/customer-detail.ts`), and DTO
 * interfaces in routes and services declare `createdAt: string`. Nothing in the type system stops a
 * local-time string, an epoch string, a `Date.toString()` or a differently-shaped ISO string from
 * flowing through those seams, and every consumer re-parses the string by hand.
 *
 * What is detected
 * 1. **Temporal fields in a Schema field bag.** A property whose key matches `temporalKeyPattern`
 *    (default: `At` / `Timestamp` / `Date`, calendar-event `On` keys and explicit validity bounds)
 *    and whose value is *string-rooted*. Generic `cursorAfter`, `sortOn` and `displayTime` are not
 *    temporal evidence; broader organization-specific conventions can opt in with the pattern. Field bags are resolved
 *    exactly as in `no-unbranded-identifier-schema`: the object arguments of `Schema.Struct`,
 *    `Schema.TaggedStruct`, `Schema.TaggedError<E>()('T', {...})`, `Schema.TaggedRequest`,
 *    `Schema.Class`, `Schema.TaggedClass`, `Schema.ErrorClass`, `Schema.Record`, plus any shared
 *    column object spread — transitively — into one of those. What makes an object a field bag is the
 *    *use*, not its name, so `{ ...auditColumns }` is walked exactly like `{ ...auditFields }`.
 *    Namespace resolution goes through the real `effect` import bindings, so aliases
 *    (`import { Schema as S }`), submodule namespace imports (`import * as Schema from
 *    "effect/Schema"`), direct member imports (`import { Struct, String as SchemaString } from
 *    "effect/Schema"`), the root barrel (`import * as Effect from "effect"` → `Effect.Schema.Struct`),
 *    computed access (`Schema["Struct"]`, `` Schema[`Struct`] ``) and optional chaining all work, and a
 *    locally shadowed `Schema` / `Struct` is ignored. `schemaModules` also covers the framework
 *    re-exports this repository actually imports from — `@modern-js/plugin-bff/effect-client` and
 *    `…/effect-edge` — which is where the shell and Contacts HTTP contracts live.
 * 2. **Hand-rolled temporal string codecs.** `Schema.isPattern(...)` / `Schema.pattern(...)` (also
 *    when imported directly) whose RegExp source spells out a calendar date or an ISO time-of-day.
 *    The source is normalised to a shape before it is probed — every digit matcher collapses to one
 *    `D` — so `\d{4}-\d{2}-\d{2}`, `[0-9]{4}-[0-9]{2}-[0-9]{2}`, `\d\d\d\d-\d\d-\d\d`, `(?:\d){4}-…`
 *    and `\d{4}\-\d{2}\-\d{2}` are all the same pattern, as are `T\d{2}:` and `[T ][0-9]{2}:`. The
 *    enclosing `.check(...)` / `.pipe(...)` call is reported, so the whole hand-rolled codec is
 *    flagged once. Sources behind an in-file `const`, `new RegExp(...)`, a template literal or a `+`
 *    concatenation are followed.
 * 3. **Temporal members of TS DTO types** (`includeTypeMembers`, default `true`): a
 *    `TSPropertySignature` inside a `TSInterfaceBody` or `TSTypeLiteral` whose key matches
 *    `temporalKeyPattern` and whose annotation is string-rooted — `string`, a union of `string` with
 *    `null` / `undefined`, an in-file `type IsoTimestamp = string` alias chain, or a branded
 *    `string & { readonly _brand: … }`. These are the interface-first DTOs A2 wants replaced by
 *    `Schema.Type<typeof …>`. This lane deliberately does not require an `effect` import — the
 *    route/page DTOs the audit cites import nothing from `effect`.
 *
 * "String-rooted" is true for `Schema.String`, `NonEmptyString`, `Trim`, `UUID`, `ULID`, ...; through
 * `.check(...)`, `.annotate(...)`, `.pipe(...)`, `.brand(...)` chains; through `Schema.NullOr` /
 * `UndefinedOr` / `NullishOr` / `optional` / `optionalKey` / `Array` / `mutable` wrappers; through
 * `pipe(Schema.String, ...)`; and through a bare identifier that resolves to an **in-file** `const`
 * with a string-rooted initialiser. A brand does *not* rescue a timestamp: a branded string is still
 * a string, not a `DateTime.Utc`.
 *
 * What is deliberately allowed
 * - `Schema.DateTimeUtc`, `Schema.DateTimeUtcFromDate`, `Schema.DateTimeUtcFromNumber`, `Schema.Date`,
 *   `Schema.ValidDateFromSelf`, an explicit date-only codec, `Schema.OptionFromNullOr(Schema.DateTimeUtc)`
 *   — none of these are string-rooted.
 * - `interface Row { readonly createdAt: Date }` / `DateTime.Utc` / a branded date-only type: only a
 *   literal `string` annotation (optionally unioned with `null` / `undefined`) is reported.
 * - Non-temporal keys (`format`, `name`, `timeZoneName`, `dateFormat`, …) and non-string values
 *   (`Schema.Number` epochs are an A2 concern for a different rule, not this one).
 * - **Imported** schemas: `{ createdAt: ContactsIsoTimestampSchema }` where the schema comes from
 *   another module is not reported here — the codec is reported in the module that declares it.
 * - The declaration/usage pair is reported **once**: a field whose value resolves to an in-file
 *   codec that this rule already reports (lane 2) is skipped. Fixing the shared codec fixes every
 *   consumer, so the count reflects real work, not references.
 * - Everything outside `include` (default `apps/** verticals/** packages/** scripts/**`) or matched by
 *   `ignore`. Tests are in scope by default (`ignoreTests: false`) because fixtures encode the same
 *   contracts; set `ignoreTests: true` to narrow.
 * - Nothing in the audit's "Existing patterns to preserve" or D-tier list touches temporal modelling:
 *   correct Drizzle JSONB, HttpApi serialization, `Layer.orDie` at a startup root and framework
 *   Promise adapters are all outside this rule's surface.
 *
 * Known limitation: key-name heuristics without a type checker. A pre-formatted display string
 * ending in `Date` can still match; configure `ignoreKeyPattern` rather than changing its semantics.
 * Unknown pipe steps are not assumed transparent, and generic/cross-file type aliases are not inferred. Report-only; this rule never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

import {
  memberName as staticMemberName,
  unwrapNode,
  skipWrappers,
  keyName,
} from '../shared/ast.ts';
import { resolveVariable } from '../shared/bindings.ts';
import { importedName } from '../shared/imports.ts';
import { isSchemaConstructorArgument as isConstructorArgument } from '../shared/schema-constructor.ts';
import { stringArray, stringOption, safeRegExp } from '../shared/options.ts';

const SCHEMA_NAMESPACE = 'Schema';

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**', 'scripts/**'];
const DEFAULT_IGNORE: string[] = [];
// Generic On/Time/After suffixes also name sort keys, labels and pagination cursors. The audit
// does not authorize changing those into instants; require a calendar/event vocabulary instead.
const DEFAULT_TEMPORAL_KEY_PATTERN =
  '(?:At|Timestamp|Date)$|^(?:established|dissolved|born|died|issued|expires|expired|created|updated|deleted|published|placed|shipped|delivered|started|ended|completed)On$|^(?:notBefore|notAfter|validSince|validUntil|expiry|expires)$';
const DEFAULT_IGNORE_KEY_PATTERN = '';
/**
 * Enclosing type names that are label bags, not contracts. Every i18n dictionary in this repository is
 * named `*Copy` (`CustomerDetailCopy`, `ContactDetailCopy`, `CustomersListCopy`), and a translated
 * column label such as "Created" cannot be modelled as a `DateTime.Utc`. Narrow allowlist, matched
 * against the interface / type-alias name only.
 */
const DEFAULT_IGNORE_TYPE_PATTERN = '(?:Copy|Labels?|Messages|Strings|Translations?|I18n)$';
/**
 * A member named `<key>Iso` / `<key>Utc` / `<key>Raw` / `<key>Timestamp` beside `<key>` means the type
 * carries the machine value separately and `<key>` is its rendered projection (`<time
 * dateTime={createdAtIso}>{createdAt}</time>`). The projection is a display string, not a contract.
 */
const PROJECTION_SUFFIXES = ['Iso', 'IsoString', 'Raw', 'Timestamp', 'Utc'];
/**
 * Modules that re-export Effect's `Schema`. The repository's BFF contracts import `Schema` from
 * `@modern-js/plugin-bff/effect-client` (and `…/effect-edge`), which is the same `effect` Schema
 * behind a framework barrel; without these the shell/contacts API contracts would be invisible.
 */
const DEFAULT_SCHEMA_MODULES = ['effect', 'effect/**', '@modern-js/plugin-bff/effect-*'];
/** Of those, the ones whose namespace import is a *barrel* (`import * as X` → `X.Schema.Struct`). */
const SCHEMA_SUBMODULE = /(?:^|\/)Schema$/u;

/**
 * Digit atoms a hand-rolled temporal regex may use: `\d`, `[0-9]`, `[\d]`, `[0-9]` written out.
 * `[0-9]` is at least as common as `\d` in this repository's contracts, so the raw source is
 * normalised before it is probed instead of matching one spelling literally.
 */
const DIGIT_ATOM_SOURCE = String.raw`(?:\\d|\[0-9\]|\[\\d\]|\[0123456789\])`;
const QUANTIFIED_DIGIT = new RegExp(`${DIGIT_ATOM_SOURCE}\\{(\\d{1,2})(?:,\\d{0,2})?\\}`, 'gu');
const BARE_DIGIT = new RegExp(DIGIT_ATOM_SOURCE, 'gu');
/** `(?:D){4}` / `(DD){3}` — a repeated group of already-normalised digits. */
const GROUPED_DIGIT_RUN = /\((?:\?:)?(D+)\)\{(\d{1,2})(?:,\d{0,2})?\}/gu;
/** A redundant escape before punctuation (`\-`, `\:`, `\/`) changes nothing about the shape. */
const REDUNDANT_ESCAPE = /\\([^\p{L}\p{N}_])/gu;

/** Normalised RegExp shapes that spell out a calendar date or an ISO time-of-day by hand. */
const CALENDAR_DATE_SOURCE = /DDDD-DD-DD/u;
const ISO_TIME_SOURCE = /T[^\p{L}\p{N}]{0,3}DD:/u;

/**
 * Rewrite a RegExp source into a shape-only form where every digit matcher is one `D`, so that
 * `\d{4}-\d{2}-\d{2}`, `[0-9]{4}-[0-9]{2}-[0-9]{2}`, `\d\d\d\d-\d\d-\d\d` and `\d{4}\-\d{2}\-\d{2}`
 * all normalise to the same `DDDD-DD-DD`.
 */
function normaliseRegexSource(source: string): string {
  const repeat = (run: string, count: string): string => run.repeat(Math.min(Number(count), 12));
  let text = source.replace(QUANTIFIED_DIGIT, (_match, count: string) => repeat('D', count));
  text = text.replace(BARE_DIGIT, 'D');
  text = text.replace(GROUPED_DIGIT_RUN, (_match, run: string, count: string) =>
    repeat(run, count),
  );
  return text.replace(REDUNDANT_ESCAPE, '$1');
}

/** `Schema.<X>` combinators whose object arguments are field bags (`{ createdAt: ... }`). */
const FIELD_BAG_CONSTRUCTORS = new Set([
  'Class',
  'ErrorClass',
  'Record',
  'Struct',
  'TaggedClass',
  'TaggedError',
  'TaggedRequest',
  'TaggedStruct',
]);

/** `Schema.<X>` leaves whose encoded/decoded type is a plain, unparsed string. */
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

/** `Schema.<X>(inner)` wrappers that keep the inner schema's decoded shape. */
const TRANSPARENT_WRAPPERS = new Set([
  'Array',
  'NonEmptyArray',
  'NullishOr',
  'NullOr',
  'ReadonlyArray',
  'UndefinedOr',
  'mutable',
  'optional',
  'optionalKey',
]);

/**
 * Instance methods that refine/annotate without turning a string into a `DateTime.Utc`. `brand` is
 * included on purpose: a branded ISO string is still a string.
 */
const TRANSPARENT_METHODS = new Set(['annotate', 'annotateKey', 'brand', 'check', 'pipe']);

/** `Schema.isPattern` / `Schema.pattern` — the regex-validated hand-rolled codec entry points. */
const PATTERN_MEMBERS = new Set(['isPattern', 'pattern']);

const UNWRAPPABLE = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

const NULLISH_KEYWORDS = new Set(['TSNullKeyword', 'TSUndefinedKeyword']);

/** Records whether a string-rooted chain travelled through a codec this rule already reported. */
interface StringRootTrace {
  viaReportedCodec: boolean;
}

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly temporalKeyPattern: string;
  readonly ignoreKeyPattern: string;
  readonly ignoreTypePattern: string;
  readonly includeTypeMembers: boolean;
  readonly ignoreTests: boolean;
  readonly schemaModules: readonly string[];
}

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    ignoreKeyPattern: stringOption(record.ignoreKeyPattern, DEFAULT_IGNORE_KEY_PATTERN),
    ignoreTests: record.ignoreTests === true,
    ignoreTypePattern: stringOption(record.ignoreTypePattern, DEFAULT_IGNORE_TYPE_PATTERN),
    include: stringArray(record.include, DEFAULT_INCLUDE),
    includeTypeMembers: record.includeTypeMembers !== false,
    schemaModules: stringArray(record.schemaModules, DEFAULT_SCHEMA_MODULES),
    temporalKeyPattern: stringOption(
      record.temporalKeyPattern,
      DEFAULT_TEMPORAL_KEY_PATTERN,
      false,
    ),
  };
}

function memberName(node: ESTree.MemberExpression): string | null {
  return staticMemberName(node, { templates: true, rawTemplates: true });
}

function unwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { wrappers: UNWRAPPABLE, maxDepth: 16 });
}

interface SchemaLocals {
  /** Locals that stand for the `Schema` namespace itself. */
  readonly schema: ReadonlySet<string>;
  /** Locals that stand for the whole `effect` barrel (`import * as Effect from "effect"`). */
  readonly barrel: ReadonlySet<string>;
  /**
   * Locals bound by a direct member import of the Schema module — `import { Struct, String as
   * SchemaString, NullOr, isPattern } from "effect/Schema"` — mapped to the exported name. These are
   * exactly the same combinators as `Schema.Struct` / `Schema.String`, just without the namespace.
   */
  readonly members: ReadonlyMap<string, string>;
  /** Locals bound to `pipe` from `effect` / `effect/Function`. */
  readonly pipe: ReadonlySet<string>;
}

function collectSchemaLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  schemaModules: readonly string[],
): SchemaLocals {
  const schema = new Set<string>();
  const barrel = new Set<string>();
  const members = new Map<string, string>();
  const pipe = new Set<string>();
  // Base pass: the shared `effect` import tracker (aliases, `effect/*` namespace imports).
  for (const [local, namespace] of bindings.namespaces) {
    if (namespace === SCHEMA_NAMESPACE) schema.add(local);
    if (namespace === 'pipe') pipe.add(local);
  }
  const collectSpecifier = (
    specifier: ESTree.ImportDeclaration['specifiers'][number],
    isSchemaSubmodule: boolean,
  ): void => {
    if (specifier.type === 'ImportNamespaceSpecifier') {
      (isSchemaSubmodule ? schema : barrel).add(specifier.local.name);
      return;
    }
    if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') return;
    const imported = importedName(specifier);
    if (imported === SCHEMA_NAMESPACE) schema.add(specifier.local.name);
    else if (imported === 'pipe') pipe.add(specifier.local.name);
    else if (isSchemaSubmodule) members.set(specifier.local.name, imported);
  };
  const modulePatterns = schemaModules.map((glob) => globToRegExp(glob));
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
    if (!modulePatterns.some((pattern) => pattern.test(statement.source.value))) continue;
    for (const specifier of statement.specifiers)
      collectSpecifier(specifier, SCHEMA_SUBMODULE.test(statement.source.value));
  }
  return { barrel, members, pipe, schema };
}

function lookupVariable(context: Context, identifier: ESTree.Node, name: string): Variable | null {
  return resolveVariable(context, name, identifier);
}

/** `Schema.DateTimeUtc` for a timestamp key, an explicit date-only codec for a calendar key. */
function replacementFor(key: string): string {
  return /(?:^|[a-z])(?:Date|On|Since|Until|Before|After|Expiry)$/u.test(key)
    ? 'Schema.DateTimeUtc (or an explicit date-only codec when the value really is calendar-only)'
    : 'Schema.DateTimeUtc';
}

export const rule = defineRule({
  meta: {
    defaultOptions: [
      {
        ignore: DEFAULT_IGNORE,
        ignoreKeyPattern: DEFAULT_IGNORE_KEY_PATTERN,
        ignoreTests: false,
        ignoreTypePattern: DEFAULT_IGNORE_TYPE_PATTERN,
        include: DEFAULT_INCLUDE,
        includeTypeMembers: true,
        schemaModules: DEFAULT_SCHEMA_MODULES,
        temporalKeyPattern: DEFAULT_TEMPORAL_KEY_PATTERN,
      },
    ],
    docs: {
      description:
        'Audit A2 + B5: timestamps and calendar dates must be modelled with `Schema.DateTimeUtc` ' +
        '(or `Schema.DateTimeUtcFromDate` for Drizzle rows) and explicit date-only codecs, never as ' +
        '`Schema.String`, regex-validated ISO strings, hand-rolled leap-year checks, or `createdAt: string` ' +
        'DTO interfaces.',
    },
    messages: {
      stringTemporalField:
        'Temporal field `{{key}}` is modelled as a string Schema, so local time, epoch strings and ' +
        'differently-shaped ISO strings all type-check and every consumer re-parses by hand. Use ' +
        '{{replacement}} and derive the TypeScript type from the Schema (audit A2, B5).',
      handRolledTemporalCodec:
        'Hand-rolled temporal string codec: this `check` validates a {{kind}} with a regular expression ' +
        'instead of decoding it. Use `Schema.DateTimeUtc` (or `Schema.DateTimeUtcFromDate` for Drizzle rows, ' +
        'or an explicit date-only codec) so the decoded value is a real `DateTime.Utc` rather than a string ' +
        'that merely looks like one (audit A2, B5).',
      stringTemporalMember:
        'DTO member `{{key}}` is declared as `string`. Interface-first temporal DTOs are exactly what A2 ' +
        'removes: model the field once as {{replacement}} and derive this type with ' +
        '`Schema.Type<typeof …>` instead of re-declaring it as a string (audit A2, B5).',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          ignore: { items: { type: 'string' }, type: 'array' },
          ignoreKeyPattern: { type: 'string' },
          ignoreTests: { type: 'boolean' },
          ignoreTypePattern: { type: 'string' },
          include: { items: { type: 'string' }, type: 'array' },
          includeTypeMembers: { type: 'boolean' },
          schemaModules: { items: { type: 'string' }, type: 'array' },
          temporalKeyPattern: { type: 'string' },
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

    const keyPattern = safeRegExp(options.temporalKeyPattern, DEFAULT_TEMPORAL_KEY_PATTERN);
    const ignoreKey =
      options.ignoreKeyPattern.length > 0 ? safeRegExp(options.ignoreKeyPattern, '$^') : null;
    const ignoreType =
      options.ignoreTypePattern.length > 0 ? safeRegExp(options.ignoreTypePattern, '$^') : null;

    const isTemporalKey = (key: string): boolean => {
      if (!keyPattern.test(key)) return false;
      return ignoreKey === null || !ignoreKey.test(key);
    };

    let bindings: EffectBindings = { importsEffect: false, namespaces: new Map() };
    let locals: SchemaLocals = {
      barrel: new Set(),
      members: new Map(),
      pipe: new Set(),
      schema: new Set(),
    };

    /** Declarator starts whose initialiser already produced a hand-rolled-codec report (lane 2). */
    const reportedCodecDeclarators = new Set<number>();

    const objects: ESTree.ObjectExpression[] = [];
    const patternCalls: ESTree.CallExpression[] = [];
    const typeMembers: ESTree.TSPropertySignature[] = [];
    /** `{ ...auditColumns }` edges: the object doing the spreading and the identifier spread into it. */
    const spreads: Array<{
      readonly container: ESTree.ObjectExpression;
      readonly id: ESTree.Node;
    }> = [];
    /** Identifiers handed straight to a field-bag constructor: `Schema.TaggedError<E>()('T', fields)`. */
    const bagIdentifiers: ESTree.Node[] = [];

    /** `true` when the namespace identifier still resolves to its `effect` import (no local shadow). */
    const resolvesToImport = (node: ESTree.Node, name: string): boolean => {
      const variable = lookupVariable(context, node, name);
      if (variable === null || variable.defs.length === 0) return true;
      return variable.defs.some(
        (definition) =>
          definition.type === 'ImportBinding' &&
          definition.parent?.type === 'ImportDeclaration' &&
          definition.parent.importKind !== 'type' &&
          (definition.node.type !== 'ImportSpecifier' || definition.node.importKind !== 'type'),
      );
    };

    /** `Schema.Struct` / `S.Struct` / `Effect.Schema.Struct` / `Schema["Struct"]` → `"Struct"`. */
    const schemaMember = (node: ESTree.Node): string | null => {
      if (node.type !== 'MemberExpression') return null;
      const member = memberName(node);
      if (member === null) return null;
      const object = unwrap(node.object);
      if (object.type === 'Identifier') {
        if (!locals.schema.has(object.name)) return null;
        return resolvesToImport(object, object.name) ? member : null;
      }
      return barrelSchemaMember(object, member);
    };

    const barrelSchemaMember = (object: ESTree.Node, member: string): string | null => {
      if (object.type !== 'MemberExpression') return null;
      if (memberName(object) !== SCHEMA_NAMESPACE) return null;
      const root = unwrap(object.object);
      if (root.type !== 'Identifier') return null;
      if (!locals.barrel.has(root.name)) return null;
      return resolvesToImport(root, root.name) ? member : null;
    };

    /**
     * The Schema export an expression denotes, whether written through the namespace
     * (`Schema.Struct`, `Effect.Schema.Struct`, `Schema["Struct"]`) or imported directly
     * (`import { Struct } from "effect/Schema"`).
     */
    const schemaRef = (node: ESTree.Node): string | null => {
      const expression = unwrap(node);
      if (expression.type === 'Identifier') {
        const member = locals.members.get(expression.name);
        if (member === undefined) return null;
        return resolvesToImport(expression, expression.name) ? member : null;
      }
      return schemaMember(expression);
    };

    /** The in-file `const` declarator an identifier resolves to, or `null` for imports/params/globals. */
    const localDeclarator = (node: ESTree.Node, name: string): ESTree.VariableDeclarator | null => {
      const variable = lookupVariable(context, node, name);
      if (variable === null || variable.defs.length !== 1) return null;
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return null;
      const definition = variable.defs[0];
      if (definition === undefined || definition.type !== 'Variable') return null;
      const declarator = definition.node;
      return declarator.type === 'VariableDeclarator' ? declarator : null;
    };

    /**
     * A schema expression whose decoded value is still a plain string — no `DateTimeUtc` anywhere in
     * the chain. `seen` guards mutually-referential `const`s.
     */
    const isStringRooted = (
      node: ESTree.Node | null,
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      if (node === null || depth > 24) return false;
      const expression = unwrap(node);

      if (expression.type === 'MemberExpression') {
        const member = schemaMember(expression);
        return member !== null && STRING_ROOTS.has(member);
      }

      if (expression.type === 'Identifier') return stringIdentifier(expression, seen, depth, trace);
      return stringCall(expression, seen, depth, trace);
    };

    const stringIdentifier = (
      expression: Extract<ESTree.Node, { type: 'Identifier' }>,
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      // `import { String as SchemaString } from "effect/Schema"` — the same leaf, no namespace.
      const imported = locals.members.get(expression.name);
      if (imported !== undefined && resolvesToImport(expression, expression.name)) {
        return STRING_ROOTS.has(imported);
      }
      const declarator = localDeclarator(expression, expression.name);
      if (declarator === null || seen.has(declarator.start)) return false;
      seen.add(declarator.start);
      if (reportedCodecDeclarators.has(declarator.start)) trace.viaReportedCodec = true;
      return isStringRooted(declarator.init, seen, depth + 1, trace);
    };

    const stringCall = (
      expression: ESTree.Node,
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      if (expression.type !== 'CallExpression') return false;
      const callee = unwrap(expression.callee);

      // `Schema.NullOr(inner)`, `Schema.optionalKey(inner)`, `Schema.Array(inner)`, `NullOr(inner)`.
      const wrapper = schemaRef(callee);
      if (wrapper !== null) {
        if (!TRANSPARENT_WRAPPERS.has(wrapper)) return false;
        const first = expression.arguments[0];
        if (first === undefined || first.type === 'SpreadElement') return false;
        return isStringRooted(first, seen, depth + 1, trace);
      }

      if (callee.type === 'MemberExpression')
        return stringMethod(callee, expression.arguments, seen, depth, trace);

      return importedStringPipeline(callee, expression.arguments, seen, depth, trace);
    };
    const importedStringPipeline = (
      callee: ESTree.Node,
      args: readonly ESTree.Node[],
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      // `pipe(Schema.String, Schema.brand('X'))`.
      if (
        callee.type === 'Identifier' &&
        locals.pipe.has(callee.name) &&
        resolvesToImport(callee, callee.name)
      ) {
        const first = args[0];
        if (first === undefined || first.type === 'SpreadElement') return false;
        return stringPipeline(first, args.slice(1), seen, depth, trace);
      }

      return false;
    };

    const stringMethod = (
      callee: ESTree.MemberExpression,
      args: readonly ESTree.Node[],
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      const method = memberName(callee);
      if (method === null || !TRANSPARENT_METHODS.has(method)) return false;
      if (method === 'pipe') return stringPipeline(callee.object, args, seen, depth, trace);
      return isStringRooted(callee.object, seen, depth + 1, trace);
    };

    /** Composition can change decoded types; never assume an arbitrary pipe step preserves strings. */
    const stringPipeline = (
      source: ESTree.Node,
      steps: readonly ESTree.Node[],
      seen: Set<number>,
      depth: number,
      trace: StringRootTrace,
    ): boolean => {
      let string = isStringRooted(source, seen, depth + 1, trace);
      for (const raw of steps) {
        const step = unwrap(raw);
        const member = schemaRef(step.type === 'CallExpression' ? step.callee : step);
        if (member === 'decodeTo' && step.type === 'CallExpression') {
          const target = step.arguments[0];
          string = target !== undefined && isStringRooted(target, new Set(seen), depth + 1, trace);
        } else if (
          member === null ||
          (!TRANSPARENT_WRAPPERS.has(member) &&
            !['annotate', 'annotateKey', 'brand', 'check', 'encodeTo'].includes(member))
        ) {
          return false;
        }
      }
      return string;
    };

    /** Is `node` an argument of a `Schema.Struct` / `Schema.TaggedError<E>()('T', ...)` style call? */
    const isSchemaConstructorArgument = (node: ESTree.Node): boolean =>
      isConstructorArgument(node, schemaRef, FIELD_BAG_CONSTRUCTORS, unwrap);

    /** The object literal an identifier resolves to: `const auditColumns = { ... }`. */
    const declaredObject = (node: ESTree.Node): ESTree.ObjectExpression | null => {
      const expression = unwrap(node);
      if (expression.type !== 'Identifier') return null;
      const declarator = localDeclarator(expression, expression.name);
      if (declarator === null || declarator.init === null || declarator.init === undefined)
        return null;
      const init = unwrap(declarator.init);
      return init.type === 'ObjectExpression' ? init : null;
    };

    /**
     * Every object literal this file eventually hands to a Schema field-bag constructor: the direct
     * arguments, the identifiers passed as arguments, and — transitively — the shared column objects
     * spread into any of them. The *target* is what makes an object a field bag, so a shared bag is
     * found whatever it is called (`auditColumns` as much as `auditFields`).
     */
    const collectFieldBags = (): ReadonlySet<number> => {
      const bags = new Set<number>();
      const queue: ESTree.ObjectExpression[] = [];
      const enqueue = (object: ESTree.ObjectExpression | null): void => {
        if (object === null || bags.has(object.start)) return;
        bags.add(object.start);
        queue.push(object);
      };
      for (const object of objects) {
        const current = skipWrappers(object, UNWRAPPABLE).node;
        if (isSchemaConstructorArgument(current)) enqueue(object);
      }
      for (const identifier of bagIdentifiers) enqueue(declaredObject(identifier));
      // Each pop happens at most once per object literal (`enqueue` de-duplicates), so the bound is
      // the number of objects in the file; the guard only makes non-termination impossible.
      for (let guard = 0; guard <= objects.length && queue.length > 0; guard += 1) {
        const container = queue.pop();
        if (container === undefined) break;
        for (const spread of spreads) {
          if (spread.container.start !== container.start) continue;
          enqueue(declaredObject(spread.id));
        }
      }
      return bags;
    };

    const propertyKey = (property: ESTree.ObjectProperty): string | null =>
      keyName(property.key, property.computed, { templates: false });

    const signatureKey = (signature: ESTree.TSPropertySignature): string | null =>
      keyName(signature.key, signature.computed, { templates: false });

    const unwrapType = (node: ESTree.Node): ESTree.Node => {
      let current = node;
      for (let guard = 0; guard < 8; guard += 1) {
        if (current.type !== 'TSParenthesizedType') return current;
        const inner = (current as { typeAnnotation?: ESTree.Node }).typeAnnotation;
        if (inner === undefined) return current;
        current = inner;
      }
      return current;
    };

    /**
     * `string`, `string | null` / `string | undefined`, an in-file alias for either
     * (`type IsoTimestamp = string`), or `string & { readonly _brand: … }` — a branded ISO string is
     * still a string, exactly as `Schema.String.pipe(Schema.brand(…))` is in lane 1.
     */
    const isPlainStringType = (node: ESTree.Node, seen: Set<string>, depth: number): boolean => {
      if (depth > 12) return false;
      const type = unwrapType(node);
      if (type.type === 'TSStringKeyword') return true;

      if (type.type === 'TSTypeReference') return stringTypeAlias(type, seen, depth);
      if (type.type === 'TSUnionType')
        return stringTypeMembers(type.types, seen, depth, NULLISH_KEYWORDS);
      if (type.type === 'TSIntersectionType')
        return stringTypeMembers(type.types, seen, depth, new Set(['TSTypeLiteral']));
      return false;
    };

    const stringTypeAlias = (
      type: ESTree.TSTypeReference,
      seen: Set<string>,
      depth: number,
    ): boolean => {
      const name = type.typeName;
      if (name.type !== 'Identifier' || seen.has(name.name)) return false;
      const variable = lookupVariable(context, name, name.name);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (
        definition?.node.type !== 'TSTypeAliasDeclaration' ||
        definition.node.typeParameters != null
      )
        return false;
      seen.add(name.name);
      return isPlainStringType(definition.node.typeAnnotation, seen, depth + 1);
    };

    const stringTypeMembers = (
      members: readonly ESTree.Node[],
      seen: Set<string>,
      depth: number,
      allowed: ReadonlySet<string>,
    ): boolean => {
      let sawString = false;
      for (const member of members) {
        if (isPlainStringType(member, seen, depth + 1)) sawString = true;
        else if (!allowed.has(unwrapType(member).type)) return false;
      }
      return sawString;
    };

    /** The interface / type-alias / class name that owns a type member, for `ignoreTypePattern`. */
    const enclosingTypeName = (node: ESTree.Node): string | null => {
      let current: ESTree.Node | null | undefined = node;
      for (let guard = 0; guard < 8; guard += 1) {
        if (current === null || current === undefined) return null;
        if (
          [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'ClassDeclaration',
            'ClassExpression',
            'VariableDeclarator',
          ].includes(current.type)
        ) {
          const id = (current as { id?: ESTree.Node | null }).id;
          return id?.type === 'Identifier' ? id.name : null;
        }
        current = current.parent;
      }
      return null;
    };

    /**
     * A type literal used as a function-parameter annotation is a *consumer* of a contract, not a
     * declaration of one. The Contacts predicate `(customer: { readonly dissolvedOn: string | null })`
     * is string-typed only because the codec it reads from is, and that codec is reported already.
     */
    const isParameterTypeLiteral = (owner: ESTree.Node): boolean => {
      if (owner.type !== 'TSTypeLiteral') return false;
      const annotation = owner.parent;
      if (annotation === null || annotation === undefined || annotation.type !== 'TSTypeAnnotation')
        return false;
      const target = annotation.parent;
      if (target === null || target === undefined) return false;
      const owner2 = target.parent;
      if (owner2 === null || owner2 === undefined) return false;
      const parameters = (owner2 as { params?: readonly ESTree.Node[] }).params;
      return Array.isArray(parameters) && parameters.some((parameter) => parameter === target);
    };

    /** The declared member names of the interface body / type literal that owns a signature. */
    const siblingKeys = (owner: ESTree.Node): ReadonlySet<string> => {
      const members: readonly ESTree.Node[] =
        owner.type === 'TSInterfaceBody'
          ? owner.body
          : ((owner as { members?: readonly ESTree.Node[] }).members ?? []);
      const names = new Set<string>();
      for (const member of members) {
        if (member.type !== 'TSPropertySignature') continue;
        const name = signatureKey(member);
        if (name !== null) names.add(name);
      }
      return names;
    };

    /** `createdAt` beside `createdAtIso` is the rendered projection of the machine value. */
    const hasProjectionSibling = (key: string, siblings: ReadonlySet<string>): boolean =>
      PROJECTION_SUFFIXES.some((suffix) => siblings.has(`${key}${suffix}`));

    /** The regex source behind `Schema.isPattern(<arg>)`, following in-file `const` regex literals. */
    const regexSource = (node: ESTree.Node, depth: number): string | null => {
      if (depth > 8) return null;
      const expression = unwrap(node);
      if (expression.type === 'Literal') return literalRegexSource(expression);
      if (expression.type === 'NewExpression') {
        const first = expression.arguments[0];
        if (first === undefined || first.type === 'SpreadElement') return null;
        return regexSource(first, depth + 1);
      }
      // `` `^${YEAR}-\\d{2}$` `` and `'^\\d{4}' + '-\\d{2}'` are the same regex, spelled out.
      if (expression.type === 'TemplateLiteral') return templateRegexSource(expression, depth);
      if (expression.type === 'BinaryExpression' && expression.operator === '+')
        return concatenatedRegexSource(expression, depth);
      return identifierRegexSource(expression, depth);
    };

    const identifierRegexSource = (expression: ESTree.Node, depth: number): string | null => {
      if (expression.type === 'Identifier') {
        const declarator = localDeclarator(expression, expression.name);
        if (declarator === null || declarator.init === null) return null;
        return regexSource(declarator.init, depth + 1);
      }
      return null;
    };

    const literalRegexSource = (
      expression: Extract<ESTree.Node, { type: 'Literal' }>,
    ): string | null => {
      const regex = (expression as { regex?: { pattern: string } }).regex;
      if (regex !== undefined) return regex.pattern;
      return typeof expression.value === 'string' ? expression.value : null;
    };

    const templateRegexSource = (expression: ESTree.TemplateLiteral, depth: number): string => {
      let text = '';
      for (const [index, quasi] of expression.quasis.entries()) {
        text += quasi.value.cooked ?? quasi.value.raw;
        const placeholder = expression.expressions[index];
        if (placeholder !== undefined) text += regexSource(placeholder, depth + 1) ?? '';
      }
      return text;
    };

    const concatenatedRegexSource = (
      expression: ESTree.BinaryExpression,
      depth: number,
    ): string | null => {
      const left = regexSource(expression.left, depth + 1);
      const right = regexSource(expression.right, depth + 1);
      return left === null && right === null ? null : `${left ?? ''}${right ?? ''}`;
    };

    /** `Schema.isPattern` / `Schema.pattern` / a directly-imported `isPattern`. */
    const isPatternCallee = (node: ESTree.Node): boolean => {
      const member = schemaRef(node);
      return member !== null && PATTERN_MEMBERS.has(member);
    };

    /** The `const X = <codec>` declarator that owns a reported codec, if any. */
    const enclosingDeclarator = (node: ESTree.Node): ESTree.VariableDeclarator | null => {
      let current: ESTree.Node = node;
      for (let guard = 0; guard < 12; guard += 1) {
        const parent: ESTree.Node | null | undefined = current.parent;
        if (parent === null || parent === undefined) return null;
        if (parent.type === 'VariableDeclarator') return parent.init === current ? parent : null;
        current = parent;
      }
      return null;
    };

    const isTransparentCall = (call: ESTree.CallExpression): boolean => {
      const callee = unwrap(call.callee);
      return (
        callee.type === 'MemberExpression' && TRANSPARENT_METHODS.has(memberName(callee) ?? '')
      );
    };

    /** Walk out of `Schema.isPattern(...)` to the `.check(...)` / `.pipe(...)` that owns it. */
    const enclosingCheck = (node: ESTree.CallExpression): ESTree.Node => {
      let current: ESTree.Node = node;
      for (let guard = 0; guard < 8; guard += 1) {
        const parent: ESTree.Node | null | undefined = current.parent;
        if (parent === null || parent === undefined) return node;
        if (parent.type === 'CallExpression') {
          return isTransparentCall(parent) ? parent : node;
        }
        if (!UNWRAPPABLE.has(parent.type) && parent.type !== 'SpreadElement') return node;
        current = parent;
      }
      return node;
    };

    const reports: Array<{
      readonly node: ESTree.Node;
      readonly messageId:
        | 'stringTemporalField'
        | 'handRolledTemporalCodec'
        | 'stringTemporalMember';
      readonly data: Record<string, string>;
      readonly start: number;
    }> = [];
    /** Spans of hand-rolled temporal codecs already reported — consumers are not re-reported. */
    const codecSpans: Array<{ start: number; end: number }> = [];

    const outerCodecResult = (target: ESTree.Node): ESTree.Node => {
      let result = target;
      for (let depth = 0; depth < 12; depth += 1) {
        const next = outerCodecStep(result);
        if (next === null) break;
        result = next;
      }
      return result;
    };
    const outerCodecStep = (result: ESTree.Node): ESTree.Node | null => {
      const parent = result.parent;
      if (
        parent?.type === 'MemberExpression' &&
        parent.object === result &&
        parent.parent?.type === 'CallExpression' &&
        TRANSPARENT_METHODS.has(memberName(parent) ?? '')
      )
        return parent.parent;
      return enclosingPipe(result, parent);
    };
    const enclosingPipe = (
      result: ESTree.Node,
      parent: ESTree.Node | null | undefined,
    ): ESTree.Node | null => {
      if (
        parent?.type === 'CallExpression' &&
        parent.arguments.some((argument) => argument === result) &&
        parent.callee.type === 'MemberExpression' &&
        memberName(parent.callee) === 'pipe'
      )
        return parent;
      return null;
    };
    const reportCodec = (call: ESTree.CallExpression): void => {
      const first = call.arguments[0];
      if (first === undefined || first.type === 'SpreadElement') return;
      const raw = regexSource(first, 0);
      if (raw === null) return;
      const source = normaliseRegexSource(raw);
      const isCalendarDate = CALENDAR_DATE_SOURCE.test(source);
      const isIsoTime = ISO_TIME_SOURCE.test(source);
      if (!isCalendarDate && !isIsoTime) return;
      const target = enclosingCheck(call);
      const result = outerCodecResult(target);
      if (result !== target && !isStringRooted(result, new Set(), 0, { viaReportedCodec: false }))
        return;
      codecSpans.push({ end: target.end, start: target.start });
      const owner = enclosingDeclarator(target);
      if (owner !== null) reportedCodecDeclarators.add(owner.start);
      reports.push({
        data: { kind: isIsoTime ? 'timestamp' : 'calendar date' },
        messageId: 'handRolledTemporalCodec',
        node: target,
        start: target.start,
      });
    };
    const containsReportedCodec = (node: ESTree.Node): boolean =>
      codecSpans.some((span) => span.start >= node.start && span.end <= node.end);
    const reportField = (property: ESTree.ObjectExpression['properties'][number]): void => {
      if (property.type !== 'Property') return;
      if (property.kind !== 'init' || property.method) return;
      const key = propertyKey(property);
      if (key === null || !isTemporalKey(key)) return;
      // A value that is, or resolves to, an in-file codec this rule already reports is the
      // same defect; fixing the shared codec fixes every field that references it.
      if (containsReportedCodec(property)) return;
      const trace: StringRootTrace = { viaReportedCodec: false };
      if (!isStringRooted(property.value, new Set(), 0, trace)) return;
      if (trace.viaReportedCodec) return;
      reports.push({
        data: { key, replacement: replacementFor(key) },
        messageId: 'stringTemporalField',
        node: property,
        start: property.start,
      });
    };
    const isDisplayMember = (owner: ESTree.Node, key: string): boolean => {
      const typeName = enclosingTypeName(owner);
      if (ignoreType !== null && typeName !== null && ignoreType.test(typeName)) return true;
      return hasProjectionSibling(key, siblingKeys(owner)) || isParameterTypeLiteral(owner);
    };
    const reportTypeMember = (signature: ESTree.TSPropertySignature): void => {
      const owner = signature.parent;
      if (owner == null) return;
      if (owner.type !== 'TSInterfaceBody' && owner.type !== 'TSTypeLiteral') return;
      const key = signatureKey(signature);
      if (key === null || !isTemporalKey(key)) return;
      // An i18n label bag (`CustomerDetailCopy`) keyed by field name holds translated
      // column headings, not values; no temporal codec can model "Created".
      if (isDisplayMember(owner, key)) return;
      const annotation = signature.typeAnnotation;
      if (annotation == null) return;
      if (!isPlainStringType(annotation.typeAnnotation, new Set(), 0)) return;
      reports.push({
        data: { key, replacement: replacementFor(key) },
        messageId: 'stringTemporalMember',
        node: signature,
        start: signature.start,
      });
    };
    const reportFields = (): void => {
      const fieldBags = collectFieldBags();
      for (const object of objects) {
        if (fieldBags.has(object.start)) object.properties.forEach(reportField);
      }
    };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
        locals = collectSchemaLocals(node, bindings, options.schemaModules);
      },
      ObjectExpression(node) {
        objects.push(node);
      },
      CallExpression(node) {
        for (const argument of node.arguments) {
          const value = unwrap(argument);
          if (value.type !== 'Identifier') continue;
          if (isSchemaConstructorArgument(argument)) bagIdentifiers.push(value);
        }
        if (isPatternCallee(node.callee)) patternCalls.push(node);
      },
      SpreadElement(node) {
        const container = node.parent;
        if (container === null || container === undefined || container.type !== 'ObjectExpression')
          return;
        const argument = unwrap(node.argument);
        if (argument.type === 'Identifier') spreads.push({ container, id: argument });
      },
      TSPropertySignature(node) {
        typeMembers.push(node);
      },
      'Program:exit'() {
        reports.length = 0;
        codecSpans.length = 0;
        const hasSchema =
          locals.schema.size > 0 || locals.barrel.size > 0 || locals.members.size > 0;
        if (hasSchema) {
          patternCalls.forEach(reportCodec);
          reportFields();
        }
        if (options.includeTypeMembers) typeMembers.forEach(reportTypeMember);
        reports.sort((left, right) => left.start - right.start);
        for (const report of reports) {
          context.report({ data: report.data, messageId: report.messageId, node: report.node });
        }
      },
    };
  },
});
