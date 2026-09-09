import path from 'node:path';

import { matchingDelimiter, separatedSource, topLevelSeparators } from './boundary-source-structure.mts';

export { unconstrainedHttpApiContractSchemaViolation } from './typescript-api-contract-boundary.mts';

const normalize = (filePath: string): string => filePath.split(path.sep).join('/');

const privateOwnerSpecifierPattern = /vertical\.(?:manifest|registration)(?:\.ts)?$/u;
const identifierPattern = String.raw`[$A-Z_a-z][$\w]*`;
const effectEdgeSpecifier = '@modern-js/plugin-bff/effect-edge';
const layerMergeAllCallee = 'Layer.mergeAll';

const escapesRegularExpression = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const sourceTriviaPattern = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//gu;
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

const importsNamedValueMatchingSpecifier = (source: string, name: string, specifierPattern: string): boolean => {
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
  expression.replace(/\s+satisfies\s+[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*(?:<[^<>]*>)?$/u, '').trim();

const assignmentStart = (source: string, declarationEnd: number): number | undefined => {
  const index = topLevelSeparators(source, '=;', declarationEnd, source.length, true).find(
    (position) => source[position + 1] !== '>',
  );
  return index === undefined || source[index] === ';' ? undefined : index + 1;
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

const isScopeVisibleAt = (source: string, declarationIndex: number, usageIndex: number): boolean => {
  if (declarationIndex >= usageIndex) {
    return false;
  }
  const declarationAncestors = curlyAncestorsAt(source, declarationIndex);
  const usageAncestors = curlyAncestorsAt(source, usageIndex);
  return declarationAncestors.every((ancestor, index) => usageAncestors[index] === ancestor);
};

const isBindingScopeAt = (source: string, declarationIndex: number, usageIndex: number): boolean => {
  const declarationAncestors = curlyAncestorsAt(source, declarationIndex);
  const usageAncestors = curlyAncestorsAt(source, usageIndex);
  return declarationAncestors.every((ancestor, index) => usageAncestors[index] === ancestor);
};

const initializerFor = (source: string, name: string, usageIndex = source.length): string | undefined => {
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

  const [end] = topLevelSeparators(source, ';', start);
  return end === undefined ? undefined : withoutTerminalSatisfies(source.slice(start, end).trim());
};

const callArguments = (expression: string, callee: string): readonly string[] | undefined => {
  const prefix = new RegExp(String.raw`^${escapesRegularExpression(callee)}\s*\(`, 'u').exec(expression);
  if (prefix === null) {
    return undefined;
  }
  const open = prefix[0].lastIndexOf('(');
  const close = matchingDelimiter(expression, open, '(', ')');
  if (close === undefined || expression.slice(close + 1).trim().length !== 0) {
    return undefined;
  }
  const separators = topLevelSeparators(expression, ',', open + 1, close, true);
  const argumentsList = separatedSource(expression, separators, open + 1, close);
  return argumentsList.at(-1) === '' ? argumentsList.slice(0, -1) : argumentsList;
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
  const prefix = new RegExp(String.raw`^${escapesRegularExpression(callee)}\s*\(`, 'u').exec(expression);
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
  return remainder !== undefined && (remainder.length === 0 || safeLayerPipeArguments(remainder) !== undefined);
};

const leadingCallArguments = (expression: string, callee: string): readonly string[] | undefined => {
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
    new RegExp(String.raw`\b${escapesRegularExpression(handlerBuilder)}\s*\.\s*handle\s*\(`, 'u').test(
      callback.slice(binding?.[0].length ?? 0),
    )
  );
};

interface RuntimeTopologyModule {
  readonly id: string;
  readonly resolveImport: RuntimeTopologyModuleResolver;
  readonly source: string;
}

export type RuntimeTopologyModuleResolver = (specifier: string) => RuntimeTopologyModule | undefined;

interface NamedBinding {
  readonly imported: string;
  readonly specifier: string;
}

const namedBindingInDeclaration = (bindings: string, name: string, specifier: string): NamedBinding | undefined => {
  for (const binding of bindings.split(',')) {
    const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
    if (local === name && imported !== undefined) {
      return { imported, specifier };
    }
  }
  return undefined;
};

const namedModuleBinding = (source: string, name: string, allowExport: boolean): NamedBinding | undefined => {
  const visible = withoutComments(source);
  const code = withoutCommentsOrLiterals(source);
  for (const candidate of visible.matchAll(
    /^(?<indent>[\t ]*)(?<keyword>import|export)\s*\{(?<bindings>[^}]*)\}\s*from\s*['"](?<specifier>[^'"]+)['"]/gmu,
  )) {
    const { bindings = '', indent = '', keyword = '', specifier = '' } = candidate.groups ?? {};
    if ((keyword === 'export' && !allowExport) || !code.slice(candidate.index + indent.length).startsWith(keyword)) {
      continue;
    }
    const binding = namedBindingInDeclaration(bindings, name, specifier);
    if (binding !== undefined) {
      return binding;
    }
  }
  return undefined;
};

const importedBindingFromAnyModule = (source: string, name: string): NamedBinding | undefined =>
  namedModuleBinding(source, name, true);
const importedValueBindingFromAnyModule = (source: string, name: string): NamedBinding | undefined =>
  namedModuleBinding(source, name, false);

const hasUnaliasedValueImport = (source: string, name: string, specifier: string): boolean => {
  const binding = importedValueBindingFromAnyModule(source, name);
  return binding?.imported === name && binding.specifier === specifier;
};

const initializerCalls = (code: string, name: string, callee: string, index = code.length): boolean => {
  const initializer = initializerFor(code, name, index);
  return initializer !== undefined && callArguments(initializer, callee) !== undefined;
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
  const pipedLayer = new RegExp(String.raw`^(?<base>${identifierPattern})(?<pipe>\.pipe\s*\()`, 'u').exec(initializer);
  return pipedLayer?.groups?.base === undefined || pipedLayer.groups.pipe === undefined
    ? false
    : layerValueUsesCors(source, pipedLayer.groups.base, usageIndex, new Set([...seen, name]));
};

const matchingRoundClose = (source: string, openIndex: number): number | undefined =>
  matchingDelimiter(source, openIndex, '(', ')');

const matchingCurlyClose = (source: string, openIndex: number): number | undefined =>
  matchingDelimiter(source, openIndex, '{', '}');

const parameterBinding = (parameter: string): string => parameter.slice(0, topLevelSeparators(parameter, ':=')[0]);

const parameterListShadows = (parameters: string, name: string): boolean => {
  const pattern = new RegExp(String.raw`\b${escapesRegularExpression(name)}\b`, 'u');
  const separators = topLevelSeparators(parameters, ',', 0, parameters.length, true);
  return separatedSource(parameters, separators).some((parameter) => pattern.test(parameterBinding(parameter)));
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
  const precedingWord = new RegExp(String.raw`(?<word>${identifierPattern})$`, 'u').exec(withoutGeneric)?.groups?.word;
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
  for (let openIndex = code.indexOf('('); openIndex >= 0; openIndex = code.indexOf('(', openIndex + 1)) {
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
      new RegExp(String.raw`\b(?:class|const|function|let|module|namespace|using|var)\s+${escapedName}\b`, 'gu'),
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
  if (!new RegExp(String.raw`\bexport\s+const\s+${escapesRegularExpression(name)}\s*=`, 'u').test(code)) {
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

const composedLayerOperand = (rawArgument: string): string | undefined => {
  const argument = withoutTerminalSatisfies(rawArgument);
  const layer = new RegExp(String.raw`^(?<name>${identifierPattern})(?<remainder>[\s\S]*)$`, 'u').exec(argument);
  const { name, remainder } = layer?.groups ?? {};
  if (name === undefined || remainder === undefined) {
    return undefined;
  }
  return remainder.trim().length === 0 || safeLayerPipeArguments(remainder.trim()) !== undefined ? name : undefined;
};

const groupUsesExpectedApi = (
  source: string,
  code: string,
  groupArguments: readonly string[],
  expectedApiExport: string,
  expectedApiModuleId: string | undefined,
  usageIndex: number,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
): boolean => {
  const [apiName] = groupArguments;
  if (apiName === undefined) {
    return false;
  }
  const apiBinding = importedValueBindingFromAnyModule(source, apiName);
  if (apiBinding === undefined) {
    return false;
  }
  const apiModule = resolveImport?.(apiBinding.specifier);
  return (
    hasUnaliasedValueImport(source, 'HttpApiBuilder', effectEdgeSpecifier) &&
    !shadowsBinding(code, 'HttpApiBuilder', usageIndex) &&
    sameApiExport(apiModule, apiBinding.imported, expectedApiExport) &&
    (expectedApiModuleId === undefined
      ? /(?:^|\/)shared\/api\.ts$/u.test(apiBinding.specifier)
      : apiModule?.id === expectedApiModuleId)
  );
};

const resolvedHandlerBinding = (
  source: string,
  code: string,
  name: string,
  usageIndex: number,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
): { readonly importedName: string; readonly resolved: RuntimeTopologyModule } | undefined => {
  if (shadowsBinding(code, name, usageIndex)) {
    return undefined;
  }
  const binding = importedBindingFromAnyModule(source, name);
  if (binding === undefined) {
    return undefined;
  }
  const resolved = resolveImport?.(binding.specifier);
  return resolved === undefined ? undefined : { importedName: binding.imported, resolved };
};

const safeHandlerGroupArguments = (initializer: string): readonly string[] | undefined => {
  const args = leadingCallArguments(initializer, 'HttpApiBuilder.group');
  return hasSafeLayerConstructor(initializer, 'HttpApiBuilder.group') &&
    args !== undefined &&
    groupCallbackRegistersHandler(args)
    ? args
    : undefined;
};

const safeMergeOperands = (source: string, initializer: string): readonly string[] | undefined => {
  const args = leadingCallArguments(initializer, layerMergeAllCallee);
  return hasUnaliasedValueImport(source, 'Layer', effectEdgeSpecifier) &&
    hasSafeLayerConstructor(initializer, layerMergeAllCallee) &&
    args !== undefined &&
    args.length > 0
    ? args
    : undefined;
};

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
    const groupArguments = safeHandlerGroupArguments(initializer);
    if (groupArguments !== undefined) {
      return groupUsesExpectedApi(
        source,
        code,
        groupArguments,
        expectedApiExport,
        expectedApiModuleId,
        usageIndex,
        resolveImport,
      );
    }
    const mergeArguments = safeMergeOperands(source, initializer);
    if (mergeArguments === undefined) {
      return false;
    }
    return mergeArguments.every((rawArgument) => {
      const layerName = composedLayerOperand(rawArgument);
      return (
        layerName !== undefined &&
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

  const imported = resolvedHandlerBinding(source, code, name, usageIndex, resolveImport);
  if (imported === undefined) {
    return false;
  }
  const { importedName, resolved } = imported;
  const resolvedCode = withoutCommentsOrLiterals(resolved.source);
  return handlerLayerDerivesFromHttpApiBuilder(
    resolved.source,
    resolvedCode,
    importedName,
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
      const layerName = composedLayerOperand(rawArgument);
      if (layerName === undefined) {
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

  const base = composedLayerOperand(initializer);
  return (
    base !== undefined &&
    initializer.startsWith(`${base}.pipe`) &&
    declaresLayerValue(
      source,
      code,
      base,
      allowCors,
      requireHandlerOperands,
      expectedApiExport,
      expectedApiModuleId,
      resolveImport,
      usageIndex,
      new Set([...seen, name]),
    )
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
    if (bodyStart !== -1 && bodyStart < endIndex && (statementEnd === -1 || bodyStart < statementEnd)) {
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
  return [...code.slice(bodyStart + 1, endIndex).matchAll(/\b(?:return|throw)\b/gu)].some(({ index }) => {
    const absoluteIndex = bodyStart + 1 + index;
    const owningFunction = innermostFunctionBody(curlyAncestorsAt(code, absoluteIndex), bodyStart, functionBodies);
    return owningFunction === bodyStart;
  });
};

const isDirectFactoryReturn = (code: string, bodyStart: number, callIndex: number, callEnd: number): boolean => {
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
      new RegExp(String.raw`\bexport\s+const\s+(?<factory>${identifierPattern})\s*=[\s\S]{0,2000}?=>\s*\{`, 'gu'),
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
  return (
    defaultRuntime !== undefined &&
    initializerCalls(code, defaultRuntime, factory) &&
    new RegExp(String.raw`\bexport\s+default\s+${escapesRegularExpression(defaultRuntime)}\s*;`, 'u').test(code)
  );
};

const expressionFactoryOwnsCall = (code: string, callIndex: number, callEnd: number): boolean => {
  const expressionFactory = new RegExp(
    String.raw`\bexport\s+const\s+(?<factory>${identifierPattern})\s*=\s*\(\s*\)\s*=>\s*$`,
    'u',
  ).exec(code.slice(0, callIndex));
  const factory = expressionFactory?.groups?.factory;
  if (
    expressionFactory !== null &&
    factory !== undefined &&
    curlyDepthAt(code, expressionFactory.index) === 0 &&
    /^\s*;/u.test(code.slice(callEnd))
  ) {
    const factoryResult = new RegExp(
      String.raw`\bconst\s+(?<runtime>${identifierPattern})\s*=\s*${escapesRegularExpression(factory)}\s*\(\s*\)\s*;`,
      'gu',
    );
    return [...code.slice(callEnd).matchAll(factoryResult)].some((match) => {
      const runtime = match.groups?.runtime;
      return (
        runtime !== undefined &&
        curlyDepthAt(code, callEnd + match.index) === 0 &&
        new RegExp(String.raw`\bexport\s+default\s+${escapesRegularExpression(runtime)}\s*;`, 'u').test(
          code.slice(callEnd),
        )
      );
    });
  }
  return false;
};

const isRuntimeRootCall = (code: string, callIndex: number, callEnd: number): boolean => {
  const prefix = code.slice(0, callIndex);
  if (/\bexport\s+default\s*$/u.test(prefix)) {
    return /^\s*(?:;|$)/u.test(code.slice(callEnd));
  }
  if (/\breturn\s*$/u.test(prefix)) {
    return exportedFactoryOwnsCall(code, callIndex, callEnd);
  }
  if (expressionFactoryOwnsCall(code, callIndex, callEnd)) {
    return true;
  }
  const assignment = new RegExp(String.raw`\bconst\s+(?<name>${identifierPattern})\s*=\s*$`, 'u').exec(prefix);
  const runtimeName = assignment?.groups?.name;
  return (
    runtimeName !== undefined &&
    assignment !== null &&
    /^\s*;/u.test(code.slice(callEnd)) &&
    curlyDepthAt(code, assignment.index) === 0 &&
    new RegExp(String.raw`\bexport\s+default\s+${escapesRegularExpression(runtimeName)}\s*;`, 'u').test(
      code.slice(callIndex),
    )
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

const usesImportedCorsTransport = (source: string, code: string, transport: string, callIndex: number): boolean =>
  !layerValueUsesCors(code, transport, callIndex) ||
  (importedValueBindingFromAnyModule(source, 'HttpRouter')?.imported === 'HttpRouter' &&
    importedValueBindingFromAnyModule(source, 'HttpRouter')?.specifier === effectEdgeSpecifier &&
    !shadowsBinding(code, 'HttpRouter', callIndex));

const hasRpcGroupContract = (
  source: string,
  group: string,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
): boolean => {
  if (!hasUnaliasedValueImport(source, group, '../shared/rpc.ts')) {
    return false;
  }
  const module = resolveImport?.('../shared/rpc.ts');
  if (module === undefined) {
    return false;
  }
  const code = withoutCommentsOrLiterals(module.source);
  return (
    hasUnaliasedValueImport(module.source, 'RpcGroup', 'effect/unstable/rpc') &&
    initializerCalls(code, group, 'RpcGroup.make') &&
    !shadowsBinding(code, 'RpcGroup', code.length)
  );
};

const hasRpcRuntimeLayers = (source: string, code: string, call: RegExpExecArray, helper: string): boolean => {
  const { api, group, layer = 'layer', rpcLayer } = call.groups ?? {};
  if (api === undefined || group === undefined || rpcLayer === undefined) {
    return false;
  }
  return (
    ['HttpApi', 'Layer'].every((name) => hasUnaliasedValueImport(source, name, effectEdgeSpecifier)) &&
    [helper, 'HttpApi', 'Layer', group].every((name) => !shadowsBinding(code, name, call.index)) &&
    initializerCalls(code, api, 'HttpApi.make', call.index) &&
    initializerFor(code, layer, call.index) === 'Layer.empty' &&
    initializerCalls(code, rpcLayer, `${group}.toLayer`, call.index)
  );
};

/** Keeps genuinely different generated RPC assembly outside the REST-only helper contract. */
export const usesStrictRpcRuntimeTopology = (
  source: string,
  resolveImport?: RuntimeTopologyModuleResolver,
): boolean => {
  const code = withoutCommentsOrLiterals(source);
  const helper = importedLocalNameMatchingSpecifier(
    source,
    'defineEffectBff',
    escapesRegularExpression(effectEdgeSpecifier),
  );
  if (helper === undefined || !/\bfrom\s+['"]\.\.\/shared\/rpc\.ts['"]/u.test(withoutComments(source))) {
    return false;
  }
  const call = new RegExp(
    String.raw`\b${escapesRegularExpression(helper)}\s*\(\s*\{\s*api:\s*(?<api>${identifierPattern})\s*,\s*layer(?:\s*:\s*(?<layer>${identifierPattern}))?\s*,\s*rpc:\s*\{\s*group:\s*(?<group>${identifierPattern})\s*,\s*layer:\s*(?<rpcLayer>${identifierPattern})\s*,\s*path:\s*,\s*serialization:\s*,?\s*\}\s*,?\s*\}\s*,?\s*\)`,
    'u',
  ).exec(code);
  if (call === null) {
    return false;
  }
  const group = call.groups?.group;
  return (
    group !== undefined &&
    hasRpcGroupContract(source, group, resolveImport) &&
    hasRpcRuntimeLayers(source, code, call, helper) &&
    isRuntimeRootCall(code, call.index, call.index + call[0].length)
  );
};

interface AssemblyBindings {
  readonly api: string;
  readonly handlers: string;
  readonly transport: string | undefined;
}

const assemblyTransportViolation = (
  source: string,
  code: string,
  transport: string | undefined,
  apiExport: string,
  expectedApiModuleId: string | undefined,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
  index: number,
): string | undefined => {
  if (transport === undefined) {
    return undefined;
  }
  if (!declaresLayerValue(source, code, transport, true, false, apiExport, expectedApiModuleId, resolveImport, index)) {
    return 'must pass an explicitly composed Layer as assembleEffectBffRuntime transport';
  }
  return usesImportedCorsTransport(source, code, transport, index)
    ? undefined
    : 'must use the imported HttpRouter for the transport Layer';
};

const assembledRuntimeViolation = (
  source: string,
  code: string,
  helper: string,
  call: RegExpExecArray,
  bindings: AssemblyBindings,
  resolveImport: RuntimeTopologyModuleResolver | undefined,
): string | undefined => {
  const { api, handlers, transport } = bindings;
  if (!importsNamedValueFromSharedApi(source, api)) {
    return 'must pass the API imported from ../shared/api.ts to assembleEffectBffRuntime';
  }
  const apiBinding = importedValueBindingFromAnyModule(source, api);
  if (apiBinding === undefined) {
    return 'must prove the exact shared API export used by assembleEffectBffRuntime';
  }
  const apiExport = apiBinding.imported;
  const expectedApiModuleId = resolveImport?.(apiBinding.specifier)?.id;
  if (resolveImport !== undefined && expectedApiModuleId === undefined) {
    return 'must prove the exact shared API export used by assembleEffectBffRuntime';
  }
  if (!usesUnshadowedHelperImports(source, code, api, helper, call.index)) {
    return 'must use unshadowed server helper, API, and Layer imports for assembly';
  }
  if (
    !declaresLayerValue(source, code, handlers, false, true, apiExport, expectedApiModuleId, resolveImport, call.index)
  ) {
    return 'must pass an explicitly composed Layer as assembleEffectBffRuntime handlers';
  }
  const transportViolation = assemblyTransportViolation(
    source,
    code,
    transport,
    apiExport,
    expectedApiModuleId,
    resolveImport,
    call.index,
  );
  if (transportViolation !== undefined) {
    return transportViolation;
  }
  if (!isRuntimeRootCall(code, call.index, call.index + call[0].length)) {
    return 'must return or export the assembled strict Effect BFF runtime';
  }
  return undefined;
};

/** Proves the shared helper's concrete API/Layer topology. */
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
  const { api, handlers, transport } = call?.groups ?? {};
  if (call === null || api === undefined || handlers === undefined) {
    return 'must pass a concrete api and composed handlers directly to assembleEffectBffRuntime';
  }
  return assembledRuntimeViolation(source, code, helper, call, { api, handlers, transport }, resolveImport);
};

export const privateOwnerImportViolation = (root: string, file: string, specifier: string): string | undefined => {
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
