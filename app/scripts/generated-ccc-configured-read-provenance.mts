import path from 'node:path';

import { Schema } from 'effect';

import { SyntaxKind } from '@typescript/native/unstable/ast';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  AssignmentTargetMaybeDefault,
  AssignmentTargetRest,
  BindingPattern,
  CallExpression,
  Expression,
  Function as SourceFunction,
  ParamPattern,
  Program,
  Span,
  SpreadElement,
  VariableDeclarator,
  TSTypeAliasDeclaration,
} from 'oxc-parser';

import { tokenizeGovernedClient } from './generated-module-api-boundary.mts';

export interface ConfiguredReadPhaseOwner {
  readonly diagnostics?: string[];
  readonly ownerPath: string;
  readonly readFile: string;
  readonly sources: ReadonlyMap<string, string>;
}

const CORE_RUNTIME = '@app/core-runtime';

interface Source {
  readonly file: string;
  readonly program: Program;
  readonly text: string;
}

interface Imported {
  readonly imported: string;
  readonly local: string;
  readonly module: string;
  readonly typeOnly: boolean;
}

interface Original {
  readonly name: string;
  readonly source: Source;
  readonly value: Expression;
}

const failed = (owner: ConfiguredReadPhaseOwner, reason: string): false => {
  owner.diagnostics?.push(`${owner.readFile}: ${reason}`);
  return false;
};
const parse = (file: string, text: string): Source | undefined => {
  try {
    const result = parseSync(file, text);
    return result.errors.length === 0 ? { file, program: result.program, text } : undefined;
  } catch {
    return undefined;
  }
};

const checked = (owner: ConfiguredReadPhaseOwner, checks: Readonly<Record<string, boolean>>): boolean =>
  Object.entries(checks).every(([name, valid]) => valid || failed(owner, `configured Read ${name}`));

const textOf = (source: Source, node: Span): string => source.text.slice(node.start, node.end);
const structuralTokens = (text: string) => {
  const tokens = tokenizeGovernedClient(text);
  return tokens.filter(
    (token, index) =>
      token.kind !== SyntaxKind.CommaToken ||
      ![SyntaxKind.CloseParenToken, SyntaxKind.CloseBraceToken, SyntaxKind.CloseBracketToken].includes(
        tokens[index + 1]?.kind ?? SyntaxKind.Unknown,
      ),
  );
};
const exact = (source: Source, node: Span, expected: string): boolean => {
  const actual = structuralTokens(textOf(source, node));
  const target = structuralTokens(expected);
  return (
    actual.length === target.length &&
    actual.every((token, index) => token.kind === target[index]?.kind && token.value === target[index]?.value)
  );
};

const imports = (source: Source): readonly Imported[] =>
  source.program.body.flatMap((statement) =>
    statement.type === 'ImportDeclaration'
      ? statement.specifiers.flatMap((specifier) =>
          specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
            ? [
                {
                  imported: specifier.imported.name,
                  local: specifier.local.name,
                  module: statement.source.value,
                  typeOnly: statement.importKind === 'type' || specifier.importKind === 'type',
                },
              ]
            : [],
        )
      : [],
  );

const declarations = (source: Source, exported = false): readonly VariableDeclarator[] =>
  source.program.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (exported && statement.type !== 'ExportNamedDeclaration') {
      return [];
    }
    return declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' ? declaration.declarations : [];
  });

const constant = (source: Source, name: string, exported = false): Expression | undefined => {
  const matches = declarations(source, exported).filter(
    (item) => item.id.type === 'Identifier' && item.id.name === name,
  );
  return matches.length === 1 ? (matches[0]?.init ?? undefined) : undefined;
};

const typeAlias = (source: Source, name: string): TSTypeAliasDeclaration | undefined => {
  const matches = source.program.body.flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return declaration?.type === 'TSTypeAliasDeclaration' && declaration.id.name === name ? [declaration] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
};

const identifier = (node: Expression | ParamPattern | undefined): string | undefined =>
  node?.type === 'Identifier' ? node.name : undefined;

const unparenthesized = (expression: Expression | undefined): Expression | undefined =>
  expression?.type === 'ParenthesizedExpression' ? unparenthesized(expression.expression) : expression;

const properties = (expression: Expression | undefined): ReadonlyMap<string, Expression> | undefined => {
  const object = unparenthesized(expression);
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  const result = new Map<string, Expression>();
  for (const property of object.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
      return undefined;
    }
    const key = property.key.type === 'Identifier' ? property.key.name : undefined;
    if (key === undefined || result.has(key)) {
      return undefined;
    }
    result.set(key, property.value);
  }
  return result;
};

const member = (node: Expression | undefined, receiver: string, property: string): boolean =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  !node.optional &&
  identifier(node.object) === receiver &&
  node.property.type === 'Identifier' &&
  node.property.name === property;

/** Type assertions and parentheses do not create a new runtime receiver identity. */
const identityExpression = (node: Expression): Expression => {
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSInstantiationExpression'
  ) {
    return identityExpression(node.expression);
  }
  return node;
};

const rootName = (node: Expression): string | undefined => {
  const expression = identityExpression(node);
  return expression.type === 'MemberExpression' ? rootName(expression.object) : identifier(expression);
};

const boundNames = (pattern: BindingPattern | ParamPattern): readonly string[] => {
  if (pattern.type === 'Identifier') {
    return [pattern.name];
  }
  if (pattern.type === 'AssignmentPattern') {
    return boundNames(pattern.left);
  }
  if (pattern.type === 'RestElement') {
    return boundNames(pattern.argument);
  }
  if (pattern.type === 'TSParameterProperty') {
    return boundNames(pattern.parameter);
  }
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap((item) => (item === null ? [] : boundNames(item)));
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((item) => boundNames(item.type === 'RestElement' ? item.argument : item.value));
  }
  return [];
};

