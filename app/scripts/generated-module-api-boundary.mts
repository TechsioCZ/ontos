import { LanguageVariant, SyntaxKind, createScanner } from '@typescript/native/unstable/ast';

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

export const toPascalCase = (value: string): string =>
  value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');

const toCamelCase = (value: string): string => {
  const pascal = toPascalCase(value);
  return `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}`;
};

export interface GovernedClientToken {
  readonly kind: SyntaxKind;
  readonly value: string;
}

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

export const tokenizeGovernedClient = (source: string): readonly GovernedClientToken[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: GovernedClientToken[] = [];
  const templateExpressionBraceDepths: number[] = [];
  let scannedKind = scanner.scan();
  while (scannedKind !== SyntaxKind.EndOfFile) {
    let kind: SyntaxKind = scannedKind;
    const templateDepthIndex = templateExpressionBraceDepths.length - 1;
    if (
      kind === SyntaxKind.SlashToken &&
      (tokens.length === 0 ||
        REGULAR_EXPRESSION_PRECEDERS.has(tokens.at(-1)?.kind ?? SyntaxKind.Unknown))
    ) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.TemplateHead) {
      templateExpressionBraceDepths.push(0);
    } else if (kind === SyntaxKind.OpenBraceToken && templateDepthIndex >= 0) {
      templateExpressionBraceDepths[templateDepthIndex] =
        (templateExpressionBraceDepths[templateDepthIndex] ?? 0) + 1;
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
    tokens.push({ kind, value: scanner.getTokenValue() });
    scannedKind = scanner.scan();
  }
  return tokens;
};

const matchesToken = (token: GovernedClientToken | undefined, expected: ExpectedToken): boolean =>
  token?.kind === expected[0] && (expected[1] === undefined || token.value === expected[1]);

const matchesSequence = (
  tokens: readonly GovernedClientToken[],
  start: number,
  expected: readonly ExpectedToken[],
): boolean => expected.every((token, offset) => matchesToken(tokens[start + offset], token));

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
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
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
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return count;
};

const generatedSlotSource = (
  source: string,
  [start, end]: readonly [string, string],
): string | undefined => {
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
): number | undefined => {
  let braceDepth = 0;
  for (let index = start; index < end; index += 1) {
    if (braceDepth === 0 && matchesSequence(tokens, index, expected)) {
      return index;
    }
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return undefined;
};

const hasTopLevelSequence = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
): boolean => findTopLevelSequence(tokens, expected, 0, tokens.length) !== undefined;

export const hasTopLevelExportedConst = (source: string, name: string): boolean =>
  hasTopLevelSequence(tokenizeGovernedClient(source), [
    [SyntaxKind.ExportKeyword],
    [SyntaxKind.ConstKeyword],
    [SyntaxKind.Identifier, name],
    [SyntaxKind.EqualsToken],
  ]);

const findRootExpressionSequence = (
  tokens: readonly GovernedClientToken[],
  expected: readonly ExpectedToken[],
  start: number,
  end: number,
): number | undefined => {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  for (let index = start; index < end; index += 1) {
    if (
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenthesisDepth === 0 &&
      matchesSequence(tokens, index, expected)
    ) {
      return index;
    }
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    } else if (kind === SyntaxKind.OpenBracketToken) {
      bracketDepth += 1;
    } else if (kind === SyntaxKind.CloseBracketToken) {
      bracketDepth -= 1;
    } else if (kind === SyntaxKind.OpenParenToken) {
      parenthesisDepth += 1;
    } else if (kind === SyntaxKind.CloseParenToken) {
      parenthesisDepth -= 1;
    }
  }
  return undefined;
};

const findClosingBrace = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
): number | undefined => {
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

const findObjectPropertyValue = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
  property: string,
): number | undefined => {
  let depth = 0;
  for (let index = openBraceIndex; index < closeBraceIndex; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (
      depth === 1 &&
      (token?.kind === SyntaxKind.Identifier || token?.kind === SyntaxKind.StringLiteral) &&
      token.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken
    ) {
      return index + 2;
    }
  }
  return undefined;
};

const directObjectPropertyOccurrences = (
  tokens: readonly GovernedClientToken[],
  openBraceIndex: number,
  closeBraceIndex: number,
  property: string,
): number => {
  let count = 0;
  let depth = 0;
  for (let index = openBraceIndex; index < closeBraceIndex; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (
      depth === 1 &&
      (token?.kind === SyntaxKind.Identifier || token?.kind === SyntaxKind.StringLiteral) &&
      token.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken
    ) {
      count += 1;
    }
  }
  return count;
};

const hasExactObjectPropertyValue = (
  tokens: readonly GovernedClientToken[],
  valueStart: number | undefined,
  expected: readonly ExpectedToken[],
): boolean => {
  if (valueStart === undefined || !matchesSequence(tokens, valueStart, expected)) {
    return false;
  }
  const follower = tokens[valueStart + expected.length]?.kind;
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
    const token = tokens[index];
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
    } else if (
      depth === 1 &&
      (token?.kind === SyntaxKind.DotDotDotToken || token?.kind === SyntaxKind.OpenBracketToken)
    ) {
      return undefined;
    } else if (
      depth === 1 &&
      (token?.kind === SyntaxKind.Identifier || token?.kind === SyntaxKind.StringLiteral) &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken
    ) {
      properties.push(token.value);
    }
  }
  return properties;
};

