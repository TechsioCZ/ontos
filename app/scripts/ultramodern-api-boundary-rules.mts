import path from 'node:path';

export {
  type ApiContractSourceContext,
  unconstrainedHttpApiContractSchemaViolation,
} from './typescript-api-contract-boundary.mts';

const normalize = (filePath: string): string => filePath.split(path.sep).join('/');

const privateOwnerSpecifierPattern = /vertical\.(?:manifest|registration)(?:\.ts)?$/u;
const identifierPattern = String.raw`[$A-Z_a-z][$\w]*`;
const effectEdgeSpecifier = '@modern-js/plugin-bff/effect-edge';
const layerMergeAllCallee = 'Layer.mergeAll';

const escapesRegularExpression = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const sourceTriviaPattern =
  /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//gu;
const regularExpressionLiteralPattern =
  /(?<prefix>(?:^|[!(:,;=[{]|=>|\b(?:case|return|throw))[\t ]*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n\r])*\]|[^/\\\n\r])+\/[dgimsuvy]*/gmu;

const mask = (value: string): string => value.replaceAll(/[^\n\r]/gu, ' ');

const withoutRegularExpressionLiterals = (source: string): string =>
  source.replaceAll(
    regularExpressionLiteralPattern,
    (value, prefix: string) => `${prefix}${mask(value.slice(prefix.length))}`,
  );

const withoutComments = (source: string): string =>
  withoutRegularExpressionLiterals(source).replaceAll(sourceTriviaPattern, (value) =>
    value.startsWith('//') || value.startsWith('/*') ? mask(value) : value,
  );

const withoutCommentsOrLiterals = (source: string): string =>
  withoutRegularExpressionLiterals(source).replaceAll(sourceTriviaPattern, mask);

const importsNamedValueMatchingSpecifier = (
  source: string,
  name: string,
  specifierPattern: string,
): boolean => {
  const visibleSource = withoutComments(source);
  const code = withoutCommentsOrLiterals(source);
  const imports = visibleSource.matchAll(
    new RegExp(
      String.raw`^(?<indent>[\t ]*)import\s*\{(?<bindings>[^}]*)\}\s*from\s*['"]${specifierPattern}['"]`,
      'gmu',
    ),
  );
  return [...imports].some((candidate) => {
    const indentLength = candidate.groups?.indent?.length ?? 0;
    const isRealImport = code.slice(candidate.index + indentLength).startsWith('import');
    return (
      isRealImport &&
      (candidate.groups?.bindings?.split(',').some((binding) => {
        const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
        return local === name;
      }) ??
        false)
    );
  });
};

const importedLocalNameMatchingSpecifier = (
  source: string,
  importedName: string,
  specifierPattern: string,
): string | undefined => {
  const visibleSource = withoutComments(source);
  const code = withoutCommentsOrLiterals(source);
  for (const candidate of visibleSource.matchAll(
    new RegExp(
      String.raw`^(?<indent>[\t ]*)import\s*\{(?<bindings>[^}]*)\}\s*from\s*['"]${specifierPattern}['"]`,
      'gmu',
    ),
  )) {
    const indentLength = candidate.groups?.indent?.length ?? 0;
    if (!code.slice(candidate.index + indentLength).startsWith('import')) {
      continue;
    }
    for (const binding of candidate.groups?.bindings?.split(',') ?? []) {
      const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
      if (imported === importedName) {
        return local;
      }
    }
  }
  return undefined;
};

const importsNamedValue = (source: string, name: string, specifier: string): boolean =>
  importsNamedValueMatchingSpecifier(source, name, escapesRegularExpression(specifier));

const importsNamedValueFromSharedApi = (source: string, name: string): boolean =>
  importsNamedValue(source, name, '../shared/api.ts');

const withoutTerminalSatisfies = (expression: string): string =>
  expression
    .replace(/\s+satisfies\s+[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*(?:<[^<>]*>)?$/u, '')
    .trim();

// oxlint-disable-next-line complexity -- Balanced TypeScript declaration scanning owns each delimiter state explicitly.
const assignmentStart = (source: string, declarationEnd: number): number | undefined => {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  for (let index = declarationEnd; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    } else if (character === '<') {
      angleDepth += 1;
    } else if (character === '>' && source[index - 1] !== '=') {
      angleDepth -= 1;
    } else if (
      character === '=' &&
      source[index + 1] !== '>' &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      angleDepth === 0
    ) {
      return index + 1;
    } else if (
      character === ';' &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      angleDepth === 0
    ) {
      return undefined;
    }
  }
  return undefined;
};

const curlyAncestorsAt = (source: string, targetIndex: number): readonly number[] => {
  const ancestors: number[] = [];
  for (let index = 0; index < targetIndex; index += 1) {
    if (source[index] === '{') {
      ancestors.push(index);
    } else if (source[index] === '}') {
      ancestors.pop();
    }
  }
  return ancestors;
};

const isScopeVisibleAt = (
  source: string,
  declarationIndex: number,
  usageIndex: number,
): boolean => {
  if (declarationIndex >= usageIndex) {
    return false;
  }
  const declarationAncestors = curlyAncestorsAt(source, declarationIndex);
  const usageAncestors = curlyAncestorsAt(source, usageIndex);
  return declarationAncestors.every((ancestor, index) => usageAncestors[index] === ancestor);
};

