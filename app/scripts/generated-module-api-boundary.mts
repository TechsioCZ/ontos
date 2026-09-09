import { LanguageVariant, SyntaxKind, createScanner } from '@typescript/native/unstable/ast';

import { DelimiterDepth, toCamelCase } from './boundary-source-structure.mts';

const REGISTRATION_API_SLOT = [
  '// <generated-module-registration-apis>',
  '// </generated-module-registration-apis>',
] as const;
const REGISTRATION_REPORT_SLOT = [
  '// <generated-module-registration-reports>',
  '// </generated-module-registration-reports>',
] as const;
const REGISTRATION_SEARCH_SLOT = [
  '// <generated-module-registration-search>',
  '// </generated-module-registration-search>',
] as const;
const MANIFEST_REPORT_SLOT = [
  '// <generated-module-manifest-reports>',
  '// </generated-module-manifest-reports>',
] as const;
const MANIFEST_SEARCH_SLOT = [
  '// <generated-module-manifest-search>',
  '// </generated-module-manifest-search>',
] as const;
const MANIFEST_SHELL_REPORT_SLOT = [
  '// <generated-module-shell-reports>',
  '// </generated-module-shell-reports>',
] as const;
const MANIFEST_SHELL_SEARCH_SLOT = [
  '// <generated-module-shell-search>',
  '// </generated-module-shell-search>',
] as const;

export { toPascalCase } from './boundary-source-structure.mts';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export interface GovernedClientToken {
  readonly kind: SyntaxKind;
  readonly value: string;
}

/** Out-of-range lookahead is a nonmatching token, never an invented identifier. */
const tokenKind = (tokens: readonly GovernedClientToken[], index: number): SyntaxKind | undefined =>
  tokens[index]?.kind;
const tokenValue = (tokens: readonly GovernedClientToken[], index: number): string | undefined => tokens[index]?.value;

const tokenDelimiter = new Map([
  [SyntaxKind.OpenBraceToken, '{'],
  [SyntaxKind.CloseBraceToken, '}'],
  [SyntaxKind.OpenBracketToken, '['],
  [SyntaxKind.CloseBracketToken, ']'],
  [SyntaxKind.OpenParenToken, '('],
  [SyntaxKind.CloseParenToken, ')'],
]);

const tokenBraceDelta = (kind: SyntaxKind | undefined): number => {
  if (kind === SyntaxKind.OpenBraceToken) {
    return 1;
  }
  return kind === SyntaxKind.CloseBraceToken ? -1 : 0;
};

type ExpectedToken = readonly [kind: SyntaxKind, value?: string];

const REGULAR_EXPRESSION_PRECEDERS = new Set([
  SyntaxKind.ColonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.ReturnKeyword,
]);

const scanTemplateDelimiter = (
  scanner: ReturnType<typeof createScanner>,
  scannedKind: SyntaxKind,
  templateExpressionBraceDepths: number[],
): SyntaxKind => {
  let kind = scannedKind;
  const templateDepthIndex = templateExpressionBraceDepths.length - 1;
  if (kind === SyntaxKind.TemplateHead) {
    templateExpressionBraceDepths.push(0);
  } else if (kind === SyntaxKind.OpenBraceToken && templateDepthIndex >= 0) {
    templateExpressionBraceDepths[templateDepthIndex] = (templateExpressionBraceDepths[templateDepthIndex] ?? 0) + 1;
  } else if (kind === SyntaxKind.CloseBraceToken && templateDepthIndex >= 0) {
    const braceDepth = templateExpressionBraceDepths[templateDepthIndex] ?? 0;
    if (braceDepth === 0) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) {
        templateExpressionBraceDepths.pop();
      }
    } else {
      templateExpressionBraceDepths[templateDepthIndex] = braceDepth - 1;
    }
  }
  return kind;
};

export const tokenizeGovernedClient = (source: string): readonly GovernedClientToken[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: GovernedClientToken[] = [];
  const templateExpressionBraceDepths: number[] = [];
  let scannedKind = scanner.scan();
  while (scannedKind !== SyntaxKind.EndOfFile) {
    let kind: SyntaxKind = scannedKind;
    if (
      kind === SyntaxKind.SlashToken &&
      (tokens.length === 0 || REGULAR_EXPRESSION_PRECEDERS.has(tokens.at(-1)?.kind ?? SyntaxKind.Unknown))
    ) {
      kind = scanner.reScanSlashToken();
    }
    kind = scanTemplateDelimiter(scanner, kind, templateExpressionBraceDepths);
    tokens.push({ kind, value: scanner.getTokenValue() });
    scannedKind = scanner.scan();
  }
  return tokens;
};

const importStateAfter = (kind: SyntaxKind, inImport: boolean): boolean | undefined => {
  if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
    return inImport;
  }
  if (kind === SyntaxKind.ImportKeyword) {
    return true;
  }
  return inImport ? kind !== SyntaxKind.SemicolonToken : undefined;
};

// Comments from the leading import section, with undefined marking interruptions.
const leadingSourceComments = function* leadingSourceComments(source: string): Generator<string | undefined> {
  const scanner = createScanner(false, LanguageVariant.Standard, source);
  let inImport = false;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.WhitespaceTrivia || kind === SyntaxKind.NewLineTrivia) {
      continue;
    }
    yield kind === SyntaxKind.SingleLineCommentTrivia ? scanner.getTokenText().trim() : undefined;
    const nextState = importStateAfter(kind, inImport);
    if (nextState === undefined) {
      return;
    }
    inImport = nextState;
  }
};

/** Import sorting may move provenance comments between leading imports. */
export const hasGeneratedSourceHeader = (source: string, header: string): boolean => {
  const expected = header.trim().split(/\r?\n/u);
  let matched = 0;
  for (const comment of leadingSourceComments(source)) {
    if (comment === expected[matched]) {
      matched += 1;
    } else {
      matched = comment === expected[0] ? 1 : 0;
    }
    if (matched === expected.length) {
      return true;
    }
  }
  return false;
};

const matchesToken = (token: GovernedClientToken | undefined, expected: ExpectedToken): boolean =>
  token?.kind === expected[0] && (expected[1] === undefined || token.value === expected[1]);

const matchesSequence = (
  tokens: readonly GovernedClientToken[],
  start: number,
  expected: readonly ExpectedToken[],
): boolean => expected.every((token, offset) => matchesToken(tokens[start + offset], token));

const isOptionalTrailingComma = (tokens: readonly GovernedClientToken[], next: number, close: number): boolean =>
  next === close || (tokenKind(tokens, next) === SyntaxKind.CommaToken && next + 1 === close);

const findSequence = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  start = 0,
  end = tokens.length,
): number | undefined => {
  for (let index = start; index < end; index += 1) {
    if (matchesSequence(tokens, index, expected)) {
      return index;
    }
  }
  return undefined;
};

const findSequenceAtBraceDepth = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  start: number,
  end: number,
  expectedDepth: number,
): number | undefined => {
  let braceDepth = 0;
  for (let index = start; index < end; index += 1) {
    if (braceDepth === expectedDepth && matchesSequence(tokens, index, expected)) {
      return index;
    }
    braceDepth += tokenBraceDelta(tokenKind(tokens, index));
  }
  return undefined;
};

const sequenceOccurrencesAtBraceDepth = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  expectedDepth: number,
): number => {
  let count = 0;
  let braceDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (braceDepth === expectedDepth && matchesSequence(tokens, index, expected)) {
      count += 1;
    }
    braceDepth += tokenBraceDelta(tokenKind(tokens, index));
  }
  return count;
};

const generatedSlotSource = (source: string, [start, end]: readonly [string, string]): string | undefined => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (
    startIndex === -1 ||
    endIndex === -1 ||
    source.lastIndexOf(start) !== startIndex ||
    source.lastIndexOf(end) !== endIndex ||
    endIndex <= startIndex
  ) {
    return undefined;
  }
  return source.slice(startIndex + start.length, endIndex);
};

const findTopLevelSequence = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  start: number,
  end: number,
): number | undefined => findSequenceAtBraceDepth(tokens, expected, start, end, 0);

const hasTopLevelSequence = (tokens: readonly GovernedClientToken[], expected: readonly ExpectedToken[]): boolean =>
  findTopLevelSequence(tokens, expected, 0, tokens.length) !== undefined;

const findRootExpressionSequence = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  start: number,
  end: number,
): number | undefined => {
  const depth = new DelimiterDepth();
  for (let index = start; index < end; index += 1) {
    if (depth.isTopLevel() && matchesSequence(tokens, index, expected)) {
      return index;
    }
    depth.update(tokenDelimiter.get(tokenKind(tokens, index) ?? SyntaxKind.Unknown));
  }
  return undefined;
};

const findClosingBrace = (tokens: readonly GovernedClientToken[], openBraceIndex: number): number | undefined => {
  let depth = 0;
  for (let index = openBraceIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

const findClosingParenthesis = (
  tokens: readonly GovernedClientToken[],
  openParenthesisIndex: number,
  end: number,
): number | undefined => {
  let depth = 0;
  for (let index = openParenthesisIndex; index < end; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenParenToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseParenToken) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

const isNamedObjectProperty = (tokens: readonly GovernedClientToken[], index: number, property: string): boolean => {
  const token = tokens[index];
  return (
    (token?.kind === SyntaxKind.Identifier || token?.kind === SyntaxKind.StringLiteral) &&
    token.value === property &&
    tokenKind(tokens, index + 1) === SyntaxKind.ColonToken
  );
};

const objectPropertyValuePositions = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
  property: string,
): readonly number[] => {
  const positions: number[] = [];
  let depth = 0;
  for (let index = openBraceIndex; index < closeBraceIndex; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (depth === 1 && isNamedObjectProperty(tokens, index, property)) {
      positions.push(index + 2);
    }
  }
  return positions;
};

const findObjectPropertyValue = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
  property: string,
): number | undefined => objectPropertyValuePositions(tokens, openBraceIndex, closeBraceIndex, property)[0];

const directObjectPropertyOccurrences = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
  property: string,
): number => objectPropertyValuePositions(tokens, openBraceIndex, closeBraceIndex, property).length;