const hasExactProperties = (
  properties: readonly string[] | undefined,
  expected: ReadonlySet<string>,
): boolean =>
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
const CORRELATION_HEADER = 'x-correlation-id';

export const hasUniqueExactNamedImport = (
  source: string,
  importedName: string,
  moduleSpecifier: string,
): boolean => {
  const tokens = tokenizeGovernedClient(source);
  let matchCount = 0;
  let bindingCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])) {
      const closeBrace = findClosingBrace(tokens, index + 1);
      if (closeBrace !== undefined) {
        bindingCount += tokens
          .slice(index + 2, closeBrace)
          .filter(
            ({ kind, value }) => kind === SyntaxKind.Identifier && value === importedName,
          ).length;
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

const hasExclusiveNamedImportFrom = (
  source: string,
  importedName: string,
  moduleSpecifier: string,
): boolean => {
  const tokens = tokenizeGovernedClient(source);
  let bindingCount = 0;
  let exactBindingCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      !matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])
    ) {
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
    if (
      !matchesSequence(tokens, index, [[SyntaxKind.ImportKeyword], [SyntaxKind.OpenBraceToken]])
    ) {
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
      [SyntaxKind.Identifier, 'makeEffectBffClient'],
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

const identifierOccurrences = (
  tokens: readonly GovernedClientToken[],
  identifier: string,
): number =>
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
      const name = tokens[index + 2]?.value;
      if (name !== undefined) {
        const nextExport = findSequence(
          tokens,
          [[SyntaxKind.ExportKeyword]],
          index + 1,
          tokens.length,
        );
        declarations.push({ end: nextExport ?? tokens.length, name, start: index });
      }
    }
  }
  return declarations;
};

const findClientHelper = (
  tokens: readonly GovernedClientToken[],
  authorizedExportStart: number,
): GovernedClientHelper | undefined => {
  for (let index = 0; index < authorizedExportStart; index += 1) {
    if (
      matchesSequence(tokens, index, [
        [SyntaxKind.ConstKeyword],
        [SyntaxKind.Identifier],
        [SyntaxKind.EqualsToken],
        [SyntaxKind.OpenParenToken],
      ])
    ) {
      const name = tokens[index + 1]?.value;
      const parametersClose = findClosingParenthesis(tokens, index + 3, authorizedExportStart);
      const bodyOpen = parametersClose === undefined ? undefined : parametersClose + 2;
      const bodyClose = bodyOpen === undefined ? undefined : findClosingBrace(tokens, bodyOpen);
      const helper =
        name !== undefined &&
        parametersClose !== undefined &&
        bodyOpen !== undefined &&
        bodyClose !== undefined &&
        matchesSequence(tokens, parametersClose + 1, [
          [SyntaxKind.EqualsGreaterThanToken],
          [SyntaxKind.OpenBraceToken],
        ]) &&
        bodyClose + 1 < authorizedExportStart &&
        tokens[bodyClose + 1]?.kind === SyntaxKind.SemicolonToken
          ? {
              declarationStart: index,
              end: bodyClose + 2,
              name,
              parametersEnd: parametersClose,
              parametersStart: index + 4,
              start: bodyOpen + 1,
            }
          : undefined;
      if (
        helper !== undefined &&
        findTopLevelSequence(
          tokens,
          [
            [SyntaxKind.ConstKeyword],
            [SyntaxKind.Identifier, 'clientConfig'],
            [SyntaxKind.EqualsToken],
            [SyntaxKind.OpenBraceToken],
          ],
          helper.start,
          helper.end,
        ) !== undefined
      ) {
        return helper;
      }
    }
  }
  return undefined;
};

const findStatementSemicolon = (
  tokens: readonly GovernedClientToken[],
  start: number,
): number | undefined =>
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
  const allowedOptionsInterfaces = new Set([
    `${apiStem}ClientOptions`,
    `${operationStem}ClientOptions`,
  ]);
  let optionsInterfaceSeen = false;
  // eslint-disable-next-line complexity -- This recursive recognizer is the closed top-level client module grammar.
  const acceptsFrom = (index: number): boolean => {
    if (index === tokens.length) {
      return true;
    }
    if (tokens[index]?.kind === SyntaxKind.ImportKeyword) {
      const end = findStatementSemicolon(tokens, index);
      return end !== undefined && acceptsFrom(end + 1);
    }
    if (tokens[index]?.kind === SyntaxKind.TypeKeyword) {
      const end = findStatementSemicolon(tokens, index);
      return end !== undefined && acceptsFrom(end + 1);
    }
    const isExportedInterface = matchesSequence(tokens, index, [
      [SyntaxKind.ExportKeyword],
      [SyntaxKind.InterfaceKeyword],
      [SyntaxKind.Identifier],
    ]);
    if (isExportedInterface) {
      const name = tokens[index + 2]?.value;
      if (name === undefined || optionsInterfaceSeen || !allowedOptionsInterfaces.has(name)) {
        return false;
      }
      optionsInterfaceSeen = true;
      const openBrace = findSequence(tokens, [[SyntaxKind.OpenBraceToken]], index + 2);
      const closeBrace = openBrace === undefined ? undefined : findClosingBrace(tokens, openBrace);
      if (closeBrace === undefined) {
        return false;
      }
      const next =
        tokens[closeBrace + 1]?.kind === SyntaxKind.SemicolonToken
          ? closeBrace + 2
          : closeBrace + 1;
      return acceptsFrom(next);
    }
    if (index === helper.declarationStart) {
      return acceptsFrom(helper.end);
    }
    if (
      matchesSequence(tokens, index, [
        [SyntaxKind.ExportKeyword],
        [SyntaxKind.ConstKeyword],
        [SyntaxKind.Identifier],
        [SyntaxKind.EqualsToken],
      ]) &&
      allowedOperations.has(tokens[index + 2]?.value ?? '')
    ) {
      const end = findStatementSemicolon(tokens, index);
      return end !== undefined && acceptsFrom(end + 1);
    }
    return false;
  };
  return acceptsFrom(0) && optionsInterfaceSeen;
};

