/**
 * Proposal-only transport upgrade for Action HTTP artifacts that already exist (O80/O85).
 *
 * The full Action HTTP scaffold renders every artifact from scratch. That is right for a fresh
 * scaffold, but it is the wrong tool for an endpoint that already carries owner decisions: a catalog
 * Action maps `SizePersistenceConflict` onto four distinct HTTP problems and names its own recovery
 * resolution, and an assortment Action reads the idempotency key from the handler headers. Rendering
 * such a file again replaces the owner's domain semantics with the generator's defaults.
 *
 * This module therefore applies exactly the edits a parked-proposal transport needs, and nothing
 * else:
 *
 * - the shared contract answers a parked proposal with `202` on the success channel, importing and
 *   re-exporting Core's `ActionProposalAcceptedSchema` (one wire shape, browser-safe module);
 * - the trusted server handler declares `successContract: 'result-or-proposal'`, so the runner it
 *   binds can answer the 202 its contract declares;
 * - the generated client offers the explicit, optional `intent: 'propose'`, so a caller states the
 *   intent instead of having its refusal turned into a proposal.
 * - an existing closed 403 schema includes Core's `action_approval_required` refusal without changing
 *   any owner error code, status, or problem projection.
 *
 * Every other byte stays where the owner put it: owner error schema literals, problem mappers, recovery
 * text, custom server header decoding, custom client composition, and the argument position of the
 * owner's runtime services. Barrels, package files and problem mappers are never part of this plan.
 *
 * Edits are located through the TypeScript scanner rather than by re-rendering the file, and every
 * unsupported or ambiguous source shape fails closed before a mutation exists.
 */
import { LanguageVariant, SyntaxKind, createScanner } from '@typescript/native/unstable/ast';
import { Effect, FileSystem, Schema, SchemaAST } from 'effect';
import { hasRuntimeNamedSourceImport } from '../../generated-governed-http-boundary.mts';

import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  ACTION_HTTP_GENERATED_HEADER,
  inspectAction,
  isProposableActionDeclaration,
  validateActionRuntimeIdentity,
  validateActionSources,
  validatePublicActionSchemas,
} from './scaffold.mts';
import {
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  formatGeneratedMutationContent,
  raiseScaffoldFailure,
  requireCanonicalSlug,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  tryScaffold,
} from '../shared.mts';
import type { ActionHttpScaffoldConfig, ActionHttpScaffoldResult, Mutation, ScaffoldFailure } from '../shared.mts';

/** The one Core module that owns the accepted-proposal wire shape; safe for a browser client too. */
const PROPOSAL_MODULE = '@app/core-runtime/http/action-proposal';
const PROPOSAL_SCHEMA = 'ActionProposalAcceptedSchema';
const PROPOSAL_IMPORT = `import { ${PROPOSAL_SCHEMA} } from '${PROPOSAL_MODULE}';`;
const PROPOSAL_EXPORT = `export { ${PROPOSAL_SCHEMA} } from '${PROPOSAL_MODULE}';`;
const PROPOSAL_CONTRACT_VALUE = "'result-or-proposal'";
const PROPOSAL_SUCCESS_CONTRACT = `successContract: ${PROPOSAL_CONTRACT_VALUE},`;
const PROPOSAL_INTENT_VALUE = "'propose'";
const PROPOSAL_INTENT = `readonly intent?: ${PROPOSAL_INTENT_VALUE};`;
/** O80: the intent is optional and never inferred, so a refusal is never converted for the caller. */
const PROPOSAL_INTENT_MEMBERS: readonly string[] = [
  '/**',
  ' * O80: ask for a parked proposal instead of an immediate write. Omitted means the ordinary run, so a',
  " * refusal is never turned into a proposal on the caller's behalf.",
  ' */',
  PROPOSAL_INTENT,
];
const PROPOSAL_INTENT_MEMBER_TOKENS: readonly string[] = ['readonly', 'intent', '?', ':', PROPOSAL_INTENT_VALUE];
const PROPOSAL_INTENT_WIRING_TOKENS: readonly string[] = ['options', '.', 'intent'];
const PROPOSAL_INTENT_WIRING = 'intent: options.intent,';
const PROBLEM_DETAILS_MODULE = '@app/shared-contracts/problem-details';
const CLIENT_OPTIONS_SUFFIX = 'ActionClientOptions';
const GOVERNED_CLIENT_FACTORY = 'makeGovernedEffectBffClient';
const GOVERNED_RUNNER_FACTORY = 'bindActionHttpRunner';

const ActionHttpProposalArtifactKindSchema = Schema.Literals(['client', 'contract', 'server']);
type ActionHttpProposalArtifactKind = typeof ActionHttpProposalArtifactKindSchema.Type;

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

interface SourceToken {
  readonly end: number;
  readonly kind: SyntaxKind;
  readonly start: number;
  readonly text: string;
}

/**
 * A template literal resumes its own interpolation, so a plain `scan()` loop would swallow the rest
 * of the file after the first `` `...${ ``. The scanner is asked to re-scan the closing brace instead.
 */
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

const trackTemplateToken = (
  scanner: ReturnType<typeof createScanner>,
  kind: SyntaxKind,
  depths: number[],
): SyntaxKind => {
  if (kind === SyntaxKind.TemplateHead) {
    depths.push(0);
    return kind;
  }
  if (depths.length === 0) {
    return kind;
  }
  const index = depths.length - 1;
  if (kind === SyntaxKind.OpenBraceToken) {
    depths[index] = (depths[index] ?? 0) + 1;
    return kind;
  }
  return kind === SyntaxKind.CloseBraceToken ? rescanTemplateClose(scanner, depths) : kind;
};

/** Trivia-free tokens with their byte span, so an edit can splice the original source exactly. */
const tokenizeSource = (source: string): readonly SourceToken[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: SourceToken[] = [];
  const templateDepths: number[] = [];
  let scanned = scanner.scan();
  while (scanned !== SyntaxKind.EndOfFile) {
    // The native scanner returns a zero-width PrivateIdentifier for a bare `#` in a regexp.
    if (scanned === SyntaxKind.PrivateIdentifier && scanner.getTokenStart() === scanner.getTokenEnd()) {
      scanned = scanner.reScanHashToken();
    }
    const kind = trackTemplateToken(scanner, scanned, templateDepths);
    tokens.push({ end: scanner.getTokenEnd(), kind, start: scanner.getTokenStart(), text: scanner.getTokenText() });
    scanned = scanner.scan();
  }
  return tokens;
};