const escapes = (argument: Expression | SpreadElement, names: ReadonlyMap<string, number>): boolean => {
  const node = argument.type === 'SpreadElement' ? argument : identityExpression(argument);
  if (node.type === 'Identifier') {
    return names.has(node.name);
  }
  if (node.type === 'SpreadElement') {
    return escapes(node.argument, names);
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.some((property) =>
      escapes(property.type === 'SpreadElement' ? property : property.value, names),
    );
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.some((element) => element !== null && escapes(element, names));
  }
  return false;
};

/** Reject rebinding, shadowing, property writes and escapes of the selected original identities. */
const stable = (source: Source, names: ReadonlyMap<string, number>, allowedCalls: readonly string[] = []): boolean => {
  const counts = new Map<string, number>();
  let valid = true;
  const bind = (patterns: readonly ParamPattern[]) => {
    for (const name of patterns.flatMap(boundNames)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  };
  const writes = (node: AssignmentTargetMaybeDefault | AssignmentTargetRest | Expression): void => {
    if (node.type === 'ArrayPattern') {
      for (const element of node.elements) {
        if (element !== null) {
          writes(element);
        }
      }
    } else if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        writes(property.type === 'RestElement' ? property.argument : property.value);
      }
    } else if (node.type === 'AssignmentPattern') {
      writes(node.left);
    } else if (node.type === 'RestElement') {
      writes(node.argument);
    } else if (names.has(rootName(node) ?? '')) {
      valid = false;
    }
  };
  const callback = (node: SourceFunction | ArrowFunctionExpression) => {
    bind(node.params);
    if (node.id !== null) {
      bind([node.id]);
    }
  };
  new Visitor({
    ArrowFunctionExpression: callback,
    AssignmentExpression: (node) => writes(node.left),
    CallExpression: (node) => {
      const callee = textOf(source, node.callee).replaceAll(/\s/gu, '');
      if (allowedCalls.includes(callee)) {
        return;
      }
      const escaped = node.arguments.some((argument) => escapes(argument, names));
      if (escaped) {
        valid = false;
      }
    },
    CatchClause: (node) => {
      if (node.param !== null) {
        bind([node.param]);
      }
    },
    ClassDeclaration: (node) => {
      if (node.id !== null) {
        bind([node.id]);
      }
    },
    FunctionDeclaration: callback,
    FunctionExpression: callback,
    ImportDeclaration: (node) => bind(node.specifiers.map((item) => item.local)),
    TSInterfaceDeclaration: (node) => bind([node.id]),
    TSTypeAliasDeclaration: (node) => bind([node.id]),
    TSTypeParameter: (node) => bind([node.name]),
    UnaryExpression: (node) => {
      if (node.operator === 'delete') {
        writes(node.argument);
      }
    },
    UpdateExpression: (node) => writes(node.argument),
    VariableDeclarator: (node) => {
      bind([node.id]);
      if (node.init !== null && names.has(identifier(identityExpression(node.init)) ?? '')) {
        valid = false;
      }
    },
  }).visit(source.program);
  return valid && [...names].every(([name, count]) => (counts.get(name) ?? 0) === count);
};

const native = (source: Source, exported: string, module: string, typeOnly = false): string | undefined => {
  const matches = imports(source).filter(
    (item) => item.imported === exported && item.module === module && (typeOnly || !item.typeOnly),
  );
  const name = matches.length === 1 ? matches[0]?.local : undefined;
  return name !== undefined && stable(source, new Map([[name, 1]]), [`${name}.fn`, `${name}.mapError`])
    ? name
    : undefined;
};

const original = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  local: string,
  allowedCalls: readonly string[] = [],
): Original | undefined => {
  const matches = imports(source).filter((item) => item.local === local && !item.typeOnly);
  const imported = matches.length === 1 ? matches[0] : undefined;
  if (imported === undefined || !/^\.\.?\/.+\.ts$/u.test(imported.module)) {
    return undefined;
  }
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(source.file), imported.module));
  const targetText = file.startsWith(`${owner.ownerPath}/`) ? owner.sources.get(file) : undefined;
  const target = targetText === undefined ? undefined : parse(file, targetText);
  const value = target === undefined ? undefined : constant(target, imported.imported, true);
  if (
    target === undefined ||
    value === undefined ||
    (value.type === 'ArrowFunctionExpression' && value.async) ||
    !stable(source, new Map([[local, 1]]), [
      local,
      ...allowedCalls,
      ...imports(source)
        .filter((item) => item.module === CORE_RUNTIME && item.imported === 'defineRead')
        .map((item) => item.local),
    ]) ||
    !stable(target, new Map([[imported.imported, 1]]), [imported.imported])
  ) {
    return undefined;
  }
  return { name: imported.imported, source: target, value };
};

const call = (node: Expression | undefined, name: string, count: number): CallExpression | undefined =>
  node?.type === 'CallExpression' &&
  !node.optional &&
  identifier(node.callee) === name &&
  node.arguments.length === count &&
  node.arguments.every((argument) => argument.type !== 'SpreadElement')
    ? node
    : undefined;

const effectGenerator = (source: Source, expression: Expression): SourceFunction | undefined => {
  const effect = native(source, 'Effect', 'effect');
  if (
    effect === undefined ||
    expression.type !== 'CallExpression' ||
    expression.arguments.length !== 1 ||
    expression.callee.type !== 'CallExpression' ||
    expression.callee.arguments.length !== 1 ||
    !member(expression.callee.callee, effect, 'fn')
  ) {
    return undefined;
  }
  const [generator] = expression.arguments;
  return generator?.type === 'FunctionExpression' && generator.generator && !generator.async && generator.body !== null
    ? generator
    : undefined;
};

