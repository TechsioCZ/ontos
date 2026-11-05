import nodePath from 'node:path';
import { LanguageVariant, SyntaxKind, createScanner } from '@typescript/native/unstable/ast';
import { Array as EffectArray, Order, Predicate, Redacted, Result, Schema } from 'effect';

import {
  accessCarrierIssue,
  collectAccessCatalog,
  decodeAccessActor,
  decodeAccessDeclaration,
  decodeAccessFieldGroups,
  decodeAccessWorkload,
  deriveAgentPolicy,
  hasDangerousAccessVerb,
} from '../packages/core-runtime/src/authorization/access-declaration.ts';
import type {
  AccessActor,
  AccessCatalogFinding,
  AccessCatalogModule,
  AccessDeclaration,
  AccessDeclarationOwner,
  AccessFieldGroup,
} from '../packages/core-runtime/src/authorization/access-declaration.ts';
import { ModuleEntrypointSchema } from '../packages/core-runtime/src/modules/module-entrypoint.ts';

/**
 * Report-only derivation of the Authorization v2 access catalog from the `accessDeclaration`
 * metadata that descriptors carry. Nothing here decides access: it reads declarations, lists the
 * declaration gaps of the whole repository and compares two revisions so a module release can
 * become Novinky v oprávněních items.
 */

export const ACCESS_CATALOG_REPORT_SCHEMA_VERSION = 1 as const;
export const ACCESS_CATALOG_DIFF_SCHEMA_VERSION = 1 as const;

/** Declaration kinds and risk tiers, exactly as the Core schema fixes them. */
export const ACCESS_CATALOG_KINDS = ['action', 'read', 'field_read', 'field_write', 'export', 'admin'] as const;
export type AccessCatalogKind = (typeof ACCESS_CATALOG_KINDS)[number];

export const ACCESS_CATALOG_RISKS = ['routine', 'sensitive', 'critical'] as const;
export type AccessCatalogRisk = (typeof ACCESS_CATALOG_RISKS)[number];

/** Descriptor kinds that own exactly one declaration: Actions, reads, contributions, pages. */
export const ACCESS_CATALOG_CARRIERS = ['action', 'contribution', 'page', 'read'] as const;
export type AccessCatalogCarrier = (typeof ACCESS_CATALOG_CARRIERS)[number];

/** Only the v2 `protected` classification carries a declaration; the legacy kinds are gone (O62). */
const PROTECTED_AUTHORIZATIONS: ReadonlySet<string> = new Set(['protected']);

/** The module-entrypoint factory names that imply the scope the descriptor omits. */
const IMPLIED_SCOPES: ReadonlyMap<string, string> = new Map([
  ['defineModuleEntrypoint', 'tenant'],
  ['defineSystemModuleEntrypoint', 'system'],
  ['defineTenantModuleEntrypoint', 'tenant'],
]);

/** A carrier property is what makes a descriptor a declaration carrier, not its factory name. */
const CARRIER_MARKERS: readonly (readonly [string, AccessCatalogCarrier])[] = [
  ['actionKey', 'action'],
  ['readKey', 'read'],
  ['contributionKey', 'contribution'],
  ['canonicalPath', 'page'],
];

const DECLARING_FACTORY = /^(?:define[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*Contribution)$/u;

const OPEN_DELIMITERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenParenToken,
]);

const CLOSE_DELIMITERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseParenToken,
]);

const SKIPPED_PATH_SEGMENTS = ['/fixtures/', '/node_modules/', '/tests/', '/.output/', '/dist'];
const SOURCE_FILE_PATTERN = /\.(?:mts|ts|tsx)$/u;
const MISSING_ENTRYPOINT = 'entrypoint is neither an object literal nor a same-file entrypoint constant';
const STATIC_DECLARATION_REQUIRED = 'accessDeclaration must be a static object literal';
const STATIC_FIELD_GROUPS_REQUIRED = 'accessFieldGroups must be a static array of group object literals';
const STATIC_WORKLOAD_REQUIRED = 'accessWorkload must be a static object literal';
const STATIC_ACTOR_REQUIRED = 'accessActor must be a static object literal';

export type Ordering = -1 | 0 | 1;

export interface AccessCatalogSource {
  readonly file: string;
  readonly source: string;
}

/** The closed `authorization` classification (O62, CUTOVER-PLAN §4.2), v2-only. */
export type ScannedAuthorization =
  | { readonly credential: Redacted.Redacted; readonly kind: 'capability_issuance' }
  | { readonly kind: 'authenticated_principal' }
  | { readonly kind: 'owner_local_background' }
  | { readonly kind: 'protected' }
  | { readonly kind: 'public' };

export interface ScannedEntrypoint {
  readonly access: string;
  readonly authorization: ScannedAuthorization;
  readonly entrypointKey: string;
  readonly moduleKey: string;
  readonly role: string;
  readonly scope: string;
}

/** Static literal values only: a computed declaration is reported instead of guessed. */
export interface LiteralObject {
  readonly [key: string]: LiteralValue;
}

export type LiteralValue = boolean | LiteralObject | null | number | readonly LiteralValue[] | string;

/**
 * One declaration carrier found in source, with its optional raw declaration literal, its raw field
 * groups, its raw workload marker and its raw module-caller marker. At most one of the declaration and
 * the workload may appear.
 */
export interface ScannedCarrier {
  readonly accessActor: LiteralObject | null;
  readonly accessDeclaration: LiteralObject | null;
  readonly accessFieldGroups: readonly LiteralObject[] | null;
  readonly accessWorkload: LiteralObject | null;
  readonly carrier: AccessCatalogCarrier;
  readonly entrypoint: ScannedEntrypoint;
  readonly file: string;
}

export interface ScannedProblem {
  readonly entrypointKey: string | null;
  readonly file: string;
  readonly moduleId: string | null;
  readonly reason: string;
}

export interface ScannedSource {
  readonly carriers: readonly ScannedCarrier[];
  /** Entrypoint literals that are not declaration carriers, for example plain route metadata. */
  readonly entrypoints: readonly ScannedEntrypoint[];
  readonly problems: readonly ScannedProblem[];
}

export interface TokenSpan {
  readonly end: number;
  readonly start: number;
}

interface CatalogToken {
  readonly kind: SyntaxKind;
  readonly value: string;
}

interface EntrypointLiteral {
  readonly impliedScope: string | null;
  readonly index: number;
}

interface PropertyRead {
  readonly entry: readonly [string, TokenSpan] | null;
  readonly next: number;
}

interface ScanContext {
  readonly constants: ReadonlyMap<string, string>;
  readonly delimiters: ReadonlyMap<number, number>;
  readonly file: string;
  readonly sites: ReadonlyMap<string, EntrypointLiteral>;
  readonly tokens: readonly CatalogToken[];
}

type CarrierScan =
  | { readonly kind: 'carrier'; readonly value: ScannedCarrier }
  | { readonly kind: 'entrypoint'; readonly value: ScannedEntrypoint }
  | { readonly kind: 'problem'; readonly value: ScannedProblem };

/** `toSorted` is absent from the script type environment, so ordering goes through Effect. */
const sortedBy = <Value,>(
  values: Iterable<Value>,
  compare: (left: Value, right: Value) => Ordering,
): readonly Value[] => EffectArray.sort(values, Order.make(compare));

const stableTextOrder = (left: string, right: string): Ordering => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const rescanTemplateClose = (scanner: ReturnType<typeof createScanner>, depths: number[]): SyntaxKind => {
  const index = depths.length - 1;
  const depth = depths[index] ?? 0;
  if (depth !== 0) {
    depths[index] = depth - 1;
    return SyntaxKind.CloseBraceToken;
  }
  const kind = scanner.reScanTemplateToken(false);
  if (kind === SyntaxKind.TemplateTail) {
    depths.pop();
  }
  return kind;
};

const updateTemplateToken = (
  scanner: ReturnType<typeof createScanner>,
  kind: SyntaxKind,
  depths: number[],
): SyntaxKind => {
  if (kind === SyntaxKind.TemplateHead) {
    depths.push(0);
  } else if (depths.length > 0) {
    const index = depths.length - 1;
    if (kind === SyntaxKind.OpenBraceToken) {
      depths[index] = (depths[index] ?? 0) + 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      return rescanTemplateClose(scanner, depths);
    }
  }
  return kind;
};

const tokenize = (source: string): readonly CatalogToken[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: CatalogToken[] = [];
  const templateExpressionBraceDepths: number[] = [];
  let scannedKind = scanner.scan();
  while (scannedKind !== SyntaxKind.EndOfFile) {
    // The native scanner can return a zero-width PrivateIdentifier for a bare `#` in a regexp.
    if (scannedKind === SyntaxKind.PrivateIdentifier && scanner.getTokenStart() === scanner.getTokenEnd()) {
      scannedKind = scanner.reScanHashToken();
    }
    const kind = updateTemplateToken(scanner, scannedKind, templateExpressionBraceDepths);
    tokens.push({ kind, value: scanner.getTokenValue() });
    scannedKind = scanner.scan();
  }
  return tokens;
};

/** Balanced-delimiter index, so nested literals are skipped in one step. */
const matchDelimiters = (tokens: readonly CatalogToken[]): ReadonlyMap<number, number> => {
  const matches = new Map<number, number>();
  const open: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (OPEN_DELIMITERS.has(token.kind)) {
      open.push(index);
    } else if (CLOSE_DELIMITERS.has(token.kind)) {
      const start = open.pop();
      if (start !== undefined) {
        matches.set(start, index);
      }
    }
  }
  return matches;
};

const isContainer = (token: CatalogToken | undefined): boolean =>
  token !== undefined && OPEN_DELIMITERS.has(token.kind);

const isPropertyName = (token: CatalogToken | undefined): boolean =>
  token !== undefined &&
  (token.kind === SyntaxKind.Identifier ||
    token.kind === SyntaxKind.StringLiteral ||
    token.kind === SyntaxKind.NumericLiteral);