const hasExactObjectPropertyValue = (
  tokens: readonly GovernedClientToken[],
  valueStart: number | undefined,
  expected: readonly ExpectedToken[],
): boolean => {
  if (valueStart === undefined || !matchesSequence(tokens, valueStart, expected)) {
    return false;
  }
  const follower = tokenKind(tokens, valueStart + expected.length);
  return follower === SyntaxKind.CommaToken || follower === SyntaxKind.CloseBraceToken;
};

const directObjectPropertyNames = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
): readonly string[] | undefined => {
  const properties: string[] = [];
  let depth = 0;
  for (let index = openBraceIndex; index < closeBraceIndex; index += 1) {
    const kind = tokenKind(tokens, index);
    depth += tokenBraceDelta(kind);
    if (depth !== 1) {
      continue;
    }
    if (kind === SyntaxKind.DotDotDotToken || kind === SyntaxKind.OpenBracketToken) {
      return undefined;
    }
    const value = tokenValue(tokens, index);
    if (value !== undefined && isNamedObjectProperty(tokens, index, value)) {
      properties.push(value);
    }
  }
  return properties;
};

const hasExactProperties = (properties: readonly string[] | undefined, expected: ReadonlySet<string>): boolean =>
  properties !== undefined &&
  properties.length === expected.size &&
  properties.every((property) => expected.has(property));

const directObjectHasNoSpread = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
): boolean => {
  let depth = 0;
  for (let index = openBraceIndex; index < closeBraceIndex; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (depth === 1 && token?.kind === SyntaxKind.DotDotDotToken) {
      return false;
    }
  }
  return true;
};

interface GovernedClientExpectation {
  readonly authorizedOperation: string;
  readonly defaultApiPrefix: string;
  readonly endpointGroup: string;
  readonly generatedHeader: string;
  readonly invocationKind: 'module-api' | 'provider';
  readonly ownerApiValue: string;
  readonly ownerContractImport: string;
  readonly publicOperation: string;
}

const MODULE_API_INVOCATION_KIND = 'module-api';

export const hasUniqueExactNamedImport = (source: string, importedName: string, moduleSpecifier: string): boolean => {
  const tokens = tokenizeGovernedClient(source);
  let matchCount = 0;
  let bindingCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])) {
      const closeBrace = findClosingBrace(tokens, index + 1);
      if (closeBrace !== undefined) {
        bindingCount += tokens
          .slice(index + 2, closeBrace)
          .filter(({ kind, value }) => kind === SyntaxKind.Identifier && value === importedName).length;
      }
    }
    if (
      matchesSequence(tokens, index, [
        [SyntaxKind.ImportKeyword],
        [SyntaxKind.OpenBraceToken],
        [SyntaxKind.Identifier, importedName],
        [SyntaxKind.CloseBraceToken],
        [SyntaxKind.FromKeyword],
        [SyntaxKind.StringLiteral, moduleSpecifier],
        [SyntaxKind.SemicolonToken],
      ])
    ) {
      matchCount += 1;
    }
  }
  return matchCount === 1 && bindingCount === 1;
};

export const hasGeneratedOperationPrincipalContract = (source: string): boolean =>
  hasUniqueExactNamedImport(
    source,
    'makeMicroverticalHttpPrincipalAuthentication',
    '@app/core-runtime/http/principal-authentication',
  ) &&
  hasTopLevelSequence(tokenizeGovernedClient(source), [
    [SyntaxKind.ExportKeyword],
    [SyntaxKind.ConstKeyword],
    [SyntaxKind.Identifier, 'authenticateOperationPrincipal'],
    [SyntaxKind.EqualsToken],
    [SyntaxKind.Identifier, 'makeMicroverticalHttpPrincipalAuthentication'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'verifyOperationPrincipal'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.SemicolonToken],
  ]);

const hasExclusiveNamedImportFrom = (source: string, importedName: string, moduleSpecifier: string): boolean => {
  const tokens = tokenizeGovernedClient(source);
  let bindingCount = 0;
  let exactBindingCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])) {
      continue;
    }
    const closeBrace = findClosingBrace(tokens, index + 1);
    if (closeBrace === undefined) {
      return false;
    }
    const importBindingCount = tokens
      .slice(index + 2, closeBrace)
      .filter(({ kind, value }) => kind === SyntaxKind.Identifier && value === importedName).length;
    bindingCount += importBindingCount;
    if (
      importBindingCount === 1 &&
      matchesSequence(tokens, closeBrace + 1, [
        [SyntaxKind.FromKeyword],
        [SyntaxKind.StringLiteral, moduleSpecifier],
        [SyntaxKind.SemicolonToken],
      ])
    ) {
      exactBindingCount += 1;
    }
  }
  return bindingCount === 1 && exactBindingCount === 1;
};

export const hasNamedImportBinding = (source: string, importedName: string): boolean => {
  const tokens = tokenizeGovernedClient(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])) {
      continue;
    }
    const closeBrace = findClosingBrace(tokens, index + 1);
    if (
      closeBrace !== undefined &&
      tokens
        .slice(index + 2, closeBrace)
        .some(({ kind, value }) => kind === SyntaxKind.Identifier && value === importedName)
    ) {
      return true;
    }
  }
  return false;
};

const governedRequestType = (expectation: GovernedClientExpectation): string =>
  expectation.invocationKind === MODULE_API_INVOCATION_KIND
    ? `${expectation.ownerApiValue.slice(0, -'Api'.length)}Request`
    : `${expectation.ownerApiValue.replace(/(?:Report|Search)Api$/u, '')}ProviderRequest`;

const hasExactGeneratedImports = (
  tokens: readonly GovernedClientToken[],
  expectation: GovernedClientExpectation,
): boolean => {
  const expected = [
    [
      [SyntaxKind.ImportKeyword],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, 'makeGovernedEffectBffClient'],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.FromKeyword],
      [SyntaxKind.StringLiteral, '@app/shared-contracts/client-runtime'],
      [SyntaxKind.SemicolonToken],
    ],
    [
      [SyntaxKind.ImportKeyword],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, 'Effect'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'Redacted'],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.FromKeyword],
      [SyntaxKind.StringLiteral, 'effect'],
      [SyntaxKind.SemicolonToken],
    ],
    [
      [SyntaxKind.ImportKeyword],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, expectation.ownerApiValue],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.FromKeyword],
      [SyntaxKind.StringLiteral, expectation.ownerContractImport],
      [SyntaxKind.SemicolonToken],
    ],
    [
      [SyntaxKind.ImportKeyword],
      [SyntaxKind.TypeKeyword],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, governedRequestType(expectation)],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.FromKeyword],
      [SyntaxKind.StringLiteral, expectation.ownerContractImport],
      [SyntaxKind.SemicolonToken],
    ],
    [
      [SyntaxKind.ImportKeyword],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, 'operationGateway'],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.FromKeyword],
      [SyntaxKind.StringLiteral, './action-gateway.ts'],
      [SyntaxKind.SemicolonToken],
    ],
  ] satisfies readonly (readonly ExpectedToken[])[];
  let cursor = 0;
  for (const statement of expected) {
    if (!matchesSequence(tokens, cursor, statement)) {
      return false;
    }
    cursor += statement.length;
  }
  return tokens.filter(({ kind }) => kind === SyntaxKind.ImportKeyword).length === expected.length;
};

const identifierOccurrences = (tokens: readonly GovernedClientToken[], identifier: string): number =>
  tokens.filter(({ kind, value }) => kind === SyntaxKind.Identifier && value === identifier).length;

interface ExportedConst {
  readonly end: number;
  readonly name: string;
  readonly start: number;
}

interface GovernedClientHelper {
  readonly declarationStart: number;
  readonly end: number;
  readonly name: string;
  readonly parametersEnd: number;
  readonly parametersStart: number;
  readonly start: number;
}

const exportedConsts = (tokens: readonly GovernedClientToken[]): readonly ExportedConst[] => {
  const declarations: ExportedConst[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      matchesSequence(tokens, index, [
        [SyntaxKind.ExportKeyword],
        [SyntaxKind.ConstKeyword],
        [SyntaxKind.Identifier],
        [SyntaxKind.EqualsToken],
      ])
    ) {
      const name = tokenValue(tokens, index + 2);
      if (name !== undefined) {
        const nextExport = findSequence(tokens, [[SyntaxKind.ExportKeyword]], index + 1, tokens.length);
        declarations.push({
          end: nextExport ?? tokens.length,
          name,
          start: index,
        });
      }
    }
  }
  return declarations;
};

const clientHelperAt = (
  tokens: readonly GovernedClientToken[],
  index: number,
  end: number,
): GovernedClientHelper | undefined => {
  if (
    !matchesSequence(tokens, index, [
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.OpenParenToken],
    ])
  ) {
    return undefined;
  }
  const name = tokenValue(tokens, index + 1);
  const parametersClose = findClosingParenthesis(tokens, index + 3, end);
  if (name === undefined || parametersClose === undefined) {
    return undefined;
  }
  const bodyStart = parametersClose + 2;
  const bodyClose = findClosingParenthesis(tokens, bodyStart + 1, end);
  if (bodyClose === undefined || bodyClose + 1 >= end) {
    return undefined;
  }
  return matchesSequence(tokens, parametersClose + 1, [
    [SyntaxKind.EqualsGreaterThanToken],
    [SyntaxKind.Identifier, 'makeGovernedEffectBffClient'],
    [SyntaxKind.OpenParenToken],
  ]) && tokenKind(tokens, bodyClose + 1) === SyntaxKind.SemicolonToken
    ? {
        declarationStart: index,
        end: bodyClose + 2,
        name,
        parametersEnd: parametersClose,
        parametersStart: index + 4,
        start: bodyStart,
      }
    : undefined;
};

const findClientHelper = (
  tokens: readonly GovernedClientToken[],
  authorizedExportStart: number,
): GovernedClientHelper | undefined => {
  for (let index = 0; index < authorizedExportStart; index += 1) {
    const helper = clientHelperAt(tokens, index, authorizedExportStart);
    if (helper !== undefined) {
      return helper;
    }
  }
  return undefined;
};