const originalType = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  name: string,
): { readonly file: string; readonly name: string } | undefined => {
  const imported = imports(source).filter((item) => item.local === name);
  if (imported.length === 0) {
    return { file: source.file, name };
  }
  const item = imported.length === 1 ? imported[0] : undefined;
  const file =
    item === undefined ? '' : path.posix.normalize(path.posix.join(path.posix.dirname(source.file), item.module));
  return file.startsWith(`${owner.ownerPath}/`) && owner.sources.has(file)
    ? { file, name: item?.imported ?? '' }
    : undefined;
};

const parameterType = (source: Source, parameter: ParamPattern | undefined): string | undefined =>
  parameter?.type === 'Identifier' && parameter.typeAnnotation !== undefined && parameter.typeAnnotation !== null
    ? textOf(source, parameter.typeAnnotation).replace(/^:\s*/u, '')
    : undefined;

const stableHandler = (source: Source, maker: ArrowFunctionExpression, names: readonly string[]): boolean => {
  const fragment = parse(source.file, `const selectedHandler = ${textOf(source, maker)};`);
  const effect = native(source, 'Effect', 'effect');
  return (
    fragment !== undefined &&
    effect !== undefined &&
    stable(fragment, new Map(names.map((name) => [name, 1])), [`${names[0]}.resolve`, `${effect}.fn`])
  );
};
const handlerBody = (source: Source, maker: ArrowFunctionExpression): boolean => {
  const config = identifier(maker.params[0]);
  const generator = maker.body.type === 'BlockStatement' ? undefined : effectGenerator(source, maker.body);
  const input = identifier(generator?.params[0]);
  const context = identifier(generator?.params[1]);
  const effect = native(source, 'Effect', 'effect');
  const denied = native(source, 'ReadPermissionDenied', CORE_RUNTIME);
  const unavailable = native(source, 'ReadHandlerUnavailable', CORE_RUNTIME);
  const contextType = native(source, 'ReadHandlerContext', CORE_RUNTIME, true);
  if (
    maker.params.length !== 1 ||
    config === undefined ||
    generator?.params.length !== 2 ||
    input === undefined ||
    context === undefined ||
    effect === undefined ||
    denied === undefined ||
    unavailable === undefined ||
    contextType === undefined ||
    generator.body === null
  ) {
    return false;
  }
  return (
    parameterType(source, generator.params[1]) === `${contextType}<Services>` &&
    exact(
      source,
      generator.body,
      `{
      const { legalEntityId, principalId, tenantId, trustedStorefrontId: storefrontId } = ${context}.scope;
      if (legalEntityId === undefined || storefrontId === undefined ||
        ${input}.purchasingContext.tenantId !== tenantId ||
        ${input}.purchasingContext.sellingLegalEntityId !== legalEntityId ||
        ${input}.purchasingContext.storefrontId !== storefrontId ||
        (${input}.subject.kind === 'PROFILE' && ${input}.subject.profile.profileRef.tenantId !== tenantId)) {
        return yield* new ${denied}({
          code: 'read_permission_denied',
          reason: \`The \${${config}.resolutionLabel} purchase context is outside trusted operation scope\`,
        });
      }
      const resolution = yield* ${config}.resolve(
        ${input}, { legalEntityId, principalId, storefrontId, tenantId }, ${context}.services
      ).pipe(${effect}.mapError((failure) => new ${unavailable}({
        code: 'read_handler_unavailable',
        reason: \`\${${config}.resolutionLabel} dependency unavailable: \${failure.dependency}\`,
      })));
      return { evidence: { resultCount: 1 }, result: { resolution } };
    }`,
    ) &&
    stableHandler(source, maker, [config, input, context])
  );
};

const definitionCalls = (source: Source): readonly string[] =>
  imports(source)
    .filter((item) => item.module === CORE_RUNTIME && item.imported === 'defineRead')
    .map((item) => item.local);

const identifierUses = (source: Source, name: string): number => {
  let count = 0;
  new Visitor({
    Identifier: (node) => {
      if (node.name === name) {
        count += 1;
      }
    },
  }).visit(source.program);
  return count;
};

const configuredOptions = (
  source: Source,
  phase: string,
): { readonly binding: string; readonly config: ReadonlyMap<string, Expression> } | undefined => {
  const handler = constant(source, phase);
  if (handler?.type !== 'CallExpression' || handler.arguments.length !== 1 || handler.optional) {
    return undefined;
  }
  const binding = identifier(handler.callee);
  if (binding === undefined || !stable(source, new Map([[phase, 1]]), definitionCalls(source))) {
    return undefined;
  }
  const [argument] = handler.arguments;
  let options: Expression | undefined = argument?.type === 'SpreadElement' ? undefined : argument;
  if (options?.type === 'Identifier') {
    if (!stable(source, new Map([[options.name, 1]]), [binding]) || identifierUses(source, options.name) !== 2) {
      return undefined;
    }
    options = constant(source, options.name);
  }
  const config = properties(options);
  return config === undefined ? undefined : { binding, config };
};

const literalText = (node: Expression | SpreadElement | undefined): string | undefined =>
  node?.type === 'Literal' && Schema.is(Schema.String)(node.value) ? node.value : undefined;

const resolverContract = (
  resolve: Original,
): { readonly portsType: string | undefined; readonly resolve: Original } | undefined => {
  const generator = effectGenerator(resolve.source, resolve.value);
  if (generator?.params.length !== 3 || generator.body === null) {
    return undefined;
  }
  const [input, scope, ports] = generator.params.map(identifier);
  const [first] = generator.body.body;
  const current = first?.type === 'VariableDeclaration' ? first.declarations[0] : undefined;
  if (
    input === undefined ||
    scope === undefined ||
    ports === undefined ||
    current?.init?.type !== 'YieldExpression' ||
    !current.init.delegate ||
    current.init.argument === null ||
    !exact(resolve.source, current.init.argument, `${ports}.loadCurrent(${input}, ${scope})`)
  ) {
    return undefined;
  }
  return { portsType: parameterType(resolve.source, generator.params[2]), resolve };
};