/** One `name: value` or shorthand `name` property of the object literal open at `cursor`. */
const readProperty = (
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  cursor: number,
  closeIndex: number,
): PropertyRead => {
  const name = tokens[cursor];
  if (!isPropertyName(name)) {
    return { entry: null, next: cursor + 1 };
  }
  const propertyName = name?.value ?? '';
  const separator = tokens[cursor + 1];
  if (separator?.kind === SyntaxKind.CommaToken || cursor + 1 === closeIndex) {
    // Shorthand `{ moduleKey }`: the value is a referenced constant, never a literal here.
    return { entry: [propertyName, { end: cursor, start: cursor }], next: cursor + 1 };
  }
  if (separator?.kind !== SyntaxKind.ColonToken) {
    return { entry: null, next: cursor + 1 };
  }
  const start = cursor + 2;
  const end = isContainer(tokens[start]) ? (delimiters.get(start) ?? start) : start;
  return { entry: [propertyName, { end, start }], next: end + 1 };
};

/** Direct properties of one object literal, including shorthand, mapped to their value span. */
const objectEntries = (
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  openIndex: number,
): ReadonlyMap<string, TokenSpan> => {
  const closeIndex = delimiters.get(openIndex) ?? tokens.length;
  const entries = new Map<string, TokenSpan>();
  let cursor = openIndex + 1;
  while (cursor < closeIndex) {
    const read = readProperty(tokens, delimiters, cursor, closeIndex);
    if (read.entry !== null) {
      entries.set(read.entry[0], read.entry[1]);
    }
    cursor = read.next;
    while (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
      cursor += 1;
    }
  }
  return entries;
};

const numericValue = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Recursive literal reader: methods keep the mutual recursion ordered and readable. */
class LiteralParser {
  readonly #constants: ReadonlyMap<string, string>;
  readonly #delimiters: ReadonlyMap<number, number>;
  readonly #tokens: readonly CatalogToken[];

  constructor(
    tokens: readonly CatalogToken[],
    delimiters: ReadonlyMap<number, number>,
    constants: ReadonlyMap<string, string>,
  ) {
    this.#tokens = tokens;
    this.#delimiters = delimiters;
    this.#constants = constants;
  }

  /**
   * Only static values decode: literals and the module's own top-level string constants. A computed
   * value returns `undefined`.
   */
  value(start: number): LiteralValue | undefined {
    const token = this.#tokens[start];
    if (token?.kind === SyntaxKind.StringLiteral) {
      return token.value;
    }
    if (token?.kind === SyntaxKind.Identifier && this.#tokens[start + 1]?.kind !== SyntaxKind.DotToken) {
      return this.#constants.get(token.value);
    }
    if (token?.kind === SyntaxKind.NumericLiteral) {
      return numericValue(token.value) ?? undefined;
    }
    if (token?.kind === SyntaxKind.TrueKeyword) {
      return true;
    }
    if (token?.kind === SyntaxKind.FalseKeyword) {
      return false;
    }
    if (token?.kind === SyntaxKind.NullKeyword) {
      return null;
    }
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      return this.object(start);
    }
    return token?.kind === SyntaxKind.OpenBracketToken ? this.array(start) : undefined;
  }

  object(openIndex: number): LiteralObject | undefined {
    const value: Record<string, LiteralValue> = {};
    for (const [key, entry] of objectEntries(this.#tokens, this.#delimiters, openIndex)) {
      const parsed = this.value(entry.start);
      if (parsed === undefined) {
        return undefined;
      }
      value[key] = parsed;
    }
    return value;
  }

  /** A list of object literals only: every element must open a brace, so nothing else is guessed. */
  objects(openIndex: number): readonly LiteralObject[] | undefined {
    const closeIndex = this.#delimiters.get(openIndex) ?? this.#tokens.length;
    const values: LiteralObject[] = [];
    let cursor = openIndex + 1;
    while (cursor < closeIndex) {
      if (this.#tokens[cursor]?.kind === SyntaxKind.CommaToken) {
        cursor += 1;
      } else {
        if (this.#tokens[cursor]?.kind !== SyntaxKind.OpenBraceToken) {
          return undefined;
        }
        const parsed = this.object(cursor);
        if (parsed === undefined) {
          return undefined;
        }
        values.push(parsed);
        cursor = (this.#delimiters.get(cursor) ?? cursor) + 1;
      }
    }
    return values;
  }

  array(openIndex: number): readonly LiteralValue[] | undefined {
    const closeIndex = this.#delimiters.get(openIndex) ?? this.#tokens.length;
    const values: LiteralValue[] = [];
    let cursor = openIndex + 1;
    while (cursor < closeIndex) {
      const token = this.#tokens[cursor];
      if (token?.kind === SyntaxKind.CommaToken) {
        cursor += 1;
      } else {
        const parsed = this.value(cursor);
        if (parsed === undefined) {
          return undefined;
        }
        values.push(parsed);
        cursor = (this.#delimiters.get(cursor) ?? cursor) + 1;
      }
    }
    return values;
  }
}

const stringConstantAt = (tokens: readonly CatalogToken[], index: number): readonly [string, string] | null => {
  if (
    tokens[index]?.kind !== SyntaxKind.ConstKeyword ||
    tokens[index + 1]?.kind !== SyntaxKind.Identifier ||
    tokens[index + 2]?.kind !== SyntaxKind.EqualsToken ||
    tokens[index + 3]?.kind !== SyntaxKind.StringLiteral
  ) {
    return null;
  }
  return [tokens[index + 1]?.value ?? '', tokens[index + 3]?.value ?? ''];
};

const stringConstants = (tokens: readonly CatalogToken[]): ReadonlyMap<string, string> => {
  const constants = new Map<string, string>();
  for (const [index] of tokens.entries()) {
    const constant = stringConstantAt(tokens, index);
    if (constant !== null) {
      constants.set(constant[0], constant[1]);
    }
  }
  return constants;
};

/** Exported top-level string constants of a module; a name declared twice is ambiguous and dropped. */
const exportedStringConstants = (tokens: readonly CatalogToken[]): ReadonlyMap<string, string> => {
  const found: (readonly [string, string])[] = [];
  for (const [index, token] of tokens.entries()) {
    const constant = token.kind === SyntaxKind.ExportKeyword ? stringConstantAt(tokens, index + 1) : null;
    if (constant !== null) {
      found.push(constant);
    }
  }
  return new Map(found.filter(([name]) => found.filter(([other]) => other === name).length === 1));
};

/** The module directory a source belongs to, so an import may only reach inside its own module. */
const moduleDirectoryOf = (file: string): string | null =>
  /^(?:apps|verticals|packages)\/[^/]+\//u.exec(file)?.[0] ?? null;

/** A relative `.ts` specifier resolved to the repository-relative file it names, inside the same module only. */
const ownerLocalTarget = (file: string, specifier: string): string | null => {
  const owner = moduleDirectoryOf(file);
  if (owner === null || !/^\.\.?\//u.test(specifier) || !specifier.endsWith('.ts')) {
    return null;
  }
  const target = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(file), specifier));
  return target.startsWith(owner) ? target : null;
};

interface NamedImport {
  readonly imported: string;
  readonly local: string;
  readonly target: string;
}

const isWord = (token: CatalogToken | undefined, word: string): boolean =>
  token !== undefined && token.kind !== SyntaxKind.StringLiteral && token.value === word;

/**
 * The bindings of one exact static named import, `import { X, Y as Z } from './f.ts'`, read from `index`.
 * Type-only, default, namespace and mixed forms are not bindings this scan follows, so they yield nothing.
 */
const namedImportAt = (tokens: readonly CatalogToken[], index: number, file: string): readonly NamedImport[] => {
  if (tokens[index]?.kind !== SyntaxKind.ImportKeyword || tokens[index + 1]?.kind !== SyntaxKind.OpenBraceToken) {
    return [];
  }
  const bindings: { readonly imported: string; readonly local: string }[] = [];
  let cursor = index + 2;
  while (tokens[cursor]?.kind !== SyntaxKind.CloseBraceToken) {
    const imported = tokens[cursor];
    if (imported?.kind !== SyntaxKind.Identifier) {
      return [];
    }
    let local = imported.value;
    cursor += 1;
    if (isWord(tokens[cursor], 'as')) {
      const alias = tokens[cursor + 1];
      if (alias?.kind !== SyntaxKind.Identifier) {
        return [];
      }
      local = alias.value;
      cursor += 2;
    }
    bindings.push({ imported: imported.value, local });
    if (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
      cursor += 1;
    } else if (tokens[cursor]?.kind !== SyntaxKind.CloseBraceToken) {
      return [];
    }
  }
  const specifier = tokens[cursor + 2];
  if (!isWord(tokens[cursor + 1], 'from') || specifier?.kind !== SyntaxKind.StringLiteral) {
    return [];
  }
  const target = ownerLocalTarget(file, specifier.value);
  return target === null ? [] : bindings.map((binding) => ({ ...binding, target }));
};

const namedImports = (tokens: readonly CatalogToken[], file: string): readonly NamedImport[] =>
  tokens.flatMap((_token, index) => namedImportAt(tokens, index, file));

/**
 * The module-local files a source's named constant imports read. The caller supplies them to the scan
 * so the imported constants resolve; a file that is not in the module is never listed.
 */
export const ownerLocalImportTargets = (source: string, file: string): readonly string[] => [
  ...new Set(namedImports(tokenize(source), file).map((binding) => binding.target)),
];

/** Imported string constants, keyed by the local name, read from the exports of the same-module files. */
const importedStringConstants = (
  tokens: readonly CatalogToken[],
  file: string,
  moduleSources: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> => {
  const constants = new Map<string, string>();
  for (const binding of namedImports(tokens, file)) {
    const targetSource = moduleSources.get(binding.target);
    const value =
      targetSource === undefined ? undefined : exportedStringConstants(tokenize(targetSource)).get(binding.imported);
    if (value !== undefined) {
      constants.set(binding.local, value);
    }
  }
  return constants;
};

const declaredNameBefore = (tokens: readonly CatalogToken[], index: number): string | null => {
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 6; cursor -= 1) {
    if (tokens[cursor]?.kind === SyntaxKind.ConstKeyword) {
      const name = tokens[cursor + 1];
      return name?.kind === SyntaxKind.Identifier && tokens[cursor + 2]?.kind === SyntaxKind.EqualsToken
        ? name.value
        : null;
    }
  }
  return null;
};