const hasExactTransportHeaders = (
  tokens: readonly GovernedClientToken[],
  headersOpen: number,
  configClose: number,
): boolean => {
  const headersClose = findClosingBrace(tokens, headersOpen);
  if (
    headersClose === undefined ||
    headersClose > configClose ||
    !hasExactProperties(
      directObjectPropertyNames(tokens, headersOpen, headersClose),
      new Set(['authorization', CORRELATION_HEADER]),
    )
  ) {
    return false;
  }
  const authorizationValue = findObjectPropertyValue(
    tokens,
    headersOpen,
    headersClose,
    'authorization',
  );
  const correlationValue = findObjectPropertyValue(
    tokens,
    headersOpen,
    headersClose,
    CORRELATION_HEADER,
  );
  return (
    hasExactObjectPropertyValue(tokens, authorizationValue, [
      [SyntaxKind.Identifier, 'Redacted'],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'value'],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.Identifier, 'credential'],
      [SyntaxKind.CloseParenToken],
    ]) &&
    hasExactObjectPropertyValue(tokens, correlationValue, [
      [SyntaxKind.Identifier, 'requestCorrelation'],
    ])
  );
};

const hasClientConfig = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
  ownerApiValue: string,
  defaultApiPrefix: string,
): boolean => {
  const configDeclaration = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, 'clientConfig'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.OpenBraceToken],
    ],
    helper.start,
    helper.end,
  );
  if (configDeclaration === undefined) {
    return false;
  }
  const openBrace = configDeclaration + 3;
  const closeBrace = findClosingBrace(tokens, openBrace);
  if (
    closeBrace === undefined ||
    closeBrace >= helper.end ||
    configDeclaration !== helper.start ||
    tokens[closeBrace + 1]?.kind !== SyntaxKind.SemicolonToken ||
    !hasExactProperties(
      directObjectPropertyNames(tokens, openBrace, closeBrace),
      new Set(['api', 'defaultApiPrefix', 'transportHeaders']),
    )
  ) {
    return false;
  }
  const apiValue = findObjectPropertyValue(tokens, openBrace, closeBrace, 'api');
  const prefixValue = findObjectPropertyValue(tokens, openBrace, closeBrace, 'defaultApiPrefix');
  const headersValue = findObjectPropertyValue(tokens, openBrace, closeBrace, 'transportHeaders');
  if (
    apiValue === undefined ||
    prefixValue === undefined ||
    headersValue === undefined ||
    !hasExactObjectPropertyValue(tokens, apiValue, [[SyntaxKind.Identifier, ownerApiValue]]) ||
    !hasExactObjectPropertyValue(tokens, prefixValue, [
      [SyntaxKind.StringLiteral, defaultApiPrefix],
    ]) ||
    tokens[headersValue]?.kind !== SyntaxKind.OpenBraceToken
  ) {
    return false;
  }
  const headersClose = findClosingBrace(tokens, headersValue);
  return (
    headersClose !== undefined &&
    (tokens[headersClose + 1]?.kind === SyntaxKind.CommaToken ||
      tokens[headersClose + 1]?.kind === SyntaxKind.CloseBraceToken) &&
    hasExactTransportHeaders(tokens, headersValue, closeBrace)
  );
};