const matchDelimiters = (tokens: readonly SourceToken[]): ReadonlyMap<number, number> => {
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

interface TokenCursor {
  readonly matches: ReadonlyMap<number, number>;
  readonly tokens: readonly SourceToken[];
}

const cursorOf = (source: string): TokenCursor => {
  const tokens = tokenizeSource(source);
  return { matches: matchDelimiters(tokens), tokens };
};

const tokenAt = (cursor: TokenCursor, index: number): SourceToken => {
  const token = cursor.tokens.at(index);
  if (token === undefined) {
    return raiseScaffoldFailure('expected one Action HTTP source token');
  }
  return token;
};

/** The index after `index`, stepping over one balanced container when the token opens one. */
const advanceCursor = (cursor: TokenCursor, index: number): number => {
  const token = cursor.tokens.at(index);
  if (token === undefined || !OPEN_DELIMITERS.has(token.kind)) {
    return index + 1;
  }
  return (cursor.matches.get(index) ?? index) + 1;
};

const containerClose = (cursor: TokenCursor, openIndex: number, label: string): number => {
  const close = cursor.matches.get(openIndex);
  if (close === undefined) {
    return raiseScaffoldFailure(`expected one closed ${label}`);
  }
  return close;
};

const isIdentifier = (token: SourceToken | undefined, text: string): boolean =>
  token !== undefined && token.kind === SyntaxKind.Identifier && token.text === text;

const identifierIndexes = (cursor: TokenCursor, text: string): readonly number[] =>
  cursor.tokens.flatMap((token, index) => (isIdentifier(token, text) ? [index] : []));

const sameTokens = (tokens: readonly SourceToken[], expected: readonly string[]): boolean =>
  tokens.length === expected.length && tokens.every((token, index) => token.text === expected.at(index));

const stringLiteralValue = (token: SourceToken | undefined): string | undefined =>
  token?.kind === SyntaxKind.StringLiteral ? token.text.slice(1, -1) : undefined;

interface SourceMember {
  /** The identifier or literal key; `null` for a computed key, spread or index signature. */
  readonly first: number;
  readonly name: string | null;
  readonly nameIndex: number;
  /** Index of the token that terminates this member: its separator, or its own last token. */
  readonly separator: number;
  readonly valueFirst: number | null;
  readonly valueLast: number | null;
}

const memberName = (token: SourceToken | undefined, index: number): Pick<SourceMember, 'name' | 'nameIndex'> => {
  if (token?.kind === SyntaxKind.Identifier) {
    return { name: token.text, nameIndex: index };
  }
  if (token?.kind === SyntaxKind.StringLiteral || token?.kind === SyntaxKind.NumericLiteral) {
    return { name: token.text.slice(1, -1), nameIndex: index };
  }
  return { name: null, nameIndex: index };
};

/** Member modifiers a declaration may carry before its own key (`readonly idempotencyKey: string`). */
const MEMBER_MODIFIER_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AbstractKeyword,
  SyntaxKind.AccessorKeyword,
  SyntaxKind.DeclareKeyword,
  SyntaxKind.OverrideKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.StaticKeyword,
]);

const memberKeyIndex = (cursor: TokenCursor, first: number, last: number): number => {
  let index = first;
  while (index < last) {
    const kind = cursor.tokens.at(index)?.kind;
    if (kind === undefined || !MEMBER_MODIFIER_KINDS.has(kind)) {
      break;
    }
    index += 1;
  }
  return index;
};

const readMember = (cursor: TokenCursor, first: number, last: number, separator: number): SourceMember => {
  const nameIndex = memberKeyIndex(cursor, first, last);
  const identity = memberName(cursor.tokens.at(nameIndex), nameIndex);
  let colon: number | null = null;
  let index = nameIndex;
  while (index <= last) {
    if (cursor.tokens.at(index)?.kind === SyntaxKind.ColonToken) {
      colon = index;
      break;
    }
    index = advanceCursor(cursor, index);
  }
  if (colon === null || colon >= last) {
    return { first, ...identity, separator, valueFirst: null, valueLast: null };
  }
  return { first, ...identity, separator, valueFirst: colon + 1, valueLast: last };
};

/** One `key: value`, shorthand `key`, spread or index-signature member of a delimited body. */
const readMembers = (
  cursor: TokenCursor,
  openIndex: number,
  separatorKind: SyntaxKind,
  label: string,
): readonly SourceMember[] => {
  const close = containerClose(cursor, openIndex, label);
  const members: SourceMember[] = [];
  let index = openIndex + 1;
  while (index < close) {
    if (cursor.tokens.at(index)?.kind === separatorKind) {
      index += 1;
      continue;
    }
    const first = index;
    let separator: number | undefined;
    let scan = index;
    while (scan < close) {
      if (cursor.tokens.at(scan)?.kind === separatorKind) {
        separator = scan;
        break;
      }
      scan = advanceCursor(cursor, scan);
    }
    const last = (separator ?? close) - 1;
    if (last < first) {
      return raiseScaffoldFailure(`${label} contains a member without content`);
    }
    members.push(readMember(cursor, first, last, separator ?? last));
    index = (separator ?? close) + 1;
  }
  return members;
};

const objectMembers = (cursor: TokenCursor, openIndex: number): readonly SourceMember[] =>
  readMembers(cursor, openIndex, SyntaxKind.CommaToken, 'object literal');

const interfaceMembers = (cursor: TokenCursor, openIndex: number): readonly SourceMember[] =>
  readMembers(cursor, openIndex, SyntaxKind.SemicolonToken, 'interface body');

const findMember = (members: readonly SourceMember[], name: string): SourceMember | undefined =>
  members.find((member) => member.name === name);

const requireMember = (members: readonly SourceMember[], name: string, label: string): SourceMember => {
  const found = members.filter((member) => member.name === name);
  const [only] = found;
  if (only === undefined) {
    return raiseScaffoldFailure(`${label} lacks ${name}`);
  }
  if (found.length > 1) {
    return raiseScaffoldFailure(`${label} declares ${name} more than once`);
  }
  return only;
};

const memberValueTokens = (cursor: TokenCursor, member: SourceMember): readonly SourceToken[] =>
  member.valueFirst === null || member.valueLast === null
    ? []
    : cursor.tokens.slice(member.valueFirst, member.valueLast + 1);