const isBindingScopeAt = (
  source: string,
  declarationIndex: number,
  usageIndex: number,
): boolean => {
  const declarationAncestors = curlyAncestorsAt(source, declarationIndex);
  const usageAncestors = curlyAncestorsAt(source, usageIndex);
  return declarationAncestors.every((ancestor, index) => usageAncestors[index] === ancestor);
};

const initializerFor = (
  source: string,
  name: string,
  usageIndex = source.length,
): string | undefined => {
  const declarations = [
    ...source.matchAll(new RegExp(String.raw`\bconst\s+${escapesRegularExpression(name)}\b`, 'gu')),
  ].filter(({ index }) => isScopeVisibleAt(source, index, usageIndex));
  let declaration: RegExpExecArray | undefined;
  for (const candidate of declarations) {
    if (declaration === undefined) {
      declaration = candidate;
      continue;
    }
    const candidateDepth = curlyAncestorsAt(source, candidate.index).length;
    const declarationDepth = curlyAncestorsAt(source, declaration.index).length;
    if (
      candidateDepth > declarationDepth ||
      (candidateDepth === declarationDepth && candidate.index > declaration.index)
    ) {
      declaration = candidate;
    }
  }
  if (declaration === undefined) {
    return undefined;
  }
  const start = assignmentStart(source, declaration.index + declaration[0].length);
  if (start === undefined) {
    return undefined;
  }

  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    } else if (character === ';' && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      return withoutTerminalSatisfies(source.slice(start, index).trim());
    }
  }
  return undefined;
};

const callArguments = (expression: string, callee: string): readonly string[] | undefined => {
  const prefix = new RegExp(String.raw`^${escapesRegularExpression(callee)}\s*\(`, 'u').exec(
    expression,
  );
  if (prefix === null) {
    return undefined;
  }

  const openIndex = prefix[0].lastIndexOf('(');
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  let argumentStart = openIndex + 1;
  const argumentsList: string[] = [];
  for (let index = openIndex; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
      if (roundDepth === 0) {
        const finalArgument = expression.slice(argumentStart, index).trim();
        if (finalArgument.length > 0) {
          argumentsList.push(finalArgument);
        }
        return expression.slice(index + 1).trim().length === 0 ? argumentsList : undefined;
      }
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    } else if (character === '<') {
      angleDepth += 1;
    } else if (character === '>' && expression[index - 1] !== '=') {
      angleDepth -= 1;
    } else if (
      character === ',' &&
      roundDepth === 1 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      angleDepth === 0
    ) {
      argumentsList.push(expression.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }
  return undefined;
};

const safeLayerPipeArguments = (expression: string): readonly string[] | undefined => {
  const argumentsList = callArguments(expression, '.pipe');
  return argumentsList?.every(
    (argument) =>
      argument === 'Layer.orDie' ||
      argument === 'GovernedReadLayer.orDie' ||
      callArguments(argument, 'Layer.provide') !== undefined ||
      callArguments(argument, 'GovernedReadLayer.provide') !== undefined,
  ) === true
    ? argumentsList
    : undefined;
};

const layerConstructorRemainder = (expression: string, callee: string): string | undefined => {
  const prefix = new RegExp(String.raw`^${escapesRegularExpression(callee)}\s*\(`, 'u').exec(
    expression,
  );
  if (prefix === null) {
    return undefined;
  }
  const openIndex = prefix[0].lastIndexOf('(');
  let depth = 0;
  for (let index = openIndex; index < expression.length; index += 1) {
    if (expression[index] === '(') {
      depth += 1;
    } else if (expression[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return expression.slice(index + 1).trim();
      }
    }
  }
  return undefined;
};

const hasSafeLayerConstructor = (initializer: string, callee: string): boolean => {
  const remainder = layerConstructorRemainder(initializer, callee);
  return (
    remainder !== undefined &&
    (remainder.length === 0 || safeLayerPipeArguments(remainder) !== undefined)
  );
};

const leadingCallArguments = (
  expression: string,
  callee: string,
): readonly string[] | undefined => {
  const remainder = layerConstructorRemainder(expression, callee);
  return remainder === undefined
    ? undefined
    : callArguments(expression.slice(0, expression.length - remainder.length).trim(), callee);
};

const groupCallbackRegistersHandler = (groupArguments: readonly string[]): boolean => {
  const callback = groupArguments[2]?.trim();
  if (callback === undefined) {
    return false;
  }
  const binding = new RegExp(
    String.raw`^(?:\(\s*(?<parenthesized>${identifierPattern})(?:\s*:[^)]*)?\s*\)|(?<bare>${identifierPattern}))\s*=>`,
    'u',
  ).exec(callback);
  const handlerBuilder = binding?.groups?.parenthesized ?? binding?.groups?.bare;
  return (
    handlerBuilder !== undefined &&
    new RegExp(
      String.raw`\b${escapesRegularExpression(handlerBuilder)}\s*\.\s*handle\s*\(`,
      'u',
    ).test(callback.slice(binding?.[0].length ?? 0))
  );
};

export interface RuntimeTopologyModule {
  readonly id: string;
  readonly resolveImport: RuntimeTopologyModuleResolver;
  readonly source: string;
}

export type RuntimeTopologyModuleResolver = (
  specifier: string,
) => RuntimeTopologyModule | undefined;

const importedBindingFromAnyModule = (
  source: string,
  name: string,
): { readonly imported: string; readonly specifier: string } | undefined => {
  const visibleSource = withoutComments(source);
  const code = withoutCommentsOrLiterals(source);
  for (const candidate of visibleSource.matchAll(
    /^(?<indent>[\t ]*)(?:import|export)\s*\{(?<bindings>[^}]*)\}\s*from\s*['"](?<specifier>[^'"]+)['"]/gmu,
  )) {
    const indentLength = candidate.groups?.indent?.length ?? 0;
    const specifier = candidate.groups?.specifier;
    if (
      specifier === undefined ||
      !/^(?:import|export)\b/u.test(code.slice(candidate.index + indentLength))
    ) {
      continue;
    }
    for (const binding of candidate.groups?.bindings?.split(',') ?? []) {
      const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
      if (local === name && imported !== undefined) {
        return { imported, specifier };
      }
    }
  }
  return undefined;
};