const factoryConsumesClientConfig = (
  tokens: readonly GovernedClientToken[],
  helper: GovernedClientHelper,
): boolean => {
  const factoryReturn = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ReturnKeyword],
      [SyntaxKind.Identifier, 'makeEffectBffClient'],
      [SyntaxKind.OpenParenToken],
      [SyntaxKind.Identifier, 'options'],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'baseUrl'],
      [SyntaxKind.EqualsEqualsEqualsToken],
      [SyntaxKind.UndefinedKeyword],
      [SyntaxKind.QuestionToken],
      [SyntaxKind.Identifier, 'clientConfig'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.OpenBraceToken],
      [SyntaxKind.DotDotDotToken],
      [SyntaxKind.Identifier, 'clientConfig'],
      [SyntaxKind.CommaToken],
      [SyntaxKind.Identifier, 'baseUrl'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.Identifier, 'options'],
      [SyntaxKind.DotToken],
      [SyntaxKind.Identifier, 'baseUrl'],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.CommaToken],
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.SemicolonToken],
      [SyntaxKind.CloseBraceToken],
      [SyntaxKind.SemicolonToken],
    ],
    helper.start,
    helper.end,
  );
  const helperTokens = tokens.slice(helper.start, helper.end);
  const configDeclaration = findTopLevelSequence(
    tokens,
    [
      [SyntaxKind.ConstKeyword],
      [SyntaxKind.Identifier, 'clientConfig'],
      [SyntaxKind.EqualsToken],
      [SyntaxKind.OpenBraceToken],
    ],
    helper.start,
    helper.end,
  );
  const configClose =
    configDeclaration === undefined ? undefined : findClosingBrace(tokens, configDeclaration + 3);
  const forbiddenControlFlow = new Set([
    SyntaxKind.DoKeyword,
    SyntaxKind.ForKeyword,
    SyntaxKind.IfKeyword,
    SyntaxKind.SwitchKeyword,
    SyntaxKind.ThrowKeyword,
    SyntaxKind.TryKeyword,
    SyntaxKind.WhileKeyword,
  ]);
  return (
    factoryReturn !== undefined &&
    configClose !== undefined &&
    factoryReturn === configClose + 2 &&
    helperTokens.filter(({ kind }) => kind === SyntaxKind.ReturnKeyword).length === 1 &&
    !helperTokens.some(({ kind }) => forbiddenControlFlow.has(kind))
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
        bindingFollowers.has(tokens[start + offset + 1]?.kind ?? SyntaxKind.Unknown),
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
      tokens[index + 1]?.kind === SyntaxKind.Identifier &&
      names.has(tokens[index + 1]?.value ?? '')
    ) {
      return true;
    }
    if (token?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (token?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
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

const generatedClientTypeNames = (
  expectation: GovernedClientExpectation,
): GeneratedClientTypeNames => {
  const operationBase =
    expectation.invocationKind === MODULE_API_INVOCATION_KIND
      ? expectation.ownerApiValue.slice(0, -'Api'.length)
      : expectation.ownerApiValue.replace(/(?:Report|Search)Api$/u, '');
  return {
    authorizedInvocation: `${expectation.ownerApiValue.slice(0, -'Api'.length)}AuthorizedInvocation`,
    operationInvocation: `${expectation.ownerApiValue.slice(0, -'Api'.length)}OperationInvocation`,
    options: [
      `${operationBase}ClientOptions`,
      `${expectation.ownerApiValue.slice(0, -'Api'.length)}ClientOptions`,
    ],
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
        [SyntaxKind.CommaToken],
      ]),
    ) &&
    authorizedClose !== undefined &&
    [false, true].some((trailingComma) =>
      hasExactParameterTokens(
        tokens,
        authorizedOpen,
        authorizedClose,
        authorizedExpected(trailingComma),
      ),
    ) &&
    operationClose !== undefined &&
    [false, true].some((trailingComma) =>
      hasExactParameterTokens(
        tokens,
        operationOpen,
        operationClose,
        operationExpected(trailingComma),
      ),
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
  const authorizedArrow = findSequence(
    tokens,
    [[SyntaxKind.EqualsGreaterThanToken]],
    authorized.start,
    authorized.end,
  );
  const operationArrow = findSequence(
    tokens,
    [[SyntaxKind.EqualsGreaterThanToken]],
    operation.start,
    operation.end,
  );
  if (authorizedArrow === undefined || operationArrow === undefined) {
    return false;
  }
  const invocationPayloads =
    expectation.invocationKind === MODULE_API_INVOCATION_KIND
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
  const matchingInvocationPayload = invocationPayloads.find((payload) =>
    matchesSequence(tokens, authorizedInvocationEnd, payload),
  );
  const authorizedInvocationTail =
    matchingInvocationPayload === undefined
      ? undefined
      : authorizedInvocationEnd + matchingInvocationPayload.length;
  const authorizedUsesHelper =
    matchesSequence(tokens, authorizedArrow + 1, authorizedInvocation) &&
    authorizedInvocationTail !== undefined &&
    (matchesSequence(tokens, authorizedInvocationTail, [
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.CommaToken],
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.SemicolonToken],
    ]) ||
      matchesSequence(tokens, authorizedInvocationTail, [
        [SyntaxKind.CommaToken],
        [SyntaxKind.CloseParenToken],
        [SyntaxKind.CommaToken],
        [SyntaxKind.CloseParenToken],
        [SyntaxKind.SemicolonToken],
      ]));
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
    (matchesSequence(tokens, gatewayInvocationEnd, [
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.CommaToken],
      [SyntaxKind.CloseParenToken],
      [SyntaxKind.SemicolonToken],
    ]) ||
      matchesSequence(tokens, gatewayInvocationEnd, [
        [SyntaxKind.CommaToken],
        [SyntaxKind.CloseParenToken],
        [SyntaxKind.CommaToken],
        [SyntaxKind.CloseParenToken],
        [SyntaxKind.SemicolonToken],
      ]));
  const requiredHelperImports = new Set([
    'Effect',
    'Redacted',
    'makeEffectBffClient',
    expectation.ownerApiValue,
  ]);
  const helperShadowsImports =
    parametersBindIdentifier(
      tokens,
      helper.parametersStart,
      helper.parametersEnd,
      requiredHelperImports,
    ) || hasTopLevelDeclaration(tokens, helper.start, helper.end, requiredHelperImports);
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
  return (
    hasExactGeneratedOperationParameters(
      tokens,
      helper,
      authorized,
      authorizedArrow,
      operation,
      operationArrow,
      expectation,
    ) &&
    authorizedUsesHelper &&
    operationUsesGateway &&
    !helperShadowsImports &&
    !authorizedShadowsBindings &&
    !operationShadowsBindings
  );
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
      (tokens[endpointAdd]?.kind === SyntaxKind.CommaToken && endpointAdd + 1 === outerCallClose)
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
    return (
      endpointAddClose !== undefined &&
      (endpointAddClose + 1 === outerCallClose ||
        (tokens[endpointAddClose + 1]?.kind === SyntaxKind.CommaToken &&
          endpointAddClose + 2 === outerCallClose))
    );
  };
  const makeOpen = apiDeclaration + 7;
  const makeClose =
    tokens[makeOpen]?.kind === SyntaxKind.OpenParenToken
      ? findClosingParenthesis(tokens, makeOpen, end)
      : undefined;
  const hasExactApiRoot =
    makeClose !== undefined &&
    matchesSequence(tokens, makeOpen + 1, [[SyntaxKind.StringLiteral, ownerApiValue]]) &&
    (makeOpen + 2 === makeClose ||
      (tokens[makeOpen + 2]?.kind === SyntaxKind.CommaToken && makeOpen + 3 === makeClose));
  const group = makeClose === undefined ? undefined : makeClose + 1;
  return hasExactApiRoot &&
    group !== undefined &&
    matchesSequence(tokens, group, sequence) &&
    isExactGroupArgument(group)
    ? tokens[group + 7]?.value
    : undefined;
};