/** The member's own tokens, including leading modifiers and its trailing separator. */
const memberTokens = (cursor: TokenCursor, member: SourceMember): readonly SourceToken[] =>
  cursor.tokens.slice(member.first, (member.valueLast ?? member.separator) + 1);

interface SourceEdit {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const applySourceEdits = (source: string, edits: readonly SourceEdit[]): string => {
  let current = source;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    current = `${current.slice(0, edit.start)}${edit.text}${current.slice(edit.end)}`;
  }
  return current;
};

const lineStartOf = (source: string, offset: number): number => source.lastIndexOf('\n', offset - 1) + 1;

const indentationAt = (source: string, offset: number): string =>
  /^[ \t]*/u.exec(source.slice(lineStartOf(source, offset)))?.[0] ?? '';

const isInlineAnchor = (source: string, tokenStart: number): boolean =>
  !/^[ \t]*$/u.test(source.slice(lineStartOf(source, tokenStart), tokenStart));

/** One line inserted before the token, keeping the owner's own indentation. */
const lineBeforeEdit = (source: string, tokenStart: number, line: string): SourceEdit =>
  isInlineAnchor(source, tokenStart)
    ? { end: tokenStart, start: tokenStart, text: `${line} ` }
    : {
        end: lineStartOf(source, tokenStart),
        start: lineStartOf(source, tokenStart),
        text: `${indentationAt(source, tokenStart)}${line}\n`,
      };

/** A documented member block inserted before the token; a doc comment never lands on a code line. */
const blockBeforeEdit = (source: string, tokenStart: number, lines: readonly string[]): SourceEdit => {
  if (isInlineAnchor(source, tokenStart)) {
    return raiseScaffoldFailure('generated member block must start its own line');
  }
  const indentation = indentationAt(source, tokenStart);
  const separator = `\n${indentation}`;
  return {
    end: lineStartOf(source, tokenStart),
    start: lineStartOf(source, tokenStart),
    text: `${indentation}${lines.join(separator)}\n`,
  };
};

/** One property inserted after the token that ends the previous member, on its own line or inline. */
const lineAfterEdit = (source: string, tokenEnd: number, line: string): SourceEdit => {
  const tail = /^[ \t]*/u.exec(source.slice(tokenEnd))?.[0] ?? '';
  return tail.length > 0
    ? { end: tokenEnd, start: tokenEnd, text: ` ${line}` }
    : { end: tokenEnd, start: tokenEnd, text: `\n${indentationAt(source, tokenEnd)}${line}` };
};

interface ModuleStatement {
  readonly end: number;
  readonly kind: 'export' | 'import';
  readonly names: readonly string[];
  readonly source: string | undefined;
}

const statementEnd = (cursor: TokenCursor, start: number): number => {
  let index = start;
  while (index < cursor.tokens.length) {
    if (cursor.tokens.at(index)?.kind === SyntaxKind.SemicolonToken) {
      return index;
    }
    index = advanceCursor(cursor, index);
  }
  return raiseScaffoldFailure('expected one terminated module statement');
};

const statementNames = (cursor: TokenCursor, start: number, end: number): readonly string[] => {
  const names: string[] = [];
  let index = start + 1;
  while (index < end) {
    const token = tokenAt(cursor, index);
    if (token.kind === SyntaxKind.OpenBraceToken) {
      const close = containerClose(cursor, index, 'named import or export list');
      for (let member = index + 1; member < close; member += 1) {
        const candidate = cursor.tokens.at(member);
        if (candidate?.kind === SyntaxKind.Identifier) {
          names.push(candidate.text);
        }
      }
      index = close + 1;
      continue;
    }
    if (token.kind === SyntaxKind.Identifier) {
      names.push(token.text);
    }
    index = advanceCursor(cursor, index);
  }
  return names;
};

const statementSource = (cursor: TokenCursor, start: number, end: number): string | undefined => {
  let index = start;
  let from: number | undefined;
  while (index < end) {
    if (cursor.tokens.at(index)?.kind === SyntaxKind.FromKeyword) {
      from = index;
    }
    index = advanceCursor(cursor, index);
  }
  return from === undefined ? undefined : stringLiteralValue(cursor.tokens.at(from + 1));
};

/** Every top-level `import`/`export` statement, so an existing proposal statement is never re-added. */
const moduleStatements = (cursor: TokenCursor): readonly ModuleStatement[] => {
  const statements: ModuleStatement[] = [];
  let index = 0;
  while (index < cursor.tokens.length) {
    const token = tokenAt(cursor, index);
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) {
      index = advanceCursor(cursor, index);
      continue;
    }
    const end = statementEnd(cursor, index);
    statements.push({
      end,
      kind: token.kind === SyntaxKind.ImportKeyword ? 'import' : 'export',
      names: statementNames(cursor, index, end),
      source: statementSource(cursor, index, end),
    });
    index = end + 1;
  }
  return statements;
};

const requireActionHttpOwnership = (source: string, moduleId: string, action: string, label: string): void => {
  const expected = `${ACTION_HTTP_GENERATED_HEADER}\n// @ontos-action-http-owner ${moduleId}\n// @ontos-action-http-slug ${action}\n`;
  if (!source.startsWith(expected)) {
    return raiseScaffoldFailure(`${label} is not the generated Action HTTP artifact for ${moduleId}/${action}`);
  }
};

/**
 * An existing proposal statement is only ours when it names the one Core owner module. A statement
 * that names the schema from anywhere else fails closed instead of being rewritten.
 */
const hasProposalStatement = (
  statements: readonly ModuleStatement[],
  kind: ModuleStatement['kind'],
  moduleId: string,
  action: string,
): boolean => {
  const mentioning = statements.filter((statement) => statement.names.includes(PROPOSAL_SCHEMA));
  if (mentioning.some((statement) => statement.source !== PROPOSAL_MODULE)) {
    return raiseScaffoldFailure(`${PROPOSAL_SCHEMA} must come from ${PROPOSAL_MODULE} in ${moduleId}/${action}`);
  }
  const authorized = mentioning.filter((statement) => statement.kind === kind);
  if (authorized.length > 1) {
    return raiseScaffoldFailure(`Action HTTP artifact for ${moduleId}/${action} repeats the proposal ${kind}`);
  }
  return authorized.length === 1;
};

interface ArgumentSpan {
  readonly first: number;
  readonly last: number;
}