const importedValueBindingFromAnyModule = (
  source: string,
  name: string,
): { readonly imported: string; readonly specifier: string } | undefined => {
  const visibleSource = withoutComments(source);
  const code = withoutCommentsOrLiterals(source);
  for (const candidate of visibleSource.matchAll(
    /^(?<indent>[\t ]*)import\s*\{(?<bindings>[^}]*)\}\s*from\s*['"](?<specifier>[^'"]+)['"]/gmu,
  )) {
    const indentLength = candidate.groups?.indent?.length ?? 0;
    const specifier = candidate.groups?.specifier;
    if (
      specifier === undefined ||
      !code.slice(candidate.index + indentLength).startsWith('import')
    ) {
      continue;
    }
    for (const binding of candidate.groups?.bindings?.split(',') ?? []) {
      const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
      if (local === name && imported !== undefined) {
        return { imported, specifier };
      }
    }
  }
  return undefined;
};

const layerValueUsesCors = (
  source: string,
  name: string,
  usageIndex: number,
  seen: ReadonlySet<string> = new Set(),
): boolean => {
  if (seen.has(name)) {
    return false;
  }
  const initializer = initializerFor(source, name, usageIndex);
  if (initializer === undefined) {
    return false;
  }
  if (/\bHttpRouter\.cors\s*\(/u.test(initializer)) {
    return true;
  }
  const pipedLayer = new RegExp(
    String.raw`^(?<base>${identifierPattern})(?<pipe>\.pipe\s*\()`,
    'u',
  ).exec(initializer);
  return pipedLayer?.groups?.base === undefined || pipedLayer.groups.pipe === undefined
    ? false
    : layerValueUsesCors(source, pipedLayer.groups.base, usageIndex, new Set([...seen, name]));
};

const matchingRoundClose = (source: string, openIndex: number): number | undefined => {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

const matchingCurlyClose = (source: string, openIndex: number): number | undefined => {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

const parameterBinding = (parameter: string): string => {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < parameter.length; index += 1) {
    const character = parameter[index];
    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    } else if (
      (character === ':' || character === '=') &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0
    ) {
      return parameter.slice(0, index);
    }
  }
  return parameter;
};

const parameterListShadows = (parameters: string, name: string): boolean => {
  const escapedName = escapesRegularExpression(name);
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  let parameterStart = 0;
  for (let index = 0; index <= parameters.length; index += 1) {
    const character = parameters[index];
    if (character === '(') {
      roundDepth += 1;
    } else if (character === ')') {
      roundDepth -= 1;
    } else if (character === '[') {
      squareDepth += 1;
    } else if (character === ']') {
      squareDepth -= 1;
    } else if (character === '{') {
      curlyDepth += 1;
    } else if (character === '}') {
      curlyDepth -= 1;
    } else if (character === '<') {
      angleDepth += 1;
    } else if (character === '>' && parameters[index - 1] !== '=') {
      angleDepth -= 1;
    } else if (
      (character === ',' || index === parameters.length) &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      angleDepth === 0
    ) {
      if (
        new RegExp(String.raw`\b${escapedName}\b`, 'u').test(
          parameterBinding(parameters.slice(parameterStart, index)),
        )
      ) {
        return true;
      }
      parameterStart = index + 1;
    }
  }
  return false;
};

const controlFlowParentheses = new Set(['for', 'if', 'switch', 'while', 'with']);

const hasParameterDeclarationPrefix = (prefix: string): boolean => {
  const withoutGeneric = prefix.replace(/<[^<>]*>$/u, '').trimEnd();
  if (new RegExp(String.raw`\bfunction(?:\s+${identifierPattern})?$`, 'u').test(withoutGeneric)) {
    return true;
  }
  if (withoutGeneric.endsWith(']')) {
    return true;
  }
  const precedingWord = new RegExp(String.raw`(?<word>${identifierPattern})$`, 'u').exec(
    withoutGeneric,
  )?.groups?.word;
  if (precedingWord === undefined || controlFlowParentheses.has(precedingWord)) {
    return false;
  }
  if (precedingWord === 'catch') {
    return true;
  }
  return /[{};]\s*$/u.test(withoutGeneric.slice(0, -precedingWord.length));
};

const isParameterList = (code: string, openIndex: number, closeIndex: number): boolean => {
  const suffix = code.slice(closeIndex + 1).trimStart();
  if (suffix.startsWith('=>')) {
    return true;
  }
  const prefix = code.slice(0, openIndex).trimEnd();
  return (
    (suffix.startsWith('{') && hasParameterDeclarationPrefix(prefix)) ||
    (suffix.startsWith(':') &&
      /^:[^;]*(?:=>|\{)/u.test(suffix) &&
      (hasParameterDeclarationPrefix(prefix) || /[=,(:]\s*$/u.test(prefix)))
  );
};

const parameterScopeContains = (code: string, closeIndex: number, usageIndex: number): boolean => {
  for (let index = closeIndex + 1; index < usageIndex; index += 1) {
    if (code[index] === '{') {
      const close = matchingCurlyClose(code, index);
      if (close !== undefined && close >= usageIndex) {
        return true;
      }
    }
  }
  return false;
};

const parameterBindingsShadow = (code: string, name: string, usageIndex: number): boolean => {
  for (
    let openIndex = code.indexOf('(');
    openIndex >= 0;
    openIndex = code.indexOf('(', openIndex + 1)
  ) {
    const closeIndex = matchingRoundClose(code, openIndex);
    if (
      closeIndex !== undefined &&
      isParameterList(code, openIndex, closeIndex) &&
      parameterListShadows(code.slice(openIndex + 1, closeIndex), name) &&
      parameterScopeContains(code, closeIndex, usageIndex)
    ) {
      return true;
    }
  }
  return false;
};

const patternHasVisibleMatch = (code: string, pattern: RegExp, usageIndex: number): boolean =>
  [...code.matchAll(pattern)].some(({ index }) => isBindingScopeAt(code, index, usageIndex));

const singleArrowBindingShadows = (code: string, name: string, usageIndex: number): boolean => {
  const pattern = new RegExp(String.raw`\b${escapesRegularExpression(name)}\s*=>`, 'gu');
  return [...code.matchAll(pattern)].some((candidate) => {
    const arrowEnd = candidate.index + candidate[0].length;
    if (arrowEnd >= usageIndex || !isScopeVisibleAt(code, candidate.index, usageIndex)) {
      return false;
    }
    const relativeBodyStart = code.slice(arrowEnd).search(/\S/u);
    const bodyStart = relativeBodyStart < 0 ? code.length : relativeBodyStart + arrowEnd;
    if (code[bodyStart] === '{') {
      const bodyEnd = matchingCurlyClose(code, bodyStart);
      return bodyEnd !== undefined && usageIndex < bodyEnd;
    }
    const between = code.slice(arrowEnd, usageIndex);
    return !between.includes(';');
  });
};

const shadowsBinding = (code: string, name: string, usageIndex: number): boolean => {
  const escapedName = escapesRegularExpression(name);
  return (
    patternHasVisibleMatch(
      code,
      new RegExp(
        String.raw`\b(?:class|const|function|let|module|namespace|using|var)\s+${escapedName}\b`,
        'gu',
      ),
      usageIndex,
    ) ||
    singleArrowBindingShadows(code, name, usageIndex) ||
    patternHasVisibleMatch(
      code,
      new RegExp(
        String.raw`\b(?:const|let|var)\s*(?:\{[^;=]*\b${escapedName}\b[^;=]*\}|\[[^;=]*\b${escapedName}\b[^;=]*\])\s*(?:=|\bof\b|\bin\b)`,
        'gu',
      ),
      usageIndex,
    ) ||
    parameterBindingsShadow(code, name, usageIndex)
  );
};

const usesTrustedGovernedLayer = (source: string, code: string, usageIndex: number): boolean => {
  if (!/\bGovernedReadLayer\s*\./u.test(code)) {
    return true;
  }
  const binding = importedValueBindingFromAnyModule(source, 'GovernedReadLayer');
  return (
    binding?.imported === 'Layer' &&
    (binding.specifier === 'effect' || binding.specifier === effectEdgeSpecifier) &&
    !shadowsBinding(code, 'GovernedReadLayer', usageIndex)
  );
};

const canonicalApiExport = (
  source: string,
  name: string,
  seen: ReadonlySet<string> = new Set(),
): string | undefined => {
  if (seen.has(name)) {
    return undefined;
  }
  const code = withoutCommentsOrLiterals(source);
  if (
    !new RegExp(String.raw`\bexport\s+const\s+${escapesRegularExpression(name)}\s*=`, 'u').test(
      code,
    )
  ) {
    return undefined;
  }
  const initializer = initializerFor(withoutComments(source), name, source.length);
  if (initializer === undefined) {
    return undefined;
  }
  return new RegExp(String.raw`^${identifierPattern}$`, 'u').test(initializer)
    ? canonicalApiExport(source, initializer, new Set([...seen, name]))
    : name;
};

const sameApiExport = (
  module: RuntimeTopologyModule | undefined,
  actual: string | undefined,
  expected: string,
): boolean => {
  if (actual === expected) {
    return true;
  }
  if (module === undefined || actual === undefined) {
    return false;
  }
  const canonical = canonicalApiExport(module.source, actual);
  return canonical !== undefined && canonical === canonicalApiExport(module.source, expected);
};

// oxlint-disable-next-line complexity -- Transitive handler provenance must fail closed across local groups, aggregates, and imported re-exports.
const handlerLayerDerivesFromHttpApiBuilder = (
  source: string,
  code: string,
  name: string,
  expectedApiExport: string,
  expectedApiModuleId: string | undefined,
  usageIndex: number,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
  moduleId: string,
  seen: ReadonlySet<string> = new Set(),
): boolean => {
  const key = `${moduleId}#${name}`;
  if (!usesTrustedGovernedLayer(source, code, usageIndex) || seen.has(key)) {
    return false;
  }
  const nextSeen = new Set([...seen, key]);
  const initializer = initializerFor(code, name, usageIndex);
  if (initializer !== undefined) {
    const groupArguments = leadingCallArguments(initializer, 'HttpApiBuilder.group');
    if (
      hasSafeLayerConstructor(initializer, 'HttpApiBuilder.group') &&
      groupArguments !== undefined &&
      groupCallbackRegistersHandler(groupArguments)
    ) {
      const [apiName] = groupArguments;
      const apiBinding =
        apiName === undefined ? undefined : importedValueBindingFromAnyModule(source, apiName);
      const apiModule =
        apiBinding === undefined ? undefined : resolveImport?.(apiBinding.specifier);
      const apiModuleId = apiModule?.id;
      const builderBinding = importedValueBindingFromAnyModule(source, 'HttpApiBuilder');
      return (
        builderBinding?.imported === 'HttpApiBuilder' &&
        builderBinding.specifier === effectEdgeSpecifier &&
        !shadowsBinding(code, 'HttpApiBuilder', usageIndex) &&
        apiBinding !== undefined &&
        sameApiExport(apiModule, apiBinding.imported, expectedApiExport) &&
        (expectedApiModuleId === undefined
          ? /(?:^|\/)shared\/api\.ts$/u.test(apiBinding.specifier)
          : apiModuleId === expectedApiModuleId)
      );
    }
    const mergeArguments = leadingCallArguments(initializer, layerMergeAllCallee);
    const layerBinding = importedValueBindingFromAnyModule(source, 'Layer');
    if (
      layerBinding?.imported !== 'Layer' ||
      layerBinding.specifier !== effectEdgeSpecifier ||
      !hasSafeLayerConstructor(initializer, layerMergeAllCallee) ||
      mergeArguments === undefined ||
      mergeArguments.length === 0
    ) {
      return false;
    }
    return mergeArguments.every((rawArgument) => {
      const argument = withoutTerminalSatisfies(rawArgument);
      const layer = new RegExp(
        String.raw`^(?<name>${identifierPattern})(?<remainder>[\s\S]*)$`,
        'u',
      ).exec(argument);
      const layerName = layer?.groups?.name;
      const remainder = layer?.groups?.remainder?.trim();
      return (
        layerName !== undefined &&
        remainder !== undefined &&
        (remainder.length === 0 || safeLayerPipeArguments(remainder) !== undefined) &&
        handlerLayerDerivesFromHttpApiBuilder(
          source,
          code,
          layerName,
          expectedApiExport,
          expectedApiModuleId,
          usageIndex,
          resolveImport,
          moduleId,
          nextSeen,
        )
      );
    });
  }

  if (shadowsBinding(code, name, usageIndex)) {
    return false;
  }
  const importedBinding = importedBindingFromAnyModule(source, name);
  const resolved =
    importedBinding === undefined ? undefined : resolveImport?.(importedBinding.specifier);
  if (importedBinding === undefined || resolved === undefined) {
    return false;
  }
  const resolvedCode = withoutCommentsOrLiterals(resolved.source);
  return handlerLayerDerivesFromHttpApiBuilder(
    resolved.source,
    resolvedCode,
    importedBinding.imported,
    expectedApiExport,
    expectedApiModuleId,
    resolvedCode.length,
    resolved.resolveImport,
    resolved.id,
    nextSeen,
  );
};

const composesHandlerLayers = (
  source: string,
  code: string,
  initializer: string,
  expectedApiExport: string,
  expectedApiModuleId: string | undefined,
  usageIndex: number,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
): boolean => {
  const argumentsList = leadingCallArguments(initializer, layerMergeAllCallee);
  return (
    hasSafeLayerConstructor(initializer, layerMergeAllCallee) &&
    argumentsList !== undefined &&
    argumentsList.length > 0 &&
    argumentsList.every((rawArgument) => {
      const argument = withoutTerminalSatisfies(rawArgument);
      const layer = new RegExp(
        String.raw`^(?<name>${identifierPattern})(?<remainder>[\s\S]*)$`,
        'u',
      ).exec(argument);
      const layerName = layer?.groups?.name;
      const remainder = layer?.groups?.remainder?.trim();
      if (
        layerName === undefined ||
        remainder === undefined ||
        (remainder.length > 0 && safeLayerPipeArguments(remainder) === undefined)
      ) {
        return false;
      }
      return handlerLayerDerivesFromHttpApiBuilder(
        source,
        code,
        layerName,
        expectedApiExport,
        expectedApiModuleId,
        usageIndex,
        resolveImport,
        'entry',
      );
    })
  );
};

const declaresLayerValue = (
  source: string,
  code: string,
  name: string,
  allowCors = false,
  requireHandlerOperands = false,
  expectedApiExport = '',
  expectedApiModuleId?: string,
  resolveImport?: RuntimeTopologyModuleResolver,
  usageIndex = code.length,
  seen: ReadonlySet<string> = new Set(),
): boolean => {
  if (!usesTrustedGovernedLayer(source, code, usageIndex) || seen.has(name)) {
    return false;
  }
  const initializer = initializerFor(code, name, usageIndex);
  if (initializer === undefined) {
    return false;
  }
  if (hasSafeLayerConstructor(initializer, layerMergeAllCallee)) {
    return (
      !requireHandlerOperands ||
      composesHandlerLayers(
        source,
        code,
        initializer,
        expectedApiExport,
        expectedApiModuleId,
        usageIndex,
        resolveImport,
      )
    );
  }
  if (allowCors && hasSafeLayerConstructor(initializer, 'HttpRouter.cors')) {
    return true;
  }

  const pipedLayer = new RegExp(
    String.raw`^(?<base>${identifierPattern})(?<pipe>\.pipe\s*\()`,
    'u',
  ).exec(initializer);
  return pipedLayer?.groups?.base === undefined ||
    pipedLayer.groups.pipe === undefined ||
    safeLayerPipeArguments(initializer.slice(pipedLayer.groups.base.length)) === undefined
    ? false
    : declaresLayerValue(
        source,
        code,
        pipedLayer.groups.base,
        allowCors,
        requireHandlerOperands,
        expectedApiExport,
        expectedApiModuleId,
        resolveImport,
        usageIndex,
        new Set([...seen, name]),
      );
};

const curlyDepthAt = (code: string, targetIndex: number): number => {
  let depth = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
    }
  }
  return depth;
};

const functionBodyStartsBefore = (code: string, endIndex: number): ReadonlySet<number> => {
  const starts = new Set<number>();
  for (
    let openIndex = code.indexOf('(');
    openIndex >= 0 && openIndex < endIndex;
    openIndex = code.indexOf('(', openIndex + 1)
  ) {
    const closeIndex = matchingRoundClose(code, openIndex);
    if (closeIndex === undefined || !isParameterList(code, openIndex, closeIndex)) {
      continue;
    }
    const bodyStart = code.indexOf('{', closeIndex + 1);
    const statementEnd = code.indexOf(';', closeIndex + 1);
    if (
      bodyStart !== -1 &&
      bodyStart < endIndex &&
      (statementEnd === -1 || bodyStart < statementEnd)
    ) {
      starts.add(bodyStart);
    }
  }
  return starts;
};

const innermostFunctionBody = (
  ancestors: readonly number[],
  factoryBody: number,
  functionBodies: ReadonlySet<number>,
): number | undefined => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors.at(index);
    if (ancestor !== undefined && (ancestor === factoryBody || functionBodies.has(ancestor))) {
      return ancestor;
    }
  }
  return undefined;
};