/** `const <name> = define<Tenant|System>ModuleEntrypoint({ ... })`, keyed by declared name. */
const entrypointLiteralAt = (
  tokens: readonly CatalogToken[],
  index: number,
): readonly [string, EntrypointLiteral] | null => {
  const token = tokens[index];
  const opensEntrypoint =
    token?.kind === SyntaxKind.Identifier &&
    token.value.startsWith('define') &&
    token.value.endsWith('ModuleEntrypoint') &&
    tokens[index + 1]?.kind === SyntaxKind.OpenParenToken &&
    tokens[index + 2]?.kind === SyntaxKind.OpenBraceToken;
  if (!opensEntrypoint || token === undefined) {
    return null;
  }
  const name = declaredNameBefore(tokens, index);
  return name === null ? null : [name, { impliedScope: IMPLIED_SCOPES.get(token.value) ?? null, index: index + 2 }];
};

const entrypointLiteralSites = (tokens: readonly CatalogToken[]): ReadonlyMap<string, EntrypointLiteral> => {
  const sites = new Map<string, EntrypointLiteral>();
  for (const [index] of tokens.entries()) {
    const site = entrypointLiteralAt(tokens, index);
    if (site !== null) {
      sites.set(site[0], site[1]);
    }
  }
  return sites;
};

const resolveString = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  constants: ReadonlyMap<string, string>,
): string | null => {
  const token = span === undefined ? undefined : tokens[span.start];
  if (token?.kind === SyntaxKind.StringLiteral) {
    return token.value;
  }
  return token?.kind === SyntaxKind.Identifier ? (constants.get(token.value) ?? null) : null;
};

const AUTHORIZATION_KINDS = [
  'authenticated_principal',
  'capability_issuance',
  'owner_local_background',
  'protected',
  'public',
] as const;

const AUTHORIZATION_KIND_SCHEMA = Schema.Literals(AUTHORIZATION_KINDS);

/** Reads the closed authorization classification, resolving same-file string constants. */
const readAuthorization = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  constants: ReadonlyMap<string, string>,
): ScannedAuthorization | null => {
  if (span === undefined || tokens[span.start]?.kind !== SyntaxKind.OpenBraceToken) {
    return null;
  }
  const entries = objectEntries(tokens, delimiters, span.start);
  const kind = resolveString(entries.get('kind'), tokens, constants);
  if (!Schema.is(AUTHORIZATION_KIND_SCHEMA)(kind)) {
    return null;
  }
  const credential = resolveString(entries.get('credential'), tokens, constants);
  if (kind === 'capability_issuance') {
    // The credential kind is a classification token, never secret material; redact it regardless.
    return credential === null ? null : { credential: Redacted.make(credential), kind };
  }
  return { kind };
};

/** The entrypoint fields as the entrypoint schema decodes them, credentials unwrapped at the seam. */
const entrypointInput = (entrypoint: ScannedEntrypoint) => ({
  access: entrypoint.access,
  authorization:
    entrypoint.authorization.kind === 'capability_issuance'
      ? { credential: Redacted.value(entrypoint.authorization.credential), kind: 'capability_issuance' as const }
      : entrypoint.authorization,
  entrypointKey: entrypoint.entrypointKey,
  moduleKey: entrypoint.moduleKey,
  role: entrypoint.role,
  scope: entrypoint.scope,
});

const openEntrypointLiteral = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  sites: ReadonlyMap<string, EntrypointLiteral>,
): EntrypointLiteral | null => {
  if (span === undefined) {
    return null;
  }
  const token = tokens[span.start];
  if (token?.kind === SyntaxKind.OpenBraceToken) {
    return { impliedScope: null, index: span.start };
  }
  if (token?.kind !== SyntaxKind.Identifier) {
    return null;
  }
  // `entrypoint: defineTenantModuleEntrypoint({ ... })` declares the descriptor inline.
  if (tokens[span.start + 1]?.kind === SyntaxKind.OpenParenToken) {
    return tokens[span.start + 2]?.kind === SyntaxKind.OpenBraceToken
      ? { impliedScope: IMPLIED_SCOPES.get(token.value) ?? null, index: span.start + 2 }
      : null;
  }
  return sites.get(token.value) ?? null;
};

const readEntrypoint = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  constants: ReadonlyMap<string, string>,
  sites: ReadonlyMap<string, EntrypointLiteral>,
): { readonly problem: string } | { readonly value: ScannedEntrypoint } => {
  const literal = openEntrypointLiteral(span, tokens, sites);
  if (literal === null) {
    return { problem: MISSING_ENTRYPOINT };
  }
  const entries = objectEntries(tokens, delimiters, literal.index);
  const access = resolveString(entries.get('access'), tokens, constants);
  const authorization = readAuthorization(entries.get('authorization'), tokens, delimiters, constants);
  const entrypointKey = resolveString(entries.get('entrypointKey'), tokens, constants);
  const moduleKey = resolveString(entries.get('moduleKey'), tokens, constants);
  const role = resolveString(entries.get('role'), tokens, constants);
  const scope = resolveString(entries.get('scope'), tokens, constants) ?? literal.impliedScope;
  if (
    access === null ||
    authorization === null ||
    entrypointKey === null ||
    moduleKey === null ||
    role === null ||
    scope === null
  ) {
    const missing = [
      access === null ? 'access' : null,
      authorization === null ? 'authorization' : null,
      entrypointKey === null ? 'entrypointKey' : null,
      moduleKey === null ? 'moduleKey' : null,
      role === null ? 'role' : null,
      scope === null ? 'scope' : null,
    ].filter(Predicate.isString);
    return { problem: `entrypoint is missing ${missing.join(', ')}` };
  }
  return { value: { access, authorization, entrypointKey, moduleKey, role, scope } };
};

const carrierOf = (properties: ReadonlyMap<string, TokenSpan>): AccessCatalogCarrier | null => {
  const marker = CARRIER_MARKERS.find(([property]) => properties.has(property));
  return marker?.[1] ?? null;
};

/** A factory that always builds one carrier kind, used when the marker comes from a spread. */
const factoryCarrier = (factory: string | null): AccessCatalogCarrier | null => {
  if (factory?.endsWith('Contribution') === true) {
    return 'contribution';
  }
  if (factory?.endsWith('Action') === true) {
    return 'action';
  }
  return factory?.includes('Read') === true ? 'read' : null;
};

const skipGenericArguments = (tokens: readonly CatalogToken[], from: number): number => {
  if (tokens[from]?.kind !== SyntaxKind.GreaterThanToken) {
    return from;
  }
  let depth = 0;
  for (let cursor = from; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor]?.kind;
    if (kind === SyntaxKind.GreaterThanToken) {
      depth += 1;
    } else if (kind === SyntaxKind.LessThanToken) {
      depth -= 1;
      if (depth === 0) {
        return cursor - 1;
      }
    }
  }
  return from;
};

/** The callee of `factory(...)` and `factory<Type>(...)`, which carries generic descriptors too. */
const enclosingFactory = (tokens: readonly CatalogToken[], openIndex: number): string | null => {
  if (tokens[openIndex - 1]?.kind !== SyntaxKind.OpenParenToken) {
    return null;
  }
  const callee = tokens[skipGenericArguments(tokens, openIndex - 2)];
  return callee?.kind === SyntaxKind.Identifier ? callee.value : null;
};

type DeclaredValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'object'; readonly value: LiteralObject }
  | { readonly kind: 'problem' };

const declaredValue = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  constants: ReadonlyMap<string, string>,
): DeclaredValue => {
  if (span === undefined) {
    return { kind: 'absent' };
  }
  if (tokens[span.start]?.kind !== SyntaxKind.OpenBraceToken) {
    return { kind: 'problem' };
  }
  const parsed = new LiteralParser(tokens, delimiters, constants).object(span.start);
  return parsed === undefined ? { kind: 'problem' } : { kind: 'object', value: parsed };
};

type DeclaredGroups =
  | { readonly kind: 'absent' }
  | { readonly kind: 'groups'; readonly value: readonly LiteralObject[] }
  | { readonly kind: 'problem' };

/** A field-group list is only read as a static array of object literals; anything else is reported. */
const declaredGroupsValue = (
  span: TokenSpan | undefined,
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  constants: ReadonlyMap<string, string>,
): DeclaredGroups => {
  if (span === undefined) {
    return { kind: 'absent' };
  }
  if (tokens[span.start]?.kind !== SyntaxKind.OpenBracketToken) {
    return { kind: 'problem' };
  }
  const groups = new LiteralParser(tokens, delimiters, constants).objects(span.start);
  return groups === undefined ? { kind: 'problem' } : { kind: 'groups', value: groups };
};

interface DeclaredCarrierLiterals {
  readonly accessActor: LiteralObject | null;
  readonly accessDeclaration: LiteralObject | null;
  readonly accessFieldGroups: readonly LiteralObject[] | null;
  readonly accessWorkload: LiteralObject | null;
}

interface DeclaredCarrierParse {
  readonly carriers: DeclaredCarrierLiterals;
  readonly problems: readonly string[];
}

/** The three access carriers of one descriptor literal, plus the properties that are not static. */
const declaredCarriers = (
  properties: ReadonlyMap<string, TokenSpan>,
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  constants: ReadonlyMap<string, string>,
): DeclaredCarrierParse => {
  const declaration = declaredValue(properties.get('accessDeclaration'), tokens, delimiters, constants);
  const groups = declaredGroupsValue(properties.get('accessFieldGroups'), tokens, delimiters, constants);
  const workload = declaredValue(properties.get('accessWorkload'), tokens, delimiters, constants);
  const actor = declaredValue(properties.get('accessActor'), tokens, delimiters, constants);
  return {
    carriers: {
      accessActor: actor.kind === 'object' ? actor.value : null,
      accessDeclaration: declaration.kind === 'object' ? declaration.value : null,
      accessFieldGroups: groups.kind === 'groups' ? groups.value : null,
      accessWorkload: workload.kind === 'object' ? workload.value : null,
    },
    problems: [
      declaration.kind === 'problem' ? STATIC_DECLARATION_REQUIRED : null,
      groups.kind === 'problem' ? STATIC_FIELD_GROUPS_REQUIRED : null,
      workload.kind === 'problem' ? STATIC_WORKLOAD_REQUIRED : null,
      actor.kind === 'problem' ? STATIC_ACTOR_REQUIRED : null,
    ].filter(Predicate.isString),
  };
};