const findStatementSemicolon = (tokens: readonly GovernedClientToken[], start: number): number | undefined =>
  findRootExpressionSequence(tokens, [[SyntaxKind.SemicolonToken]], start, tokens.length);

const hasOnlyAllowedModuleStatements = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  expectation: GovernedClientExpectation,
): boolean => {
  const allowedOperations = new Set([expectation.authorizedOperation, expectation.publicOperation]);
  const apiStem = expectation.ownerApiValue.replace(/Api$/u, '');
  const operationStem = expectation.authorizedOperation
    .replace(/WithAuthorization$/u, '')
    .replace(/^execute/u, '')
    .replace(/^load/u, '')
    .replace(/Client$/u, '');
  const allowedOptionsInterfaces = new Set([`${apiStem}ClientOptions`, `${operationStem}ClientOptions`]);
  let optionsInterfaceSeen = false;
  const consumeOptionsInterface = (index: number): number | undefined => {
    const name = tokenValue(tokens, index + 2);
    if (name === undefined || optionsInterfaceSeen || !allowedOptionsInterfaces.has(name)) {
      return undefined;
    }
    optionsInterfaceSeen = true;
    const open = findSequence(tokens, [[SyntaxKind.OpenBraceToken]], index + 2);
    if (open === undefined) {
      return undefined;
    }
    const close = findClosingBrace(tokens, open);
    if (close === undefined) {
      return undefined;
    }
    return tokenKind(tokens, close + 1) === SyntaxKind.SemicolonToken ? close + 2 : close + 1;
  };
  const isAllowedOperation = (index: number): boolean =>
    matchesSequence(tokens, index, [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier],
      [SyntaxKind.EqualsToken],
    ]) && allowedOperations.has(tokenValue(tokens, index + 2) ?? '');
  const acceptsFrom = (index: number): boolean => {
    if (index === tokens.length) {
      return true;
    }
    if ([SyntaxKind.ImportKeyword, SyntaxKind.TypeKeyword].includes(tokenKind(tokens, index) ?? SyntaxKind.Unknown)) {
      const end = findStatementSemicolon(tokens, index);
      return end !== undefined && acceptsFrom(end + 1);
    }
    const isExportedInterface = matchesSequence(tokens, index, [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.InterfaceKeyword],
      [SyntaxKind.Identifier],
    ]);
    if (isExportedInterface) {
      const next = consumeOptionsInterface(index);
      return next !== undefined && acceptsFrom(next);
    }
    if (index === helper.declarationStart) {
      return acceptsFrom(helper.end);
    }
    if (isAllowedOperation(index)) {
      const end = findStatementSemicolon(tokens, index);
      return end !== undefined && acceptsFrom(end + 1);
    }
    return false;
  };
  return acceptsFrom(0) && optionsInterfaceSeen;
};

// The imported shared transport owns credential extraction, correlation headers and URL options.
// Validate its entire invocation, not merely a decoy property or helper name.
const hasGovernedTransportInvocation = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  ownerApiValue: string,
  defaultApiPrefix: string,
): boolean => {
  const expected = (objectTrailingComma: boolean, callTrailingComma: boolean) =>
    [
      [SyntaxKind.Identifier, 'makeGovernedEffectBffClient'],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.Identifier, 'api'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, ownerApiValue],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'credential'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'defaultApiPrefix'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.StringLiteral, defaultApiPrefix],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'requestCorrelation'],
      ...(objectTrailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'options'],
      ...(callTrailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.SemicolonToken],
    ] satisfies readonly ExpectedToken[];
  return [false, true].some((objectTrailingComma) =>
    [false, true].some((callTrailingComma) => {
      const sequence = expected(objectTrailingComma, callTrailingComma);
      return helper.end === helper.start + sequence.length && matchesSequence(tokens, helper.start, sequence);
    }),
  );
};

const parametersBindIdentifier = (
  tokens: readonly GovernedClientToken[],
  start: number,
  end: number,
  names: ReadonlySet<string>,
): boolean => {
  const bindingFollowers = new Set([
    SyntaxKind.CloseParenToken,
    SyntaxKind.ColonToken,
    SyntaxKind.CommaToken,
    SyntaxKind.EqualsToken,
    SyntaxKind.QuestionToken,
  ]);
  return tokens
    .slice(start, end)
    .some(
      ({ kind, value }, offset) =>
        kind === SyntaxKind.Identifier &&
        names.has(value) &&
        tokenKind(tokens, start + offset - 1) !== SyntaxKind.DotToken &&
        bindingFollowers.has(tokenKind(tokens, start + offset + 1) ?? SyntaxKind.Unknown),
    );
};

const hasTopLevelDeclaration = (
  tokens: readonly GovernedClientToken[],
  start: number,
  end: number,
  names: ReadonlySet<string>,
): boolean => {
  const declarationKinds = new Set([
    SyntaxKind.ClassKeyword,
    SyntaxKind.ConstKeyword,
    SyntaxKind.FunctionKeyword,
    SyntaxKind.LetKeyword,
    SyntaxKind.VarKeyword,
  ]);
  let braceDepth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (
      braceDepth === 0 &&
      declarationKinds.has(token?.kind ?? SyntaxKind.Unknown) &&
      tokenKind(tokens, index + 1) === SyntaxKind.Identifier &&
      names.has(tokenValue(tokens, index + 1) ?? '')
    ) {
      return true;
    }
    braceDepth += tokenBraceDelta(token?.kind);
  }
  return false;
};

const hasExactParameterTokens = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  expected: readonly ExpectedToken[],
): boolean => close === open + expected.length + 1 && matchesSequence(tokens, open + 1, expected);

interface GeneratedClientTypeNames {
  authorizedInvocation: string;
  operationInvocation: string;
  options: readonly string[];
  request: string;
}

const generatedClientTypeNames = (expectation: GovernedClientExpectation): GeneratedClientTypeNames => {
  const operationBase =
    expectation.invocationKind === MODULE_API_INVOCATION_KIND
      ? expectation.ownerApiValue.slice(0, -'Api'.length)
      : expectation.ownerApiValue.replace(/(?:Report|Search)Api$/u, '');
  return {
    authorizedInvocation: `${expectation.ownerApiValue.slice(0, -'Api'.length)}AuthorizedInvocation`,
    operationInvocation: `${expectation.ownerApiValue.slice(0, -'Api'.length)}OperationInvocation`,
    options: [`${operationBase}ClientOptions`, `${expectation.ownerApiValue.slice(0, -'Api'.length)}ClientOptions`],
    request: governedRequestType(expectation),
  };
};