const callArguments = (cursor: TokenCursor, openIndex: number): readonly ArgumentSpan[] => {
  const close = containerClose(cursor, openIndex, 'call');
  const spans: ArgumentSpan[] = [];
  let index = openIndex + 1;
  let first = index;
  while (index < close) {
    if (cursor.tokens.at(index)?.kind === SyntaxKind.CommaToken) {
      spans.push({ first, last: index - 1 });
      index += 1;
      first = index;
      continue;
    }
    index = advanceCursor(cursor, index);
  }
  if (close > first) {
    spans.push({ first, last: close - 1 });
  }
  return spans;
};

/** Whether this argument span is exactly one whole object literal. */
const isWholeObjectArgument = (cursor: TokenCursor, span: ArgumentSpan): boolean =>
  cursor.tokens.at(span.first)?.kind === SyntaxKind.OpenBraceToken && cursor.matches.get(span.first) === span.last;

/** The argument list of the one `name` call, so a second call site fails closed. */
const invokeArguments = (cursor: TokenCursor, name: string, label: string): readonly ArgumentSpan[] => {
  const sites = identifierIndexes(cursor, name).filter(
    (index) => cursor.tokens.at(index + 1)?.kind === SyntaxKind.OpenParenToken,
  );
  const [site] = sites;
  if (site === undefined) {
    return raiseScaffoldFailure(`${label} never invokes ${name}`);
  }
  if (sites.length > 1) {
    return raiseScaffoldFailure(`${label} invokes ${name} more than once`);
  }
  return callArguments(cursor, site + 1);
};

/** The open index of the whole object literal at `position` in one call's argument list. */
const objectArgumentAt = (
  cursor: TokenCursor,
  spans: readonly ArgumentSpan[],
  name: string,
  label: string,
  position: number,
): number => {
  const span = spans.at(position);
  if (span === undefined || !isWholeObjectArgument(cursor, span)) {
    return raiseScaffoldFailure(`${label} must pass one options object to ${name}`);
  }
  return span.first;
};

/** The open index of the one object literal passed as the only argument of the one runner call. */
const soleObjectArgument = (cursor: TokenCursor, name: string, label: string): number => {
  const spans = invokeArguments(cursor, name, label);
  if (spans.length !== 1) {
    return raiseScaffoldFailure(`${label} must pass one options object to ${name}`);
  }
  return objectArgumentAt(cursor, spans, name, label, 0);
};

export interface ActionHttpProposalContractInput {
  readonly action: string;
  readonly appId: string;
  readonly content: string;
  readonly moduleId: string;
}

interface EndpointCall {
  readonly argumentsOpen: number;
  readonly method: string;
  readonly route: string | undefined;
}

const endpointCallAt = (cursor: TokenCursor, index: number): EndpointCall | undefined => {
  const method = cursor.tokens.at(index + 2);
  if (!isIdentifier(cursor.tokens.at(index), 'HttpApiEndpoint')) {
    return undefined;
  }
  if (cursor.tokens.at(index + 1)?.kind !== SyntaxKind.DotToken || method?.kind !== SyntaxKind.Identifier) {
    return undefined;
  }
  if (cursor.tokens.at(index + 3)?.kind !== SyntaxKind.OpenParenToken) {
    return undefined;
  }
  const route = callArguments(cursor, index + 3).at(1);
  return {
    argumentsOpen: index + 3,
    method: method.text,
    route: route === undefined ? undefined : stringLiteralValue(cursor.tokens.at(route.first)),
  };
};

const endpointCalls = (cursor: TokenCursor): readonly EndpointCall[] =>
  cursor.tokens.flatMap((_token, index) => {
    const call = endpointCallAt(cursor, index);
    return call === undefined ? [] : [call];
  });

const endpointOptionsOpen = (cursor: TokenCursor, action: string, appId: string): number => {
  const route = `/${appId}/actions/${action}`;
  const matches = endpointCalls(cursor).filter((call) => call.route === route);
  const [only] = matches;
  if (only === undefined) {
    return raiseScaffoldFailure(`Action HTTP contract for ${action} has no ${route} endpoint`);
  }
  if (matches.length > 1) {
    return raiseScaffoldFailure(`Action HTTP contract for ${action} declares ${route} more than once`);
  }
  if (only.method !== 'post') {
    return raiseScaffoldFailure(`Action HTTP contract for ${action} must declare ${route} as a post endpoint`);
  }
  const spans = callArguments(cursor, only.argumentsOpen);
  const options = spans.at(2);
  if (spans.length !== 3 || options === undefined || !isWholeObjectArgument(cursor, options)) {
    return raiseScaffoldFailure(`Action HTTP endpoint for ${action} must pass one options object`);
  }
  return options.first;
};

const successEdit = (cursor: TokenCursor, action: string, optionsOpen: number): SourceEdit | undefined => {
  const success = requireMember(objectMembers(cursor, optionsOpen), 'success', `Action HTTP endpoint for ${action}`);
  const tokens = memberValueTokens(cursor, success);
  const [first] = tokens;
  if (first?.kind === SyntaxKind.OpenBracketToken && tokens.at(-1)?.kind === SyntaxKind.CloseBracketToken) {
    const members = tokens.slice(1, -1);
    if (
      (members.length === 3 || (members.length === 4 && members.at(3)?.kind === SyntaxKind.CommaToken)) &&
      isIdentifier(members.at(0), PROPOSAL_SCHEMA) &&
      members.at(1)?.kind === SyntaxKind.CommaToken &&
      members.at(2)?.kind === SyntaxKind.Identifier &&
      !isIdentifier(members.at(2), PROPOSAL_SCHEMA)
    ) {
      return undefined;
    }
    return raiseScaffoldFailure(`Action HTTP endpoint for ${action} already declares an unsupported success union`);
  }
  if (tokens.length !== 1 || first === undefined || first.kind !== SyntaxKind.Identifier) {
    return raiseScaffoldFailure(`Action HTTP endpoint for ${action} success schema is not one named result schema`);
  }
  return { end: first.end, start: first.start, text: `[${PROPOSAL_SCHEMA}, ${first.text}]` };
};

/** Preserve the existing named result, including owner-shared result schemas. */
const resultSchemaNameOf = (content: string, action: string, appId: string): string => {
  const cursor = cursorOf(content);
  const options = endpointOptionsOpen(cursor, action, appId);
  // Apply the same shape checks as the actual upgrade before selecting a schema name.
  successEdit(cursor, action, options);
  const success = requireMember(objectMembers(cursor, options), 'success', `Action HTTP endpoint for ${action}`);
  const tokens = memberValueTokens(cursor, success);
  const result = tokens.at(tokens.at(0)?.kind === SyntaxKind.OpenBracketToken ? 3 : 0);
  return result?.text ?? raiseScaffoldFailure(`Action HTTP endpoint for ${action} has no named result`);
};