export const hasGeneratedProviderApiContract = (
  source: string,
  ownerApiValue: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const groupName = generatedApiGroup(source, ownerApiValue);
  if (groupName === undefined) {
    return false;
  }
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
  const declarationEnd =
    declaration === undefined ? undefined : findStatementSemicolon(tokens, declaration);
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
    [SyntaxKind.StringLiteral, `/${moduleId}/${kind === 'report' ? 'reports' : 'search'}/${name}`],
  ] satisfies readonly ExpectedToken[];
  const endpointOpen = endpoint + 3;
  const endpointClose = matchesSequence(tokens, endpoint, endpointSequence)
    ? findClosingParenthesis(tokens, endpointOpen, tokens.length)
    : undefined;
  const groupAddClose = findClosingParenthesis(tokens, groupAddOpen, tokens.length);
  return (
    endpointClose !== undefined &&
    groupAddClose !== undefined &&
    (endpointClose + 1 === groupAddClose ||
      (tokens[endpointClose + 1]?.kind === SyntaxKind.CommaToken &&
        endpointClose + 2 === groupAddClose))
  );
};

export const hasGeneratedModuleApiContract = (
  source: string,
  ownerApiValue: string,
  groupName: string,
  stem: string,
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
  const declarationEnd =
    declaration === undefined ? undefined : findStatementSemicolon(tokens, declaration);
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
  const endpointOpen = endpoint + 3;
  const endpointClose = matchesSequence(tokens, endpoint, [
    [SyntaxKind.Identifier, 'HttpApiEndpoint'],
    [SyntaxKind.DotToken],
    [SyntaxKind.Identifier, 'post'],
    [SyntaxKind.OpenParenToken],
    [SyntaxKind.StringLiteral, 'execute'],
    [SyntaxKind.CommaToken],
    [SyntaxKind.StringLiteral, `/reads/${stem}`],
  ])
    ? findClosingParenthesis(tokens, endpointOpen, declarationEnd)
    : undefined;
  const groupAddClose = findClosingParenthesis(tokens, groupAddOpen, declarationEnd);
  return (
    endpointClose !== undefined &&
    groupAddClose !== undefined &&
    (endpointClose + 1 === groupAddClose ||
      (tokens[endpointClose + 1]?.kind === SyntaxKind.CommaToken &&
        endpointClose + 2 === groupAddClose))
  );
};

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
  const declarationEnd =
    declaration === undefined
      ? undefined
      : findRootExpressionSequence(
          tokens,
          [[SyntaxKind.SemicolonToken]],
          declaration,
          tokens.length,
        );
  const open = declaration === undefined ? undefined : declaration + (requireExport ? 6 : 5);
  const close = open === undefined ? undefined : findClosingBrace(tokens, open);
  const callClose =
    declaration === undefined || declarationEnd === undefined
      ? undefined
      : findClosingParenthesis(tokens, declaration + (requireExport ? 5 : 4), declarationEnd);
  return declaration !== undefined &&
    declarationEnd !== undefined &&
    open !== undefined &&
    close !== undefined &&
    close < declarationEnd &&
    callClose !== undefined &&
    callClose + 1 === declarationEnd
    ? [open, close, declarationEnd]
    : undefined;
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

export interface GeneratedReadAuthorization {
  readonly kind: 'authenticated_principal' | 'context_permission' | 'public';
  readonly permission?: string;
}