const hasExactGeneratedOperationParameters = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  authorized: ExportedConst,
  authorizedArrow: number,
  operation: ExportedConst,
  operationArrow: number,
  expectation: GovernedClientExpectation,
): boolean => {
  const types = generatedClientTypeNames(expectation);
  const helperOpen = helper.parametersStart - 1;
  const authorizedOpen = authorized.start + 4;
  const authorizedClose = findClosingParenthesis(tokens, authorizedOpen, authorizedArrow);
  const operationOpen = operation.start + 4;
  const operationClose = findClosingParenthesis(tokens, operationOpen, operationArrow);
  const authorizedExpected = (trailingComma: boolean) =>
    [
      [SyntaxKind.Identifier, 'payload'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, types.request],
      [SyntaxKind.CommaToken],
      [SyntaxKind.DotDotDotToken],
      [SyntaxKind.OpenBracketToken],
      [SyntaxKind.Identifier, 'credential'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'requestCorrelation'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'options'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.CloseBraceToken],
      ...(trailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
      [SyntaxKind.CloseBracketToken],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, types.authorizedInvocation],
    ] satisfies readonly ExpectedToken[];
  const operationExpected = (trailingComma: boolean) =>
    [
      [SyntaxKind.Identifier, 'payload'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, types.request],
      [SyntaxKind.CommaToken],
      [SyntaxKind.DotDotDotToken],
      [SyntaxKind.OpenBracketToken],
      [SyntaxKind.Identifier, 'requestCorrelation'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'options'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.CloseBraceToken],
      ...(trailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
      [SyntaxKind.CloseBracketToken],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, types.operationInvocation],
    ] satisfies readonly ExpectedToken[];
  return (
    types.options.some((optionsType) =>
      [false, true].some((trailingComma) =>
        hasExactParameterTokens(tokens, helperOpen, helper.parametersEnd, [
          [SyntaxKind.Identifier, 'credential'],
          [SyntaxKind.ColonToken],
          [SyntaxKind.Identifier, 'Redacted'],
          [SyntaxKind.DotToken],
          [SyntaxKind.Identifier, 'Redacted'],
          [SyntaxKind.LessThanToken],
          [SyntaxKind.StringKeyword],
          [SyntaxKind.GreaterThanToken],
          [SyntaxKind.CommaToken],
          [SyntaxKind.Identifier, 'requestCorrelation'],
          [SyntaxKind.ColonToken],
          [SyntaxKind.StringKeyword],
          [SyntaxKind.CommaToken],
          [SyntaxKind.Identifier, 'options'],
          [SyntaxKind.ColonToken],
          [SyntaxKind.Identifier, optionsType],
          ...(trailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
        ]),
      ),
    ) &&
    authorizedClose !== undefined &&
    [false, true].some((trailingComma) =>
      hasExactParameterTokens(tokens, authorizedOpen, authorizedClose, authorizedExpected(trailingComma)),
    ) &&
    operationClose !== undefined &&
    [false, true].some((trailingComma) =>
      hasExactParameterTokens(tokens, operationOpen, operationClose, operationExpected(trailingComma)),
    )
  );
};

const generatedOperationDeclarations = (
  tokens: readonly GovernedClientToken[],
  expectation: GovernedClientExpectation,
): readonly [authorized: ExportedConst, operation: ExportedConst] | undefined => {
  const declarations = exportedConsts(tokens);
  const authorized = declarations.filter(({ name }) => name === expectation.authorizedOperation);
  const operations = declarations.filter(({ name }) => name === expectation.publicOperation);
  const [authorizedDeclaration] = authorized;
  const [operationDeclaration] = operations;
  return declarations.length === 2 &&
    authorized.length === 1 &&
    operations.length === 1 &&
    authorizedDeclaration !== undefined &&
    operationDeclaration !== undefined
    ? [authorizedDeclaration, operationDeclaration]
    : undefined;
};

const matchingSequenceEnd = (
  tokens: readonly GovernedClientToken[],
  start: number,
  alternatives: readonly (readonly ExpectedToken[])[],
): number | undefined => {
  const match = alternatives.find((sequence) => matchesSequence(tokens, start, sequence));
  return match === undefined ? undefined : start + match.length;
};

const hasInvocationClosure = (tokens: readonly GovernedClientToken[], start: number | undefined): boolean =>
  start !== undefined &&
  [false, true].some((trailingComma) =>
    [false, true].some((outerTrailingComma) =>
      matchesSequence(tokens, start, [
        ...(trailingComma ? [[SyntaxKind.CommaToken] as const] : []),
        [SyntaxKind.CloseParenToken],
        ...(outerTrailingComma ? [[SyntaxKind.CommaToken] as const] : []),
        [SyntaxKind.CloseParenToken],
        [SyntaxKind.SemicolonToken],
      ]),
    ),
  );

const generatedInvocationPayloads = (
  kind: GovernedClientExpectation['invocationKind'],
): readonly (readonly ExpectedToken[])[] =>
  kind === MODULE_API_INVOCATION_KIND
    ? ([false, true] as const).map(
        (hasTrailingComma) =>
          [
            [SyntaxKind.OpenBraceToken],
            [SyntaxKind.Identifier, 'headers'],
            [SyntaxKind.ColonToken],
            [SyntaxKind.OpenBraceToken],
            [SyntaxKind.CloseBraceToken],
            [SyntaxKind.CommaToken],
            [SyntaxKind.Identifier, 'params'],
            [SyntaxKind.ColonToken],
            [SyntaxKind.OpenBraceToken],
            [SyntaxKind.CloseBraceToken],
            [SyntaxKind.CommaToken],
            [SyntaxKind.Identifier, 'payload'],
            [SyntaxKind.CommaToken],
            [SyntaxKind.Identifier, 'query'],
            [SyntaxKind.ColonToken],
            [SyntaxKind.OpenBraceToken],
            [SyntaxKind.CloseBraceToken],
            ...(hasTrailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
            [SyntaxKind.CloseBraceToken],
            [SyntaxKind.CloseParenToken],
          ] satisfies readonly ExpectedToken[],
      )
    : ([false, true] as const).map(
        (hasTrailingComma) =>
          [
            [SyntaxKind.OpenBraceToken],
            [SyntaxKind.Identifier, 'payload'],
            ...(hasTrailingComma ? ([[SyntaxKind.CommaToken]] as const) : []),
            [SyntaxKind.CloseBraceToken],
            [SyntaxKind.CloseParenToken],
          ] satisfies readonly ExpectedToken[],
      );

const clientHelperShadowsImports = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  expectation: GovernedClientExpectation,
): boolean => {
  const requiredHelperImports = new Set([
    'Effect',
    'Redacted',
    'makeGovernedEffectBffClient',
    expectation.ownerApiValue,
  ]);
  return (
    parametersBindIdentifier(tokens, helper.parametersStart, helper.parametersEnd, requiredHelperImports) ||
    hasTopLevelDeclaration(tokens, helper.start, helper.end, requiredHelperImports)
  );
};

const operationParametersShadowBindings = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  expectation: GovernedClientExpectation,
  authorized: ExportedConst,
  authorizedArrow: number,
  operation: ExportedConst,
  operationArrow: number,
): boolean => {
  const authorizedShadowsBindings = parametersBindIdentifier(
    tokens,
    authorized.start,
    authorizedArrow,
    new Set([helper.name, 'Effect', 'Redacted']),
  );
  const operationShadowsBindings = parametersBindIdentifier(
    tokens,
    operation.start,
    operationArrow,
    new Set(['operationGateway', expectation.authorizedOperation]),
  );
  return authorizedShadowsBindings || operationShadowsBindings;
};

const exportedOperationsUseClientHelperAndGateway = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  expectation: GovernedClientExpectation,
): boolean => {
  const declarations = generatedOperationDeclarations(tokens, expectation);
  if (declarations === undefined) {
    return false;
  }
  const [authorized, operation] = declarations;
  const authorizedArrow = findSequence(tokens, [[SyntaxKind.EqualsGreaterThanToken]], authorized.start, authorized.end);
  const operationArrow = findSequence(tokens, [[SyntaxKind.EqualsGreaterThanToken]], operation.start, operation.end);
  if (authorizedArrow === undefined || operationArrow === undefined) {
    return false;
  }
  const invocationPayloads = generatedInvocationPayloads(expectation.invocationKind);
  const authorizedInvocation = [
    [SyntaxKind.Identifier, helper.name],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'Redacted'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'make'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'credential'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'requestCorrelation'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'options'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'pipe'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'Effect'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'flatMap'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'client'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.EqualsGreaterThanToken],
    [SyntaxKind.Identifier, 'client'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, expectation.endpointGroup],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'execute'],
    [SyntaxKind.OpenParenToken],
  ] satisfies readonly ExpectedToken[];
  const authorizedInvocationEnd = authorizedArrow + 1 + authorizedInvocation.length;
  const authorizedInvocationTail = matchingSequenceEnd(tokens, authorizedInvocationEnd, invocationPayloads);
  const authorizedUsesHelper =
    authorizedInvocationEnd !== undefined && hasInvocationClosure(tokens, authorizedInvocationTail);
  const gatewayInvocation = [
    [SyntaxKind.Identifier, 'operationGateway'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'invoke'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'credential'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.EqualsGreaterThanToken],
    [SyntaxKind.Identifier, expectation.authorizedOperation],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'payload'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'credential'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'requestCorrelation'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'options'],
  ] satisfies readonly ExpectedToken[];
  const gatewayInvocationEnd = operationArrow + 1 + gatewayInvocation.length;
  const operationUsesGateway =
    matchesSequence(tokens, operationArrow + 1, gatewayInvocation) &&
    hasInvocationClosure(tokens, gatewayInvocationEnd);
  const helperShadowsImports = clientHelperShadowsImports(tokens, helper, expectation);
  const shadowsBindings = operationParametersShadowBindings(
    tokens,
    helper,
    expectation,
    authorized,
    authorizedArrow,
    operation,
    operationArrow,
  );
  const operationChecks = {
    parameters: hasExactGeneratedOperationParameters(
      tokens,
      helper,
      authorized,
      authorizedArrow,
      operation,
      operationArrow,
      expectation,
    ),
    authorizedUsesHelper,
    operationUsesGateway,
    helperDoesNotShadowImports: !helperShadowsImports,
    parametersDoNotShadowBindings: !shadowsBindings,
  };
  return Object.values(operationChecks).every(Boolean);
};

export const generatedApiGroup = (source: string, ownerApiValue: string): string | undefined => {
  const tokens = tokenizeGovernedClient(source);
  const apiDeclaration = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, ownerApiValue],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.Identifier, 'HttpApi'],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'make'],
    ],
    0,
    tokens.length,
  );
  if (apiDeclaration === undefined) {
    return undefined;
  }
  const declarationEnd = findRootExpressionSequence(
    tokens,
    [[SyntaxKind.SemicolonToken]],
    apiDeclaration + 7,
    tokens.length,
  );
  if (declarationEnd === undefined) {
    return undefined;
  }
  const sequence = [
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'add'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'HttpApiGroup'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'make'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.StringLiteral],
    [SyntaxKind.CloseParenToken],
  ] satisfies readonly ExpectedToken[];
  const end = declarationEnd;
  const isExactGroupArgument = (group: number): boolean => {
    const outerCallClose = findClosingParenthesis(tokens, group + 2, end);
    if (outerCallClose === undefined || outerCallClose + 1 !== declarationEnd) {
      return false;
    }
    const endpointAdd = group + sequence.length;
    if (
      endpointAdd === outerCallClose ||
      (tokenKind(tokens, endpointAdd) === SyntaxKind.CommaToken && endpointAdd + 1 === outerCallClose)
    ) {
      return true;
    }
    if (
      !matchesSequence(tokens, endpointAdd, [
        [SyntaxKind.DotToken],
        [SyntaxKind.Identifier, 'add'],
        [SyntaxKind.OpenParenToken],
      ])
    ) {
      return false;
    }
    const endpointAddClose = findClosingParenthesis(tokens, endpointAdd + 2, outerCallClose + 1);
    return endpointAddClose !== undefined && isOptionalTrailingComma(tokens, endpointAddClose + 1, outerCallClose);
  };
  const makeOpen = apiDeclaration + 7;
  const makeClose =
    tokenKind(tokens, makeOpen) === SyntaxKind.OpenParenToken
      ? findClosingParenthesis(tokens, makeOpen, end)
      : undefined;
  const hasExactApiRoot =
    makeClose !== undefined &&
    matchesSequence(tokens, makeOpen + 1, [[SyntaxKind.StringLiteral, ownerApiValue]]) &&
    isOptionalTrailingComma(tokens, makeOpen + 2, makeClose);
  if (makeClose === undefined) {
    return undefined;
  }
  const group = makeClose + 1;
  return hasExactApiRoot && matchesSequence(tokens, group, sequence) && isExactGroupArgument(group)
    ? tokenValue(tokens, group + 7)
    : undefined;
};