const exportedInitializer = (cursor: TokenCursor, name: string): number | undefined => {
  const declarations = identifierIndexes(cursor, name).filter(
    (index) =>
      cursor.tokens.at(index - 1)?.kind === SyntaxKind.ConstKeyword &&
      cursor.tokens.at(index - 2)?.kind === SyntaxKind.ExportKeyword &&
      cursor.tokens.at(index + 1)?.kind === SyntaxKind.FirstAssignment,
  );
  if (declarations.length > 1) {
    return raiseScaffoldFailure(`Action HTTP contract repeats exported ${name}`);
  }
  const declaration = declarations.at(0);
  return declaration === undefined ? undefined : declaration + 2;
};

const requireSchemaNamespace = (content: string): void => {
  if (!hasRuntimeNamedSourceImport(content, 'Schema', 'Schema', '@modern-js/bff-effect/effect-client')) {
    return raiseScaffoldFailure('Action HTTP contract needs its genuine runtime Schema import');
  }
};

const forbiddenSchemaOptions = (cursor: TokenCursor, initializer: number, type: string): number => {
  const args = callArguments(cursor, initializer + 1);
  const tag = args.at(0);
  const status = args.at(1);
  if (
    args.length !== 3 ||
    tag?.first !== tag?.last ||
    stringLiteralValue(cursor.tokens.at(tag?.first ?? -1)) !== `${type}ActionForbiddenProblem` ||
    status?.first !== status?.last ||
    cursor.tokens.at(status?.first ?? -1)?.text !== '403'
  ) {
    return raiseScaffoldFailure('Action HTTP forbidden schema must retain its exact tag and 403 status');
  }
  const options = objectArgumentAt(cursor, args, 'makeProblemDetailsSchema', 'Action HTTP forbidden schema', 2);
  return options;
};

const forbiddenCodeLiterals = (cursor: TokenCursor, options: number): readonly SourceToken[] => {
  const code = requireMember(objectMembers(cursor, options), 'code', 'Action HTTP forbidden schema');
  const tokens = memberValueTokens(cursor, code);
  if (
    !sameTokens(tokens.slice(0, 5), ['Schema', '.', 'Literals', '(', '[']) ||
    !sameTokens(tokens.slice(-2), [']', ')'])
  ) {
    return raiseScaffoldFailure('Action HTTP forbidden codes must be one closed literal list');
  }
  const codeTokens = tokens.slice(5, -2);
  if (
    codeTokens.some(
      (token, index) => token.kind !== (index % 2 === 0 ? SyntaxKind.StringLiteral : SyntaxKind.CommaToken),
    )
  ) {
    return raiseScaffoldFailure('Action HTTP forbidden codes must use separated string literals');
  }
  const literals = codeTokens.filter((token) => token.kind !== SyntaxKind.CommaToken);
  const values = literals.map(stringLiteralValue);
  if (
    values.some((value) => value === undefined) ||
    new Set(values).size !== values.length ||
    !values.includes('action_permission_denied')
  ) {
    return raiseScaffoldFailure('Action HTTP forbidden codes must preserve the exact Core permission refusal');
  }
  return literals;
};

/** Keep every owner problem projection, adding only Core's newly supported exact refusal code. */
export const upgradeActionHttpForbiddenContract = (
  input: Pick<ActionHttpProposalContractInput, 'action' | 'content' | 'moduleId'>,
): string => {
  const { action, content, moduleId } = input;
  requireActionHttpOwnership(content, moduleId, action, 'Action HTTP contract');
  const cursor = cursorOf(content);
  const type = toPascalCase(action);
  const initializer = exportedInitializer(cursor, `${type}ActionForbiddenProblemSchema`);
  if (initializer === undefined) {
    return content;
  }
  requireSchemaNamespace(content);
  if (
    !hasRuntimeNamedSourceImport(
      content,
      'makeProblemDetailsSchema',
      'makeProblemDetailsSchema',
      PROBLEM_DETAILS_MODULE,
    ) ||
    !isIdentifier(cursor.tokens.at(initializer), 'makeProblemDetailsSchema') ||
    cursor.tokens.at(initializer + 1)?.kind !== SyntaxKind.OpenParenToken
  ) {
    return raiseScaffoldFailure('Action HTTP forbidden schema must use its genuine problem factory');
  }
  const options = forbiddenSchemaOptions(cursor, initializer, type);
  const literals = forbiddenCodeLiterals(cursor, options);
  const values = literals.map(stringLiteralValue);
  if (values.includes('action_approval_required')) {
    return content;
  }
  const first = literals.at(0);
  if (first === undefined) {
    return raiseScaffoldFailure('Action HTTP forbidden codes cannot be empty');
  }
  return applySourceEdits(content, [
    {
      end: first.start,
      start: first.start,
      text: "'action_approval_required', ",
    },
  ]);
};

/**
 * An owner may add optional post-commit observations to its native result. Prove the local extension
 * preserves every native field and imports the real public result before validating that base contract.
 */
export const publicProposalResultSchemaName = (
  content: string,
  action: string,
  appId: string,
  resultSchema: Schema.Top,
): string => {
  const result = resultSchemaNameOf(content, action, appId);
  const cursor = cursorOf(content);
  const initializer = exportedInitializer(cursor, result);
  if (initializer === undefined) {
    return result;
  }
  requireSchemaNamespace(content);
  if (!sameTokens(cursor.tokens.slice(initializer, initializer + 4), ['Schema', '.', 'Struct', '('])) {
    return raiseScaffoldFailure('Local Action HTTP response must extend the native result Struct');
  }
  const args = callArguments(cursor, initializer + 3);
  const object = objectArgumentAt(cursor, args, 'Schema.Struct', 'Local Action HTTP response', 0);
  if (args.length !== 1 || !SchemaAST.isObjects(resultSchema.ast)) {
    return raiseScaffoldFailure('Local Action HTTP response needs one native object result');
  }
  const nativeResult = `${toPascalCase(action)}ResultSchema`;
  if (!hasRuntimeNamedSourceImport(content, nativeResult, nativeResult, `../actions/${action}.ts`)) {
    return raiseScaffoldFailure('Local Action HTTP response must import its exact owner result');
  }
  const members = objectMembers(cursor, object);
  const spread = members.at(0);
  if (
    spread === undefined ||
    !sameTokens(cursor.tokens.slice(spread.first, spread.separator), ['...', nativeResult, '.', 'fields'])
  ) {
    return raiseScaffoldFailure('Local Action HTTP response must retain all native result fields first');
  }
  const nativeFields = new Set(resultSchema.ast.propertySignatures.map((property) => property.name));
  const additional = members.slice(1);
  const names = additional.map((member) => member.name);
  if (new Set(names).size !== names.length) {
    return raiseScaffoldFailure('Local Action HTTP response repeats an observation field');
  }
  for (const member of additional) {
    const tokens = memberValueTokens(cursor, member);
    if (
      member.name === null ||
      nativeFields.has(member.name) ||
      !sameTokens(tokens.slice(0, 4), ['Schema', '.', 'optionalKey', '(']) ||
      member.valueFirst === null ||
      cursor.matches.get(member.valueFirst + 3) !== member.valueLast
    ) {
      return raiseScaffoldFailure(
        'Local Action HTTP observations must be optional and cannot replace native result fields',
      );
    }
  }
  return nativeResult;
};