const CARRIER_ABSENT = 'the entrypoint of this declaration comes from a spread and is not visible here';

/**
 * Shared registrations whose entrypoint is fixed by an exact contract that
 * `check-module-entrypoint-boundaries.mts` enforces token by token
 * (`hasEngagementLifecycleRegistrationContract`). The only varying part is the Action key passed
 * as the registration argument, so the entrypoint is resolved from that literal. Any other spread
 * stays a reported problem.
 */
const SHARED_REGISTRATION_ENTRYPOINTS: ReadonlyMap<string, (key: string) => ScannedEntrypoint | null> = new Map([
  [
    'engagementLifecycleRegistration',
    (key: string): ScannedEntrypoint | null =>
      /^party\.registry\.(?:archive|unarchive)-(?:organization|person)-engagement$/u.test(key)
        ? {
            access: 'write',
            authorization: { kind: 'protected' },
            entrypointKey: key,
            moduleKey: 'party.registry',
            role: 'action',
            scope: 'tenant',
          }
        : null,
  ],
]);

/** The single literal argument of `callee<Payload>('key')` starting at the callee token, if exact. */
const registrationArgument = (tokens: readonly CatalogToken[], calleeIndex: number): string | null => {
  // Only a single type argument (`<Payload>`) is part of the governed contract.
  const hasTypeArgument =
    tokens[calleeIndex + 1]?.kind === SyntaxKind.LessThanToken &&
    tokens[calleeIndex + 2]?.kind === SyntaxKind.Identifier &&
    tokens[calleeIndex + 3]?.kind === SyntaxKind.GreaterThanToken;
  const argumentOpen = hasTypeArgument ? calleeIndex + 4 : calleeIndex + 1;
  const argument = tokens[argumentOpen + 1];
  // The formatter adds one trailing comma when the call wraps.
  const argumentClose = tokens[argumentOpen + 2]?.kind === SyntaxKind.CommaToken ? argumentOpen + 3 : argumentOpen + 2;
  return tokens[argumentOpen]?.kind === SyntaxKind.OpenParenToken &&
    argument?.kind === SyntaxKind.StringLiteral &&
    tokens[argumentClose]?.kind === SyntaxKind.CloseParenToken
    ? argument.value
    : null;
};

const sharedRegistrationEntrypoint = (
  tokens: readonly CatalogToken[],
  delimiters: ReadonlyMap<number, number>,
  openIndex: number,
): ScannedEntrypoint | null => {
  const closeIndex = delimiters.get(openIndex) ?? openIndex;
  for (let cursor = openIndex + 1; cursor < closeIndex; cursor += 1) {
    const callee = tokens[cursor + 1];
    const resolve =
      tokens[cursor]?.kind === SyntaxKind.DotDotDotToken && callee?.kind === SyntaxKind.Identifier
        ? SHARED_REGISTRATION_ENTRYPOINTS.get(callee.value)
        : undefined;
    if (resolve !== undefined) {
      const key = registrationArgument(tokens, cursor + 1);
      return key === null ? null : resolve(key);
    }
  }
  return null;
};

const descriptorCandidate = (properties: ReadonlyMap<string, TokenSpan>, factory: string | null): boolean => {
  if (!properties.has('entrypoint') && !properties.has('accessDeclaration')) {
    return false;
  }
  if (factory !== null && DECLARING_FACTORY.test(factory)) {
    return true;
  }
  // Outside a descriptor factory only route metadata declares: it owns a canonical path.
  return properties.has('accessDeclaration') && properties.has('canonicalPath');
};

const carrierForDescriptor = (
  properties: ReadonlyMap<string, TokenSpan>,
  factory: string | null,
): AccessCatalogCarrier => carrierOf(properties) ?? factoryCarrier(factory) ?? 'page';

const descriptorProblem = (
  file: string,
  entrypoint: { readonly problem: string } | { readonly value: ScannedEntrypoint },
  carrierProblems: readonly string[],
): ScannedProblem => {
  const entrypointValue = 'value' in entrypoint ? entrypoint.value : null;
  const reasons = ['problem' in entrypoint ? entrypoint.problem : null, ...carrierProblems].filter(Predicate.isString);
  return {
    entrypointKey: entrypointValue?.entrypointKey ?? null,
    file,
    moduleId: entrypointValue?.moduleKey ?? null,
    reason: reasons.join('; '),
  };
};

const scanObjectLiteral = (context: ScanContext, index: number): CarrierScan | null => {
  const { constants, delimiters, file, sites, tokens } = context;
  const properties = objectEntries(tokens, delimiters, index);
  const factory = enclosingFactory(tokens, index);
  if (!descriptorCandidate(properties, factory)) {
    return null;
  }
  const carrier = carrierForDescriptor(properties, factory);
  if (!properties.has('entrypoint')) {
    const shared = sharedRegistrationEntrypoint(tokens, delimiters, index);
    const declared = declaredCarriers(properties, tokens, delimiters, constants);
    if (shared === null || declared.problems.length > 0) {
      return { kind: 'problem', value: { entrypointKey: null, file, moduleId: null, reason: CARRIER_ABSENT } };
    }
    return { kind: 'carrier', value: { ...declared.carriers, carrier, entrypoint: shared, file } };
  }
  const entrypoint = readEntrypoint(properties.get('entrypoint'), tokens, delimiters, constants, sites);
  if (
    !properties.has('accessDeclaration') &&
    !properties.has('accessWorkload') &&
    !properties.has('accessActor') &&
    !properties.has('accessFieldGroups') &&
    factory === null
  ) {
    return 'value' in entrypoint ? { kind: 'entrypoint', value: entrypoint.value } : null;
  }
  const declared = declaredCarriers(properties, tokens, delimiters, constants);
  return 'problem' in entrypoint || declared.problems.length > 0
    ? { kind: 'problem', value: descriptorProblem(file, entrypoint, declared.problems) }
    : { kind: 'carrier', value: { ...declared.carriers, carrier, entrypoint: entrypoint.value, file } };
};

const scanAccessCatalogSourceWith = ({ constants, delimiters, file, sites, tokens }: ScanContext): ScannedSource => {
  const carriers: ScannedCarrier[] = [];
  const entrypoints: ScannedEntrypoint[] = [];
  const problems: ScannedProblem[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind === SyntaxKind.OpenBraceToken) {
      const scan = scanObjectLiteral({ constants, delimiters, file, sites, tokens }, index);
      if (scan?.kind === 'carrier') {
        carriers.push(scan.value);
      } else if (scan?.kind === 'entrypoint') {
        entrypoints.push(scan.value);
      } else if (scan?.kind === 'problem') {
        problems.push(scan.value);
      }
    }
  }
  return { carriers, entrypoints, problems };
};

/**
 * Pure source scan: every carrier descriptor (Action, governed read, Shell contribution or page
 * metadata), its entrypoint and its optional raw declaration, plus unresolvable references.
 * `moduleSources` holds sources by repository-relative file. A named import of a same-module `.ts` file
 * resolves its exported string constants from there; every other reference stays unresolved.
 */
export const scanAccessCatalogSource = (
  source: string,
  file: string,
  moduleSources: ReadonlyMap<string, string> = new Map<string, string>(),
): ScannedSource => {
  const tokens = tokenize(source);
  return scanAccessCatalogSourceWith({
    constants: new Map([...importedStringConstants(tokens, file, moduleSources), ...stringConstants(tokens)]),
    delimiters: matchDelimiters(tokens),
    file,
    sites: entrypointLiteralSites(tokens),
    tokens,
  });
};

export interface AccessCatalogSnapshotEntry {
  readonly agentPolicy: 'never' | 'propose_only' | 'run';
  readonly carrier: AccessCatalogCarrier;
  readonly entrypointKey: string;
  readonly fieldClass: string | null;
  /** The governed result or payload paths of a field group entry; empty for a declaration entry. */
  readonly fields: readonly string[];
  readonly file: string;
  readonly key: string;
  readonly kind: AccessCatalogKind;
  readonly moduleId: string;
  /** The declaration key that owns a field group entry; null for a descriptor declaration. */
  readonly parentKey: string | null;
  readonly renamedFrom: readonly string[];
  readonly risk: AccessCatalogRisk;
  readonly splitFrom: string | null;
}

/**
 * An Action that only trusted machine workloads may run (O29, O59). It is never a catalog entry,
 * never granted to a human or an agent, and reported apart from declarations and from gaps.
 */
export interface AccessCatalogWorkload {
  readonly carrier: AccessCatalogCarrier;
  readonly entrypointKey: string;
  readonly file: string;
  readonly moduleId: string;
  readonly reason: string;
  /** The registered workload keys this carrier admits; at least one (O73). */
  readonly workloads: readonly string[];
}

export interface AccessCatalogSnapshotProblem {
  readonly entrypointKey: string | null;
  readonly file: string;
  readonly moduleId: string | null;
  readonly reason: string;
}

export interface AccessCatalogMissingDeclaration {
  readonly authorizationKind: string;
  readonly carrier: AccessCatalogCarrier;
  readonly entrypointKey: string;
  readonly file: string;
  readonly moduleId: string;
  readonly role: string;
}

export interface AccessCatalogSnapshot {
  readonly entries: readonly AccessCatalogSnapshotEntry[];
  /** Entrypoint literals outside the described carriers, such as plain route metadata. */
  readonly entrypointsWithoutCarrier: readonly (ScannedEntrypoint & { readonly file: string })[];
  readonly findings: readonly AccessCatalogFinding[];
  readonly invalid: readonly AccessCatalogSnapshotProblem[];
  readonly missing: readonly AccessCatalogMissingDeclaration[];
  readonly scannedFiles: number;
  readonly workloads: readonly AccessCatalogWorkload[];
}