const hasGeneratedEndpointContract = (
  source: string,
  ownerApiValue: string,
  groupName: string,
  endpointPath: string,
): boolean => {
  const tokens = tokenizeGovernedClient(source);
  const declaration = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, ownerApiValue],
      [SyntaxKind.EqualsToken],
    ],
    0,
    tokens.length,
  );
  const declarationEnd = declaration === undefined ? undefined : findStatementSemicolon(tokens, declaration);
  if (declaration === undefined || declarationEnd === undefined) {
    return false;
  }
  const groupMake = findSequence(
    tokens,
    [
      [SyntaxKind.Identifier, 'HttpApiGroup'],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'make'],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.StringLiteral, groupName],
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'add'],
      [SyntaxKind.OpenParenToken],
    ],
    declaration,
    declarationEnd,
  );
  if (groupMake === undefined) {
    return false;
  }
  const groupAddOpen = groupMake + 8;
  const endpoint = groupAddOpen + 1;
  const endpointSequence = [
    [SyntaxKind.Identifier, 'HttpApiEndpoint'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'post'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.StringLiteral, 'execute'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.StringLiteral, endpointPath],
  ] satisfies readonly ExpectedToken[];
  const endpointOpen = endpoint + 3;
  const endpointClose = matchesSequence(tokens, endpoint, endpointSequence)
    ? findClosingParenthesis(tokens, endpointOpen, declarationEnd)
    : undefined;
  const groupAddClose = findClosingParenthesis(tokens, groupAddOpen, declarationEnd);
  return (
    endpointClose !== undefined &&
    groupAddClose !== undefined &&
    isOptionalTrailingComma(tokens, endpointClose + 1, groupAddClose)
  );
};
export const hasGeneratedProviderApiContract = (
  source: string,
  ownerApiValue: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const groupName = generatedApiGroup(source, ownerApiValue);
  return (
    groupName !== undefined &&
    hasGeneratedEndpointContract(
      source,
      ownerApiValue,
      groupName,
      `/${moduleId}/${kind === 'report' ? 'reports' : 'search'}/${name}`,
    )
  );
};

export const hasGeneratedModuleApiContract = (
  source: string,
  ownerApiValue: string,
  groupName: string,
  stem: string,
): boolean => hasGeneratedEndpointContract(source, ownerApiValue, groupName, `/reads/${stem}`);

const topLevelCallObject = (
  tokens: readonly GovernedClientToken[],
  exportedName: string,
  callee: string,
  requireExport = true,
): readonly [open: number, close: number, declarationEnd: number] | undefined => {
  const declaration = findTopLevelSequence(
    tokens,
    [
      ...(requireExport ? ([[SyntaxKind.ExportKeyword]] as const) : []),
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, exportedName],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.Identifier, callee],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.OpenBraceToken],
    ],
    0,
    tokens.length,
  );
  if (declaration === undefined) {
    return undefined;
  }
  const declarationEnd = findStatementSemicolon(tokens, declaration);
  if (declarationEnd === undefined) {
    return undefined;
  }
  const open = declaration + (requireExport ? 6 : 5);
  const close = findClosingBrace(tokens, open);
  const callClose = findClosingParenthesis(tokens, open - 1, declarationEnd);
  return close !== undefined && close < declarationEnd && callClose !== undefined && callClose + 1 === declarationEnd
    ? [open, close, declarationEnd]
    : undefined;
};

// This is a source contract, not an executable import from a deployment. Accept only
// the owner-local factory's complete declaration, including its imported constructors.
const engagementLifecycleRegistrationContract = `
import { defineActionResourcePermission, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { OrganizationEngagementLifecyclePayload, PersonEngagementLifecyclePayload } from '../../shared/domain/engagement-profile.ts';
import { EngagementLifecycleErrorSchema } from './engagement-lifecycle-handler.ts';
type EngagementLifecyclePayload = | OrganizationEngagementLifecyclePayload | PersonEngagementLifecyclePayload;
type EngagementLifecycleActionKey = \`party.registry.\${'archive' | 'unarchive'}-\${'person' | 'organization'}-engagement\`;
export const engagementLifecycleRegistration = <Payload extends EngagementLifecyclePayload>(actionKey: EngagementLifecycleActionKey) => ({
  accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: \`\${actionKey}.access.v1\` },
  actionKey,
  auditProfile: 'standard',
  domainErrorSchema: EngagementLifecycleErrorSchema,
  domainEvents: {},
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: actionKey,
    moduleKey: 'party.registry',
    role: 'action',
  }),
  idempotency: 'required',
  legalEntityScope: 'required',
  owningModuleKey: 'party.registry',
  policies: [],
  resourcePermission: defineActionResourcePermission<Payload>((payload) => ({
    permission: 'write',
    resource: {
      moduleId: payload.profileRef.moduleId,
      resourceId: payload.profileRef.resourceId,
      resourceType: payload.profileRef.resourceType,
    },
  })),
  schemaVersion: '1',
}) as const;
`;

const withoutTrailingCommas = (tokens: readonly GovernedClientToken[]) =>
  tokens.filter(
    (token, index) =>
      token.kind !== SyntaxKind.CommaToken ||
      tokenKind(tokens, index - 1) === SyntaxKind.OpenBracketToken ||
      tokenKind(tokens, index - 1) === SyntaxKind.CommaToken ||
      ![
        SyntaxKind.CloseBraceToken,
        SyntaxKind.CloseParenToken,
        SyntaxKind.CloseBracketToken,
        SyntaxKind.GreaterThanToken,
      ].includes(tokens[index + 1]?.kind ?? SyntaxKind.Unknown),
  );

const engagementLifecyclePayloadUnionPrefix: readonly ExpectedToken[] = [
  [SyntaxKind.TypeKeyword, 'type'],
  [SyntaxKind.Identifier, 'EngagementLifecyclePayload'],
  [SyntaxKind.EqualsToken],
  [SyntaxKind.BarToken],
];

const withoutLeadingEngagementLifecycleUnionPipe = (
  tokens: readonly GovernedClientToken[],
): readonly GovernedClientToken[] => {
  const prefix = findSequence(tokens, engagementLifecyclePayloadUnionPrefix);
  if (prefix === undefined) {
    return tokens;
  }
  return [...tokens.slice(0, prefix + 3), ...tokens.slice(prefix + 4)];
};

const SOURCE_VALUE_TOKEN_KINDS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
]);

const sourceTokensMatch = (
  actualTokens: readonly GovernedClientToken[],
  expectedTokens: readonly GovernedClientToken[],
): boolean =>
  actualTokens.length === expectedTokens.length &&
  expectedTokens.every(
    (token, index) =>
      actualTokens[index]?.kind === token.kind &&
      (!SOURCE_VALUE_TOKEN_KINDS.has(token.kind) || actualTokens[index]?.value === token.value),
  );

const hasExactSourceTokens = (tokens: readonly GovernedClientToken[], expected: string): boolean =>
  sourceTokensMatch(withoutTrailingCommas(tokens), withoutTrailingCommas(tokenizeGovernedClient(expected)));

const hasExactSourceTokensAllowingEngagementLifecycleUnionPipe = (
  tokens: readonly GovernedClientToken[],
  expected: string,
): boolean => {
  const actualTokens = withoutTrailingCommas(tokens);
  const expectedTokens = withoutTrailingCommas(tokenizeGovernedClient(expected));
  return (
    sourceTokensMatch(actualTokens, expectedTokens) ||
    sourceTokensMatch(actualTokens, withoutLeadingEngagementLifecycleUnionPipe(expectedTokens)) ||
    sourceTokensMatch(withoutLeadingEngagementLifecycleUnionPipe(actualTokens), expectedTokens)
  );
};

export const hasEngagementLifecycleRegistrationContract = (
  source: string,
  registrationSource: string,
  action: string,
): boolean => {
  const identity = /^(?<transition>archive|unarchive)-(?<subject>organization|person)-engagement$/u.exec(
    action,
  )?.groups;
  if (
    identity === undefined ||
    !hasExactSourceTokensAllowingEngagementLifecycleUnionPipe(
      tokenizeGovernedClient(registrationSource),
      engagementLifecycleRegistrationContract,
    )
  ) {
    return false;
  }
  const subject = identity.subject === 'organization' ? 'Organization' : 'Person';
  const exportedName = `${toCamelCase(action)}Action`;
  const payload = `${subject}EngagementLifecyclePayload`;
  const result = `${subject}EngagementProfile`;
  const tokens = tokenizeGovernedClient(source);
  const declaration = topLevelCallObject(tokens, exportedName, 'defineAction');
  if (declaration === undefined) {
    return false;
  }
  const [open, close, end] = declaration;
  return (
    end + 1 === tokens.length &&
    hasExactSourceTokens(
      tokens.slice(0, open),
      `
      import { defineAction, OperationContextUnavailable } from '@app/core-runtime';
      import { Effect } from 'effect';
      import { ${payload}Schema, ${result}Schema } from '../../shared/domain/engagement-profile.ts';
      import type { ${payload}, ${result} } from '../../shared/domain/engagement-profile.ts';
      import { transition${subject}EngagementProfile } from '../services/engagement-profile-persistence.service.ts';
      import { handleEngagementLifecycle } from './engagement-lifecycle-handler.ts';
      import { engagementLifecycleRegistration } from './engagement-lifecycle-registration.ts';
      export const ${exportedName} = defineAction(
    `,
    ) &&
    hasExactSourceTokens(
      tokens.slice(open, close + 1),
      `{
      ...engagementLifecycleRegistration<${payload}>('party.registry.${action}'),
      payloadSchema: ${payload}Schema,
      resultSchema: ${result}Schema,
    }`,
    ) &&
    ['defineAction', 'engagementLifecycleRegistration', `${payload}Schema`, `${result}Schema`].every(
      (binding) => identifierOccurrences(tokens, binding) === 2,
    )
  );
};

const objectHasExactString = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  property: string,
  value: string,
): boolean =>
  directObjectPropertyOccurrences(tokens, open, close, property) === 1 &&
  hasExactObjectPropertyValue(tokens, findObjectPropertyValue(tokens, open, close, property), [
    [SyntaxKind.StringLiteral, value],
  ]);

const objectHasExactStrings = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  expected: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(expected).every(([property, value]) => objectHasExactString(tokens, open, close, property, value));

const objectHasExactStringsOrConstAliases = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  expected: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(expected).every(([property, value]) => {
    if (directObjectPropertyOccurrences(tokens, open, close, property) !== 1) {
      return false;
    }
    const valueStart = findObjectPropertyValue(tokens, open, close, property);
    if (hasExactObjectPropertyValue(tokens, valueStart, [[SyntaxKind.StringLiteral, value]])) {
      return true;
    }
    const alias = valueStart === undefined ? undefined : tokenValue(tokens, valueStart);
    return (
      alias !== undefined &&
      tokenKind(tokens, valueStart) === SyntaxKind.Identifier &&
      hasExactObjectPropertyValue(tokens, valueStart, [[SyntaxKind.Identifier, alias]]) &&
      sequenceOccurrencesAtBraceDepth(
        tokens,
        [
          [SyntaxKind.ConstKeyword],
          [SyntaxKind.Identifier, alias],
          [SyntaxKind.EqualsToken],
          [SyntaxKind.StringLiteral, value],
          [SyntaxKind.SemicolonToken],
        ],
        0,
      ) === 1
    );
  });