const configuredHandler = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  phase: string,
): ReturnType<typeof resolverContract> => {
  const options = configuredOptions(source, phase);
  if (options === undefined || options.config.size !== 3) {
    return undefined;
  }
  const { binding, config } = options;
  if (literalText(config.get('effectName')) === undefined || literalText(config.get('resolutionLabel')) === undefined) {
    return undefined;
  }
  const target = original(owner, source, binding);
  const resolver = identifier(config.get('resolve'));
  if (
    target?.value.type !== 'ArrowFunctionExpression' ||
    resolver === undefined ||
    !handlerBody(target.source, target.value)
  ) {
    return undefined;
  }
  const resolve = original(owner, source, resolver, [binding]);
  return resolve === undefined ? undefined : resolverContract(resolve);
};

const readFactoryBinding = (source: Source, phase: string): string | undefined => {
  const defineRead = native(source, 'defineRead', CORE_RUNTIME);
  if (defineRead === undefined) {
    return undefined;
  }
  const reads = declarations(source, true).filter((item) => {
    const invocation = call(item.init ?? undefined, defineRead, 3);
    const phases = invocation?.arguments[1];
    return phases?.type !== 'SpreadElement' && identifier(properties(phases)?.get('load')) === phase;
  });
  const invocation = reads.length === 1 ? call(reads[0]?.init ?? undefined, defineRead, 3) : undefined;
  const factory = invocation?.arguments[2];
  return factory?.type === 'Identifier' ? factory.name : undefined;
};

const publishedExecutor = (source: Source): string | undefined => {
  const alias = source.program.body.find(
    (statement) => statement.type === 'TSTypeAliasDeclaration' && /Parameters<typeof/u.test(textOf(source, statement)),
  );
  if (alias?.type !== 'TSTypeAliasDeclaration') {
    return undefined;
  }
  const local = /Parameters<typeof\s+(?<binding>\w+)>/u.exec(textOf(source, alias))?.groups?.binding;
  const contract = imports(source).find((item) => item.local === local && item.typeOnly);
  // The executor's operation name comes from its imported contract, but its native
  // publisher must match the Party audience used by the scope-bound delegation.
  if (
    contract?.module !== '@app/party-registry/api/client' ||
    !stable(source, new Map([['Parameters', 0]])) ||
    native(source, contract.imported, contract.module, true) !== contract.local
  ) {
    return undefined;
  }
  return native(source, `${contract.imported}WithAuthorization`, contract.module);
};

const optionalExecutorReference = (source: Source): boolean => {
  const context = native(source, 'Context', 'effect');
  const functions = native(source, 'Function', 'effect');
  const reference = constant(source, 'PartyAddressSourceExecutor');
  if (
    context === undefined ||
    functions === undefined ||
    reference?.type !== 'CallExpression' ||
    !member(reference.callee, context, 'Reference') ||
    reference.arguments.length !== 2
  ) {
    return false;
  }
  const [key, options] = reference.arguments;
  if (literalText(key) === undefined || options === undefined || options.type === 'SpreadElement') {
    return false;
  }
  const fields = properties(options);
  return fields?.size === 1 && member(fields.get('defaultValue'), functions, 'constUndefined');
};

const executorContract = (source: Source, value: Expression | undefined): boolean => {
  if (
    value?.type !== 'ArrowFunctionExpression' ||
    value.async ||
    value.params.length !== 3 ||
    value.body.type !== 'ArrowFunctionExpression' ||
    value.body.async ||
    value.body.params.length !== 2
  ) {
    return false;
  }
  const [scope, crypto, requirement] = value.params.map(identifier);
  const [payload, correlation] = value.body.params.map(identifier);
  const effect = native(source, 'Effect', 'effect');
  const requireOperation = native(source, 'requireModuleOperation', CORE_RUNTIME);
  const acquire = native(source, 'acquireDelegatedGatewayContext', '@app/shared-contracts/gateway-context-server');
  const execute = publishedExecutor(source);
  if (
    [scope, crypto, requirement, payload, correlation, effect, requireOperation, acquire, execute].some(
      (name) => name === undefined,
    )
  ) {
    return false;
  }
  const subjectScope = scope === 'scope' ? scope : `scope: ${scope}`;
  return (
    exact(
      source,
      value.body.body,
      `(${requirement} === undefined ? ${effect}.void : ${requireOperation}(${requirement})).pipe(
    ${effect}.andThen(PartyAddressSourceExecutor),
    ${effect}.flatMap((execute) => {
      if (execute !== undefined) { return execute(${payload}, ${correlation}); }
      return ${acquire}({
        audience: 'party-registry',
        legalEntityScope: 'subject',
        requestCorrelation: ${scope}.correlationId,
        subject: { _tag: 'Assertion', ${subjectScope} },
      }, ${crypto}).pipe(
        ${effect}.flatMap((issued) => ${execute}(${payload}, issued.authorization, ${scope}.correlationId, {
          baseUrl: new URL(issued.apiBaseUrl),
          compositionRevision: issued.compositionRevision,
        })),
      );
    }),
  )`,
    ) &&
    effect !== undefined &&
    optionalExecutorReference(source) &&
    stable(
      source,
      new Map([
        ['URL', 0],
        ['PartyAddressSourceExecutor', 1],
      ]),
      [`${effect}.andThen`],
    )
  );
};