const importAnchor = (statements: readonly ModuleStatement[]): ModuleStatement => {
  const statement =
    statements.find((entry) => entry.kind === 'import' && entry.source === PROBLEM_DETAILS_MODULE) ??
    statements.findLast((entry) => entry.kind === 'import');
  if (statement === undefined) {
    return raiseScaffoldFailure('Action HTTP contract lacks an import anchor');
  }
  return statement;
};

const payloadExportAnchor = (statements: readonly ModuleStatement[], action: string, type: string): ModuleStatement => {
  const statement = statements.find(
    (entry) =>
      entry.kind === 'export' &&
      entry.source?.endsWith(`/actions/${action}.ts`) === true &&
      entry.names.includes(`${type}PayloadSchema`),
  );
  return statement ?? importAnchor(statements);
};

/**
 * Applies the proposal edits a shared contract needs and leaves every other statement alone: the
 * endpoint's success schema gains the 202 alternative, and the shared schema is imported and
 * re-exported from its one owner so the endpoint and its client cannot declare it twice.
 */
export const upgradeActionHttpProposalContract = (input: ActionHttpProposalContractInput): string => {
  const { action, appId, content, moduleId } = input;
  requireActionHttpOwnership(content, moduleId, action, 'Action HTTP contract');
  const cursor = cursorOf(content);
  const statements = moduleStatements(cursor);
  const edits: SourceEdit[] = [];
  const edit = successEdit(cursor, action, endpointOptionsOpen(cursor, action, appId));
  if (edit !== undefined) {
    edits.push(edit);
  }
  const insertions = new Map<number, string[]>();
  const addInsertion = (offset: number, text: string): void => {
    insertions.set(offset, [...(insertions.get(offset) ?? []), text]);
  };
  if (!hasProposalStatement(statements, 'import', moduleId, action)) {
    addInsertion(tokenAt(cursor, importAnchor(statements).end).end, `\n${PROPOSAL_IMPORT}`);
  }
  if (!hasProposalStatement(statements, 'export', moduleId, action)) {
    addInsertion(
      tokenAt(cursor, payloadExportAnchor(statements, action, toPascalCase(action)).end).end,
      `\n${PROPOSAL_EXPORT}`,
    );
  }
  for (const [offset, lines] of insertions.entries()) {
    edits.push({ end: offset, start: offset, text: lines.join('') });
  }
  return upgradeActionHttpForbiddenContract({ action, content: applySourceEdits(content, edits), moduleId });
};

export interface ActionHttpProposalServerInput {
  readonly action: string;
  readonly content: string;
  readonly moduleId: string;
}

const runnerBindingName = (cursor: TokenCursor, moduleId: string, action: string): string => {
  const label = `Action HTTP server for ${moduleId}/${action}`;
  // The imported binding is not a call site; the one factory invocation is.
  const invocations = identifierIndexes(cursor, GOVERNED_RUNNER_FACTORY).filter(
    (index) => cursor.tokens.at(index + 1)?.kind === SyntaxKind.OpenParenToken,
  );
  const [invocation] = invocations;
  if (invocation === undefined) {
    return raiseScaffoldFailure(`${label} does not bind the governed Action runner`);
  }
  if (invocations.length > 1) {
    return raiseScaffoldFailure(`${label} binds the governed Action runner more than once`);
  }
  const name = cursor.tokens.at(invocation - 2);
  if (cursor.tokens.at(invocation - 1)?.kind !== SyntaxKind.FirstAssignment || name?.kind !== SyntaxKind.Identifier) {
    return raiseScaffoldFailure(`${label} must bind the governed Action runner to one const`);
  }
  return name.text;
};

/**
 * Declares the 202 success contract in sorted property order. The owner's own header decoding
 * and problem wiring stay untouched.
 */
export const upgradeActionHttpProposalServer = (input: ActionHttpProposalServerInput): string => {
  const { action, content, moduleId } = input;
  requireActionHttpOwnership(content, moduleId, action, 'Action HTTP server');
  const cursor = cursorOf(content);
  const label = `Action HTTP server for ${moduleId}/${action}`;
  const members = objectMembers(cursor, soleObjectArgument(cursor, runnerBindingName(cursor, moduleId, action), label));
  const declared = findMember(members, 'successContract');
  if (declared !== undefined) {
    if (!sameTokens(memberValueTokens(cursor, declared), [PROPOSAL_CONTRACT_VALUE])) {
      return raiseScaffoldFailure(`${label} already declares another success contract`);
    }
    return content;
  }
  requireMember(members, 'registration', label);
  const following = members.find((member) => member.name !== null && member.name.localeCompare('successContract') > 0);
  if (following !== undefined) {
    return applySourceEdits(content, [
      lineBeforeEdit(content, tokenAt(cursor, following.first).start, PROPOSAL_SUCCESS_CONTRACT),
    ]);
  }
  const last = members.at(-1);
  if (last === undefined) {
    return raiseScaffoldFailure(`${label} has no runner properties`);
  }
  const separator = tokenAt(cursor, last.separator);
  const edit = lineAfterEdit(content, separator.end, PROPOSAL_SUCCESS_CONTRACT);
  return applySourceEdits(content, [
    separator.kind === SyntaxKind.CommaToken ? edit : { ...edit, text: `,${edit.text}` },
  ]);
};

export interface ActionHttpProposalClientInput {
  readonly action: string;
  readonly content: string;
  readonly moduleId: string;
}