const objectReferencesEntrypoint = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  entrypoint: string,
): boolean =>
  directObjectPropertyOccurrences(tokens, open, close, 'entrypoint') === 1 &&
  hasExactObjectPropertyValue(tokens, findObjectPropertyValue(tokens, open, close, 'entrypoint'), [
    [SyntaxKind.Identifier, entrypoint],
  ]);

export interface GeneratedReadAuthorization {
  readonly kind: 'authenticated_principal' | 'context_permission' | 'public';
  readonly permission?: string;
}

const objectStringProperty = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  property: string,
): string | undefined => {
  const start = findObjectPropertyValue(tokens, open, close, property);
  return start !== undefined && hasExactObjectPropertyValue(tokens, start, [[SyntaxKind.StringLiteral]])
    ? tokenValue(tokens, start)
    : undefined;
};

const authorizationObject = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
): GeneratedReadAuthorization | undefined => {
  const kind = objectStringProperty(tokens, open, close, 'kind');
  const properties = directObjectPropertyNames(tokens, open, close);
  if (kind === 'context_permission') {
    const permission = objectStringProperty(tokens, open, close, 'permission');
    return permission !== undefined &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(permission) &&
      hasExactProperties(properties, new Set(['kind', 'permission']))
      ? { kind, permission }
      : undefined;
  }
  if (kind !== 'authenticated_principal' && kind !== 'public') {
    return undefined;
  }
  return hasExactProperties(properties, new Set(['kind'])) ? { kind } : undefined;
};

const nestedObjectRange = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
  property: string,
): readonly [number, number] | undefined => {
  const value = findObjectPropertyValue(tokens, open, close, property);
  if (value === undefined || tokenKind(tokens, value) !== SyntaxKind.OpenBraceToken) {
    return undefined;
  }
  const end = findClosingBrace(tokens, value);
  return end === undefined ? undefined : [value, end];
};

const generatedReadAuthorization = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
): GeneratedReadAuthorization | undefined => {
  if (directObjectPropertyOccurrences(tokens, open, close, 'authorization') !== 1) {
    return undefined;
  }
  const range = nestedObjectRange(tokens, open, close, 'authorization');
  return range !== undefined && directObjectHasNoSpread(tokens, ...range)
    ? authorizationObject(tokens, ...range)
    : undefined;
};

const matchesGeneratedReadAuthorization = (
  actual: GeneratedReadAuthorization | undefined,
  expected: GeneratedReadAuthorization | undefined,
): boolean =>
  actual !== undefined &&
  (expected === undefined || (actual.kind === expected.kind && actual.permission === expected.permission));

const hasGeneratedReadContract = (
  source: string,
  moduleId: string,
  name: string,
  role: 'api' | 'report' | 'search',
  authorization?: GeneratedReadAuthorization,
): boolean => {
  const tokens = tokenizeGovernedClient(source);
  const camel = toCamelCase(name);
  const entrypointName = `${camel}Entrypoint`;
  const entrypoint = topLevelCallObject(tokens, entrypointName, 'defineTenantModuleEntrypoint', false);
  const read = topLevelCallObject(tokens, `${camel}Read`, 'defineRead');
  if (entrypoint === undefined || read === undefined) {
    return false;
  }
  const [entrypointOpen, entrypointClose, entrypointEnd] = entrypoint;
  const [readOpen, readClose] = read;
  return (
    directObjectHasNoSpread(tokens, entrypointOpen, entrypointClose) &&
    directObjectHasNoSpread(tokens, readOpen, readClose) &&
    matchesGeneratedReadAuthorization(
      generatedReadAuthorization(tokens, entrypointOpen, entrypointClose),
      authorization,
    ) &&
    matchesSequence(tokens, entrypointClose + 1, [[SyntaxKind.CloseParenToken], [SyntaxKind.SemicolonToken]]) &&
    entrypointClose + 2 === entrypointEnd &&
    objectHasExactStrings(tokens, entrypointOpen, entrypointClose, {
      access: 'read',
      entrypointKey: `${moduleId}.${role}.${name}`,
      moduleKey: moduleId,
      role,
    }) &&
    objectReferencesEntrypoint(tokens, readOpen, readClose, entrypointName) &&
    objectHasExactStrings(tokens, readOpen, readClose, {
      owningModuleKey: moduleId,
      readKey: `${moduleId}.${role}.${name}`,
      schemaVersion: '1',
    })
  );
};

export const hasGeneratedProviderReadContract = (
  source: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
  authorization?: GeneratedReadAuthorization,
): boolean =>
  hasGeneratedReadContract(source, moduleId, name, kind, authorization) &&
  (() => {
    const tokens = tokenizeGovernedClient(source);
    const read = topLevelCallObject(tokens, `${toCamelCase(name)}Read`, 'defineRead');
    return (
      read !== undefined &&
      objectHasExactString(tokens, read[0], read[1], 'accessKind', kind) &&
      directObjectPropertyOccurrences(tokens, read[0], read[1], 'legalEntityScope') === 1
    );
  })();

const enclosingBraceRange = (
  tokens: readonly GovernedClientToken[],
  index: number,
): readonly [start: number, end: number] | undefined => {
  const openBraces: number[] = [];
  for (let cursor = 0; cursor <= index; cursor += 1) {
    if (tokenKind(tokens, cursor) === SyntaxKind.OpenBraceToken) {
      openBraces.push(cursor);
    } else if (tokenKind(tokens, cursor) === SyntaxKind.CloseBraceToken) {
      openBraces.pop();
    }
  }
  const start = openBraces.at(-1);
  const end = start === undefined ? undefined : findClosingBrace(tokens, start);
  return start === undefined || end === undefined ? undefined : [start, end];
};

export const hasMatchingGeneratedProviderAuthorization = (
  providerSource: string,
  manifest: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const providerTokens = tokenizeGovernedClient(providerSource);
  const entrypoint = topLevelCallObject(
    providerTokens,
    `${toCamelCase(name)}Entrypoint`,
    'defineTenantModuleEntrypoint',
    false,
  );
  const shellSlot = generatedSlotSource(
    manifest,
    kind === 'report' ? MANIFEST_SHELL_REPORT_SLOT : MANIFEST_SHELL_SEARCH_SLOT,
  );
  if (entrypoint === undefined || shellSlot === undefined) {
    return false;
  }
  const shellTokens = tokenizeGovernedClient(shellSlot);
  const identity = findSequenceAtBraceDepth(
    shellTokens,
    [
      [SyntaxKind.Identifier, 'contributionKey'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.StringLiteral, `${moduleId}.${kind}.${name}`],
    ],
    0,
    shellTokens.length,
    1,
  );
  const contribution = identity === undefined ? undefined : enclosingBraceRange(shellTokens, identity);
  const manifestEntrypoint =
    contribution === undefined ? undefined : nestedObjectRange(shellTokens, ...contribution, 'entrypoint');
  if (manifestEntrypoint === undefined) {
    return false;
  }
  const providerAuthorization = generatedReadAuthorization(providerTokens, entrypoint[0], entrypoint[1]);
  const manifestAuthorization = generatedReadAuthorization(shellTokens, ...manifestEntrypoint);
  return matchesGeneratedReadAuthorization(providerAuthorization, manifestAuthorization);
};

export const hasGeneratedModuleApiReadContract = (
  source: string,
  moduleId: string,
  name: string,
  authorization?: GeneratedReadAuthorization,
): boolean => {
  const aliases = [
    ...source.matchAll(
      new RegExp(
        `^const\\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(['"])${escapeRegExp(moduleId)}\\2(?:\\s+as\\s+const)?;\\s*$`,
        'gmu',
      ),
    ),
  ];
  const alias = aliases.length === 1 ? aliases[0]?.groups?.name : undefined;
  const normalizedSource =
    alias === undefined
      ? source
      : source
          .replaceAll(
            new RegExp(
              `(?<property>\\b(?:moduleKey|owningModuleKey))\\s*:\\s*${escapeRegExp(alias)}(?=\\s*[,}])`,
              'gu',
            ),
            `$<property>: '${moduleId}'`,
          )
          .replaceAll(new RegExp(`\\b${escapeRegExp(alias)}(?=\\s*[,}])`, 'gu'), `moduleKey: '${moduleId}'`);
  const tokens = tokenizeGovernedClient(normalizedSource);
  const camel = toCamelCase(name);
  const entrypointName = `${camel}Entrypoint`;
  const entrypoint = topLevelCallObject(tokens, entrypointName, 'defineTenantModuleEntrypoint', false);
  const read = topLevelCallObject(tokens, `${camel}Read`, 'defineRead');
  if (entrypoint === undefined || read === undefined) {
    return false;
  }
  const access = findObjectPropertyValue(tokens, entrypoint[0], entrypoint[1], 'access');
  return (
    directObjectHasNoSpread(tokens, entrypoint[0], entrypoint[1]) &&
    directObjectHasNoSpread(tokens, read[0], read[1]) &&
    matchesGeneratedReadAuthorization(
      generatedReadAuthorization(tokens, entrypoint[0], entrypoint[1]),
      authorization,
    ) &&
    ['read', 'historical_read'].some((value) =>
      hasExactObjectPropertyValue(tokens, access, [[SyntaxKind.StringLiteral, value]]),
    ) &&
    objectHasExactStringsOrConstAliases(tokens, entrypoint[0], entrypoint[1], {
      entrypointKey: `${moduleId}.api.${name}`,
      moduleKey: moduleId,
      role: 'api',
    }) &&
    objectReferencesEntrypoint(tokens, read[0], read[1], entrypointName) &&
    ['legalEntityScope', 'permissionTarget', 'policies'].every(
      (property) => directObjectPropertyOccurrences(tokens, read[0], read[1], property) === 1,
    ) &&
    objectHasExactStringsOrConstAliases(tokens, read[0], read[1], {
      owningModuleKey: moduleId,
      readKey: `${moduleId}.api.${name}`,
      schemaVersion: '1',
    })
  );
};