const postalResolverContract = (source: Source, value: Expression | undefined): boolean => {
  if (
    value?.type !== 'ArrowFunctionExpression' ||
    value.async ||
    value.params.length !== 2 ||
    value.body.type !== 'ArrowFunctionExpression' ||
    value.body.async ||
    value.body.params.length !== 1
  ) {
    return false;
  }
  const [correlation, execute] = value.params.map(identifier);
  const [address] = value.body.params.map(identifier);
  const effect = native(source, 'Effect', 'effect');
  const delegationError = native(
    source,
    'GatewayDelegationSourceError',
    '@app/shared-contracts/gateway-context-server',
  );
  if ([correlation, execute, address, effect, delegationError].some((name) => name === undefined)) {
    return false;
  }
  return (
    exact(
      source,
      value.body.body,
      `{
    if (${address}.origin.kind === 'COMMERCE_ONLY') {
      const { postalAddress } = ${address}.origin;
      return postalAddress === undefined
        ? ${effect}.succeed(notFound<ResolvedSavedPostalAddress>())
        : ${effect}.succeed(found({ kind: 'COMMERCE_ONLY' as const, postalAddress }));
    }
    const { origin } = ${address};
    return (${execute} === undefined ? PartyAddressSourceExecutor : ${effect}.succeed(${execute})).pipe(
      ${effect}.flatMap((client: PartyContactPointDetailExecutor | undefined) =>
        client === undefined
          ? ${effect}.fail(new ${delegationError}({ reason: partyOwnerTransportRequired }))
          : client({ contactPointRef: origin.contactPointRef }, ${correlation}),
      ),
      ${effect}.map((contactPoint) => resolvePartyBackedPostalAddress(origin, contactPoint)),
      ${effect}.catch(resolverFailure),
    );
  }`,
    ) &&
    effect !== undefined &&
    stable(
      source,
      new Map([
        ['PartyAddressSourceExecutor', 1],
        ['resolverFailure', 1],
        ['resolvePartyBackedPostalAddress', 1],
      ]),
      [`${effect}.catch`, `${effect}.andThen`],
    )
  );
};

const scopedResolver = (target: Original): boolean => {
  if (target.value.type !== 'ArrowFunctionExpression' || target.value.params.length !== 3) {
    return false;
  }
  const parameters = target.value.params.map(identifier);
  const { body } = target.value;
  if (body.type !== 'CallExpression' || body.arguments.length !== 2 || parameters.some((item) => item === undefined)) {
    return false;
  }
  const [correlation, executor] = body.arguments;
  const executorName = executor?.type === 'CallExpression' ? identifier(executor.callee) : undefined;
  const resolverName = identifier(body.callee);
  const resolver = resolverName === undefined ? undefined : constant(target.source, resolverName);
  return (
    executorName !== undefined &&
    correlation !== undefined &&
    executor !== undefined &&
    exact(target.source, correlation, `${parameters[0]}.correlationId`) &&
    exact(target.source, executor, `${executorName}(${parameters.join(', ')})`) &&
    postalResolverContract(target.source, resolver) &&
    executorContract(target.source, constant(target.source, executorName)) &&
    resolverName !== undefined &&
    stable(
      target.source,
      new Map([
        [resolverName, 1],
        [executorName, 1],
      ]),
    )
  );
};

const defaultDependency = (owner: ConfiguredReadPhaseOwner, source: Source, name: string): boolean => {
  const dependency = constant(source, name);
  if (dependency?.type !== 'ArrowFunctionExpression' || dependency.async || dependency.params.length !== 3) {
    return false;
  }
  const parameters = dependency.params.map(identifier);
  if (parameters.some((item) => item === undefined) || dependency.body.type === 'BlockStatement') {
    return false;
  }
  const fields = properties(dependency.body);
  const resolution = fields?.get('resolvePartyPostalAddress');
  const binding = resolution?.type === 'CallExpression' ? identifier(resolution.callee) : undefined;
  if (
    binding === undefined ||
    fields?.size !== 1 ||
    resolution === undefined ||
    !exact(source, resolution, `${binding}(${parameters.join(', ')})`)
  ) {
    return false;
  }
  const target = original(owner, source, binding);
  return target !== undefined && scopedResolver(target) && stable(source, new Map([[name, 1]]));
};

const stableMaker = (source: Source, maker: ArrowFunctionExpression, parameter: string): boolean => {
  const fragment = parse(source.file, `const selectedFactory = ${textOf(source, maker)};`);
  return fragment !== undefined && stable(fragment, new Map([[parameter, 1]]), [parameter]);
};

interface SelectedMaker {
  readonly dependency: string;
  readonly exported: Original;
  readonly maker: ArrowFunctionExpression;
  readonly name: string;
  readonly parameter: string;
}
const selectedMaker = (owner: ConfiguredReadPhaseOwner, source: Source, binding: string): SelectedMaker | undefined => {
  const exported = original(owner, source, binding);
  const invocation = exported?.value;
  const name = invocation?.type === 'CallExpression' ? identifier(invocation.callee) : undefined;
  if (exported === undefined || name === undefined || call(invocation, name, 0) === undefined) {
    return undefined;
  }
  const maker = constant(exported.source, name);
  if (maker?.type !== 'ArrowFunctionExpression' || maker.async || maker.params.length !== 1) {
    return undefined;
  }
  const [parameter] = maker.params;
  if (
    parameter?.type !== 'AssignmentPattern' ||
    parameter.left.type !== 'Identifier' ||
    parameter.right.type !== 'Identifier'
  ) {
    return undefined;
  }
  return { dependency: parameter.right.name, exported, maker, name, parameter: parameter.left.name };
};