const clientOptionsInterfaceOpen = (cursor: TokenCursor, moduleId: string, action: string): number => {
  const label = `Action HTTP client for ${moduleId}/${action}`;
  const candidates = cursor.tokens.flatMap((token, index) => {
    if (token.kind !== SyntaxKind.InterfaceKeyword) {
      return [];
    }
    const name = cursor.tokens.at(index + 1);
    return name?.kind === SyntaxKind.Identifier && name.text.endsWith(CLIENT_OPTIONS_SUFFIX) ? [index] : [];
  });
  const [candidate] = candidates;
  if (candidate === undefined) {
    return raiseScaffoldFailure(`${label} has no ${CLIENT_OPTIONS_SUFFIX} declaration`);
  }
  if (candidates.length > 1) {
    return raiseScaffoldFailure(`${label} declares ${CLIENT_OPTIONS_SUFFIX} more than once`);
  }
  if (cursor.tokens.at(candidate + 2)?.kind !== SyntaxKind.OpenBraceToken) {
    return raiseScaffoldFailure(`${label} declares an unsupported ${CLIENT_OPTIONS_SUFFIX}`);
  }
  return candidate + 2;
};

/** The offset the optional intent member must be inserted at, or `undefined` when it is already there. */
const proposalIntentAnchor = (
  cursor: TokenCursor,
  members: readonly SourceMember[],
  moduleId: string,
  action: string,
): number | undefined => {
  const label = `Action HTTP client for ${moduleId}/${action}`;
  const declared = findMember(members, 'intent');
  if (declared !== undefined && !sameTokens(memberTokens(cursor, declared), PROPOSAL_INTENT_MEMBER_TOKENS)) {
    return raiseScaffoldFailure(`${label} already declares an unsupported intent option`);
  }
  const anchor =
    members.find((member) => member.name !== null && member.name.localeCompare('intent') > 0) ??
    members.find((member) => cursor.tokens.at(member.nameIndex)?.kind === SyntaxKind.OpenBracketToken);
  if (anchor === undefined) {
    if (declared !== undefined) {
      return undefined;
    }
    return raiseScaffoldFailure(`${label} has no anchor for the optional proposal intent`);
  }
  if (declared !== undefined && declared.first < anchor.first) {
    return undefined;
  }
  return tokenAt(cursor, anchor.first).start;
};

/** Move only the exact documented member this generator owns, never an owner's differently documented option. */
const removeGeneratedIntent = (content: string, cursor: TokenCursor, declared: SourceMember): SourceEdit => {
  const token = tokenAt(cursor, declared.first);
  const indentation = indentationAt(content, token.start);
  const block = `${PROPOSAL_INTENT_MEMBERS.map((line) => indentation + line).join('\n')}\n`;
  const end = tokenAt(cursor, declared.separator).end + 1;
  const start = end - block.length;
  if (content.slice(start, end) !== block) {
    return raiseScaffoldFailure('Only the exact generated proposal-intent documentation may be moved');
  }
  return { end, start, text: '' };
};

/**
 * Offers the explicit proposal intent from a generated client and wires it into the governed client
 * options. Nothing else about the client's composition, headers or argument positions changes.
 */
export const upgradeActionHttpProposalClient = (input: ActionHttpProposalClientInput): string => {
  const { action, content, moduleId } = input;
  requireActionHttpOwnership(content, moduleId, action, 'Action HTTP client');
  const cursor = cursorOf(content);
  const label = `Action HTTP client for ${moduleId}/${action}`;
  const optionsOpen = clientOptionsInterfaceOpen(cursor, moduleId, action);
  const optionsMembers = interfaceMembers(cursor, optionsOpen);
  const anchor = proposalIntentAnchor(cursor, optionsMembers, moduleId, action);
  const clientMembers = objectMembers(
    cursor,
    objectArgumentAt(
      cursor,
      invokeArguments(cursor, GOVERNED_CLIENT_FACTORY, label),
      GOVERNED_CLIENT_FACTORY,
      label,
      0,
    ),
  );
  const declaredIntent = findMember(clientMembers, 'intent');
  const edits: SourceEdit[] = [];
  if (anchor !== undefined) {
    const existing = findMember(optionsMembers, 'intent');
    if (existing !== undefined) {
      edits.push(removeGeneratedIntent(content, cursor, existing));
    }
    edits.push(blockBeforeEdit(content, anchor, PROPOSAL_INTENT_MEMBERS));
  }
  if (declaredIntent === undefined) {
    const correlation = requireMember(clientMembers, 'requestCorrelation', label);
    edits.push(lineBeforeEdit(content, tokenAt(cursor, correlation.first).start, PROPOSAL_INTENT_WIRING));
  } else if (!sameTokens(memberValueTokens(cursor, declaredIntent), PROPOSAL_INTENT_WIRING_TOKENS)) {
    return raiseScaffoldFailure(`${label} already wires another intent`);
  }
  return applySourceEdits(content, edits);
};

export interface ActionHttpProposalArtifacts {
  readonly client: string;
  readonly contract: string;
  readonly server: string;
}

export interface ActionHttpProposalPlanInput {
  readonly action: string;
  readonly appId: string;
  readonly artifacts: ActionHttpProposalArtifacts;
  readonly moduleId: string;
  /**
   * The registered declaration is the only source of truth for this (O85): callers derive the fact
   * with `isProposableActionDeclaration` from the loaded Action registration, never from a flag that
   * restates it.
   */
  readonly proposalAccepted: boolean;
}

export interface ActionHttpProposalPlan {
  readonly artifacts: ActionHttpProposalArtifacts;
  /** The artifacts that actually changed; a non-proposable Action changes nothing. */
  readonly changed: readonly ActionHttpProposalArtifactKind[];
  readonly proposalAccepted: boolean;
}

/**
 * Plans the whole upgrade from source texts. Every artifact is transformed before any caller sees a
 * result, so an unsupported or ambiguous shape fails the plan instead of half-writing an endpoint.
 */
export const planActionHttpProposalArtifacts = (input: ActionHttpProposalPlanInput): ActionHttpProposalPlan => {
  const { action, appId, artifacts, moduleId, proposalAccepted } = input;
  if (!proposalAccepted) {
    return { artifacts, changed: [], proposalAccepted: false };
  }
  const contract = upgradeActionHttpProposalContract({ action, appId, content: artifacts.contract, moduleId });
  const server = upgradeActionHttpProposalServer({ action, content: artifacts.server, moduleId });
  const client = upgradeActionHttpProposalClient({ action, content: artifacts.client, moduleId });
  const changed: ActionHttpProposalArtifactKind[] = [];
  if (contract !== artifacts.contract) {
    changed.push('contract');
  }
  if (server !== artifacts.server) {
    changed.push('server');
  }
  if (client !== artifacts.client) {
    changed.push('client');
  }
  return { artifacts: { client, contract, server }, changed, proposalAccepted: true };
};