const hasEarlierFactoryExit = (code: string, bodyStart: number, endIndex: number): boolean => {
  const functionBodies = functionBodyStartsBefore(code, endIndex);
  return [...code.slice(bodyStart + 1, endIndex).matchAll(/\b(?:return|throw)\b/gu)].some(
    ({ index }) => {
      const absoluteIndex = bodyStart + 1 + index;
      const owningFunction = innermostFunctionBody(
        curlyAncestorsAt(code, absoluteIndex),
        bodyStart,
        functionBodies,
      );
      return owningFunction === bodyStart;
    },
  );
};

const isDirectFactoryReturn = (
  code: string,
  bodyStart: number,
  callIndex: number,
  callEnd: number,
): boolean => {
  let depth = 1;
  let statementStart = bodyStart + 1;
  for (let index = bodyStart + 1; index < callIndex; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
    } else if (code[index] === ';' && depth === 1) {
      statementStart = index + 1;
    }
  }
  return (
    depth === 1 &&
    /^\s*return\s*$/u.test(code.slice(statementStart, callIndex)) &&
    !hasEarlierFactoryExit(code, bodyStart, statementStart) &&
    /^\s*(?:;|\})/u.test(code.slice(callEnd))
  );
};

const exportedFactoryOwnsCall = (code: string, callIndex: number, callEnd: number): boolean => {
  const candidates = code
    .slice(0, callIndex)
    .matchAll(
      new RegExp(
        String.raw`\bexport\s+const\s+(?<factory>${identifierPattern})\s*=[\s\S]{0,2000}?=>\s*\{`,
        'gu',
      ),
    );
  let candidate: RegExpExecArray | undefined;
  for (const current of candidates) {
    if (curlyDepthAt(code, current.index) === 0) {
      candidate = current;
    }
  }
  const factory = candidate?.groups?.factory;
  if (candidate === undefined || factory === undefined) {
    return false;
  }
  const bodyStart = candidate.index + candidate[0].length - 1;
  if (!isDirectFactoryReturn(code, bodyStart, callIndex, callEnd)) {
    return false;
  }
  const defaultRuntime = [
    ...code.matchAll(
      new RegExp(
        String.raw`\bconst\s+(?<runtime>${identifierPattern})\s*=\s*${escapesRegularExpression(factory)}\s*\(`,
        'gu',
      ),
    ),
  ].find(({ index }) => curlyDepthAt(code, index) === 0)?.groups?.runtime;
  const defaultRuntimeInitializer =
    defaultRuntime === undefined ? undefined : initializerFor(code, defaultRuntime, code.length);
  return (
    defaultRuntime !== undefined &&
    defaultRuntimeInitializer !== undefined &&
    callArguments(defaultRuntimeInitializer, factory) !== undefined &&
    new RegExp(
      String.raw`\bexport\s+default\s+${escapesRegularExpression(defaultRuntime)}\s*;`,
      'u',
    ).test(code)
  );
};