// eslint-disable-next-line complexity -- This parser rejects every non-canonical authorization object shape.
const generatedReadAuthorization = (
  tokens: readonly GovernedClientToken[],
  open: number,
  close: number,
): GeneratedReadAuthorization | undefined => {
  if (directObjectPropertyOccurrences(tokens, open, close, 'authorization') !== 1) {
    return undefined;
  }
  const authorizationOpen = findObjectPropertyValue(tokens, open, close, 'authorization');
  const authorizationClose =
    authorizationOpen === undefined || tokens[authorizationOpen]?.kind !== SyntaxKind.OpenBraceToken
      ? undefined
      : findClosingBrace(tokens, authorizationOpen);
  if (
    authorizationOpen === undefined ||
    authorizationClose === undefined ||
    !directObjectHasNoSpread(tokens, authorizationOpen, authorizationClose)
  ) {
    return undefined;
  }
  const kindStart = findObjectPropertyValue(tokens, authorizationOpen, authorizationClose, 'kind');
  const kind =
    kindStart !== undefined &&
    tokens[kindStart]?.kind === SyntaxKind.StringLiteral &&
    hasExactObjectPropertyValue(tokens, kindStart, [[SyntaxKind.StringLiteral]])
      ? tokens[kindStart]?.value
      : undefined;
  const permissionStart = findObjectPropertyValue(
    tokens,
    authorizationOpen,
    authorizationClose,
    'permission',
  );
  const permission =
    permissionStart !== undefined &&
    tokens[permissionStart]?.kind === SyntaxKind.StringLiteral &&
    hasExactObjectPropertyValue(tokens, permissionStart, [[SyntaxKind.StringLiteral]])
      ? tokens[permissionStart]?.value
      : undefined;
  const properties = directObjectPropertyNames(tokens, authorizationOpen, authorizationClose);
  if (kind === 'context_permission') {
    if (permission === undefined) {
      return undefined;
    }
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(permission)) {
      return undefined;
    }
    return hasExactProperties(properties, new Set(['kind', 'permission']))
      ? { kind, permission }
      : undefined;
  }
  if (kind !== 'authenticated_principal' && kind !== 'public') {
    return undefined;
  }
  return hasExactProperties(properties, new Set(['kind'])) ? { kind } : undefined;
};

const matchesGeneratedReadAuthorization = (
  actual: GeneratedReadAuthorization | undefined,
  expected: GeneratedReadAuthorization | undefined,
): boolean =>
  actual !== undefined &&
  (expected === undefined ||
    (actual.kind === expected.kind && actual.permission === expected.permission));

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
  const entrypoint = topLevelCallObject(
    tokens,
    entrypointName,
    'defineTenantModuleEntrypoint',
    false,
  );
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
    tokens[entrypointClose + 1]?.kind === SyntaxKind.CloseParenToken &&
    tokens[entrypointClose + 2]?.kind === SyntaxKind.SemicolonToken &&
    entrypointClose + 2 === entrypointEnd &&
    objectHasExactString(tokens, entrypointOpen, entrypointClose, 'access', 'read') &&
    objectHasExactString(
      tokens,
      entrypointOpen,
      entrypointClose,
      'entrypointKey',
      `${moduleId}.${role}.${name}`,
    ) &&
    objectHasExactString(tokens, entrypointOpen, entrypointClose, 'moduleKey', moduleId) &&
    objectHasExactString(tokens, entrypointOpen, entrypointClose, 'role', role) &&
    directObjectPropertyOccurrences(tokens, readOpen, readClose, 'entrypoint') === 1 &&
    hasExactObjectPropertyValue(
      tokens,
      findObjectPropertyValue(tokens, readOpen, readClose, 'entrypoint'),
      [[SyntaxKind.Identifier, entrypointName]],
    ) &&
    objectHasExactString(tokens, readOpen, readClose, 'owningModuleKey', moduleId) &&
    objectHasExactString(tokens, readOpen, readClose, 'readKey', `${moduleId}.${role}.${name}`) &&
    objectHasExactString(tokens, readOpen, readClose, 'schemaVersion', '1')
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
    if (tokens[cursor]?.kind === SyntaxKind.OpenBraceToken) {
      openBraces.push(cursor);
    } else if (tokens[cursor]?.kind === SyntaxKind.CloseBraceToken) {
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
  const contribution =
    identity === undefined ? undefined : enclosingBraceRange(shellTokens, identity);
  const manifestEntrypointOpen =
    contribution === undefined
      ? undefined
      : findObjectPropertyValue(shellTokens, contribution[0], contribution[1], 'entrypoint');
  const manifestEntrypointClose =
    manifestEntrypointOpen === undefined ||
    shellTokens[manifestEntrypointOpen]?.kind !== SyntaxKind.OpenBraceToken
      ? undefined
      : findClosingBrace(shellTokens, manifestEntrypointOpen);
  if (manifestEntrypointOpen === undefined || manifestEntrypointClose === undefined) {
    return false;
  }
  const providerAuthorization = generatedReadAuthorization(
    providerTokens,
    entrypoint[0],
    entrypoint[1],
  );
  const manifestAuthorization = generatedReadAuthorization(
    shellTokens,
    manifestEntrypointOpen,
    manifestEntrypointClose,
  );
  return matchesGeneratedReadAuthorization(providerAuthorization, manifestAuthorization);
};