export const hasGeneratedGovernedClientContract = (source: string, expectation: GovernedClientExpectation): boolean => {
  if (!hasGeneratedSourceHeader(source, expectation.generatedHeader)) {
    return false;
  }
  const tokens = tokenizeGovernedClient(source);
  const declarations = exportedConsts(tokens);
  const authorized = declarations.find(({ name }) => name.endsWith('WithAuthorization'));
  if (authorized === undefined) {
    return false;
  }
  const helper = findClientHelper(tokens, authorized.start);
  return (
    helper !== undefined &&
    hasExactGeneratedImports(tokens, expectation) &&
    hasGovernedTransportInvocation(tokens, helper, expectation.ownerApiValue, expectation.defaultApiPrefix) &&
    exportedOperationsUseClientHelperAndGateway(tokens, helper, expectation) &&
    hasOnlyAllowedModuleStatements(tokens, helper, expectation) &&
    ['makeGovernedEffectBffClient', 'operationGateway', expectation.ownerApiValue, 'Effect', helper.name].every(
      (name) => identifierOccurrences(tokens, name) === 2,
    ) &&
    !tokens.some(({ value }) => value === 'makeEffectHttpApiClient' || value === 'HttpClientRequest')
  );
};

const slotHasDirectPropertyKey = (source: string | undefined, key: string): boolean => {
  if (source === undefined) {
    return false;
  }
  const tokens = tokenizeGovernedClient(source);
  return [SyntaxKind.StringLiteral, SyntaxKind.Identifier].some(
    (keyKind) =>
      findSequenceAtBraceDepth(tokens, [[keyKind, key], [SyntaxKind.ColonToken]], 0, tokens.length, 0) !== undefined,
  );
};

const directPropertyKeyOccurrences = (source: string, key: string): number => {
  const tokens = tokenizeGovernedClient(source);
  let count = 0;
  for (const keyKind of [SyntaxKind.StringLiteral, SyntaxKind.Identifier]) {
    count += sequenceOccurrencesAtBraceDepth(tokens, [[keyKind, key], [SyntaxKind.ColonToken]], 0);
  }
  return count;
};

const topLevelCommaSeparatedRanges = (
  tokens: readonly GovernedClientToken[],
): readonly (readonly [start: number, end: number])[] | undefined => {
  const ranges: (readonly [number, number])[] = [];
  const depth = new DelimiterDepth();
  let start = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokenKind(tokens, index);
    depth.update(tokenDelimiter.get(kind ?? SyntaxKind.Unknown));
    if (depth.hasUnmatchedClose()) {
      return undefined;
    }
    if (kind === SyntaxKind.CommaToken && depth.isTopLevel()) {
      if (start < index) {
        ranges.push([start, index]);
      }
      start = index + 1;
    }
  }
  if (!depth.isTopLevel()) {
    return undefined;
  }
  if (start < tokens.length) {
    ranges.push([start, tokens.length]);
  }
  return ranges;
};

const directSlotPropertyNames = (source: string | undefined): readonly string[] | undefined => {
  if (source === undefined) {
    return undefined;
  }
  const tokens = tokenizeGovernedClient(source);
  const ranges = topLevelCommaSeparatedRanges(tokens);
  if (ranges === undefined) {
    return undefined;
  }
  const names: string[] = [];
  for (const [start] of ranges) {
    const key = tokens[start];
    if (
      (key?.kind !== SyntaxKind.Identifier && key?.kind !== SyntaxKind.StringLiteral) ||
      tokenKind(tokens, start + 1) !== SyntaxKind.ColonToken
    ) {
      return undefined;
    }
    names.push(key.value);
  }
  return names;
};

const hasRelatedSequenceInObject = (
  tokens: readonly GovernedClientToken[],
  anchor: readonly ExpectedToken[],
  related: readonly ExpectedToken[],
): boolean => {
  const anchorIndex = findSequenceAtBraceDepth(tokens, anchor, 0, tokens.length, 1);
  const range = anchorIndex === undefined ? undefined : enclosingBraceRange(tokens, anchorIndex);
  return range !== undefined && findSequenceAtBraceDepth(tokens, related, range[0], range[1], 1) !== undefined;
};

const registrationIdentityIsExclusiveToSlot = (
  registration: string,
  name: string,
  intendedSlot: readonly [string, string],
): boolean =>
  [REGISTRATION_API_SLOT, REGISTRATION_REPORT_SLOT, REGISTRATION_SEARCH_SLOT].every((slot) => {
    const source = generatedSlotSource(registration, slot);
    return slot === intendedSlot ? source !== undefined : !slotHasDirectPropertyKey(source, name);
  });

export const hasGeneratedProviderRegistration = (
  registration: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const slot = generatedSlotSource(
    registration,
    kind === 'report' ? REGISTRATION_REPORT_SLOT : REGISTRATION_SEARCH_SLOT,
  );
  if (slot === undefined) {
    return false;
  }
  const intendedSlot = kind === 'report' ? REGISTRATION_REPORT_SLOT : REGISTRATION_SEARCH_SLOT;
  if (!registrationIdentityIsExclusiveToSlot(registration, name, intendedSlot)) {
    return false;
  }
  const tokens = tokenizeGovernedClient(slot);
  const clientSuffix = kind === 'report' ? 'report-client' : 'search-client';
  const registrationTail = [
    [SyntaxKind.ColonToken],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.EqualsGreaterThanToken],
    [SyntaxKind.ImportKeyword],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.StringLiteral, `./src/api/${name}-${clientSuffix}.ts`],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.CommaToken],
  ] satisfies readonly ExpectedToken[];
  return (
    directPropertyKeyOccurrences(slot, name) === 1 &&
    [SyntaxKind.StringLiteral, SyntaxKind.Identifier].some((keyKind) => {
      const key: ExpectedToken = [keyKind, name];
      return findSequenceAtBraceDepth(tokens, [key, ...registrationTail], 0, tokens.length, 0) !== undefined;
    })
  );
};

const hasProviderShellEntrypoint = (
  tokens: readonly GovernedClientToken[],
  contribution: readonly [number, number],
  identity: Readonly<Record<string, string>>,
): boolean => {
  const range = nestedObjectRange(tokens, ...contribution, 'entrypoint');
  return (
    range !== undefined &&
    directObjectHasNoSpread(tokens, ...range) &&
    objectHasExactStrings(tokens, ...range, identity)
  );
};

const slotOmitsIdentity = (source: string | undefined, identity: readonly ExpectedToken[]): boolean =>
  source === undefined || sequenceOccurrencesAtBraceDepth(tokenizeGovernedClient(source), identity, 1) === 0;

const hasOwnedProviderDescriptor = (
  tokens: readonly GovernedClientToken[],
  identity: readonly ExpectedToken[],
  moduleId: string,
): boolean =>
  sequenceOccurrencesAtBraceDepth(tokens, identity, 1) === 1 &&
  hasRelatedSequenceInObject(tokens, identity, [
    [SyntaxKind.Identifier, 'owningModuleId'],
    [SyntaxKind.ColonToken],
    [SyntaxKind.StringLiteral, moduleId],
  ]);

const hasOwnedProviderShellContribution = (
  shellTokens: readonly GovernedClientToken[],
  shellIdentity: readonly ExpectedToken[],
  shellContribution: readonly [number, number] | undefined,
  shellContributionKey: string,
  moduleId: string,
  kind: 'report' | 'search',
  descriptorKey: string,
): boolean =>
  sequenceOccurrencesAtBraceDepth(shellTokens, shellIdentity, 1) === 1 &&
  shellContribution !== undefined &&
  hasProviderShellEntrypoint(shellTokens, shellContribution, {
    access: 'read',
    entrypointKey: shellContributionKey,
    moduleKey: moduleId,
    role: kind,
    scope: 'tenant',
  }) &&
  hasRelatedSequenceInObject(shellTokens, shellIdentity, [
    [SyntaxKind.Identifier, kind === 'report' ? 'reportKey' : 'searchKey'],
    [SyntaxKind.ColonToken],
    [SyntaxKind.StringLiteral, descriptorKey],
  ]);

export const hasGeneratedProviderManifest = (
  manifest: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const [descriptorMarkers, shellMarkers, otherDescriptorMarkers, otherShellMarkers] =
    kind === 'report'
      ? [MANIFEST_REPORT_SLOT, MANIFEST_SHELL_REPORT_SLOT, MANIFEST_SEARCH_SLOT, MANIFEST_SHELL_SEARCH_SLOT]
      : [MANIFEST_SEARCH_SLOT, MANIFEST_SHELL_SEARCH_SLOT, MANIFEST_REPORT_SLOT, MANIFEST_SHELL_REPORT_SLOT];
  const descriptorSlot = generatedSlotSource(manifest, descriptorMarkers);
  const shellSlot = generatedSlotSource(manifest, shellMarkers);
  if (descriptorSlot === undefined || shellSlot === undefined) {
    return false;
  }
  const descriptorTokens = tokenizeGovernedClient(descriptorSlot);
  const shellTokens = tokenizeGovernedClient(shellSlot);
  const descriptorKey = `${moduleId}.${name}`;
  const shellContributionKey = `${moduleId}.${kind}.${name}`;
  const descriptorIdentity = [
    [SyntaxKind.Identifier, 'key'],
    [SyntaxKind.ColonToken],
    [SyntaxKind.StringLiteral, descriptorKey],
  ] satisfies readonly ExpectedToken[];
  const shellIdentity = [
    [SyntaxKind.Identifier, 'contributionKey'],
    [SyntaxKind.ColonToken],
    [SyntaxKind.StringLiteral, shellContributionKey],
  ] satisfies readonly ExpectedToken[];
  const otherDescriptorSlot = generatedSlotSource(manifest, otherDescriptorMarkers);
  const otherShellSlot = generatedSlotSource(manifest, otherShellMarkers);
  const shellIdentityIndex = findSequenceAtBraceDepth(shellTokens, shellIdentity, 0, shellTokens.length, 1);
  const shellContribution =
    shellIdentityIndex === undefined ? undefined : enclosingBraceRange(shellTokens, shellIdentityIndex);
  return (
    hasOwnedProviderDescriptor(descriptorTokens, descriptorIdentity, moduleId) &&
    hasOwnedProviderShellContribution(
      shellTokens,
      shellIdentity,
      shellContribution,
      shellContributionKey,
      moduleId,
      kind,
      descriptorKey,
    ) &&
    slotOmitsIdentity(otherDescriptorSlot, descriptorIdentity) &&
    slotOmitsIdentity(otherShellSlot, shellIdentity)
  );
};