interface DecodedCarrier {
  readonly carrier: ScannedCarrier;
  readonly entrypoint: typeof ModuleEntrypointSchema.Type;
}

interface DeclaredCarrier {
  readonly carrier: ScannedCarrier;
  readonly declaration: AccessDeclaration;
  readonly entrypoint: typeof ModuleEntrypointSchema.Type;
  readonly fieldGroups: readonly AccessFieldGroup[];
}

const TopologyCallersSchema = Schema.Struct({
  verticals: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/**
 * The topology verticals of one `topology/reference-topology.json` document: the only app ids that may
 * sign a module call's `act` claim (DESIGN D5). Every caller of a scan reads it from the scanned root or
 * revision, never from this checkout.
 */
export const decodeTopologyCallerAppIds = (topologyJson: string): Result.Result<ReadonlySet<string>, string> =>
  Schema.decodeUnknownResult(Schema.fromJsonString(TopologyCallersSchema))(topologyJson).pipe(
    Result.mapError((issue) => issue.message),
    Result.map((topology) => new Set(topology.verticals.map((vertical) => vertical.id))),
  );

/**
 * The decoded `accessActor` of one carrier, or the reason it is refused. Shared by the catalog report and
 * the stage bootstrap so both refuse the same declarations. Core decides the shape, the entrypoint kind and
 * the `rights` rule (D5) through `accessCarrierIssue`; this adds only the topology caller check.
 */
export const decodeCarrierActor = (
  literal: LiteralObject,
  owner: AccessDeclarationOwner,
  declaration: AccessDeclaration | undefined,
  callerAppIds: ReadonlySet<string>,
): Result.Result<AccessActor, string> => {
  const decoded = decodeAccessActor(literal, owner);
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure.reason);
  }
  const issue = accessCarrierIssue(
    declaration === undefined
      ? { accessActor: decoded.success, entrypoint: owner }
      : { accessActor: decoded.success, accessDeclaration: declaration, entrypoint: owner },
  );
  if (issue !== undefined) {
    return Result.fail(issue);
  }
  const unknownCaller = decoded.success.callers.find((caller) => !callerAppIds.has(caller));
  if (unknownCaller !== undefined) {
    return Result.fail(`accessActor names an unknown caller "${unknownCaller}": not a topology vertical`);
  }
  return Result.succeed(decoded.success);
};

const decodeEntrypoint = (carrier: ScannedCarrier): Result.Result<DecodedCarrier, AccessCatalogSnapshotProblem> =>
  Schema.decodeUnknownResult(ModuleEntrypointSchema, { onExcessProperty: 'error' })(
    entrypointInput(carrier.entrypoint),
  ).pipe(
    Result.mapError((issue) => ({
      entrypointKey: carrier.entrypoint.entrypointKey,
      file: carrier.file,
      moduleId: carrier.entrypoint.moduleKey,
      reason: `entrypoint descriptor is invalid: ${issue.message}`,
    })),
    Result.map((entrypoint) => ({ carrier, entrypoint })),
  );

const declaredOf = (decoded: DecodedCarrier): Result.Result<AccessDeclaration | null, AccessCatalogSnapshotProblem> =>
  decoded.carrier.accessDeclaration === null
    ? Result.succeed(null)
    : decodeAccessDeclaration(decoded.carrier.accessDeclaration, decoded.entrypoint).pipe(
        Result.mapError((failure) => ({
          entrypointKey: decoded.entrypoint.entrypointKey,
          file: decoded.carrier.file,
          moduleId: decoded.entrypoint.moduleKey,
          reason: `accessDeclaration is invalid: ${failure.reason}`,
        })),
      );

const missingDeclaration = (carrier: ScannedCarrier): AccessCatalogMissingDeclaration => ({
  authorizationKind: carrier.entrypoint.authorization.kind,
  carrier: carrier.carrier,
  entrypointKey: carrier.entrypoint.entrypointKey,
  file: carrier.file,
  moduleId: carrier.entrypoint.moduleKey,
  role: carrier.entrypoint.role,
});

const entrypointId = (entrypoint: ScannedEntrypoint): string =>
  `${entrypoint.moduleKey}\u0000${entrypoint.entrypointKey}`;

const snapshotEntry = (declared: DeclaredCarrier): AccessCatalogSnapshotEntry => ({
  agentPolicy: deriveAgentPolicy(declared.declaration),
  carrier: declared.carrier.carrier,
  entrypointKey: declared.entrypoint.entrypointKey,
  fieldClass: declared.declaration.fieldClass ?? null,
  fields: [],
  file: declared.carrier.file,
  key: declared.declaration.key,
  kind: declared.declaration.kind,
  moduleId: declared.entrypoint.moduleKey,
  parentKey: null,
  renamedFrom: declared.declaration.lineage?.renamedFrom ?? [],
  risk: declared.declaration.risk,
  splitFrom: declared.declaration.lineage?.splitFrom ?? null,
});

/** A field group is its own catalog entry, tied to the declaration of the same descriptor (O58). */
const groupSnapshotEntry = (declared: DeclaredCarrier, group: AccessFieldGroup): AccessCatalogSnapshotEntry => ({
  agentPolicy: deriveAgentPolicy(group),
  carrier: declared.carrier.carrier,
  entrypointKey: declared.entrypoint.entrypointKey,
  fieldClass: group.fieldClass,
  fields: group.fields,
  file: declared.carrier.file,
  key: group.key,
  kind: group.kind,
  moduleId: declared.entrypoint.moduleKey,
  parentKey: declared.declaration.key,
  renamedFrom: [],
  risk: group.risk,
  splitFrom: null,
});

const declaredSnapshotEntries = (declared: DeclaredCarrier): readonly AccessCatalogSnapshotEntry[] => [
  snapshotEntry(declared),
  ...declared.fieldGroups.map((group) => groupSnapshotEntry(declared, group)),
];

const catalogModule = (moduleId: string, declared: readonly DeclaredCarrier[]): AccessCatalogModule => ({
  descriptors: declared.map(({ declaration, entrypoint, fieldGroups }) =>
    fieldGroups.length === 0
      ? { accessDeclaration: declaration, entrypoint }
      : { accessDeclaration: declaration, accessFieldGroups: fieldGroups, entrypoint },
  ),
  moduleId,
});

const compareSnapshotEntries = (left: AccessCatalogSnapshotEntry, right: AccessCatalogSnapshotEntry): Ordering =>
  stableTextOrder(left.moduleId, right.moduleId) ||
  stableTextOrder(left.key, right.key) ||
  stableTextOrder(left.entrypointKey, right.entrypointKey);

const compareFindings = (left: AccessCatalogFinding, right: AccessCatalogFinding): Ordering =>
  stableTextOrder(left.moduleId, right.moduleId) || stableTextOrder(left.key, right.key);

const sortedFiles = (sources: readonly AccessCatalogSource[]): readonly AccessCatalogSource[] =>
  sortedBy(sources, (left, right) => stableTextOrder(left.file, right.file));

const scanSources = (sources: readonly AccessCatalogSource[]) => {
  const carriers: ScannedCarrier[] = [];
  const withoutCarrier: (ScannedEntrypoint & { readonly file: string })[] = [];
  const problems: ScannedProblem[] = [];
  const moduleSources = new Map(sources.map(({ file, source }) => [file, source] as const));
  for (const { file, source } of sortedFiles(sources)) {
    const scanned = scanAccessCatalogSource(source, file, moduleSources);
    carriers.push(...scanned.carriers);
    withoutCarrier.push(...scanned.entrypoints.map((entrypoint) => ({ ...entrypoint, file })));
    problems.push(...scanned.problems);
  }
  return { carriers, problems, withoutCarrier };
};

interface CatalogAccumulator {
  readonly declared: Map<string, DeclaredCarrier[]>;
  readonly invalid: AccessCatalogSnapshotProblem[];
  readonly missing: AccessCatalogMissingDeclaration[];
  readonly seenDeclarations: Set<string>;
  readonly seenMissing: Set<string>;
  readonly seenWorkloads: Set<string>;
  /** Entrypoints whose declaration requirement is settled, by an accessDeclaration or a workload. */
  readonly settledEntrypoints: Set<string>;
  readonly workloads: AccessCatalogWorkload[];
}

const carrierProblem = (carrier: ScannedCarrier, reason: string): AccessCatalogSnapshotProblem => ({
  entrypointKey: carrier.entrypoint.entrypointKey,
  file: carrier.file,
  moduleId: carrier.entrypoint.moduleKey,
  reason,
});

/** The carrier kinds a workload marker may sit on, alone or beside a declaration (O59, O67-Q4, O72). */
const WORKLOAD_CARRIERS: ReadonlySet<AccessCatalogCarrier> = new Set(['action', 'read']);

/** A workload marker settles the entrypoint without ever entering the configurable catalog (O59). */
const collectWorkload = (
  accumulator: CatalogAccumulator,
  carrier: ScannedCarrier,
  entrypoint: typeof ModuleEntrypointSchema.Type,
  id: string,
): void => {
  const { accessDeclaration, accessFieldGroups, accessWorkload } = carrier;
  if (accessWorkload === null) {
    return;
  }
  // O67-Q4, O72: an Action or a governed read may carry a workload marker beside its declaration
  // (the workload path never admits humans and the declaration path never admits workloads). Field
  // groups never sit beside a workload, and no other carrier may combine the two.
  if (accessFieldGroups !== null || (accessDeclaration !== null && !WORKLOAD_CARRIERS.has(carrier.carrier))) {
    accumulator.invalid.push(
      carrierProblem(
        carrier,
        'accessWorkload sits beside accessDeclaration only on an Action or a governed read, and never beside accessFieldGroups (O59, O67-Q4, O72)',
      ),
    );
    return;
  }
  const workload = decodeAccessWorkload(accessWorkload, entrypoint);
  if (Result.isFailure(workload)) {
    accumulator.invalid.push(carrierProblem(carrier, `accessWorkload is invalid: ${workload.failure.reason}`));
    return;
  }
  accumulator.settledEntrypoints.add(id);
  if (!accumulator.seenWorkloads.has(id)) {
    accumulator.seenWorkloads.add(id);
    accumulator.workloads.push({
      carrier: carrier.carrier,
      entrypointKey: entrypoint.entrypointKey,
      file: carrier.file,
      moduleId: entrypoint.moduleKey,
      reason: workload.success.reason,
      workloads: workload.success.workloads,
    });
  }
};