export const hasGeneratedModuleApiReadContract = (
  source: string,
  moduleId: string,
  name: string,
  authorization?: GeneratedReadAuthorization,
): boolean => {
  const tokens = tokenizeGovernedClient(source);
  const camel = toCamelCase(name);
  const entrypointName = `${camel}Entrypoint`;
  const entrypoint = topLevelCallObject(
    tokens,
    entrypointName,
    'defineTenantModuleEntrypoint',
    false,
  );
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
    (hasExactObjectPropertyValue(tokens, access, [[SyntaxKind.StringLiteral, 'read']]) ||
      hasExactObjectPropertyValue(tokens, access, [
        [SyntaxKind.StringLiteral, 'historical_read'],
      ])) &&
    objectHasExactString(
      tokens,
      entrypoint[0],
      entrypoint[1],
      'entrypointKey',
      `${moduleId}.api.${name}`,
    ) &&
    objectHasExactString(tokens, entrypoint[0], entrypoint[1], 'moduleKey', moduleId) &&
    objectHasExactString(tokens, entrypoint[0], entrypoint[1], 'role', 'api') &&
    directObjectPropertyOccurrences(tokens, read[0], read[1], 'entrypoint') === 1 &&
    hasExactObjectPropertyValue(
      tokens,
      findObjectPropertyValue(tokens, read[0], read[1], 'entrypoint'),
      [[SyntaxKind.Identifier, entrypointName]],
    ) &&
    ['legalEntityScope', 'permissionTarget', 'policies'].every(
      (property) => directObjectPropertyOccurrences(tokens, read[0], read[1], property) === 1,
    ) &&
    objectHasExactString(tokens, read[0], read[1], 'owningModuleKey', moduleId) &&
    objectHasExactString(tokens, read[0], read[1], 'readKey', `${moduleId}.api.${name}`) &&
    objectHasExactString(tokens, read[0], read[1], 'schemaVersion', '1')
  );
};

export const hasGeneratedGovernedClientContract = (
  source: string,
  expectation: GovernedClientExpectation,
): boolean => {
  if (!source.startsWith(expectation.generatedHeader)) {
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
    hasClientConfig(tokens, helper, expectation.ownerApiValue, expectation.defaultApiPrefix) &&
    factoryConsumesClientConfig(tokens, helper) &&
    exportedOperationsUseClientHelperAndGateway(tokens, helper, expectation) &&
    hasOnlyAllowedModuleStatements(tokens, helper, expectation) &&
    identifierOccurrences(tokens, 'makeEffectBffClient') === 2 &&
    identifierOccurrences(tokens, 'operationGateway') === 2 &&
    identifierOccurrences(tokens, expectation.ownerApiValue) === 2 &&
    identifierOccurrences(tokens, 'Effect') === 2 &&
    identifierOccurrences(tokens, helper.name) === 2 &&
    !tokens.some(
      ({ value }) => value === 'makeEffectHttpApiClient' || value === 'HttpClientRequest',
    )
  );
};

const slotHasDirectPropertyKey = (source: string | undefined, key: string): boolean => {
  if (source === undefined) {
    return false;
  }
  const tokens = tokenizeGovernedClient(source);
  return [SyntaxKind.StringLiteral, SyntaxKind.Identifier].some(
    (keyKind) =>
      findSequenceAtBraceDepth(
        tokens,
        [[keyKind, key], [SyntaxKind.ColonToken]],
        0,
        tokens.length,
        0,
      ) !== undefined,
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

// eslint-disable-next-line complexity -- Delimiter balance is required to reject computed or nested slot identities.
const topLevelCommaSeparatedRanges = (
  tokens: readonly GovernedClientToken[],
): readonly (readonly [start: number, end: number])[] | undefined => {
  const ranges: (readonly [start: number, end: number])[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    } else if (kind === SyntaxKind.OpenBracketToken) {
      bracketDepth += 1;
    } else if (kind === SyntaxKind.CloseBracketToken) {
      bracketDepth -= 1;
    } else if (kind === SyntaxKind.OpenParenToken) {
      parenthesisDepth += 1;
    } else if (kind === SyntaxKind.CloseParenToken) {
      parenthesisDepth -= 1;
    }
    if (braceDepth < 0 || bracketDepth < 0 || parenthesisDepth < 0) {
      return undefined;
    }
    if (
      kind === SyntaxKind.CommaToken &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenthesisDepth === 0
    ) {
      if (start < index) {
        ranges.push([start, index]);
      }
      start = index + 1;
    }
  }
  if (braceDepth !== 0 || bracketDepth !== 0 || parenthesisDepth !== 0) {
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
      tokens[start + 1]?.kind !== SyntaxKind.ColonToken
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
  return (
    range !== undefined &&
    findSequenceAtBraceDepth(tokens, related, range[0], range[1], 1) !== undefined
  );
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
      return (
        findSequenceAtBraceDepth(tokens, [key, ...registrationTail], 0, tokens.length, 0) !==
        undefined
      );
    })
  );
};