interface FactoryBody {
  readonly cryptoName: string;
  readonly returned: CallExpression;
  readonly scope: string;
  readonly transaction: string;
}
const capturedCrypto = (source: Source, capture: Program['body'][number] | undefined): string | undefined => {
  if (capture?.type !== 'VariableDeclaration' || capture.kind !== 'const' || capture.declarations.length !== 1) {
    return undefined;
  }
  const [captured] = capture.declarations;
  const crypto = native(source, 'Crypto', 'effect');
  const cryptoName = identifier(captured?.id);
  return captured?.init !== undefined &&
    captured.init !== null &&
    crypto !== undefined &&
    cryptoName !== undefined &&
    exact(source, captured.init, `yield* ${crypto}.Crypto`)
    ? cryptoName
    : undefined;
};
const factoryBody = (source: Source, maker: ArrowFunctionExpression): FactoryBody | undefined => {
  if (maker.body.type === 'BlockStatement') {
    return undefined;
  }
  const generator = effectGenerator(source, maker.body);
  if (generator?.params.length !== 2 || generator.body === null) {
    return undefined;
  }
  const [transaction, scope] = generator.params.map(identifier);
  const [capture, result, ...extra] = generator.body.body;
  const cryptoName = capturedCrypto(source, capture);
  const returned = result?.type === 'ReturnStatement' ? result.argument : undefined;
  return transaction === undefined ||
    scope === undefined ||
    cryptoName === undefined ||
    extra.length !== 0 ||
    returned?.type !== 'CallExpression'
    ? undefined
    : { cryptoName, returned, scope, transaction };
};

interface FactoryComposition {
  readonly adapter: Original;
  readonly adapterName: string;
  readonly compose: Original;
  readonly composeName: string;
  readonly key: string;
  readonly keySource: string;
}
const factoryComposition = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  returned: CallExpression,
): FactoryComposition | undefined => {
  const adapterName = identifier(returned.callee);
  if (returned.arguments.length !== 3 || adapterName === undefined) {
    return undefined;
  }
  const composed = returned.arguments.at(2);
  if (composed?.type !== 'CallExpression' || composed.arguments.length !== 1) {
    return undefined;
  }
  const composeName = identifier(composed.callee);
  const [configured] = composed.arguments;
  if (composeName === undefined || configured?.type !== 'CallExpression' || configured.arguments.length !== 3) {
    return undefined;
  }
  const adapter = original(owner, source, adapterName);
  const compose = original(owner, source, composeName);
  const requirement = configured.arguments.at(2);
  const key = literalText(requirement);
  return adapter === undefined || compose === undefined || key === undefined
    ? undefined
    : {
        adapter,
        adapterName,
        compose,
        composeName,
        key,
        keySource: requirement === undefined ? '' : textOf(source, requirement),
      };
};

const missingExternalContract = (source: Source, value: Expression): boolean => {
  if (
    value?.type !== 'ArrowFunctionExpression' ||
    value.async ||
    value.params.length !== 0 ||
    value.body.type !== 'CallExpression'
  ) {
    return false;
  }
  const binding = identifier(value.body.callee);
  if (
    binding === undefined ||
    value.body.arguments.length !== 1 ||
    literalText(value.body.arguments[0]) === undefined
  ) {
    return false;
  }
  const helper = constant(source, binding);
  const effect = native(source, 'Effect', 'effect');
  if (
    helper?.type !== 'ArrowFunctionExpression' ||
    helper.async ||
    helper.params.length !== 1 ||
    effect === undefined ||
    helper.body.type === 'BlockStatement'
  ) {
    return false;
  }
  const [dependency] = helper.params.map(identifier);
  return (
    dependency !== undefined &&
    exact(source, helper.body, `${effect}.fail(unavailable(${dependency}))`) &&
    stable(source, new Map([[binding, 1]]), [binding])
  );
};

const composeContract = (target: Original): boolean => {
  if (target.value.type !== 'ArrowFunctionExpression' || target.value.params.length !== 1) {
    return false;
  }
  const [configured] = target.value.params.map(identifier);
  const body = target.value.body.type === 'BlockStatement' ? target.value.body : unparenthesized(target.value.body);
  if (configured === undefined || body?.type !== 'ObjectExpression' || body.properties.length !== 2) {
    return false;
  }
  const [defaults, override] = body.properties;
  const defaultsName = defaults?.type === 'SpreadElement' ? identifier(defaults.argument) : undefined;
  if (
    defaultsName === undefined ||
    override?.type !== 'SpreadElement' ||
    identifier(override.argument) !== configured
  ) {
    return false;
  }
  const fallback = properties(constant(target.source, defaultsName));
  return (
    fallback !== undefined &&
    fallback.size > 0 &&
    [...fallback.values()].every((value) => missingExternalContract(target.source, value)) &&
    stable(target.source, new Map([[defaultsName, 1]]))
  );
};

const adapterTypes = (
  owner: ConfiguredReadPhaseOwner,
  adapter: Original,
  resolver: Original,
  portsType: string | undefined,
): boolean => {
  if (adapter.value.type !== 'ArrowFunctionExpression' || portsType === undefined) {
    return false;
  }
  const [, scope] = adapter.value.params;
  const scopeType = native(adapter.source, 'OperationalScope', CORE_RUNTIME, true);
  const { returnType } = adapter.value;
  const namedType =
    returnType === undefined || returnType === null
      ? undefined
      : textOf(adapter.source, returnType).replace(/^:\s*/u, '');
  if (scopeType === undefined || namedType === undefined || parameterType(adapter.source, scope) !== scopeType) {
    return false;
  }
  const expected = originalType(owner, resolver.source, portsType);
  const actual = originalType(owner, adapter.source, namedType);
  return expected !== undefined && actual?.file === expected.file && actual.name === expected.name;
};