/**
 * One entrypoint may be carried twice (a page and its navigation entry): declaring either counts,
 * whichever copy the scan meets first. Missing entries are therefore settled after the whole scan.
 */
const collectCarrier = (
  accumulator: CatalogAccumulator,
  carrier: ScannedCarrier,
  callerAppIds: ReadonlySet<string>,
): void => {
  const entrypoint = decodeEntrypoint(carrier);
  if (Result.isFailure(entrypoint)) {
    accumulator.invalid.push(entrypoint.failure);
    return;
  }
  const id = entrypointId(carrier.entrypoint);
  collectWorkload(accumulator, carrier, entrypoint.success.entrypoint, id);
  if (carrier.accessWorkload !== null && carrier.accessDeclaration === null && carrier.accessActor === null) {
    // A workload-only carrier settles nothing here; a dual Action (O67-Q4) continues, because its
    // declaration is the human capability of the same descriptor.
    return;
  }
  const declared = declaredOf(entrypoint.success);
  if (Result.isFailure(declared)) {
    accumulator.invalid.push(declared.failure);
    return;
  }
  if (carrier.accessActor !== null) {
    // A module caller settles the entrypoint too, with or without a declaration (D5, D6). The `rights`
    // rule reads the carrier's own declaration, so the actor is checked after it is decoded.
    const actor = decodeCarrierActor(
      carrier.accessActor,
      entrypoint.success.entrypoint,
      declared.success ?? undefined,
      callerAppIds,
    );
    if (Result.isFailure(actor)) {
      accumulator.invalid.push(carrierProblem(carrier, `accessActor is invalid: ${actor.failure}`));
      return;
    }
    accumulator.settledEntrypoints.add(id);
  }
  if (declared.success === null) {
    if (carrier.accessFieldGroups !== null) {
      accumulator.invalid.push(
        carrierProblem(carrier, 'accessFieldGroups require the descriptor to declare its own accessDeclaration (O58)'),
      );
      return;
    }
    if (carrier.accessActor !== null) {
      // An identity-mode caller carries no catalog entry, so the entrypoint is settled, not missing.
      return;
    }
    const isProtected = PROTECTED_AUTHORIZATIONS.has(carrier.entrypoint.authorization.kind);
    if (isProtected && !accumulator.seenMissing.has(id)) {
      accumulator.seenMissing.add(id);
      accumulator.missing.push(missingDeclaration(carrier));
    }
    return;
  }
  const groups = carrier.accessFieldGroups ?? [];
  const fieldGroups =
    groups.length === 0
      ? Result.succeed<readonly AccessFieldGroup[]>([])
      : decodeAccessFieldGroups(groups, entrypoint.success.entrypoint, declared.success.key);
  if (Result.isFailure(fieldGroups)) {
    accumulator.invalid.push(carrierProblem(carrier, fieldGroups.failure.reason));
    return;
  }
  const declarationId = `${id}\u0000${declared.success.key}`;
  accumulator.settledEntrypoints.add(id);
  if (!accumulator.seenDeclarations.has(declarationId)) {
    accumulator.seenDeclarations.add(declarationId);
    const moduleId = entrypoint.success.entrypoint.moduleKey;
    accumulator.declared.set(moduleId, [
      ...(accumulator.declared.get(moduleId) ?? []),
      {
        carrier,
        declaration: declared.success,
        entrypoint: entrypoint.success.entrypoint,
        fieldGroups: fieldGroups.success,
      },
    ]);
  }
};

const emptyAccumulator = (problems: readonly ScannedProblem[]): CatalogAccumulator => ({
  declared: new Map(),
  invalid: problems.map((problem) => problem),
  missing: [],
  seenDeclarations: new Set(),
  seenMissing: new Set(),
  seenWorkloads: new Set(),
  settledEntrypoints: new Set(),
  workloads: [],
});

/**
 * Collects the catalog across every module through the Core `collectAccessCatalog`, degrading to
 * per-module collection so one invalid declaration never hides the rest of the repository.
 */
/**
 * The catalog of one set of sources. `callerAppIds` are the topology verticals the scanned revision declares
 * (`decodeTopologyCallerAppIds`): a module caller outside that set is refused.
 */
export const buildAccessCatalogSnapshot = (
  sources: readonly AccessCatalogSource[],
  callerAppIds: ReadonlySet<string>,
): AccessCatalogSnapshot => {
  const scanned = scanSources(sources);
  const accumulator = emptyAccumulator(scanned.problems);
  for (const carrier of scanned.carriers) {
    collectCarrier(accumulator, carrier, callerAppIds);
  }
  const modules = sortedBy(accumulator.declared.entries(), (left, right) => stableTextOrder(left[0], right[0])).map(
    ([moduleId, declared]) => catalogModule(moduleId, declared),
  );
  const findings: AccessCatalogFinding[] = [];
  const collectedAcrossModules = collectAccessCatalog(modules);
  if (Result.isSuccess(collectedAcrossModules)) {
    findings.push(...collectedAcrossModules.success.findings);
  } else {
    // Attribute the failure per module, so one rejected module does not hide the rest.
    for (const module of modules) {
      const collected = collectAccessCatalog([module]);
      if (Result.isFailure(collected)) {
        accumulator.invalid.push({
          entrypointKey: null,
          file: '',
          moduleId: module.moduleId,
          reason: `${collected.failure.code}: ${collected.failure.reason}`,
        });
      } else {
        findings.push(...collected.success.findings);
      }
    }
  }
  const entries = [...accumulator.declared.values()].flatMap((declared) => declared.flatMap(declaredSnapshotEntries));
  return {
    entries: sortedBy(entries, compareSnapshotEntries),
    entrypointsWithoutCarrier: sortedBy(
      scanned.withoutCarrier,
      (left, right) =>
        stableTextOrder(left.file, right.file) || stableTextOrder(left.entrypointKey, right.entrypointKey),
    ),
    findings: sortedBy(findings, compareFindings),
    invalid: sortedBy(
      accumulator.invalid,
      (left, right) =>
        stableTextOrder(left.file, right.file) || stableTextOrder(left.entrypointKey ?? '', right.entrypointKey ?? ''),
    ),
    missing: sortedBy(
      accumulator.missing.filter(
        (entry) => !accumulator.settledEntrypoints.has(`${entry.moduleId}\u0000${entry.entrypointKey}`),
      ),
      (left, right) =>
        stableTextOrder(left.file, right.file) || stableTextOrder(left.entrypointKey, right.entrypointKey),
    ),
    scannedFiles: sources.length,
    workloads: sortedBy(
      accumulator.workloads,
      (left, right) =>
        stableTextOrder(left.moduleId, right.moduleId) || stableTextOrder(left.entrypointKey, right.entrypointKey),
    ),
  };
};

const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Branded identifier schemas keep a module id from being passed where an entrypoint key belongs. */
const ModuleIdSchema = Schema.String.pipe(Schema.brand('AccessCatalogModuleId'), Schema.decodeTo(Schema.String));
const EntrypointKeySchema = Schema.String.pipe(
  Schema.brand('AccessCatalogEntrypointKey'),
  Schema.decodeTo(Schema.String),
);
const AccessKeySchema = Schema.String.pipe(Schema.brand('AccessCatalogKey'), Schema.decodeTo(Schema.String));
const KindSchema = Schema.Literals(ACCESS_CATALOG_KINDS);
const RiskSchema = Schema.Literals(ACCESS_CATALOG_RISKS);
const CarrierSchema = Schema.Literals(ACCESS_CATALOG_CARRIERS);

const CarrierCountSchema = Schema.Array(Schema.Struct({ count: CountSchema, value: CarrierSchema }));
const KindCountSchema = Schema.Array(Schema.Struct({ count: CountSchema, value: KindSchema }));
const RiskCountSchema = Schema.Array(Schema.Struct({ count: CountSchema, value: RiskSchema }));

const DeclaredAccessSchema = Schema.Struct({
  agentPolicy: Schema.Literals(['run', 'propose_only', 'never']),
  carrier: CarrierSchema,
  entrypointKey: EntrypointKeySchema,
  fieldClass: Schema.optionalKey(Schema.String),
  /** The governed paths of a field group entry; absent for a descriptor declaration. */
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  file: Schema.String,
  key: AccessKeySchema,
  kind: KindSchema,
  moduleId: ModuleIdSchema,
  /** The parent declaration key of a field group entry; absent for a descriptor declaration. */
  parentKey: Schema.optionalKey(AccessKeySchema),
  risk: RiskSchema,
});

const WorkloadSchema = Schema.Struct({
  carrier: CarrierSchema,
  entrypointKey: EntrypointKeySchema,
  file: Schema.String,
  moduleId: ModuleIdSchema,
  reason: Schema.String,
  workloads: Schema.Array(Schema.String),
});

const ModuleSummarySchema = Schema.Struct({
  declarations: CountSchema,
  findings: CountSchema,
  kinds: KindCountSchema,
  missingDeclarations: CountSchema,
  moduleId: ModuleIdSchema,
  protectedEntrypoints: CountSchema,
  risks: RiskCountSchema,
  workloadActions: CountSchema,
});

const CatalogFindingSchema = Schema.Struct({
  code: Schema.String,
  file: Schema.optionalKey(Schema.String),
  key: AccessKeySchema,
  moduleId: ModuleIdSchema,
  reason: Schema.String,
});

const MissingDeclarationSchema = Schema.Struct({
  authorizationKind: Schema.String,
  carrier: CarrierSchema,
  entrypointKey: EntrypointKeySchema,
  file: Schema.String,
  moduleId: ModuleIdSchema,
  role: Schema.String,
});

const SnapshotProblemSchema = Schema.Struct({
  entrypointKey: Schema.optionalKey(EntrypointKeySchema),
  file: Schema.String,
  moduleId: Schema.optionalKey(ModuleIdSchema),
  reason: Schema.String,
});