export interface ActionHttpProposalBaselineFile {
  readonly content: string;
  readonly path: string;
}

export interface ActionHttpProposalBaselineArtifacts {
  readonly client: ActionHttpProposalBaselineFile;
  readonly contract: ActionHttpProposalBaselineFile;
  readonly server: ActionHttpProposalBaselineFile;
}

export interface ActionHttpProposalBaselinePlan {
  readonly mutations: readonly Mutation[];
  readonly plan: ActionHttpProposalPlan;
}
/**
 * Codesmith mutations for baseline texts the caller supplies, without reading the filesystem or
 * touching git. Codesmith formats every mutation when it applies the plan, so a caller that writes
 * these contents itself must format them the same way.
 */
export const planActionHttpProposalBaselineMutations = (
  input: ActionHttpProposalPlanInput & { readonly files: ActionHttpProposalBaselineArtifacts },
): ActionHttpProposalBaselinePlan => {
  const plan = planActionHttpProposalArtifacts(input);
  const mutations: readonly Mutation[] = plan.changed.map((kind) => ({
    content: plan.artifacts[kind],
    kind: 'update',
    path: input.files[kind].path,
  }));
  ensureUniqueMutationPaths(mutations);
  return { mutations, plan };
};

/**
 * Formats planned mutation contents exactly as Codesmith would before writing them, for a caller that
 * writes the artifacts itself instead of handing the plan to Codesmith.
 */
const formatProposalMutation = Effect.fn('ActionHttpProposalScaffold.formatMutation')(
  function* formatProposalMutationEffect(mutation: Mutation) {
    if (mutation.kind === 'delete') {
      return mutation;
    }
    const content = yield* formatGeneratedMutationContent(mutation.path, mutation.content);
    return { ...mutation, content };
  },
);

export const formatActionHttpProposalMutations = Effect.fn('ActionHttpProposalScaffold.formatMutations')(
  function* formatActionHttpProposalMutationsEffect(
    mutations: readonly Mutation[],
  ): Effect.fn.Return<readonly Mutation[], ScaffoldFailure> {
    const formatted = yield* Effect.all(mutations.map((mutation) => formatProposalMutation(mutation)));
    return formatted;
  },
);

export interface ActionHttpProposalScaffoldResult extends ActionHttpScaffoldResult {
  readonly proposalAccepted: boolean;
  /** The generated artifacts this run had to change; empty when the Action cannot propose. */
  readonly updated: readonly string[];
}

/**
 * The opt-in CLI/generator entry: validate the real Action metadata, owner and runtime exports with
 * the same machinery the full scaffold uses, then upgrade only the proposal transport of the three
 * owned endpoint artifacts. Problem mappers, barrels and package files are never read or planned.
 */
export const planActionHttpProposalUpgrade = Effect.fn('ActionHttpProposalScaffold.plan')(
  function* planActionHttpProposalUpgradeEffect(workspaceRoot: string, config: ActionHttpScaffoldConfig) {
    const action = yield* tryScaffold('Action name is invalid', () => requireCanonicalSlug(config.action, 'action'));
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
    const type = toPascalCase(action);
    const value = `${toCamelCase(action)}Action`;
    const actionPath = resolveContainedPath(vertical.directory, 'src', 'actions', `${action}.action.ts`);
    const publicActionPath = resolveContainedPath(vertical.directory, 'shared', 'actions', `${action}.ts`);
    const contractPath = resolveContainedPath(vertical.directory, 'shared', 'apis', `${action}-action.ts`);
    const serverPath = resolveContainedPath(vertical.directory, 'api', `${action}-action-server.ts`);
    const clientPath = resolveContainedPath(vertical.directory, 'src', 'api', `${action}-action-client.ts`);
    const fileSystem = yield* FileSystem.FileSystem;
    const [contract, server, client, actionSource, publicActionSource] = yield* Effect.all([
      fileSystem.readFileString(contractPath),
      fileSystem.readFileString(serverPath),
      fileSystem.readFileString(clientPath),
      fileSystem.readFileString(actionPath),
      fileSystem.readFileString(publicActionPath),
    ]).pipe(
      Effect.mapError((cause) => scaffoldFailure('failed to read the existing Action HTTP owner sources', cause)),
    );
    // The same metadata checks the full scaffold runs: ownership markers, real schema exports and the
    // registered runtime identity. The proposal path never loosens them.
    yield* validateActionSources(vertical, action, actionSource, publicActionSource);
    const inspected = yield* inspectAction(actionPath, value);
    yield* validateActionRuntimeIdentity(inspected, vertical.moduleId, action);
    const proposalAccepted = isProposableActionDeclaration(inspected.descriptor.accessDeclaration);
    // Run-only contracts need no migration. Their owner may deliberately share a differently named
    // result schema; do not impose fresh-scaffold naming on artifacts we will leave untouched.
    if (proposalAccepted) {
      const resultSchemaName = yield* tryScaffold('Action HTTP result schema is unsupported', () =>
        publicProposalResultSchemaName(contract, action, vertical.appId, inspected.descriptor.resultSchema),
      );
      yield* validatePublicActionSchemas(publicActionPath, type, resultSchemaName);
    }
    const { mutations, plan } = yield* tryScaffold(
      'Action HTTP proposal upgrade is unsupported for this source shape',
      () =>
        planActionHttpProposalBaselineMutations({
          action,
          appId: vertical.appId,
          artifacts: { client, contract, server },
          files: {
            client: { content: client, path: clientPath },
            contract: { content: contract, path: contractPath },
            server: { content: server, path: serverPath },
          },
          moduleId: vertical.moduleId,
          proposalAccepted,
        }),
    );
    return {
      mutations,
      result: {
        clientPath,
        contractPath,
        proposalAccepted: plan.proposalAccepted,
        serverPath,
        updated: mutations.map((mutation) => mutation.path),
      } satisfies ActionHttpProposalScaffoldResult,
    };
  },
);

export const actionHttpProposalGenerator = createCodesmithGenerator(planActionHttpProposalUpgrade);