const isRuntimeRootCall = (code: string, callIndex: number, callEnd: number): boolean => {
  const prefix = code.slice(0, callIndex);
  if (/\bexport\s+default\s*$/u.test(prefix)) {
    return /^\s*(?:;|$)/u.test(code.slice(callEnd));
  }
  if (/\breturn\s*$/u.test(prefix)) {
    return exportedFactoryOwnsCall(code, callIndex, callEnd);
  }
  const assignment = new RegExp(
    String.raw`\bconst\s+(?<name>${identifierPattern})\s*=\s*$`,
    'u',
  ).exec(prefix);
  const runtimeName = assignment?.groups?.name;
  return (
    runtimeName !== undefined &&
    assignment !== null &&
    /^\s*;/u.test(code.slice(callEnd)) &&
    curlyDepthAt(code, assignment.index) === 0 &&
    new RegExp(
      String.raw`\bexport\s+default\s+${escapesRegularExpression(runtimeName)}\s*;`,
      'u',
    ).test(code.slice(callIndex))
  );
};

const usesUnshadowedHelperImports = (
  source: string,
  code: string,
  api: string,
  helper: string,
  callIndex: number,
): boolean =>
  importedValueBindingFromAnyModule(source, 'Layer')?.imported === 'Layer' &&
  importedValueBindingFromAnyModule(source, 'Layer')?.specifier === effectEdgeSpecifier &&
  !shadowsBinding(code, helper, callIndex) &&
  !shadowsBinding(code, 'Layer', callIndex) &&
  !shadowsBinding(code, api, callIndex);