const NonCarrierEntrypointSchema = Schema.Struct({
  authorizationKind: Schema.String,
  entrypointKey: EntrypointKeySchema,
  file: Schema.String,
  moduleId: ModuleIdSchema,
  role: Schema.String,
});

export const AccessCatalogReportSchema = Schema.Struct({
  byCarrier: CarrierCountSchema,
  byKind: KindCountSchema,
  byRisk: RiskCountSchema,
  declared: Schema.Array(DeclaredAccessSchema),
  findings: Schema.Array(CatalogFindingSchema),
  invalid: Schema.Array(SnapshotProblemSchema),
  missing: Schema.Array(MissingDeclarationSchema),
  modules: Schema.Array(ModuleSummarySchema),
  nonCarrierEntrypoints: Schema.Array(NonCarrierEntrypointSchema),
  scannedFiles: CountSchema,
  schemaVersion: Schema.Literal(ACCESS_CATALOG_REPORT_SCHEMA_VERSION),
  totals: Schema.Struct({
    declarations: CountSchema,
    fieldGroups: CountSchema,
    findings: CountSchema,
    invalid: CountSchema,
    missing: CountSchema,
    modules: CountSchema,
    protectedEntrypoints: CountSchema,
    workloads: CountSchema,
  }),
  workloads: Schema.Array(WorkloadSchema),
});

export type AccessCatalogReport = typeof AccessCatalogReportSchema.Type;

interface Counted<Value extends string> {
  readonly count: number;
  readonly value: Value;
}

const countValues = <Value extends string>(
  values: readonly Value[],
  order: readonly Value[],
): readonly Counted<Value>[] => {
  const counts = new Map<Value, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  // The whole vocabulary is listed, so a zero count is information and not an omission.
  return order.map((value) => ({ count: counts.get(value) ?? 0, value }));
};

/** `<module>.<resource>.<verb>[.<qualifier>]`: only the segments after the resource carry a verb. */
const verbSegmentsOf = (moduleId: string, key: string): string =>
  key.startsWith(`${moduleId}.`)
    ? key
        .slice(moduleId.length + 1)
        .split('.')
        .slice(1)
        .join('.')
    : key;

/** Review items beyond the Core findings: dangerous verbs in the verb segments of a declared key. */
const dangerousVerbFindings = (snapshot: AccessCatalogSnapshot): readonly AccessCatalogReport['findings'][number][] =>
  snapshot.entries
    .filter((entry) => hasDangerousAccessVerb(verbSegmentsOf(entry.moduleId, entry.key)))
    .map((entry) => ({
      code: 'dangerous_verb',
      file: entry.file,
      key: entry.key,
      moduleId: entry.moduleId,
      reason: `dangerous verb declared as ${entry.risk}`,
    }));

const declaredReport = (entry: AccessCatalogSnapshotEntry): AccessCatalogReport['declared'][number] => {
  const base = {
    agentPolicy: entry.agentPolicy,
    carrier: entry.carrier,
    entrypointKey: entry.entrypointKey,
    file: entry.file,
    key: entry.key,
    kind: entry.kind,
    moduleId: entry.moduleId,
    risk: entry.risk,
  };
  const withFieldClass = entry.fieldClass === null ? base : { ...base, fieldClass: entry.fieldClass };
  const withParent = entry.parentKey === null ? withFieldClass : { ...withFieldClass, parentKey: entry.parentKey };
  return entry.fields.length === 0 ? withParent : { ...withParent, fields: [...entry.fields] };
};

/** Field group entries share the entrypoint of their parent, so entrypoints are counted once. */
const distinctEntrypoints = (entries: readonly AccessCatalogSnapshotEntry[]): number =>
  new Set(entries.map((entry) => `${entry.moduleId}\u0000${entry.entrypointKey}`)).size;

/** An entrypoint or module id that could not be resolved statically is omitted, not faked. */
const problemReport = (problem: AccessCatalogSnapshotProblem): AccessCatalogReport['invalid'][number] => {
  const base = { file: problem.file, reason: problem.reason };
  const withEntrypoint = problem.entrypointKey === null ? base : { ...base, entrypointKey: problem.entrypointKey };
  return problem.moduleId === null ? withEntrypoint : { ...withEntrypoint, moduleId: problem.moduleId };
};

/** Pure report over one snapshot: counts by module, kind, risk, gaps, findings and problems. */
export const buildAccessCatalogReport = (snapshot: AccessCatalogSnapshot): AccessCatalogReport => {
  const moduleIds = sortedBy(
    new Set([
      ...snapshot.entries.map((entry) => entry.moduleId),
      ...snapshot.missing.map((entry) => entry.moduleId),
      ...snapshot.workloads.map((entry) => entry.moduleId),
      ...snapshot.invalid.flatMap((entry) => (entry.moduleId === null ? [] : [entry.moduleId])),
    ]),
    stableTextOrder,
  );
  const findings = sortedBy(
    [
      ...snapshot.findings.map((finding) => ({
        code: finding.code,
        key: finding.key,
        moduleId: finding.moduleId,
        reason: finding.reason,
      })),
      ...dangerousVerbFindings(snapshot),
    ],
    (left, right) =>
      stableTextOrder(left.moduleId, right.moduleId) ||
      stableTextOrder(left.code, right.code) ||
      stableTextOrder(left.key, right.key),
  );
  const modules = moduleIds.map((moduleId) => {
    const entries = snapshot.entries.filter((entry) => entry.moduleId === moduleId);
    const missingDeclarations = snapshot.missing.filter((entry) => entry.moduleId === moduleId).length;
    const workloadActions = snapshot.workloads.filter((entry) => entry.moduleId === moduleId).length;
    return {
      declarations: entries.length,
      findings: findings.filter((finding) => finding.moduleId === moduleId).length,
      kinds: countValues(
        entries.map((entry) => entry.kind),
        ACCESS_CATALOG_KINDS,
      ),
      missingDeclarations,
      moduleId,
      protectedEntrypoints: distinctEntrypoints(entries) + missingDeclarations + workloadActions,
      risks: countValues(
        entries.map((entry) => entry.risk),
        ACCESS_CATALOG_RISKS,
      ),
      workloadActions,
    };
  });
  return {
    byCarrier: countValues(
      snapshot.entries.map((entry) => entry.carrier),
      ACCESS_CATALOG_CARRIERS,
    ),
    byKind: countValues(
      snapshot.entries.map((entry) => entry.kind),
      ACCESS_CATALOG_KINDS,
    ),
    byRisk: countValues(
      snapshot.entries.map((entry) => entry.risk),
      ACCESS_CATALOG_RISKS,
    ),
    declared: snapshot.entries.map(declaredReport),
    findings,
    invalid: snapshot.invalid.map(problemReport),
    missing: snapshot.missing.map((missing) => ({ ...missing })),
    modules,
    nonCarrierEntrypoints: snapshot.entrypointsWithoutCarrier.map((entrypoint) => ({
      authorizationKind: entrypoint.authorization.kind,
      entrypointKey: entrypoint.entrypointKey,
      file: entrypoint.file,
      moduleId: entrypoint.moduleKey,
      role: entrypoint.role,
    })),
    scannedFiles: snapshot.scannedFiles,
    schemaVersion: ACCESS_CATALOG_REPORT_SCHEMA_VERSION,
    totals: {
      declarations: snapshot.entries.length,
      fieldGroups: snapshot.entries.filter((entry) => entry.parentKey !== null).length,
      findings: findings.length,
      invalid: snapshot.invalid.length,
      missing: snapshot.missing.length,
      modules: modules.length,
      protectedEntrypoints: distinctEntrypoints(snapshot.entries) + snapshot.missing.length + snapshot.workloads.length,
      workloads: snapshot.workloads.length,
    },
    workloads: snapshot.workloads.map((workload) => ({ ...workload })),
  };
};

const countLine = (counts: readonly Counted<string>[]): string =>
  counts.length === 0 ? 'none' : counts.map(({ count, value }) => `${value} ${count}`).join(', ');

/** Compact, deterministic text view for a terminal or a review comment. */
export const renderAccessCatalogReportText = (report: AccessCatalogReport): string => {
  const lines = [
    'Authorization v2 access catalog (report only; no decision changes)',
    `Scanned ${report.scannedFiles} files: ${report.totals.declarations} declarations, ${report.totals.workloads} workload Actions, ${report.totals.protectedEntrypoints} protected entrypoints in ${report.totals.modules} modules.`,
    `Kinds: ${countLine(report.byKind)}`,
    `Risks: ${countLine(report.byRisk)}`,
    `Carriers: ${countLine(report.byCarrier)}`,
    '',
    'Modules:',
    ...report.modules.map(
      (module) =>
        `  ${module.moduleId}: ${module.declarations} declarations, ${module.workloadActions} workload Actions, ${module.protectedEntrypoints} protected entrypoints, ${module.missingDeclarations} missing, ${module.findings} findings (${countLine(module.risks)})`,
    ),
    '',
    `Missing declarations: ${report.totals.missing}`,
    ...report.missing.map(
      (missing) => `  ${missing.file}: ${missing.entrypointKey} (${missing.authorizationKind}, ${missing.role})`,
    ),
    '',
    `Field groups: ${report.totals.fieldGroups} (listed as their own entries beside their parent declaration)`,
    '',
    `Workload Actions: ${report.totals.workloads} (machine-only, never granted to humans or agents)`,
    ...report.workloads.map(
      (workload) =>
        `  ${workload.file}: ${workload.entrypointKey} [${workload.workloads.join(', ')}] (${workload.reason})`,
    ),
    '',
    `Findings: ${report.totals.findings}`,
    ...report.findings.map((finding) => `  ${finding.code} ${finding.key} (${finding.moduleId}): ${finding.reason}`),
    '',
    `Invalid declarations and unresolved carriers: ${report.totals.invalid}`,
    ...report.invalid.map(
      (invalid) => `  ${invalid.file}: ${invalid.entrypointKey ?? invalid.moduleId ?? ''} ${invalid.reason}`,
    ),
    '',
    `Entrypoints outside the declaration carriers: ${report.nonCarrierEntrypoints.length} (route metadata and similar).`,
  ];
  return `${lines.join('\n')}\n`;
};