// eslint-disable-next-line complexity -- Exact descriptor, contribution, entrypoint, and slot ownership are one contract.
export const hasGeneratedProviderManifest = (
  manifest: string,
  moduleId: string,
  name: string,
  kind: 'report' | 'search',
): boolean => {
  const descriptorSlot = generatedSlotSource(
    manifest,
    kind === 'report' ? MANIFEST_REPORT_SLOT : MANIFEST_SEARCH_SLOT,
  );
  const shellSlot = generatedSlotSource(
    manifest,
    kind === 'report' ? MANIFEST_SHELL_REPORT_SLOT : MANIFEST_SHELL_SEARCH_SLOT,
  );
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
  const otherDescriptorSlot = generatedSlotSource(
    manifest,
    kind === 'report' ? MANIFEST_SEARCH_SLOT : MANIFEST_REPORT_SLOT,
  );
  const otherShellSlot = generatedSlotSource(
    manifest,
    kind === 'report' ? MANIFEST_SHELL_SEARCH_SLOT : MANIFEST_SHELL_REPORT_SLOT,
  );
  const shellIdentityIndex = findSequenceAtBraceDepth(
    shellTokens,
    shellIdentity,
    0,
    shellTokens.length,
    1,
  );
  const shellContribution =
    shellIdentityIndex === undefined
      ? undefined
      : enclosingBraceRange(shellTokens, shellIdentityIndex);
  const entrypointOpen =
    shellContribution === undefined
      ? undefined
      : findObjectPropertyValue(
          shellTokens,
          shellContribution[0],
          shellContribution[1],
          'entrypoint',
        );
  const entrypointClose =
    entrypointOpen === undefined || shellTokens[entrypointOpen]?.kind !== SyntaxKind.OpenBraceToken
      ? undefined
      : findClosingBrace(shellTokens, entrypointOpen);
  return (
    sequenceOccurrencesAtBraceDepth(descriptorTokens, descriptorIdentity, 1) === 1 &&
    hasRelatedSequenceInObject(descriptorTokens, descriptorIdentity, [
      [SyntaxKind.Identifier, 'owningModuleId'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.StringLiteral, moduleId],
    ]) &&
    sequenceOccurrencesAtBraceDepth(shellTokens, shellIdentity, 1) === 1 &&
    entrypointOpen !== undefined &&
    entrypointClose !== undefined &&
    directObjectHasNoSpread(shellTokens, entrypointOpen, entrypointClose) &&
    objectHasExactString(shellTokens, entrypointOpen, entrypointClose, 'access', 'read') &&
    objectHasExactString(
      shellTokens,
      entrypointOpen,
      entrypointClose,
      'entrypointKey',
      shellContributionKey,
    ) &&
    objectHasExactString(shellTokens, entrypointOpen, entrypointClose, 'moduleKey', moduleId) &&
    objectHasExactString(shellTokens, entrypointOpen, entrypointClose, 'role', kind) &&
    objectHasExactString(shellTokens, entrypointOpen, entrypointClose, 'scope', 'tenant') &&
    hasRelatedSequenceInObject(shellTokens, shellIdentity, [
      [SyntaxKind.Identifier, kind === 'report' ? 'reportKey' : 'searchKey'],
      [SyntaxKind.ColonToken],
      [SyntaxKind.StringLiteral, descriptorKey],
    ]) &&
    (otherDescriptorSlot === undefined ||
      sequenceOccurrencesAtBraceDepth(
        tokenizeGovernedClient(otherDescriptorSlot),
        descriptorIdentity,
        1,
      ) === 0) &&
    (otherShellSlot === undefined ||
      sequenceOccurrencesAtBraceDepth(tokenizeGovernedClient(otherShellSlot), shellIdentity, 1) ===
        0)
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
      const value = tokens[index + 2]?.value ?? '';
      const name = value.startsWith(prefix) ? value.slice(prefix.length) : '';
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
        names.push(name);
      }
    }
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return names;
};

const registrationProviderNames = (source: string | undefined): readonly string[] =>
  (directSlotPropertyNames(source) ?? []).filter((name) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name),
  );

const providerIdentitySlotIsExact = (
  source: string | undefined,
  names: readonly string[],
  identityProperty: 'contributionKey' | 'key',
  depth: number,
): boolean =>
  source !== undefined &&
  sequenceOccurrencesAtBraceDepth(
    tokenizeGovernedClient(source),
    [
      [SyntaxKind.Identifier, identityProperty],
      [SyntaxKind.ColonToken],
      [SyntaxKind.StringLiteral],
    ],
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
    [
      MANIFEST_REPORT_SLOT,
      MANIFEST_SEARCH_SLOT,
      MANIFEST_SHELL_REPORT_SLOT,
      MANIFEST_SHELL_SEARCH_SLOT,
    ].some((slot) => generatedSlotSource(manifest, slot) !== undefined) ||
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
      (tokens[index + 1]?.kind === SyntaxKind.DotToken &&
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

export const hasGeneratedOperationGatewayContract = (
  source: string,
  deploymentAppId: string,
): boolean => {
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
    hasExclusiveNamedImportFrom(source, 'issueGatewayContext', '@app/shared-contracts') &&
    hasExclusiveNamedImportFrom(source, 'makeSharedOperationGateway', '@app/shared-contracts') &&
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