const usesImportedCorsTransport = (
  source: string,
  code: string,
  transport: string,
  callIndex: number,
): boolean =>
  !layerValueUsesCors(code, transport, callIndex) ||
  (importedValueBindingFromAnyModule(source, 'HttpRouter')?.imported === 'HttpRouter' &&
    importedValueBindingFromAnyModule(source, 'HttpRouter')?.specifier === effectEdgeSpecifier &&
    !shadowsBinding(code, 'HttpRouter', callIndex));

/** Keeps genuinely different generated RPC assembly outside the REST-only helper contract. */
// oxlint-disable-next-line complexity -- The RPC exception is deliberately an exact, fail-closed topology proof.
export const usesStrictRpcRuntimeTopology = (
  source: string,
  resolveImport?: RuntimeTopologyModuleResolver,
): boolean => {
  const code = withoutCommentsOrLiterals(source);
  const defineEffectBff = importedLocalNameMatchingSpecifier(
    source,
    'defineEffectBff',
    escapesRegularExpression(effectEdgeSpecifier),
  );
  if (
    defineEffectBff === undefined ||
    !/\bfrom\s+['"]\.\.\/shared\/rpc\.ts['"]/u.test(withoutComments(source))
  ) {
    return false;
  }
  const call = new RegExp(
    String.raw`\b${escapesRegularExpression(defineEffectBff)}\s*\(\s*\{\s*api:\s*(?<api>${identifierPattern})\s*,\s*layer(?:\s*:\s*(?<layer>${identifierPattern}))?\s*,\s*rpc:\s*\{\s*group:\s*(?<group>${identifierPattern})\s*,\s*layer:\s*(?<rpcLayer>${identifierPattern})\s*,\s*path:\s*,\s*serialization:\s*,?\s*\}\s*,?\s*\}\s*,?\s*\)`,
    'u',
  ).exec(code);
  const api = call?.groups?.api;
  const layer = call === null ? undefined : (call.groups?.layer ?? 'layer');
  const group = call?.groups?.group;
  const rpcLayer = call?.groups?.rpcLayer;
  const callIndex = call?.index ?? code.length;
  const apiInitializer = api === undefined ? undefined : initializerFor(code, api, callIndex);
  const layerInitializer = layer === undefined ? undefined : initializerFor(code, layer, callIndex);
  const rpcLayerInitializer =
    rpcLayer === undefined ? undefined : initializerFor(code, rpcLayer, callIndex);
  const httpApiBinding = importedValueBindingFromAnyModule(source, 'HttpApi');
  const layerBinding = importedValueBindingFromAnyModule(source, 'Layer');
  const groupBinding =
    group === undefined ? undefined : importedValueBindingFromAnyModule(source, group);
  const rpcModule =
    groupBinding === undefined ? undefined : resolveImport?.(groupBinding.specifier);
  const rpcModuleCode =
    rpcModule === undefined ? undefined : withoutCommentsOrLiterals(rpcModule.source);
  const rpcGroupInitializer =
    rpcModuleCode === undefined || groupBinding === undefined
      ? undefined
      : initializerFor(rpcModuleCode, groupBinding.imported, rpcModuleCode.length);
  const rpcGroupConstructor =
    rpcModule === undefined
      ? undefined
      : importedValueBindingFromAnyModule(rpcModule.source, 'RpcGroup');
  return (
    call !== null &&
    api !== undefined &&
    layer !== undefined &&
    group !== undefined &&
    rpcLayer !== undefined &&
    httpApiBinding?.imported === 'HttpApi' &&
    httpApiBinding.specifier === effectEdgeSpecifier &&
    layerBinding?.imported === 'Layer' &&
    layerBinding.specifier === effectEdgeSpecifier &&
    groupBinding?.imported === group &&
    groupBinding.specifier === '../shared/rpc.ts' &&
    rpcModuleCode !== undefined &&
    rpcGroupConstructor?.imported === 'RpcGroup' &&
    rpcGroupConstructor.specifier === 'effect/unstable/rpc' &&
    rpcGroupInitializer !== undefined &&
    callArguments(rpcGroupInitializer, 'RpcGroup.make') !== undefined &&
    !shadowsBinding(rpcModuleCode, 'RpcGroup', rpcModuleCode.length) &&
    !shadowsBinding(code, defineEffectBff, call.index) &&
    !shadowsBinding(code, 'HttpApi', call.index) &&
    !shadowsBinding(code, 'Layer', call.index) &&
    !shadowsBinding(code, group, call.index) &&
    apiInitializer !== undefined &&
    callArguments(apiInitializer, 'HttpApi.make') !== undefined &&
    layerInitializer === 'Layer.empty' &&
    rpcLayerInitializer !== undefined &&
    callArguments(rpcLayerInitializer, `${group}.toLayer`) !== undefined &&
    isRuntimeRootCall(code, call.index, call.index + call[0].length)
  );
};

/** Proves the shared helper's concrete API/Layer topology. */
// oxlint-disable-next-line complexity -- One fail-closed decision keeps the helper import, call, layers, and runtime-root proof atomic.
export const strictEffectRuntimeTopologyViolation = (
  source: string,
  resolveImport?: RuntimeTopologyModuleResolver,
): string | undefined => {
  const code = withoutCommentsOrLiterals(source);
  const helper = importedLocalNameMatchingSpecifier(
    source,
    'assembleEffectBffRuntime',
    String.raw`@[a-z0-9-]+\/shared-contracts\/server\/effect-bff-runtime`,
  );
  if (helper === undefined) {
    return usesStrictRpcRuntimeTopology(source, resolveImport)
      ? undefined
      : 'must import the server-only shared Effect BFF assembly helper';
  }
  const call = new RegExp(
    String.raw`\b${escapesRegularExpression(helper)}\s*\(\s*\{\s*api:\s*(?<api>${identifierPattern})\s*,\s*handlers:\s*(?<handlers>${identifierPattern})(?:\s*,\s*transport:\s*(?<transport>${identifierPattern}))?\s*,?\s*\}\s*\)`,
    'u',
  ).exec(code);
  const api = call?.groups?.api;
  const handlers = call?.groups?.handlers;
  const transport = call?.groups?.transport;
  if (call === null || api === undefined || handlers === undefined) {
    return 'must pass a concrete api and composed handlers directly to assembleEffectBffRuntime';
  }
  if (!importsNamedValueFromSharedApi(source, api)) {
    return 'must pass the API imported from ../shared/api.ts to assembleEffectBffRuntime';
  }
  const apiBinding = importedValueBindingFromAnyModule(source, api);
  const apiExport = apiBinding?.imported;
  const expectedApiModuleId =
    apiBinding === undefined ? undefined : resolveImport?.(apiBinding.specifier)?.id;
  if (
    apiExport === undefined ||
    (resolveImport !== undefined && expectedApiModuleId === undefined)
  ) {
    return 'must prove the exact shared API export used by assembleEffectBffRuntime';
  }
  if (!usesUnshadowedHelperImports(source, code, api, helper, call.index)) {
    return 'must use unshadowed server helper, API, and Layer imports for assembly';
  }
  if (
    !declaresLayerValue(
      source,
      code,
      handlers,
      false,
      true,
      apiExport,
      expectedApiModuleId,
      resolveImport,
      call.index,
    )
  ) {
    return 'must pass an explicitly composed Layer as assembleEffectBffRuntime handlers';
  }
  if (
    transport !== undefined &&
    !declaresLayerValue(
      source,
      code,
      transport,
      true,
      false,
      apiExport,
      expectedApiModuleId,
      resolveImport,
      call.index,
    )
  ) {
    return 'must pass an explicitly composed Layer as assembleEffectBffRuntime transport';
  }
  if (transport !== undefined && !usesImportedCorsTransport(source, code, transport, call.index)) {
    return 'must use the imported HttpRouter for the transport Layer';
  }
  if (!isRuntimeRootCall(code, call.index, call.index + call[0].length)) {
    return 'must return or export the assembled strict Effect BFF runtime';
  }
  return undefined;
};

export const privateOwnerImportViolation = (
  root: string,
  file: string,
  specifier: string,
): string | undefined => {
  if (!privateOwnerSpecifierPattern.test(specifier)) {
    return undefined;
  }
  const ownerMatch = /^verticals\/(?<owner>[^/]+)\//u.exec(normalize(file));
  const owner = ownerMatch?.groups?.owner;
  if (owner === undefined || !specifier.startsWith('.')) {
    return 'Shell/Core and consumers may not import a deployment owner file';
  }
  const ownerRoot = path.resolve(root, 'verticals', owner);
  const resolved = path.resolve(root, path.dirname(file), specifier).replace(/\.ts$/u, '');
  const expectedManifest = path.join(ownerRoot, 'vertical.manifest');
  const expectedRegistration = path.join(ownerRoot, 'vertical.registration');
  return resolved === expectedManifest || resolved === expectedRegistration
    ? undefined
    : 'a MicroVertical may import only its own deployment owner files';
};