const adapterSavedAddress = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  value: ArrowFunctionExpression,
  transaction: string,
  scope: string,
): boolean => {
  const effect = native(source, 'Effect', 'effect');
  const option = native(source, 'Option', 'effect');
  const found = imports(source).find((item) => item.imported === 'found')?.local;
  const notFound = imports(source).find((item) => item.imported === 'notFound')?.local;
  const savedAddress = imports(source).find((item) => item.imported === 'SavedAddress')?.local;
  if (
    effect === undefined ||
    option === undefined ||
    found === undefined ||
    notFound === undefined ||
    savedAddress === undefined ||
    value.body.type === 'BlockStatement'
  ) {
    return failed(owner, 'original saved-address imports');
  }
  return exact(
    source,
    value,
    `({ profile, resourceId }) =>
    invokeDetail(${transaction}, ${scope}, profile, resourceId).pipe(
      ${effect}.flatMap(([row]) =>
        row?.outcome === 'FOUND' && ${option}.contains(row.lifecycle, 'ACTIVE')
          ? addressFromRow(profile, row).pipe(${effect}.map(${found}))
          : ${effect}.succeed(${notFound}<${savedAddress}>()),
      ),
    )`,
  );
};

const defaultAddressSelection = (source: Source, value: ArrowFunctionExpression) => {
  const code = textOf(source, value);
  const field = /\bdefaults\.(?<field>[a-z_]+)\s*,/u.exec(code)?.groups?.field;
  const tokens = tokenizeGovernedClient(code);
  const reason = tokens.findLast((token) => token.kind === SyntaxKind.StringLiteral)?.value;
  return field === undefined || reason === undefined ? undefined : { field, reason };
};

const adapterDefaultAddress = (
  source: Source,
  value: ArrowFunctionExpression,
  transaction: string,
  scope: string,
): boolean => {
  const selection = defaultAddressSelection(source, value);
  const effect = native(source, 'Effect', 'effect');
  if (selection === undefined || effect === undefined) {
    return false;
  }
  const reasonToken = tokenizeGovernedClient(textOf(source, value)).findLast(
    (token) => token.kind === SyntaxKind.StringLiteral,
  );
  if (reasonToken === undefined || value.body.type === 'BlockStatement') {
    return false;
  }
  const expected = `(profile) => invokeDefaults(${transaction}, ${scope}, profile).pipe(
    ${effect}.flatMap(([defaults]) => {
      if (defaults === undefined || defaults.outcome !== 'PRESENT') {
        return ${effect}.fail(unavailable('commerce.customer-context.address-profile'));
      }
      return loadDefaultAddress(${transaction}, ${scope}, profile, defaults.${selection.field}, '${selection.reason}');
    }),
  )`;
  return exact(source, value, expected);
};

const adapterMember = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  key: string,
  value: Expression,
  transaction: string,
  scope: string,
  external: string,
): boolean => {
  if (value.type === 'MemberExpression') {
    return !value.computed && !value.optional && identifier(value.object) === external;
  }
  if (value?.type !== 'ArrowFunctionExpression' || value.async || value.params.length !== 1) {
    return false;
  }
  if (key === 'loadSavedAddress') {
    return adapterSavedAddress(owner, source, value, transaction, scope);
  }
  if (/^loadDefault[A-Z]\w*Address$/u.test(key)) {
    return adapterDefaultAddress(source, value, transaction, scope);
  }
  const [parameter] = value.params.map(identifier);
  return (
    key === 'resolvePostalAddress' &&
    parameter !== undefined &&
    exact(source, value, `(${parameter}) => resolvePostalAddress(${parameter}, ${external})`)
  );
};

const adapterMembers = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  value: ArrowFunctionExpression,
  external: string,
): boolean => {
  if (value.body.type === 'BlockStatement') {
    return false;
  }
  const [transaction, scope] = value.params.map(identifier);
  const fields = properties(value.body);
  return (
    transaction !== undefined &&
    scope !== undefined &&
    fields !== undefined &&
    fields.size > 0 &&
    [...fields].every(
      ([key, expression]) =>
        adapterMember(owner, source, key, expression, transaction, scope, external) ||
        failed(owner, `original adapter member ${key}`),
    ) &&
    stable(
      source,
      new Map([
        ['invokeDetail', 1],
        ['invokeDefaults', 1],
        ['loadDefaultAddress', 1],
        ['addressFromRow', 1],
        ['resolvePostalAddress', 1],
      ]),
    )
  );
};

const adapterContract = (
  owner: ConfiguredReadPhaseOwner,
  adapter: Original,
  resolver: Original,
  portsType: string | undefined,
): boolean => {
  if (
    adapter.value.type !== 'ArrowFunctionExpression' ||
    adapter.value.params.length !== 3 ||
    !adapterTypes(owner, adapter, resolver, portsType) ||
    adapter.value.body.type === 'BlockStatement'
  ) {
    return false;
  }
  const external = adapter.value.params.at(2);
  const externalName = external?.type === 'AssignmentPattern' ? identifier(external.left) : undefined;
  const fields = properties(adapter.value.body);
  const load = fields?.get('loadCurrent');
  return (
    externalName !== undefined &&
    load?.type === 'MemberExpression' &&
    !load.computed &&
    identifier(load.object) === externalName &&
    load.property.type === 'Identifier' &&
    /^load[A-Z]\w*Current$/u.test(load.property.name) &&
    adapterMembers(owner, adapter.source, adapter.value, externalName) &&
    stable(adapter.source, new Map([[adapter.name, 1]]), [adapter.name])
  );
};

