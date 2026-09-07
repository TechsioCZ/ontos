import {
  isAsExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSpreadAssignment,
  isStringLiteralLikeNode,
  isVariableStatement,
  NodeFlags,
  SyntaxKind,
} from '@typescript/native/unstable/ast';
import type {
  CallExpression,
  Expression,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
  VariableDeclaration,
} from '@typescript/native/unstable/ast';
import { API as TypeScriptApi } from '@typescript/native/unstable/sync';

const camelCaseStem = (stem: string): string =>
  stem.replaceAll(/-(?<letter>[a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());

const pascalCaseStem = (stem: string): string => {
  const camelStem = camelCaseStem(stem);
  return `${camelStem.slice(0, 1).toUpperCase()}${camelStem.slice(1)}`;
};

const identifierName = (node: Node | undefined): string | undefined =>
  node !== undefined && isIdentifier(node) ? node.text : undefined;

const propertyName = (node: Node | undefined): string | undefined => {
  if (
    node !== undefined &&
    (isIdentifier(node) || isStringLiteralLikeNode(node) || isNumericLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
};

const accessPath = (node: Expression): readonly string[] | undefined => {
  if (isIdentifier(node)) {
    return [node.text];
  }
  if (isPropertyAccessExpression(node)) {
    const parent = accessPath(node.expression);
    return parent === undefined ? undefined : [...parent, node.name.text];
  }
  return undefined;
};

const isAccessPath = (node: Expression, expected: readonly string[]): boolean =>
  accessPath(node)?.join('.') === expected.join('.');

const unwrapExpression = (expression: Expression): Expression => {
  let current = expression;
  while (
    isAsExpression(current) ||
    isParenthesizedExpression(current) ||
    isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const stringLiteral = (expression: Expression | undefined): string | undefined => {
  if (expression === undefined) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  return isStringLiteralLikeNode(unwrapped) ? unwrapped.text : undefined;
};

const numericLiteral = (expression: Expression | undefined): number | undefined => {
  if (expression === undefined) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  return isNumericLiteral(unwrapped) ? Number(unwrapped.text) : undefined;
};

const callExpression = (
  expression: Expression | undefined,
  callee: readonly string[],
): CallExpression | undefined => {
  if (expression === undefined) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  return isCallExpression(unwrapped) && isAccessPath(unwrapped.expression, callee)
    ? unwrapped
    : undefined;
};

const exportedConst = (sourceFile: SourceFile, name: string): VariableDeclaration | undefined => {
  for (const statement of sourceFile.statements) {
    if (
      !isVariableStatement(statement) ||
      !(
        statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
      ) ||
      statement.declarationList.flags !== NodeFlags.Const
    ) {
      continue;
    }
    const declarations = statement.declarationList.declarations.filter(
      (declaration) => identifierName(declaration.name) === name,
    );
    if (declarations.length === 1) {
      return declarations[0];
    }
  }
  return undefined;
};

const localConst = (sourceFile: SourceFile, name: string): VariableDeclaration | undefined => {
  for (const statement of sourceFile.statements) {
    if (!isVariableStatement(statement) || statement.declarationList.flags !== NodeFlags.Const) {
      continue;
    }
    const declarations = statement.declarationList.declarations.filter(
      (declaration) => identifierName(declaration.name) === name,
    );
    if (declarations.length === 1) {
      return declarations[0];
    }
  }
  return undefined;
};

const objectLiteral = (expression: Expression | undefined): ObjectLiteralExpression | undefined => {
  if (expression === undefined) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  return isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
};

const propertyAssignments = (
  properties: readonly ObjectLiteralElementLike[],
): ReadonlyMap<string, PropertyAssignment> | undefined => {
  const assignments = new Map<string, PropertyAssignment>();
  for (const property of properties) {
    if (!isPropertyAssignment(property)) {
      return undefined;
    }
    const name = propertyName(property.name);
    if (name === undefined || assignments.has(name)) {
      return undefined;
    }
    assignments.set(name, property);
  }
  return assignments;
};

interface SharedSchemaObject {
  readonly assignments: ReadonlyMap<string, PropertyAssignment>;
  readonly identity: boolean;
}

const sharedSchemaObject = (
  declaration: VariableDeclaration | undefined,
  sharedSchemaName: string,
  protectedFields: readonly string[],
): SharedSchemaObject | undefined => {
  if (declaration?.initializer === undefined) {
    return undefined;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (isIdentifier(initializer) && initializer.text === sharedSchemaName) {
    return { assignments: new Map(), identity: true };
  }
  const struct = callExpression(initializer, ['Schema', 'Struct']);
  const schemaObject = objectLiteral(struct?.arguments[0]);
  if (struct?.arguments.length !== 1 || schemaObject === undefined) {
    return undefined;
  }
  const sharedSpreads = schemaObject.properties.filter(
    (property) =>
      isSpreadAssignment(property) &&
      isAccessPath(property.expression, [sharedSchemaName, 'fields']),
  );
  const nonSpreadProperties = schemaObject.properties.filter(
    (property) => !isSpreadAssignment(property),
  );
  const assignments = propertyAssignments(nonSpreadProperties);
  if (
    sharedSpreads.length !== 1 ||
    schemaObject.properties.some(
      (property) => isSpreadAssignment(property) && property !== sharedSpreads[0],
    ) ||
    assignments === undefined ||
    protectedFields.some((field) => assignments.has(field))
  ) {
    return undefined;
  }
  return { assignments, identity: false };
};

interface DirectCallChain {
  readonly base: CallExpression;
  readonly methods: readonly {
    readonly arguments: readonly Expression[];
    readonly name: string;
  }[];
}

const directCallChain = (expression: Expression | undefined): DirectCallChain | undefined => {
  if (expression === undefined) {
    return undefined;
  }
  let current = unwrapExpression(expression);
  const methods: { readonly arguments: readonly Expression[]; readonly name: string }[] = [];
  while (
    isCallExpression(current) &&
    isPropertyAccessExpression(current.expression) &&
    !isIdentifier(current.expression.expression)
  ) {
    methods.unshift({ arguments: current.arguments, name: current.expression.name.text });
    current = unwrapExpression(current.expression.expression);
  }
  if (!isCallExpression(current)) {
    return undefined;
  }
  return { base: current, methods };
};

const exactCall = (
  expression: Expression | undefined,
  callee: readonly string[],
  argumentCount: number,
): CallExpression | undefined => {
  const call = callExpression(expression, callee);
  return call?.arguments.length === argumentCount ? call : undefined;
};

const brandedStringSchemaIsExact = (
  declaration: VariableDeclaration | undefined,
  brand: string,
): boolean => {
  const initializer = declaration?.initializer;
  if (initializer === undefined) {
    return false;
  }
  const pipeCall = unwrapExpression(initializer);
  if (
    !isCallExpression(pipeCall) ||
    !isPropertyAccessExpression(pipeCall.expression) ||
    pipeCall.expression.name.text !== 'pipe' ||
    !isAccessPath(pipeCall.expression.expression, ['Schema', 'String']) ||
    pipeCall.arguments.length !== 1
  ) {
    return false;
  }
  const brandCall = exactCall(pipeCall.arguments[0], ['Schema', 'brand'], 1);
  return stringLiteral(brandCall?.arguments[0]) === brand;
};

const importsExactBindings = (
  sourceFile: SourceFile,
  expectedPackage: string,
  expectedBindings: readonly string[],
): boolean => {
  const required = new Set(expectedBindings);
  for (const statement of sourceFile.statements) {
    if (
      !isImportDeclaration(statement) ||
      stringLiteral(statement.moduleSpecifier) !== expectedPackage ||
      statement.importClause?.getText().trimStart().startsWith('type ') === true ||
      statement.importClause?.namedBindings === undefined ||
      !isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (
        !element.isTypeOnly &&
        element.propertyName === undefined &&
        required.has(element.name.text)
      ) {
        required.delete(element.name.text);
      }
    }
  }
  return required.size === 0;
};

const importsSharedBaselinePrimitives = (
  sourceFile: SourceFile,
  expectedPackage: string,
): boolean =>
  importsExactBindings(sourceFile, expectedPackage, [
    'MicroVerticalBuildMarkerSchema',
    'MicroVerticalReadinessSchema',
    'createMicroVerticalOperationContext',
  ]);

// oxlint-disable-next-line complexity -- The AST shape is intentionally validated fail-closed in one expression. expires: 2026-12-31.
const foundationIsExact = (
  declaration: VariableDeclaration | undefined,
  stem: string,
  readinessSchemaName: string,
): boolean => {
  const chain = directCallChain(declaration?.initializer);
  const expectedApiNames = new Set([
    `${pascalCaseStem(stem)}FoundationApi`,
    `${pascalCaseStem(stem)}ApiFoundation`,
  ]);
  if (
    chain === undefined ||
    !isAccessPath(chain.base.expression, ['HttpApi', 'make']) ||
    chain.base.arguments.length !== 1 ||
    !expectedApiNames.has(stringLiteral(chain.base.arguments[0]) ?? '') ||
    chain.methods.length !== 1 ||
    chain.methods[0]?.name !== 'add' ||
    chain.methods[0].arguments.length !== 1
  ) {
    return false;
  }
  const groupChain = directCallChain(chain.methods[0].arguments[0]);
  if (
    groupChain === undefined ||
    !isAccessPath(groupChain.base.expression, ['HttpApiGroup', 'make']) ||
    groupChain.base.arguments.length !== 1 ||
    stringLiteral(groupChain.base.arguments[0]) !== 'foundation' ||
    groupChain.methods.length !== 1 ||
    groupChain.methods[0]?.name !== 'add' ||
    groupChain.methods[0].arguments.length !== 1
  ) {
    return false;
  }
  const endpoint = exactCall(groupChain.methods[0].arguments[0], ['HttpApiEndpoint', 'get'], 3);
  const endpointOptions = objectLiteral(endpoint?.arguments[2]);
  const endpointProperties =
    endpointOptions === undefined ? undefined : propertyAssignments(endpointOptions.properties);
  return (
    endpoint !== undefined &&
    stringLiteral(endpoint.arguments[0]) === 'readiness' &&
    stringLiteral(endpoint.arguments[1]) === `/${stem}/readiness` &&
    endpointProperties?.size === 1 &&
    identifierName(endpointProperties.get('success')?.initializer) === readinessSchemaName
  );
};

const rootComposesFoundation = (
  declaration: VariableDeclaration | undefined,
  stem: string,
  foundationName: string,
): boolean => {
  const chain = directCallChain(declaration?.initializer);
  const first = chain?.methods[0];
  return (
    chain !== undefined &&
    isAccessPath(chain.base.expression, ['HttpApi', 'make']) &&
    chain.base.arguments.length === 1 &&
    stringLiteral(chain.base.arguments[0]) === `${pascalCaseStem(stem)}Api` &&
    chain.methods.length > 0 &&
    chain.methods.every(
      (method) =>
        (method.name === 'add' || method.name === 'addHttpApi') && method.arguments.length === 1,
    ) &&
    first?.name === 'addHttpApi' &&
    identifierName(first.arguments[0]) === foundationName
  );
};

// oxlint-disable-next-line complexity -- One fail-closed predicate ties each generated operation identity to its method and route. expires: 2026-12-31.
const operationContextIsConstructed = (
  property: PropertyAssignment,
  stem: string,
  propertyKey: string,
): boolean => {
  const constructorCall = exactCall(
    property.initializer,
    ['createMicroVerticalOperationContext'],
    1,
  );
  const input = objectLiteral(constructorCall?.arguments[0]);
  const fields = input === undefined ? undefined : propertyAssignments(input.properties);
  const method = stringLiteral(fields?.get('method')?.initializer);
  const operationId = stringLiteral(fields?.get('operationId')?.initializer);
  const routePath = stringLiteral(fields?.get('routePath')?.initializer);
  if (
    fields?.size !== 3 ||
    method === undefined ||
    operationId === undefined ||
    routePath === undefined ||
    !/^[A-Z]+$/u.test(method) ||
    !/^\/(?!.*(?:^|\/)\.\.?\/)[^\s?#]*$/u.test(routePath)
  ) {
    return false;
  }
  const apiName = `${pascalCaseStem(stem)}Api`;
  if (propertyKey !== 'readiness') {
    const generatedOperation = new Map([
      ['addCartItem', { method: 'POST', routePath: `/${stem}/cart/items` }],
      ['clearCart', { method: 'POST', routePath: `/${stem}/cart/clear` }],
      ['create', { method: 'POST', routePath: `/${stem}` }],
      ['get', { method: 'GET', routePath: `/${stem}/:id` }],
      ['getCart', { method: 'GET', routePath: `/${stem}/cart` }],
      ['list', { method: 'GET', routePath: `/${stem}` }],
      ['removeCartItem', { method: 'POST', routePath: `/${stem}/cart/remove` }],
    ]).get(propertyKey);
    return (
      operationId === `${apiName}:${routePath}` ||
      (operationId === `${apiName}:${camelCaseStem(stem)}:${propertyKey}` &&
        generatedOperation?.method === method &&
        generatedOperation.routePath === routePath)
    );
  }
  return (
    method === 'GET' &&
    routePath === `/${stem}/readiness` &&
    (operationId === `${apiName}:/${stem}/readiness` ||
      operationId === `${apiName}:${camelCaseStem(stem)}:readiness`)
  );
};

const operationMapIsConnected = (
  declaration: VariableDeclaration | undefined,
  stem: string,
): boolean => {
  const map = objectLiteral(declaration?.initializer);
  const properties = map === undefined ? undefined : propertyAssignments(map.properties);
  return (
    properties !== undefined &&
    properties.has('readiness') &&
    [...properties].every(([key, property]) => operationContextIsConstructed(property, stem, key))
  );
};

const constAssertionObject = (
  declaration: VariableDeclaration | undefined,
): ObjectLiteralExpression | undefined => {
  const initializer = declaration?.initializer;
  if (
    initializer === undefined ||
    !isAsExpression(initializer) ||
    initializer.type.getText() !== 'const'
  ) {
    return undefined;
  }
  return objectLiteral(initializer.expression);
};

const metadataIsExact = (
  declaration: VariableDeclaration | undefined,
  expectation: MicroVerticalApiBaselineExpectation,
): boolean => {
  const object = constAssertionObject(declaration);
  const fields = object === undefined ? undefined : propertyAssignments(object.properties);
  const expectedFields = new Map([
    ['apiPrefix', expectation.apiPrefix],
    ['basePath', expectation.basePath],
    ['ownerId', expectation.ownerId],
    ['readinessPath', expectation.readinessPath],
    ...Object.entries(expectation.additionalPaths),
  ]);
  if (
    fields === undefined ||
    fields.size !== expectedFields.size ||
    [...expectedFields].some(
      ([field, value]) => stringLiteral(fields.get(field)?.initializer) !== value,
    )
  ) {
    return false;
  }
  return (
    stringLiteral(fields.get('apiPrefix')?.initializer) === expectation.apiPrefix &&
    stringLiteral(fields.get('basePath')?.initializer) === expectation.basePath &&
    stringLiteral(fields.get('ownerId')?.initializer) === expectation.ownerId &&
    stringLiteral(fields.get('readinessPath')?.initializer) === expectation.readinessPath
  );
};

const markerSchemaIsShared = (
  sourceFile: SourceFile,
  declaration: VariableDeclaration | undefined,
): boolean => {
  const schema = sharedSchemaObject(declaration, 'MicroVerticalBuildMarkerSchema', [
    'build',
    'buildMarker',
    'deployProfile',
    'packageName',
    'sourceRevision',
    'surface',
    'version',
  ]);
  if (schema === undefined || schema.identity) {
    return schema?.identity === true;
  }
  if (
    [...schema.assignments.keys()].some(
      (field) => !['appId', 'kind', 'schemaVersion', 'unitId'].includes(field),
    ) ||
    (schema.assignments.has('appId') &&
      (identifierName(schema.assignments.get('appId')?.initializer) !== 'AppIdSchema' ||
        !brandedStringSchemaIsExact(localConst(sourceFile, 'AppIdSchema'), 'AppId'))) ||
    (schema.assignments.has('unitId') &&
      (identifierName(schema.assignments.get('unitId')?.initializer) !== 'UnitIdSchema' ||
        !brandedStringSchemaIsExact(localConst(sourceFile, 'UnitIdSchema'), 'UnitId')))
  ) {
    return false;
  }
  const kind = exactCall(schema.assignments.get('kind')?.initializer, ['Schema', 'Literal'], 1);
  const schemaVersion = exactCall(
    schema.assignments.get('schemaVersion')?.initializer,
    ['Schema', 'Literal'],
    1,
  );
  return (
    (!schema.assignments.has('kind') ||
      stringLiteral(kind?.arguments[0]) === 'microvertical-delivery-unit') &&
    (!schema.assignments.has('schemaVersion') || numericLiteral(schemaVersion?.arguments[0]) === 1)
  );
};

const readinessSchemaIsShared = (
  declaration: VariableDeclaration | undefined,
  markerSchemaName: string,
  ownerMarkerIsIdentity: boolean,
): boolean => {
  const schema = sharedSchemaObject(declaration, 'MicroVerticalReadinessSchema', [
    'checks',
    'status',
    'versionSkew',
  ]);
  return (
    schema !== undefined &&
    ((schema.identity && ownerMarkerIsIdentity) ||
      (schema.assignments.size === 1 &&
        identifierName(schema.assignments.get('marker')?.initializer) === markerSchemaName))
  );
};

const declarationIsIdentifier = (
  declaration: VariableDeclaration | undefined,
  identifier: string,
): boolean =>
  declaration?.initializer !== undefined &&
  identifierName(unwrapExpression(declaration.initializer)) === identifier;

const validateParsedContract = (
  sourceFile: SourceFile,
  stem: string,
  expectation: MicroVerticalApiBaselineExpectation,
): string | undefined => {
  const exportStem = camelCaseStem(stem);
  const foundationName = `${exportStem}FoundationApi`;
  const markerSchemaName = `${exportStem}MarkerSchema`;
  const readinessSchemaName = `${exportStem}ReadinessSchema`;
  const markerDeclaration = exportedConst(sourceFile, markerSchemaName);
  if (
    !importsExactBindings(sourceFile, expectation.effectClientPackage, [
      'HttpApi',
      'HttpApiEndpoint',
      'HttpApiGroup',
      'Schema',
    ])
  ) {
    return 'MicroVertical root contract must import exact Effect API primitives from the framework client package';
  }
  if (!importsSharedBaselinePrimitives(sourceFile, expectation.sharedContractsPackage)) {
    return 'MicroVertical root contract must import exact baseline primitives from the shared contracts package';
  }
  if (!markerSchemaIsShared(sourceFile, markerDeclaration)) {
    return 'MicroVertical root contract must consume the shared build marker schema without overriding shared fields';
  }
  if (
    !readinessSchemaIsShared(
      exportedConst(sourceFile, readinessSchemaName),
      markerSchemaName,
      declarationIsIdentifier(markerDeclaration, 'MicroVerticalBuildMarkerSchema'),
    )
  ) {
    return 'MicroVertical readiness schema must consume the shared readiness schema without overriding shared fields';
  }
  if (!foundationIsExact(exportedConst(sourceFile, foundationName), stem, readinessSchemaName)) {
    return 'MicroVertical readiness foundation API must directly compose its exact readiness endpoint and foundation identity';
  }
  if (
    !rootComposesFoundation(exportedConst(sourceFile, `${exportStem}Api`), stem, foundationName)
  ) {
    return 'MicroVertical root API must explicitly compose its readiness foundation API';
  }
  if (!operationMapIsConnected(exportedConst(sourceFile, `${exportStem}OperationContexts`), stem)) {
    return 'MicroVertical operation map must construct every operation with the shared context constructor';
  }
  if (!metadataIsExact(exportedConst(sourceFile, `${exportStem}ApiContract`), expectation)) {
    return 'MicroVertical root contract must keep exact owner and API path metadata without forbidden fields';
  }
  return undefined;
};

const parseAndValidate = (
  stem: string,
  filePath: string,
  expectation: MicroVerticalApiBaselineExpectation,
): string | undefined => {
  const compiler = new TypeScriptApi();
  try {
    const snapshot = compiler.updateSnapshot({ openFiles: [filePath] });
    const project = snapshot.getDefaultProjectForFile(filePath);
    const sourceFile = project?.program.getSourceFile(filePath);
    if (
      sourceFile === undefined ||
      (project?.program.getSyntacticDiagnostics(filePath).length ?? 1) > 0 ||
      (project?.program.getBindDiagnostics(filePath).length ?? 1) > 0
    ) {
      return 'MicroVertical root contract must be valid TypeScript syntax';
    }
    return validateParsedContract(sourceFile, stem, expectation);
  } finally {
    compiler.close();
  }
};

export interface MicroVerticalApiBaselineExpectation {
  readonly additionalPaths: Readonly<Record<string, string>>;
  readonly apiPrefix: string;
  readonly basePath: string;
  readonly effectClientPackage: string;
  readonly ownerId: string;
  readonly readinessPath: string;
  readonly sharedContractsPackage: string;
}

export interface MicroVerticalTopologyEntry {
  readonly api?: { readonly readiness?: { readonly endpoint?: string } };
  readonly id: string;
  readonly path?: string;
}

export const configuredMicroVerticalApiStem = (
  verticalPath: string,
  verticals: readonly MicroVerticalTopologyEntry[],
): string | undefined => {
  const topologyVertical = verticals.find(
    (vertical) => (vertical.path ?? `verticals/${vertical.id}`) === verticalPath,
  );
  const endpoint = topologyVertical?.api?.readiness?.endpoint;
  return endpoint?.match(/^\/(?<stem>[a-z0-9]+(?:-[a-z0-9]+)*)\/readiness$/u)?.groups?.stem;
};

export const microVerticalApiBaselineViolation = (
  stem: string,
  filePath: string,
  expectation?: MicroVerticalApiBaselineExpectation,
): string | undefined =>
  parseAndValidate(
    stem,
    filePath,
    expectation ?? {
      additionalPaths: {},
      apiPrefix: `/${stem}-api`,
      basePath: `/${stem}-api/${stem}`,
      effectClientPackage: '@modern-js/plugin-bff/effect-client',
      ownerId: stem,
      readinessPath: `/${stem}-api/${stem}/readiness`,
      sharedContractsPackage: '@app/shared-contracts',
    },
  );