/**
 * O62 makes declarations mandatory: the check fails on a gap instead of reporting it. Findings stay
 * report-only, because they are review items and not missing access metadata.
 */
export const accessCatalogGapReason = (report: AccessCatalogReport): string | null => {
  if (report.totals.missing === 0 && report.totals.invalid === 0) {
    return null;
  }
  const gaps: string[] = [];
  if (report.totals.missing > 0) {
    gaps.push(
      `${report.totals.missing} protected entrypoints declare no access: ${report.missing
        .map((missing) => `${missing.entrypointKey} (${missing.file})`)
        .join(', ')}`,
    );
  }
  if (report.totals.invalid > 0) {
    gaps.push(
      `${report.totals.invalid} invalid declarations: ${report.invalid
        .map((invalid) => `${invalid.file}: ${invalid.reason}`)
        .join('; ')}`,
    );
  }
  return `the Authorization v2 access catalog has gaps: ${gaps.join('; ')}`;
};

export interface AccessCatalogDiffSource {
  readonly entrypointKey: string;
  readonly file: string;
  readonly key: string;
  readonly kind: AccessCatalogKind;
  readonly moduleId: string;
  readonly renamedFrom: readonly string[];
  readonly risk: AccessCatalogRisk;
  readonly splitFrom: string | null;
}

export interface AccessCatalogDiffInput {
  readonly entries: readonly AccessCatalogDiffSource[];
}

const EntryChangeSchema = Schema.Struct({
  file: Schema.String,
  key: AccessKeySchema,
  kind: KindSchema,
  moduleId: ModuleIdSchema,
  risk: RiskSchema,
});

export const AccessCatalogDiffSchema = Schema.Struct({
  added: Schema.Array(EntryChangeSchema),
  baseRef: Schema.String,
  headRef: Schema.String,
  kindChanged: Schema.Array(
    Schema.Struct({ fromKind: KindSchema, key: AccessKeySchema, moduleId: ModuleIdSchema, toKind: KindSchema }),
  ),
  removed: Schema.Array(EntryChangeSchema),
  renamed: Schema.Array(
    Schema.Struct({
      fromKey: AccessKeySchema,
      key: AccessKeySchema,
      kind: KindSchema,
      moduleId: ModuleIdSchema,
      risk: RiskSchema,
    }),
  ),
  riskChanged: Schema.Array(
    Schema.Struct({ fromRisk: RiskSchema, key: AccessKeySchema, moduleId: ModuleIdSchema, toRisk: RiskSchema }),
  ),
  schemaVersion: Schema.Literal(ACCESS_CATALOG_DIFF_SCHEMA_VERSION),
  split: Schema.Array(
    Schema.Struct({ fromKey: AccessKeySchema, keys: Schema.Array(AccessKeySchema), moduleId: ModuleIdSchema }),
  ),
});
export type AccessCatalogDiff = typeof AccessCatalogDiffSchema.Type;

const qualifiedKey = (moduleId: string, key: string): string => `${moduleId}\u0000${key}`;

const entryCovers = (
  before: readonly AccessCatalogDiffSource[],
  key: string,
  moduleId: string,
): AccessCatalogDiffSource | null => before.find((entry) => entry.moduleId === moduleId && entry.key === key) ?? null;

const sortChanges = <Value extends { readonly key: string; readonly moduleId: string }>(
  values: readonly Value[],
): readonly Value[] =>
  sortedBy(
    values,
    (left, right) => stableTextOrder(left.moduleId, right.moduleId) || stableTextOrder(left.key, right.key),
  );

const changeSource = (entry: AccessCatalogDiffSource): AccessCatalogDiff['added'][number] => ({
  file: entry.file,
  key: entry.key,
  kind: entry.kind,
  moduleId: entry.moduleId,
  risk: entry.risk,
});

/** Rename and split predecessors, which their successors account for, are never plain removals. */
const lineagePredecessorsOf = (
  before: readonly AccessCatalogDiffSource[],
  after: readonly AccessCatalogDiffSource[],
): ReadonlySet<string> => {
  const predecessors = new Set<string>();
  for (const entry of after) {
    for (const predecessor of entry.renamedFrom) {
      if (entryCovers(before, predecessor, entry.moduleId) !== null) {
        predecessors.add(qualifiedKey(entry.moduleId, predecessor));
      }
    }
    const { splitFrom } = entry;
    if (splitFrom !== null && entryCovers(before, splitFrom, entry.moduleId) !== null) {
      predecessors.add(qualifiedKey(entry.moduleId, splitFrom));
    }
  }
  return predecessors;
};

const renamedChanges = (
  before: readonly AccessCatalogDiffSource[],
  after: readonly AccessCatalogDiffSource[],
): readonly AccessCatalogDiff['renamed'][number][] => {
  const changes: AccessCatalogDiff['renamed'][number][] = [];
  for (const entry of after) {
    for (const predecessor of entry.renamedFrom) {
      if (entryCovers(before, predecessor, entry.moduleId) !== null) {
        changes.push({
          fromKey: predecessor,
          key: entry.key,
          kind: entry.kind,
          moduleId: entry.moduleId,
          risk: entry.risk,
        });
      }
    }
  }
  return sortChanges(changes);
};

const splitChanges = (
  before: readonly AccessCatalogDiffSource[],
  after: readonly AccessCatalogDiffSource[],
): readonly AccessCatalogDiff['split'][number][] => {
  const grouped = new Map<string, { fromKey: string; keys: string[]; moduleId: string }>();
  for (const entry of after) {
    const { splitFrom } = entry;
    if (splitFrom !== null && entryCovers(before, splitFrom, entry.moduleId) !== null) {
      const id = qualifiedKey(entry.moduleId, splitFrom);
      const existing = grouped.get(id);
      grouped.set(id, {
        fromKey: splitFrom,
        keys: [...(existing?.keys ?? []), entry.key],
        moduleId: entry.moduleId,
      });
    }
  }
  return sortedBy(
    [...grouped.values()].map((change) => ({ ...change, keys: sortedBy(change.keys, stableTextOrder) })),
    (left, right) => stableTextOrder(left.moduleId, right.moduleId) || stableTextOrder(left.fromKey, right.fromKey),
  );
};

/**
 * Catalog delta between two revisions: the future Novinky items. A rename keeps identity, a split
 * registers both halves, a removal is a key nobody inherits, and a risk change is a review item.
 */
export const buildAccessCatalogDiff = (
  before: AccessCatalogDiffInput,
  after: AccessCatalogDiffInput,
  refs: { readonly baseRef: string; readonly headRef: string },
): AccessCatalogDiff => {
  const beforeKeys = new Set(before.entries.map((entry) => qualifiedKey(entry.moduleId, entry.key)));
  const afterKeys = new Set(after.entries.map((entry) => qualifiedKey(entry.moduleId, entry.key)));
  const lineagePredecessors = lineagePredecessorsOf(before.entries, after.entries);
  return {
    added: sortChanges(
      after.entries.filter((entry) => !beforeKeys.has(qualifiedKey(entry.moduleId, entry.key))).map(changeSource),
    ),
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    kindChanged: sortChanges(
      after.entries.flatMap((entry) => {
        const previous = entryCovers(before.entries, entry.key, entry.moduleId);
        return previous !== null && previous.kind !== entry.kind
          ? [{ fromKind: previous.kind, key: entry.key, moduleId: entry.moduleId, toKind: entry.kind }]
          : [];
      }),
    ),
    removed: sortChanges(
      before.entries
        .filter((entry) => !afterKeys.has(qualifiedKey(entry.moduleId, entry.key)))
        .filter((entry) => !lineagePredecessors.has(qualifiedKey(entry.moduleId, entry.key)))
        .map(changeSource),
    ),
    renamed: renamedChanges(before.entries, after.entries),
    riskChanged: sortChanges(
      after.entries.flatMap((entry) => {
        const previous = entryCovers(before.entries, entry.key, entry.moduleId);
        return previous !== null && previous.risk !== entry.risk
          ? [{ fromRisk: previous.risk, key: entry.key, moduleId: entry.moduleId, toRisk: entry.risk }]
          : [];
      }),
    ),
    schemaVersion: ACCESS_CATALOG_DIFF_SCHEMA_VERSION,
    split: splitChanges(before.entries, after.entries),
  };
};

/** Deterministic text view of a catalog delta. */
export const renderAccessCatalogDiffText = (diff: AccessCatalogDiff): string => {
  const lines = [
    `Authorization v2 access catalog diff ${diff.baseRef}..${diff.headRef} (report only)`,
    `Added ${diff.added.length}, removed ${diff.removed.length}, renamed ${diff.renamed.length}, split ${diff.split.length}, risk changed ${diff.riskChanged.length}, kind changed ${diff.kindChanged.length}`,
    ...diff.added.map((entry) => `  added ${entry.key} (${entry.kind}, ${entry.risk}) in ${entry.file}`),
    ...diff.removed.map((entry) => `  removed ${entry.key} (${entry.kind}, ${entry.risk}) from ${entry.file}`),
    ...diff.renamed.map((entry) => `  renamed ${entry.fromKey} -> ${entry.key} (${entry.kind}, ${entry.risk})`),
    ...diff.split.map((entry) => `  split ${entry.fromKey} -> ${entry.keys.join(', ')}`),
    ...diff.riskChanged.map((entry) => `  risk ${entry.key}: ${entry.fromRisk} -> ${entry.toRisk}`),
    ...diff.kindChanged.map((entry) => `  kind ${entry.key}: ${entry.fromKind} -> ${entry.toKind}`),
  ];
  return `${lines.join('\n')}\n`;
};

/** A source file counts when it can declare an entrypoint at all; the scan does the rest. */
export const isAccessCatalogSourcePath = (file: string): boolean => {
  const normalized = `/${file.replaceAll('\\', '/')}`;
  const skipped = SKIPPED_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
  return !skipped && SOURCE_FILE_PATTERN.test(normalized);
};