const factoryAnnotation = (selected: SelectedMaker, adapter: string): boolean => {
  const { exported, maker } = selected;
  const { returnType } = maker;
  const serviceFactory = native(exported.source, 'ReadServiceFactory', CORE_RUNTIME, true);
  const crypto = native(exported.source, 'Crypto', 'effect');
  if (returnType === undefined || returnType === null || serviceFactory === undefined || crypto === undefined) {
    return false;
  }
  const match = /:\s*[\w$]+<(?<services>[\w$]+),\s*[\w$]+\.Crypto>$/u.exec(textOf(exported.source, returnType))?.groups
    ?.services;
  const services = match === undefined ? undefined : typeAlias(exported.source, match);
  return (
    services !== undefined &&
    exact(exported.source, returnType, `: ${serviceFactory}<${match}, ${crypto}.Crypto>`) &&
    exact(exported.source, services.typeAnnotation, `ReturnType<typeof ${adapter}>`) &&
    stable(exported.source, new Map([['ReturnType', 0]]))
  );
};

const ownerRequirements = (source: Source): readonly Expression[] => {
  const defineManifest = native(source, 'defineOntosModuleManifest', CORE_RUNTIME);
  if (defineManifest === undefined) {
    return [];
  }
  return declarations(source, true).flatMap((declaration) => {
    const invocation = call(declaration.init ?? undefined, defineManifest, 1);
    const [manifest] = invocation?.arguments ?? [];
    if (manifest === undefined || manifest.type === 'SpreadElement') {
      return [];
    }
    const requirements = properties(properties(manifest)?.get('requirements'));
    const operations = requirements?.get('operations');
    if (
      operations?.type !== 'ArrayExpression' ||
      operations.elements.some((element) => element === null || element.type === 'SpreadElement')
    ) {
      return [];
    }
    return operations.elements.flatMap((element) =>
      element === null || element.type === 'SpreadElement' ? [] : [element],
    );
  });
};

const declaredRequirement = (owner: ConfiguredReadPhaseOwner, read: Source, factory: string, key: string): boolean => {
  const defineRead = native(read, 'defineRead', CORE_RUNTIME);
  if (defineRead === undefined) {
    return false;
  }
  const registrations = declarations(read, true).filter((declaration) => {
    const invocation = call(declaration.init ?? undefined, defineRead, 3);
    const dependency = invocation?.arguments.at(2);
    return dependency?.type === 'Identifier' && dependency.name === factory;
  });
  const [registration] = registrations;
  if (registrations.length !== 1 || registration?.id.type !== 'Identifier') {
    return false;
  }
  const registeredName = registration.id.name;
  let claims = 0;
  const manifests = [...owner.sources].filter(
    ([file, text]) => file.startsWith(`${owner.ownerPath}/`) && text.includes('defineOntosModuleManifest'),
  );
  for (const [file, text] of manifests) {
    const source = parse(file, text);
    if (source === undefined) {
      return false;
    }
    const imported = imports(source).find(
      (item) =>
        item.imported === registeredName &&
        path.posix.normalize(path.posix.join(path.posix.dirname(file), item.module)) === read.file,
    );
    if (imported === undefined) {
      continue;
    }
    claims += ownerRequirements(source).filter((requirement) => {
      const fields = properties(requirement);
      const entrypoint = fields?.get('entrypointKey');
      return (
        literalText(fields?.get('key')) === key &&
        entrypoint !== undefined &&
        exact(source, entrypoint, `${imported.local}.descriptor.entrypoint.entrypointKey`)
      );
    }).length;
  }
  return claims === 1;
};

const serviceFactory = (
  owner: ConfiguredReadPhaseOwner,
  source: Source,
  binding: string,
  resolver: Original,
  portsType: string | undefined,
): boolean => {
  const selected = selectedMaker(owner, source, binding);
  if (selected === undefined) {
    return failed(owner, 'original zero-argument factory');
  }
  const { dependency, exported, maker, name, parameter } = selected;
  if (!defaultDependency(owner, exported.source, dependency)) {
    return failed(owner, 'original default dependency');
  }
  const body = factoryBody(exported.source, maker);
  if (body === undefined) {
    return failed(owner, 'original factory body');
  }
  const composition = factoryComposition(owner, exported.source, body.returned);
  if (composition === undefined) {
    return failed(owner, 'original factory composition');
  }
  const { adapter, adapterName, compose, composeName, key, keySource } = composition;
  return checked(owner, {
    adapter: adapterContract(owner, adapter, resolver, portsType),
    annotation: factoryAnnotation(selected, adapterName),
    binding: stable(exported.source, new Map([[name, 1]]), [name]),
    composition: composeContract(compose),
    invocation: exact(
      exported.source,
      body.returned,
      `${adapterName}(${body.transaction}, ${body.scope},
      ${composeName}(${parameter}(${body.scope}, ${body.cryptoName}, ${keySource})))`,
    ),
    requirement: declaredRequirement(owner, source, binding, key),
    scope: stableMaker(exported.source, maker, parameter),
  });
};

/** A closed native configured-handler family, not permission to accept arbitrary owner factories. */
export const hasOriginalConfiguredReadPhase = (
  owner: ConfiguredReadPhaseOwner,
  source: string,
  phaseSource: string,
): boolean => {
  const unit = owner.sources.get(owner.readFile) === source ? parse(owner.readFile, source) : undefined;
  const configured = unit === undefined ? undefined : configuredHandler(owner, unit, phaseSource);
  const factory = unit === undefined ? undefined : readFactoryBinding(unit, phaseSource);
  const valid =
    unit !== undefined &&
    configured !== undefined &&
    factory !== undefined &&
    serviceFactory(owner, unit, factory, configured.resolve, configured.portsType);
  if (!valid) {
    owner.diagnostics?.push(
      `${owner.readFile}: configured Read provenance is not original (${configured === undefined ? 'handler' : 'factory'}, ${factory ?? 'missing factory'})`,
    );
  }
  return valid;
};