export interface GeneratedProviderIdentity {
  readonly kind: 'report' | 'search';
  readonly name: string;
}

const slotProviderNames = (
  source: string | undefined,
  moduleId: string,
  kind: GeneratedProviderIdentity['kind'],
  identityProperty: 'contributionKey' | 'key',
  depth: number,
): readonly string[] => {
  if (source === undefined || moduleId.length === 0) {
    return [];
  }
  const prefix = identityProperty === 'contributionKey' ? `${moduleId}.${kind}.` : `${moduleId}.`;
  const tokens = tokenizeGovernedClient(source);
  const names: string[] = [];
  let braceDepth = 0;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      braceDepth === depth &&
      matchesSequence(tokens, index, [
        [SyntaxKind.Identifier, identityProperty],
        [SyntaxKind.ColonToken],
        [SyntaxKind.StringLiteral],
      ])
    ) {
      const value = tokenValue(tokens, index + 2) ?? '';
      const name = value.startsWith(prefix) ? value.slice(prefix.length) : '';
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
        names.push(name);
      }
    }
    braceDepth += tokenBraceDelta(tokenKind(tokens, index));
  }
  return names;
};

const registrationProviderNames = (source: string | undefined): readonly string[] =>
  (directSlotPropertyNames(source) ?? []).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name));

const providerIdentitySlotIsExact = (
  source: string | undefined,
  names: readonly string[],
  identityProperty: 'contributionKey' | 'key',
  depth: number,
): boolean =>
  source !== undefined &&
  sequenceOccurrencesAtBraceDepth(
    tokenizeGovernedClient(source),
    [[SyntaxKind.Identifier, identityProperty], [SyntaxKind.ColonToken], [SyntaxKind.StringLiteral]],
    depth,
  ) === names.length;

const sameUniqueNames = (...collections: readonly (readonly string[])[]): boolean => {
  const [first, ...remaining] = collections;
  if (first === undefined || new Set(first).size !== first.length) {
    return false;
  }
  const expected = new Set(first);
  return remaining.every(
    (names) =>
      names.length === expected.size &&
      new Set(names).size === names.length &&
      names.every((name) => expected.has(name)),
  );
};

export const hasExactGeneratedProviderIdentityTopology = (
  manifest: string,
  registration: string,
  moduleId: string,
): boolean => {
  const slotsPresent =
    [MANIFEST_REPORT_SLOT, MANIFEST_SEARCH_SLOT, MANIFEST_SHELL_REPORT_SLOT, MANIFEST_SHELL_SEARCH_SLOT].some(
      (slot) => generatedSlotSource(manifest, slot) !== undefined,
    ) ||
    [REGISTRATION_REPORT_SLOT, REGISTRATION_SEARCH_SLOT].some(
      (slot) => generatedSlotSource(registration, slot) !== undefined,
    );
  if (!slotsPresent) {
    return true;
  }
  return (['report', 'search'] as const).every((kind) => {
    const descriptorSlot = generatedSlotSource(
      manifest,
      kind === 'report' ? MANIFEST_REPORT_SLOT : MANIFEST_SEARCH_SLOT,
    );
    const shellSlot = generatedSlotSource(
      manifest,
      kind === 'report' ? MANIFEST_SHELL_REPORT_SLOT : MANIFEST_SHELL_SEARCH_SLOT,
    );
    const registrationSlot = generatedSlotSource(
      registration,
      kind === 'report' ? REGISTRATION_REPORT_SLOT : REGISTRATION_SEARCH_SLOT,
    );
    const descriptorNames = slotProviderNames(descriptorSlot, moduleId, kind, 'key', 1);
    const shellNames = slotProviderNames(shellSlot, moduleId, kind, 'contributionKey', 1);
    const directRegistrationNames = directSlotPropertyNames(registrationSlot);
    const registrationNames = registrationProviderNames(registrationSlot);
    return (
      directRegistrationNames !== undefined &&
      directRegistrationNames.length === registrationNames.length &&
      providerIdentitySlotIsExact(descriptorSlot, descriptorNames, 'key', 1) &&
      providerIdentitySlotIsExact(shellSlot, shellNames, 'contributionKey', 1) &&
      sameUniqueNames(descriptorNames, shellNames, registrationNames)
    );
  });
};

export const generatedProviderIdentities = (
  manifest: string,
  registration: string,
  moduleId: string,
): readonly GeneratedProviderIdentity[] => {
  const identities = new Map<string, GeneratedProviderIdentity>();
  for (const kind of ['report', 'search'] as const) {
    const descriptorSlot = generatedSlotSource(
      manifest,
      kind === 'report' ? MANIFEST_REPORT_SLOT : MANIFEST_SEARCH_SLOT,
    );
    const shellSlot = generatedSlotSource(
      manifest,
      kind === 'report' ? MANIFEST_SHELL_REPORT_SLOT : MANIFEST_SHELL_SEARCH_SLOT,
    );
    const registrationSlot = generatedSlotSource(
      registration,
      kind === 'report' ? REGISTRATION_REPORT_SLOT : REGISTRATION_SEARCH_SLOT,
    );
    const names = [
      ...slotProviderNames(descriptorSlot, moduleId, kind, 'key', 1),
      ...slotProviderNames(shellSlot, moduleId, kind, 'contributionKey', 1),
      ...registrationProviderNames(registrationSlot),
    ];
    for (const name of names) {
      identities.set(`${kind}:${name}`, { kind, name });
    }
  }
  return [...identities.values()];
};

const hasExactGeneratedGatewayFactory = (
  tokens: readonly GovernedClientToken[],
  start: number,
  end: number,
): boolean => {
  const expected = [
    [SyntaxKind.ExportKeyword],
    [SyntaxKind.ConstKeyword],
    [SyntaxKind.Identifier, 'makeOperationGateway'],
    [SyntaxKind.EqualsToken],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'acquire'],
    [SyntaxKind.ColonToken],
    [SyntaxKind.Identifier, 'OperationGatewayIssuer'],
    [SyntaxKind.EqualsToken],
    [SyntaxKind.Identifier, 'issueGatewayContext'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.EqualsGreaterThanToken],
    [SyntaxKind.Identifier, 'makeSharedOperationGateway'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.Identifier, 'ACTION_GATEWAY_AUDIENCE'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.Identifier, 'acquire'],
    [SyntaxKind.CloseParenToken],
    [SyntaxKind.SemicolonToken],
  ] satisfies readonly ExpectedToken[];
  return start + expected.length === end + 1 && matchesSequence(tokens, start, expected);
};

const hasGatewayBindingMutation = (tokens: readonly GovernedClientToken[]): boolean => {
  const protectedBindings = new Set(['makeOperationGateway', 'operationGateway']);
  for (let index = 0; index < tokens.length; index += 1) {
    const binding = tokens[index];
    if (binding?.kind !== SyntaxKind.Identifier || !protectedBindings.has(binding.value)) {
      continue;
    }
    if (
      ['assign', 'defineProperties', 'defineProperty'].some((operation) =>
        matchesSequence(tokens, index - 4, [
          [SyntaxKind.Identifier, 'Object'],
          [SyntaxKind.DotToken],
          [SyntaxKind.Identifier, operation],
          [SyntaxKind.OpenParenToken],
          [SyntaxKind.Identifier, binding.value],
        ]),
      ) ||
      matchesSequence(tokens, index - 4, [
        [SyntaxKind.Identifier, 'Reflect'],
        [SyntaxKind.DotToken],
        [SyntaxKind.Identifier, 'set'],
        [SyntaxKind.OpenParenToken],
        [SyntaxKind.Identifier, binding.value],
      ]) ||
      (tokenKind(tokens, index + 1) === SyntaxKind.DotToken &&
        findSequence(
          tokens,
          [[SyntaxKind.EqualsToken]],
          index + 2,
          findStatementSemicolon(tokens, index) ?? tokens.length,
        ) !== undefined)
    ) {
      return true;
    }
  }
  return false;
};

export const hasGeneratedOperationGatewayContract = (source: string, deploymentAppId: string): boolean => {
  const header = `// @generated by OntOS Codesmith MicroVertical Action Boundary v1\n// @ontos-action-boundary-owner ${deploymentAppId}\n`;
  if (!source.startsWith(header)) {
    return false;
  }
  const tokens = tokenizeGovernedClient(source);
  const audience = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, 'ACTION_GATEWAY_AUDIENCE'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.StringLiteral, deploymentAppId],
      [SyntaxKind.AsKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.SemicolonToken],
    ],
    0,
    tokens.length,
  );
  const factory = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, 'makeOperationGateway'],
      [SyntaxKind.EqualsToken],
    ],
    0,
    tokens.length,
  );
  const factoryEnd = factory === undefined ? undefined : findStatementSemicolon(tokens, factory);
  const invokesFreshIssuer =
    factory !== undefined &&
    factoryEnd !== undefined &&
    hasExactGeneratedGatewayFactory(tokens, factory, factoryEnd) &&
    ['issueGatewayContext', 'makeSharedOperationGateway'].every((name) =>
      hasExclusiveNamedImportFrom(source, name, '@app/shared-contracts'),
    ) &&
    findSequence(
      tokens,
      [
        [SyntaxKind.Identifier, 'makeOperationGateway'],
        [SyntaxKind.AsKeyword],
        [SyntaxKind.Identifier, 'makeSharedOperationGateway'],
      ],
      0,
      tokens.length,
    ) !== undefined;
  return (
    audience !== undefined &&
    invokesFreshIssuer &&
    !hasGatewayBindingMutation(tokens) &&
    hasTopLevelSequence(tokens, [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, 'operationGateway'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.Identifier, 'makeOperationGateway'],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.SemicolonToken],
    ])
  );
};
