import { Array as EffectArray, Effect, FileSystem, Option, Schema } from 'effect';
import { SyntaxKind } from '@typescript/native/unstable/ast';
import {
  GOVERNED_HTTP_API_ADDITION_SLOT_END,
  GOVERNED_HTTP_API_ADDITION_SLOT_START,
  GOVERNED_HTTP_API_IMPORT_SLOT_END,
  GOVERNED_HTTP_API_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_COMPONENT_SLOT_END,
  MODULE_REGISTRATION_COMPONENT_SLOT_START,
  MODULE_REGISTRATION_REPORT_SLOT_END,
  MODULE_REGISTRATION_REPORT_SLOT_START,
  MODULE_REGISTRATION_SEARCH_SLOT_END,
  MODULE_REGISTRATION_SEARCH_SLOT_START,
  createOrAcceptGeneratedMutationEffect,
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  generatedSlotContainsExactEntry,
  insertSortedSlot,
  insertModuleFederationExposure,
  isModuleManifestImport,
  raiseScaffoldFailure,
  readGeneratedSlotEntries,
  requireCanonicalSlug,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  toTitle,
  tryScaffold,
  updateMutation,
  withExactDependencies,
} from '../shared.mts';
import { hasValidGovernedHttpCompositionRoot } from '../../generated-governed-http-boundary.mts';
import { planActionBoundaryScaffold } from '../microvertical-action-boundary/scaffold.mts';
import {
  hasGeneratedOperationGatewayContract,
  hasGeneratedGovernedClientContract,
  hasGeneratedModuleApiReadContract,
  hasGeneratedModuleApiContract,
  hasNamedImportBinding,
  hasGeneratedProviderApiContract,
  hasGeneratedProviderReadContract,
  hasGeneratedOperationPrincipalContract,
  hasUniqueExactNamedImport,
  tokenizeGovernedClient,
} from '../../generated-module-api-boundary.mts';
import type {
  GovernedContributionScaffoldConfig,
  Mutation,
  OntosVerticalMetadata,
  ScaffoldFailure,
} from '../shared.mts';

const MODULE_API_KIND = 'module-api';
const PUBLIC_COMPONENT_KIND = 'public-component';
const REPORT_KIND = 'report';
const SEARCH_PROVIDER_KIND = 'search-provider';

const GovernedContributionKindSchema = Schema.Literals([
  MODULE_API_KIND,
  PUBLIC_COMPONENT_KIND,
  REPORT_KIND,
  SEARCH_PROVIDER_KIND,
]);
export type GovernedContributionKind = typeof GovernedContributionKindSchema.Type;

const ProviderContributionKindSchema = Schema.Literals([REPORT_KIND, SEARCH_PROVIDER_KIND]);
type ProviderContributionKind = typeof ProviderContributionKindSchema.Type;
const isProviderContribution = Schema.is(ProviderContributionKindSchema);

const directTokenStringProperty = (
  tokens: ReturnType<typeof tokenizeGovernedClient>,
  property: string,
): string | undefined => {
  const identities: string[] = [];
  let braceDepth = 0;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      braceDepth === 1 &&
      tokens[index]?.kind === SyntaxKind.Identifier &&
      tokens[index]?.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
      tokens[index + 2]?.kind === SyntaxKind.StringLiteral
    ) {
      const identity = tokens[index + 2]?.value;
      if (identity !== undefined) {
        identities.push(identity);
      }
    }
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return identities.length === 1 ? identities[0] : undefined;
};

const slotEntryIdentity = (source: string): string | undefined => {
  const compositionIdentity =
    /^import \{ (?<value>[^}]+) \}/u.exec(source)?.groups?.['value'] ??
    /^\.addHttpApi\((?<value>[^)]+)\)/u.exec(source)?.groups?.['value'] ??
    /^(?<value>[A-Za-z][A-Za-z0-9]*ReadApiLive)\.pipe\(/u.exec(source)?.groups?.['value'];
  if (compositionIdentity !== undefined) {
    return compositionIdentity;
  }
  const tokens = tokenizeGovernedClient(source);
  const [registrationProperty, registrationColon] = tokens;
  if (
    registrationColon?.kind === SyntaxKind.ColonToken &&
    (registrationProperty?.kind === SyntaxKind.StringLiteral ||
      registrationProperty?.kind === SyntaxKind.Identifier)
  ) {
    return registrationProperty.value;
  }
  for (const property of ['contributionKey', 'key']) {
    const identity = directTokenStringProperty(tokens, property);
    if (identity !== undefined) {
      return identity;
    }
  }
  return undefined;
};

const insertSortedSlotIdempotently = (
  content: string,
  start: string,
  end: string,
  entry: string,
  validateEntry: (candidate: string) => boolean,
): string => {
  const entries = readGeneratedSlotEntries(content, start, end);
  if (entries.some((candidate) => !validateEntry(candidate))) {
    return raiseScaffoldFailure(
      `generated owner slot contains unsupported developer content: ${start}`,
    );
  }
  if (generatedSlotContainsExactEntry(content, start, end, entry)) {
    return content;
  }
  const expectedIdentity = slotEntryIdentity(entry);
  if (
    expectedIdentity !== undefined &&
    entries.some((candidate) => slotEntryIdentity(candidate) === expectedIdentity)
  ) {
    return raiseScaffoldFailure(`generated owner slot contains drift for ${expectedIdentity}`);
  }
  return insertSortedSlot(content, start, end, [entry], validateEntry);
};

const generatedHeader = (kind: GovernedContributionKind) =>
  isProviderContribution(kind)
    ? `// @generated by OntOS Codesmith Governed Contribution v1\n// @ontos-contribution-kind ${kind}`
    : `// @generated by OntOS Codesmith ${kind} v1`;

const manifestImport = (kind: GovernedContributionKind, name: string): string | undefined => {
  const value = `${toPascalCase(name)}${kind === PUBLIC_COMPONENT_KIND ? '' : 'Api'}`;
  if (kind === PUBLIC_COMPONENT_KIND) {
    return `import { ${value} } from './src/components/${name}.tsx';`;
  }
  if (kind === MODULE_API_KIND) {
    return `import { ${value} } from './shared/apis/${name}.ts';`;
  }
  return undefined;
};

const manifestImportIdentity = (kind: GovernedContributionKind, name: string) => ({
  binding: `${toPascalCase(name)}${kind === PUBLIC_COMPONENT_KIND ? '' : 'Api'}`,
  specifier:
    kind === PUBLIC_COMPONENT_KIND ? `./src/components/${name}.tsx` : `./shared/apis/${name}.ts`,
});

const renderPublicComponent = (name: string): string => {
  const value = toPascalCase(name);
  return `${generatedHeader(PUBLIC_COMPONENT_KIND)}
export const ${value} = () => null;
`;
};

const renderApiContract = (name: string): string => {
  const type = toPascalCase(name);
  const value = `${toPascalCase(name)}Api`;
  return `${generatedHeader(MODULE_API_KIND)}
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

export const ${type}RequestSchema = Schema.Struct({});
export type ${type}Request = typeof ${type}RequestSchema.Type;
export const ${type}ResponseSchema = Schema.Struct({ ok: Schema.Literal(true) });
export type ${type}Response = typeof ${type}ResponseSchema.Type;

export const ${type}AuthenticationProblemSchema = makeProblemDetailsSchema(
  '${type}AuthenticationProblem',
  401,
);
export const ${type}InvalidProblemSchema = makeProblemDetailsSchema('${type}InvalidProblem', 400);
export const ${type}UnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  '${type}UnavailableProblem',
  503,
);
export const ${type}ForbiddenProblemSchema = makeProblemDetailsSchema('${type}ForbiddenProblem', 403);
export const ${type}NotFoundProblemSchema = makeProblemDetailsSchema('${type}NotFoundProblem', 404);
export const ${type}PolicyProblemSchema = makeProblemDetailsSchema('${type}PolicyProblem', 422);
export const ${type}PolicyConflictProblemSchema = makeProblemDetailsSchema(
  '${type}PolicyConflictProblem',
  409,
);
export const ${type}InternalProblemSchema = makeProblemDetailsSchema('${type}InternalProblem', 500);

export const ${value} = HttpApi.make('${value}').add(
  HttpApiGroup.make('${toCamelCase(name)}').add(
    HttpApiEndpoint.post('execute', '/reads/${name}', {
      error: [
        ${type}InvalidProblemSchema,
        ${type}AuthenticationProblemSchema,
        ${type}ForbiddenProblemSchema,
        ${type}NotFoundProblemSchema,
        ${type}PolicyConflictProblemSchema,
        ${type}PolicyProblemSchema,
        ${type}UnavailableProblemSchema,
        ${type}InternalProblemSchema,
      ],
      headers: {},
      params: {},
      payload: ${type}RequestSchema,
      query: {},
      success: ${type}ResponseSchema,
    }),
  ),
);
`;
};

const renderReadAuthorization = (
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): string => {
  if (config.authorization === 'context_permission') {
    if (
      config.permission === undefined ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(config.permission)
    ) {
      return raiseScaffoldFailure(
        'context_permission authorization requires a stable --permission value',
      );
    }
    return `{ kind: 'context_permission', permission: '${config.permission}' }`;
  }
  if (config.permission !== undefined) {
    return raiseScaffoldFailure('--permission is valid only for context_permission authorization');
  }
  return `{ kind: '${config.authorization}' }`;
};

const readAuthorizationExpectation = (
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
) =>
  config.permission === undefined
    ? { kind: config.authorization }
    : { kind: config.authorization, permission: config.permission };

const renderModuleApiRead = (
  vertical: OntosVerticalMetadata,
  name: string,
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): string => {
  const type = toPascalCase(name);
  return `${generatedHeader(MODULE_API_KIND)}
import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { Effect } from 'effect';
import { ${type}RequestSchema, ${type}ResponseSchema } from '../../shared/apis/${name}.ts';

export const ${toCamelCase(name)}Entrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: ${renderReadAuthorization(config)},
  entrypointKey: '${vertical.moduleId}.api.${name}',
  moduleKey: '${vertical.moduleId}',
  role: 'api',
});

export const ${toCamelCase(name)}Read = defineRead(
  {
    accessKind: 'detail',
    entrypoint: ${toCamelCase(name)}Entrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: '${vertical.moduleId}.api.${name}.evidence.v1',
    },
    inputSchema: ${type}RequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: '${vertical.moduleId}',
    permissionTarget: 'module',
    policies: [],
    readKey: '${vertical.moduleId}.api.${name}',
    resultSchema: ${type}ResponseSchema,
    schemaVersion: '1',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { ok: true as const } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module', moduleId: '${vertical.moduleId}' }),
);
`;
};

const renderGovernedClientConstruction = (
  vertical: OntosVerticalMetadata,
  apiValue: string,
  clientName: string,
  optionsType: string,
): string => `const ${clientName} = (
  credential: Redacted.Redacted<string>,
  requestCorrelation: string,
  options: ${optionsType},
) => {
  const clientConfig = {
    api: ${apiValue},
    defaultApiPrefix: '/${vertical.appId}-api',
    transportHeaders: {
      authorization: Redacted.value(credential),
      'x-correlation-id': requestCorrelation,
    },
  };
  return makeEffectBffClient(
    options.baseUrl === undefined ? clientConfig : { ...clientConfig, baseUrl: options.baseUrl },
  );
};`;

const renderApiClient = (vertical: OntosVerticalMetadata, name: string): string => {
  const type = toPascalCase(name);
  const value = `${toPascalCase(name)}Api`;
  const clientName = `${toCamelCase(name)}Client`;
  const optionsType = `${type}ClientOptions`;
  const authorizedInvocationType = `${type}AuthorizedInvocation`;
  const operationInvocationType = `${type}OperationInvocation`;
  return `${generatedHeader(MODULE_API_KIND)}
import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';
import { ${value} } from '../../shared/apis/${name}.ts';
import type { ${type}Request } from '../../shared/apis/${name}.ts';
import { operationGateway } from './action-gateway.ts';

export interface ${optionsType} {
  readonly baseUrl?: string | URL;
}

type ${authorizedInvocationType} = readonly [
  credential: string,
  requestCorrelation: string,
  options?: ${optionsType},
];

type ${operationInvocationType} = readonly [
  requestCorrelation: string,
  options?: ${optionsType},
];

${renderGovernedClientConstruction(vertical, value, clientName, optionsType)}

export const execute${type}WithAuthorization = (
  payload: ${type}Request,
  ...[credential, requestCorrelation, options = {}]: ${authorizedInvocationType}
) =>
  ${clientName}(Redacted.make(credential), requestCorrelation, options).pipe(
    Effect.flatMap((client) =>
      client.${toCamelCase(name)}.execute({ headers: {}, params: {}, payload, query: {} }),
    ),
  );

export const execute${type} = (
  payload: ${type}Request,
  ...[requestCorrelation, options = {}]: ${operationInvocationType}
) =>
  operationGateway.invoke((credential) =>
    execute${type}WithAuthorization(payload, credential, requestCorrelation, options),
  );
`;
};

const renderProvider = (
  kind: ProviderContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): string => {
  const type = toPascalCase(name);
  const role = kind === REPORT_KIND ? REPORT_KIND : 'search';
  const contract = `${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}`;
  const inputSchema = `${type}ProviderRequestSchema`;
  const inputType = `${type}ProviderRequest`;
  const resultSchema = `${type}ProviderResponseSchema`;
  const resultType = `${type}ProviderResponse`;
  const emptyResult = kind === REPORT_KIND ? '{ rows: [] }' : '[]';
  const resultCount = kind === REPORT_KIND ? 'result.rows.length' : 'result.length';
  return `${generatedHeader(kind)}
import { Effect } from 'effect';
import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { ${inputSchema}, ${resultSchema} } from '../../shared/apis/${contract}.ts';
import type { ${inputType}, ${resultType} } from '../../shared/apis/${contract}.ts';

export const ${toCamelCase(name)}Entrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: ${renderReadAuthorization(config)},
  entrypointKey: '${vertical.moduleId}.${role}.${name}',
  moduleKey: '${vertical.moduleId}',
  role: '${role}',
});

const load${type} = (_input: ${inputType}) =>
  Effect.succeed(${emptyResult} satisfies ${resultType});

export const ${toCamelCase(name)}Read = defineRead(
  {
    accessKind: '${kind === REPORT_KIND ? REPORT_KIND : 'search'}',
    entrypoint: ${toCamelCase(name)}Entrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: '${vertical.moduleId}.${role}.${name}.evidence.v1',
    },
    inputSchema: ${inputSchema},
    legalEntityScope: 'required',
    owningModuleKey: '${vertical.moduleId}',
    permissionTarget: 'module',
    policies: [],
    readKey: '${vertical.moduleId}.${role}.${name}',
    resultSchema: ${resultSchema},
    schemaVersion: '1',
  },
  (input, context) =>
    context.services.load(input).pipe(
      Effect.map((result) => ({
        evidence: { resultCount: ${resultCount} },
        result,
      })),
    ),
  () => Effect.succeed({ load: load${type} }),
  () => ({ kind: 'module', moduleId: '${vertical.moduleId}' }),
${kind === SEARCH_PROVIDER_KIND ? '  (result) => result.map(({ ref }) => ref),\n' : ''});
`;
};

const renderProviderClient = (
  kind: ProviderContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
): string => {
  const type = toPascalCase(name);
  const apiValue = `${type}${kind === REPORT_KIND ? 'Report' : 'Search'}Api`;
  const group = `${toCamelCase(name)}${kind === REPORT_KIND ? 'Report' : 'Search'}`;
  const clientName = `${toCamelCase(name)}Client`;
  const optionsType = `${type}ClientOptions`;
  const invocationTypePrefix = `${type}${kind === REPORT_KIND ? 'Report' : 'Search'}`;
  return `${generatedHeader(kind)}
import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';
import { ${apiValue} } from '../../shared/apis/${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts';
import type { ${type}ProviderRequest } from '../../shared/apis/${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts';
import { operationGateway } from './action-gateway.ts';

export interface ${optionsType} {
  readonly baseUrl?: string | URL;
}

type ${invocationTypePrefix}AuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options?: ${optionsType},
];

type ${invocationTypePrefix}OperationInvocation = readonly [
  requestCorrelation: string,
  options?: ${optionsType},
];

${renderGovernedClientConstruction(vertical, apiValue, clientName, optionsType)}

export const load${type}ClientWithAuthorization = (
  payload: ${type}ProviderRequest,
  ...[credential, requestCorrelation, options = {}]: ${invocationTypePrefix}AuthorizedInvocation
) =>
  ${clientName}(Redacted.make(credential), requestCorrelation, options).pipe(
    Effect.flatMap((client) => client.${group}.execute({ payload })),
  );

export const load${type}Client = (
  payload: ${type}ProviderRequest,
  ...[requestCorrelation, options = {}]: ${invocationTypePrefix}OperationInvocation
) =>
  operationGateway.invoke((credential) =>
    load${type}ClientWithAuthorization(payload, credential, requestCorrelation, options),
  );
`;
};

const renderProviderApiContract = (
  kind: ProviderContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
): string => {
  const type = toPascalCase(name);
  const apiValue = `${type}${kind === REPORT_KIND ? 'Report' : 'Search'}Api`;
  const group = `${toCamelCase(name)}${kind === REPORT_KIND ? 'Report' : 'Search'}`;
  const payloadField = kind === REPORT_KIND ? 'parameters' : 'query';
  const success =
    kind === REPORT_KIND
      ? `Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.String)) })`
      : `Schema.Array(
  Schema.Struct({
    ref: Schema.Struct({ moduleId: Schema.String, resourceId: Schema.String, resourceType: Schema.String }),
    title: Schema.String,
  }),
)`;
  return `${generatedHeader(kind)}
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

export const ${type}ProviderRequestSchema = Schema.Struct({
  ${payloadField}: ${kind === REPORT_KIND ? 'Schema.Record(Schema.String, Schema.String)' : 'Schema.String'},
});
export type ${type}ProviderRequest = typeof ${type}ProviderRequestSchema.Type;

export const ${type}ProviderResponseSchema = ${success};
export type ${type}ProviderResponse = typeof ${type}ProviderResponseSchema.Type;

export const ${type}ProviderUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  '${type}ProviderUnavailableProblem',
  503,
);

export const ${type}ProviderAuthenticationProblemSchema = makeProblemDetailsSchema(
  '${type}ProviderAuthenticationProblem',
  401,
);
export const ${type}ProviderInvalidProblemSchema = makeProblemDetailsSchema('${type}ProviderInvalidProblem', 400);
export const ${type}ProviderForbiddenProblemSchema = makeProblemDetailsSchema(
  '${type}ProviderForbiddenProblem',
  403,
);
export const ${type}ProviderNotFoundProblemSchema = makeProblemDetailsSchema(
  '${type}ProviderNotFoundProblem',
  404,
);
export const ${type}ProviderPolicyProblemSchema = makeProblemDetailsSchema('${type}ProviderPolicyProblem', 422);
export const ${type}ProviderPolicyConflictProblemSchema = makeProblemDetailsSchema(
  '${type}ProviderPolicyConflictProblem',
  409,
);
export const ${type}ProviderInternalProblemSchema = makeProblemDetailsSchema(
  '${type}ProviderInternalProblem',
  500,
);

export const ${apiValue} = HttpApi.make('${apiValue}').add(
  HttpApiGroup.make('${group}').add(
    HttpApiEndpoint.post('execute', '/${vertical.moduleId}/${kind === REPORT_KIND ? 'reports' : 'search'}/${name}', {
      error: [
        ${type}ProviderInvalidProblemSchema,
        ${type}ProviderAuthenticationProblemSchema,
        ${type}ProviderForbiddenProblemSchema,
        ${type}ProviderNotFoundProblemSchema,
        ${type}ProviderPolicyConflictProblemSchema,
        ${type}ProviderPolicyProblemSchema,
        ${type}ProviderUnavailableProblemSchema,
        ${type}ProviderInternalProblemSchema,
      ],
      payload: ${type}ProviderRequestSchema,
      success: ${type}ProviderResponseSchema,
    }),
  ),
);
`;
};

const renderGovernedServer = (
  kind: Exclude<GovernedContributionKind, typeof PUBLIC_COMPONENT_KIND>,
  name: string,
): string => {
  const type = toPascalCase(name);
  const names = {
    [MODULE_API_KIND]: {
      contract: name,
      group: toCamelCase(name),
      problemStem: type,
      readImport: `../src/api/${name}.read.ts`,
    },
    [REPORT_KIND]: {
      contract: `${name}-report`,
      group: `${toCamelCase(name)}Report`,
      problemStem: `${type}Provider`,
      readImport: `../src/reports/${name}.provider.ts`,
    },
    [SEARCH_PROVIDER_KIND]: {
      contract: `${name}-search`,
      group: `${toCamelCase(name)}Search`,
      problemStem: `${type}Provider`,
      readImport: `../src/search/${name}.provider.ts`,
    },
  };
  const { contract, group, problemStem, readImport } = names[kind];
  const readValue = `${toCamelCase(name)}Read`;
  return `${generatedHeader(kind)}
import {
  governedReadHttpStatus,
  makeGovernedReadHttpHandler,
} from '@app/core-runtime/http/governed-read';
import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { governedHttpApi } from '../shared/api.ts';
import {
  ${problemStem}AuthenticationProblemSchema,
  ${problemStem}ForbiddenProblemSchema,
  ${problemStem}InternalProblemSchema,
  ${problemStem}InvalidProblemSchema,
  ${problemStem}NotFoundProblemSchema,
  ${problemStem}PolicyConflictProblemSchema,
  ${problemStem}PolicyProblemSchema,
  ${problemStem}UnavailableProblemSchema,
} from '../shared/apis/${contract}.ts';
import { ${readValue} } from '${readImport}';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';

const problems = {
  authentication: () =>
    ${problemStem}AuthenticationProblemSchema.make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: governedReadHttpStatus.authentication,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    }),
  forbidden: () =>
    ${problemStem}ForbiddenProblemSchema.make({
      detail: 'The principal is not permitted to perform this read.',
      status: governedReadHttpStatus.forbidden,
      title: 'Read forbidden',
      type: 'https://ontos.dev/problems/read-forbidden',
    }),
  internal: () =>
    ${problemStem}InternalProblemSchema.make({
      detail: 'The governed read could not be completed.',
      status: governedReadHttpStatus.internal,
      title: 'Read failed',
      type: 'https://ontos.dev/problems/read-failed',
    }),
  invalid: () =>
    ${problemStem}InvalidProblemSchema.make({
      detail: 'The governed read request is invalid.',
      status: governedReadHttpStatus.invalid,
      title: 'Invalid read request',
      type: 'https://ontos.dev/problems/read-invalid',
    }),
  notFound: () =>
    ${problemStem}NotFoundProblemSchema.make({
      detail: 'The requested resource was not found.',
      status: governedReadHttpStatus.notFound,
      title: 'Resource not found',
      type: 'https://ontos.dev/problems/read-not-found',
    }),
  policyConflict: () =>
    ${problemStem}PolicyConflictProblemSchema.make({
      detail: 'The read conflicts with the current business state.',
      status: governedReadHttpStatus.policyConflict,
      title: 'Read conflict',
      type: 'https://ontos.dev/problems/read-policy-conflict',
    }),
  policyIneligible: () =>
    ${problemStem}PolicyProblemSchema.make({
      detail: 'The read is not eligible under the current business policy.',
      status: governedReadHttpStatus.policyIneligible,
      title: 'Read ineligible',
      type: 'https://ontos.dev/problems/read-policy-denied',
    }),
  unavailable: () =>
    ${problemStem}UnavailableProblemSchema.make({
      detail: 'The governed read is temporarily unavailable.',
      retryable: true,
      status: governedReadHttpStatus.unavailable,
      title: 'Read unavailable',
      type: 'https://ontos.dev/problems/read-unavailable',
    }),
};

export const ${toCamelCase(name)}ReadApiLive = HttpApiBuilder.group(
  governedHttpApi,
  '${group}',
  (handlers) =>
    handlers.handle(
      'execute',
      makeGovernedReadHttpHandler({
        authenticatePrincipal: authenticateOperationPrincipal,
        problems,
        registration: ${readValue},
      }),
    ),
);
`;
};

const patchGovernedHttpComposition = Effect.fn('GovernedContributionScaffold.patchHttpComposition')(
  function* patchGovernedHttpComposition(
    vertical: OntosVerticalMetadata,
    kind: Exclude<GovernedContributionKind, typeof PUBLIC_COMPONENT_KIND>,
    name: string,
  ) {
    const isModuleApi = kind === MODULE_API_KIND;
    const type = toPascalCase(name);
    const contractSuffix = kind === REPORT_KIND ? REPORT_KIND : 'search';
    const contract = isModuleApi ? name : `${name}-${contractSuffix}`;
    const apiValue = isModuleApi
      ? `${type}Api`
      : `${type}${kind === REPORT_KIND ? 'Report' : 'Search'}Api`;
    const serverSuffix = isModuleApi ? 'read' : contractSuffix;
    const layerValue = `${toCamelCase(name)}ReadApiLive`;
    const sharedApiPath = yield* tryScaffold('failed to resolve governed HTTP API path', () =>
      resolveContainedPath(vertical.directory, 'shared', 'api.ts'),
    );
    const handlerRootPath = yield* tryScaffold(
      'failed to resolve governed HTTP handler root path',
      () => resolveContainedPath(vertical.directory, 'api', 'index.ts'),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const [sharedApi, handlerRoot] = yield* Effect.all([
      fileSystem
        .readFileString(sharedApiPath)
        .pipe(
          Effect.mapError((cause) =>
            scaffoldFailure(`failed to read governed HTTP API root ${sharedApiPath}`, cause),
          ),
        ),
      fileSystem
        .readFileString(handlerRootPath)
        .pipe(
          Effect.mapError((cause) =>
            scaffoldFailure(`failed to read governed HTTP handler root ${handlerRootPath}`, cause),
          ),
        ),
    ]);
    if (!hasValidGovernedHttpCompositionRoot(sharedApi, handlerRoot)) {
      return raiseScaffoldFailure(
        'governed HTTP composition slots are not bound to the exported runtime root',
      );
    }
    const nextSharedApi = yield* tryScaffold('failed to patch governed HTTP API root', () =>
      insertSortedSlotIdempotently(
        insertSortedSlotIdempotently(
          sharedApi,
          GOVERNED_HTTP_API_IMPORT_SLOT_START,
          GOVERNED_HTTP_API_IMPORT_SLOT_END,
          `import { ${apiValue} } from './apis/${contract}.ts';`,
          (candidate) => candidate.startsWith('import { ') && candidate.endsWith("';"),
        ),
        GOVERNED_HTTP_API_ADDITION_SLOT_START,
        GOVERNED_HTTP_API_ADDITION_SLOT_END,
        `.addHttpApi(${apiValue})`,
        (candidate) => candidate.startsWith('.addHttpApi(') && candidate.endsWith(')'),
      ),
    );
    const nextHandlerRoot = yield* tryScaffold('failed to patch governed HTTP handler root', () => {
      let next = insertSortedSlotIdempotently(
        insertSortedSlotIdempotently(
          handlerRoot,
          GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START,
          GOVERNED_HTTP_HANDLER_IMPORT_SLOT_END,
          `import { ${layerValue} } from './${name}-${serverSuffix}-server.ts';`,
          (candidate) => candidate.startsWith('import { ') && candidate.endsWith("';"),
        ),
        GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
        GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
        `${layerValue}.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),`,
        (candidate) =>
          /^[A-Za-z][A-Za-z0-9]*ReadApiLive\.pipe\(/u.test(candidate) &&
          candidate.includes('GovernedReadLayer.provide(governedReadRuntimeLive)') &&
          candidate.endsWith('),'),
      );
      if (next.includes(GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START)) {
        for (const supportImport of [
          "import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';",
          "import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';",
        ]) {
          next = insertSortedSlotIdempotently(
            next,
            GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
            GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END,
            supportImport,
            (candidate) => candidate.startsWith('import { ') && candidate.endsWith("';"),
          );
        }
      }
      if (next.includes(GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START)) {
        next = insertSortedSlotIdempotently(
          next,
          GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
          GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
          'GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive)),',
          (candidate) =>
            candidate.startsWith('GovernedReadLayer.provide(') && candidate.endsWith('),'),
        );
      }
      return next;
    });
    const mutations: Mutation[] = [];
    const sharedApiMutation = yield* tryScaffold('failed to update governed HTTP API root', () =>
      updateMutation(sharedApiPath, sharedApi, nextSharedApi),
    );
    const handlerRootMutation = yield* tryScaffold(
      'failed to update governed HTTP handler root',
      () => updateMutation(handlerRootPath, handlerRoot, nextHandlerRoot),
    );
    if (sharedApiMutation !== undefined) {
      mutations.push(sharedApiMutation);
    }
    if (handlerRootMutation !== undefined) {
      mutations.push(handlerRootMutation);
    }
    return mutations;
  },
);

interface GovernedContributionSlots {
  readonly manifest: readonly [string, string, string][];
  readonly registration: readonly [string, string, string][];
}

const manifestOwnerSlots = [
  [MODULE_MANIFEST_API_SLOT_START, MODULE_MANIFEST_API_SLOT_END],
  [MODULE_MANIFEST_COMPONENT_SLOT_START, MODULE_MANIFEST_COMPONENT_SLOT_END],
  [MODULE_MANIFEST_REPORT_SLOT_START, MODULE_MANIFEST_REPORT_SLOT_END],
  [MODULE_MANIFEST_SEARCH_SLOT_START, MODULE_MANIFEST_SEARCH_SLOT_END],
  [MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START, MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END],
  [MODULE_MANIFEST_SHELL_REPORT_SLOT_START, MODULE_MANIFEST_SHELL_REPORT_SLOT_END],
  [MODULE_MANIFEST_SHELL_SEARCH_SLOT_START, MODULE_MANIFEST_SHELL_SEARCH_SLOT_END],
] as const;

const registrationOwnerSlots = [
  [MODULE_REGISTRATION_API_SLOT_START, MODULE_REGISTRATION_API_SLOT_END],
  [MODULE_REGISTRATION_COMPONENT_SLOT_START, MODULE_REGISTRATION_COMPONENT_SLOT_END],
  [MODULE_REGISTRATION_REPORT_SLOT_START, MODULE_REGISTRATION_REPORT_SLOT_END],
  [MODULE_REGISTRATION_SEARCH_SLOT_START, MODULE_REGISTRATION_SEARCH_SLOT_END],
] as const;

const slotLine = (
  kind: GovernedContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
  resource: string | undefined,
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): GovernedContributionSlots => {
  const key = `${vertical.moduleId}.${name}`;
  if (kind === PUBLIC_COMPONENT_KIND) {
    return {
      manifest: [
        [
          MODULE_MANIFEST_COMPONENT_SLOT_START,
          MODULE_MANIFEST_COMPONENT_SLOT_END,
          `'${name}': ${toPascalCase(name)},`,
        ],
        [
          MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
          MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
          `publicComponentContribution({ componentKey: '${key}', contributionKey: '${vertical.moduleId}.component.${name}', entrypoint: { access: 'read', authorization: ${renderReadAuthorization(config)}, entrypointKey: '${vertical.moduleId}.component.${name}', moduleKey: '${vertical.moduleId}', role: 'public_component', scope: 'tenant' } }),`,
        ],
      ],
      registration: [
        [
          MODULE_REGISTRATION_COMPONENT_SLOT_START,
          MODULE_REGISTRATION_COMPONENT_SLOT_END,
          `'${name}': () => import('./src/components/${name}.tsx'),`,
        ],
      ],
    };
  }
  if (kind === MODULE_API_KIND) {
    return {
      manifest: [
        [
          MODULE_MANIFEST_API_SLOT_START,
          MODULE_MANIFEST_API_SLOT_END,
          `'${name}': ${toPascalCase(name)}Api,`,
        ],
      ],
      registration: [
        [
          MODULE_REGISTRATION_API_SLOT_START,
          MODULE_REGISTRATION_API_SLOT_END,
          `'${name}': () => import('./src/api/${name}-client.ts'),`,
        ],
      ],
    };
  }
  if (resource === undefined) {
    return raiseScaffoldFailure(`--resource is required for ${kind}`);
  }
  const resourceKey = `${vertical.moduleId}.${resource}`;
  if (kind === SEARCH_PROVIDER_KIND) {
    return {
      manifest: [
        [
          MODULE_MANIFEST_SEARCH_SLOT_START,
          MODULE_MANIFEST_SEARCH_SLOT_END,
          `{ accessFiltering: 'resource_permission', key: '${key}', owningModuleId: '${vertical.moduleId}', resourceType: '${resourceKey}' },`,
        ],
        [
          MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
          MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
          `searchContribution({ contributionKey: '${vertical.moduleId}.search.${name}', entrypoint: { access: 'read', authorization: ${renderReadAuthorization(config)}, entrypointKey: '${vertical.moduleId}.search.${name}', moduleKey: '${vertical.moduleId}', role: 'search', scope: 'tenant' }, searchKey: '${key}' }),`,
        ],
      ],
      registration: [
        [
          MODULE_REGISTRATION_SEARCH_SLOT_START,
          MODULE_REGISTRATION_SEARCH_SLOT_END,
          `'${name}': () => import('./src/api/${name}-search-client.ts'),`,
        ],
      ],
    };
  }
  return {
    manifest: [
      [
        MODULE_MANIFEST_REPORT_SLOT_START,
        MODULE_MANIFEST_REPORT_SLOT_END,
        `{ accessFiltering: 'resource_permission', dimensions: [], key: '${key}', label: '${toTitle(name)}', owningModuleId: '${vertical.moduleId}', resourceTypes: ['${resourceKey}'] },`,
      ],
      [
        MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
        MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
        `reportContribution({ contributionKey: '${vertical.moduleId}.report.${name}', entrypoint: { access: 'read', authorization: ${renderReadAuthorization(config)}, entrypointKey: '${vertical.moduleId}.report.${name}', moduleKey: '${vertical.moduleId}', role: 'report', scope: 'tenant' }, reportKey: '${key}' }),`,
      ],
    ],
    registration: [
      [
        MODULE_REGISTRATION_REPORT_SLOT_START,
        MODULE_REGISTRATION_REPORT_SLOT_END,
        `'${name}': () => import('./src/api/${name}-report-client.ts'),`,
      ],
    ],
  };
};

/* eslint-disable unicorn/no-array-reduce -- Slot patches intentionally flow through the accumulated document. */

const readStringArray = (
  tokens: ReturnType<typeof tokenizeGovernedClient>,
  start: number,
): readonly string[] | undefined => {
  const values: string[] = [];
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token?.kind === SyntaxKind.CloseBracketToken) {
      return values;
    }
    if (token?.kind === SyntaxKind.StringLiteral) {
      values.push(token.value);
    } else if (token?.kind !== SyntaxKind.CommaToken) {
      return undefined;
    }
  }
  return undefined;
};

const directStringProperty = (source: string, property: string): string | undefined =>
  directTokenStringProperty(tokenizeGovernedClient(source), property);

const directStringArrayProperty = (
  source: string,
  property: string,
): readonly string[] | undefined => {
  const tokens = tokenizeGovernedClient(source);
  let braceDepth = 0;
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (
      braceDepth === 1 &&
      tokens[index]?.kind === SyntaxKind.Identifier &&
      tokens[index]?.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
      tokens[index + 2]?.kind === SyntaxKind.OpenBracketToken
    ) {
      return readStringArray(tokens, index + 3);
    }
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return undefined;
};

// Owners may adapt accessFiltering/tenantPermission and report label/dimensions. These describe
// presentation and report shape; the generated provider identity and resource ownership stay fixed.
const acceptsAdaptedProviderDescriptor = (
  start: string,
  current: string,
  expected: string,
): boolean => {
  if (start !== MODULE_MANIFEST_SEARCH_SLOT_START && start !== MODULE_MANIFEST_REPORT_SLOT_START) {
    return false;
  }
  const requiredStringProperties = ['key', 'owningModuleId', 'resourceType'];
  if (
    requiredStringProperties.some(
      (property) =>
        directStringProperty(current, property) !== directStringProperty(expected, property),
    )
  ) {
    return false;
  }
  const expectedResourceTypes = directStringArrayProperty(expected, 'resourceTypes');
  const currentResourceTypes = directStringArrayProperty(current, 'resourceTypes');
  if (
    expectedResourceTypes !== undefined &&
    (currentResourceTypes === undefined ||
      currentResourceTypes.length !== expectedResourceTypes.length ||
      expectedResourceTypes.some((value, index) => currentResourceTypes[index] !== value))
  ) {
    return false;
  }
  const accessFiltering = directStringProperty(current, 'accessFiltering');
  return (
    accessFiltering === 'resource_permission' ||
    (accessFiltering === 'tenant_scope' &&
      directStringProperty(current, 'tenantPermission') !== undefined)
  );
};

const structurallyMatchesGeneratedEntry = (current: string, expected: string): boolean => {
  const currentTokens = tokenizeGovernedClient(current);
  const expectedTokens = tokenizeGovernedClient(expected);
  if (currentTokens.length !== expectedTokens.length) {
    return false;
  }
  return expectedTokens.every((expectedToken, index) => {
    const currentToken = currentTokens[index];
    const isPropertyKey =
      index === 0 &&
      (expectedToken.kind === SyntaxKind.Identifier ||
        expectedToken.kind === SyntaxKind.StringLiteral) &&
      (currentToken?.kind === SyntaxKind.Identifier ||
        currentToken?.kind === SyntaxKind.StringLiteral);
    const sameKind = isPropertyKey || currentToken?.kind === expectedToken.kind;
    const carriesIdentity =
      expectedToken.kind === SyntaxKind.Identifier ||
      expectedToken.kind === SyntaxKind.StringLiteral;
    return sameKind && (!carriesIdentity || currentToken?.value === expectedToken.value);
  });
};

const patchSlots = (
  content: string,
  slots: readonly [string, string, string][],
  ownerSlots: readonly (readonly [string, string])[],
): string =>
  slots.reduce((current, [start, end, line]) => {
    const entries = readGeneratedSlotEntries(current, start, end);
    if (entries.some((candidate) => !candidate.endsWith(','))) {
      return raiseScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${start}`,
      );
    }
    const identity = slotEntryIdentity(line);
    const allOwnerEntries = ownerSlots
      .filter(
        ([ownerStart, ownerEnd]) => current.includes(ownerStart) && current.includes(ownerEnd),
      )
      .flatMap(([ownerStart, ownerEnd]) =>
        readGeneratedSlotEntries(current, ownerStart, ownerEnd).map((entry) => ({
          entry,
          start: ownerStart,
        })),
      );
    if (allOwnerEntries.some(({ entry }) => slotEntryIdentity(entry) === undefined)) {
      return raiseScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${start}`,
      );
    }
    const identityMatches =
      identity === undefined
        ? []
        : allOwnerEntries.filter(({ entry }) => slotEntryIdentity(entry) === identity);
    if (identityMatches.some((match) => match.start !== start)) {
      return raiseScaffoldFailure(
        `generated owner slot contains mismatched identity in the wrong contribution category: ${identity}`,
      );
    }
    if (identityMatches.length > 1) {
      return raiseScaffoldFailure(`generated owner slot contains duplicate identity: ${identity}`);
    }
    if (generatedSlotContainsExactEntry(current, start, end, line)) {
      return current;
    }
    const [identityMatch] = identityMatches;
    if (
      identityMatch !== undefined &&
      identityMatch.start === start &&
      (structurallyMatchesGeneratedEntry(identityMatch.entry, line) ||
        acceptsAdaptedProviderDescriptor(start, identityMatch.entry, line))
    ) {
      return current;
    }
    if (identityMatch !== undefined) {
      return raiseScaffoldFailure(`generated owner slot contains mismatched identity: ${identity}`);
    }
    return insertSortedSlot(current, start, end, [line], (candidate) => candidate.endsWith(','));
  }, content);
/* eslint-enable unicorn/no-array-reduce */

const patchFederationExposure = Effect.fn('GovernedContributionScaffold.patchFederationExposure')(
  function* patchFederationExposure(vertical: OntosVerticalMetadata, name: string) {
    const configPath = yield* tryScaffold('failed to resolve Module Federation config path', () =>
      resolveContainedPath(vertical.directory, 'module-federation.config.ts'),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(
        Effect.mapError((cause) =>
          scaffoldFailure(`failed to read Module Federation config ${configPath}`, cause),
        ),
      );
    const next = yield* tryScaffold('failed to patch Module Federation exposure', () =>
      insertModuleFederationExposure(
        content,
        `./${toPascalCase(name)}`,
        `./src/components/${name}.tsx`,
      ),
    );
    return { content: next, kind: 'update' as const, path: configPath };
  },
);

const acceptsGeneratedClient = (
  kind: GovernedContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
): ((current: string) => boolean) => {
  const type = toPascalCase(name);
  const isModuleApi = kind === MODULE_API_KIND;
  const providerKind = {
    [MODULE_API_KIND]: '',
    [PUBLIC_COMPONENT_KIND]: '',
    [REPORT_KIND]: 'Report',
    [SEARCH_PROVIDER_KIND]: 'Search',
  }[kind];
  const operationStem = isModuleApi ? `execute${type}` : `load${type}Client`;
  const expectedGroups = isModuleApi
    ? [toCamelCase(name)]
    : [kind === REPORT_KIND ? 'reports' : 'search', `${toCamelCase(name)}${providerKind}`];
  return (current) =>
    expectedGroups.some((endpointGroup) =>
      hasGeneratedGovernedClientContract(current, {
        authorizedOperation: `${operationStem}WithAuthorization`,
        defaultApiPrefix: `/${vertical.appId}-api`,
        endpointGroup,
        generatedHeader: `${generatedHeader(kind)}\n`,
        invocationKind: isModuleApi ? 'module-api' : 'provider',
        ownerApiValue: isModuleApi ? `${type}Api` : `${type}${providerKind}Api`,
        ownerContractImport: isModuleApi
          ? `../../shared/apis/${name}.ts`
          : `../../shared/apis/${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts`,
        publicOperation: operationStem,
      }),
    );
};

const operationBoundaryPaths = (vertical: OntosVerticalMetadata) => ({
  gatewayPath: `${vertical.directory}/src/api/action-gateway.ts`,
  principalPath: `${vertical.directory}/api/auth/action-principal.ts`,
});

const hasExistingOperationBoundary = (
  vertical: OntosVerticalMetadata,
): Effect.Effect<boolean, ScaffoldFailure, FileSystem.FileSystem> =>
  Effect.gen(function* hasExistingOperationBoundaryEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const { gatewayPath, principalPath } = operationBoundaryPaths(vertical);
    const exists = yield* Effect.all([
      fileSystem.exists(principalPath),
      fileSystem.exists(gatewayPath),
    ]).pipe(
      Effect.mapError((cause) => scaffoldFailure('failed to inspect operation boundary', cause)),
    );
    if (!exists.every(Boolean)) {
      return false;
    }
    const [principal, gateway] = yield* Effect.all([
      fileSystem.readFileString(principalPath),
      fileSystem.readFileString(gatewayPath),
    ]).pipe(
      Effect.mapError((cause) => scaffoldFailure('failed to read operation boundary', cause)),
    );
    const header = `// @generated by OntOS Codesmith MicroVertical Action Boundary v1\n// @ontos-action-boundary-owner ${vertical.appId}\n`;
    return (
      principal.startsWith(header) &&
      hasGeneratedOperationPrincipalContract(principal) &&
      hasGeneratedOperationGatewayContract(gateway, vertical.appId)
    );
  });

const planOperationBoundary = Effect.fn('GovernedContributionScaffold.planOperationBoundary')(
  function* planOperationBoundary(workspaceRoot: string, vertical: OntosVerticalMetadata) {
    if (!(yield* hasExistingOperationBoundary(vertical))) {
      const fileSystem = yield* FileSystem.FileSystem;
      const { gatewayPath, principalPath } = operationBoundaryPaths(vertical);
      const existingBoundaryFiles = yield* Effect.all([
        fileSystem.exists(principalPath),
        fileSystem.exists(gatewayPath),
      ]).pipe(
        Effect.mapError((cause) =>
          scaffoldFailure('failed to inspect operation boundary files', cause),
        ),
      );
      if (existingBoundaryFiles.every(Boolean)) {
        return yield* Effect.fail(
          scaffoldFailure('refusing to overwrite existing business file: operation boundary'),
        );
      }
      const boundary = yield* planActionBoundaryScaffold(workspaceRoot, {
        vertical: vertical.slug,
      });
      return boundary.mutations;
    }
    const dependencyMutation = yield* tryScaffold(
      'failed to ensure governed client dependency',
      () =>
        withExactDependencies(vertical, {
          '@app/shared-contracts': 'workspace:*',
        }),
    );
    return EffectArray.getSomes([Option.fromNullishOr(dependencyMutation)]);
  },
);

const acceptsGovernedArtifact = (
  kind: typeof MODULE_API_KIND | ProviderContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): ((current: string) => boolean) => {
  if (kind === MODULE_API_KIND) {
    return (current) =>
      current.startsWith(`${generatedHeader(kind)}\n`) &&
      hasGeneratedModuleApiContract(current, `${toPascalCase(name)}Api`, toCamelCase(name), name);
  }
  if (!isProviderContribution(kind)) {
    return () => false;
  }
  return (current) =>
    current.startsWith(`${generatedHeader(kind)}\n`) &&
    hasGeneratedProviderReadContract(
      current,
      vertical.moduleId,
      name,
      kind === REPORT_KIND ? 'report' : 'search',
      readAuthorizationExpectation(config),
    );
};

const planGovernedTransport = Effect.fn('GovernedContributionScaffold.transport')(
  function* planGovernedTransport(
    workspaceRoot: string,
    kind: GovernedContributionKind,
    vertical: OntosVerticalMetadata,
    name: string,
  ) {
    const isApi = kind === MODULE_API_KIND;
    const mutations: Mutation[] = [];
    let clientPath: string | undefined;
    let serverPath: string | undefined;
    if (kind !== PUBLIC_COMPONENT_KIND) {
      const suffix = {
        [MODULE_API_KIND]: 'client',
        [REPORT_KIND]: 'report-client',
        [SEARCH_PROVIDER_KIND]: 'search-client',
      }[kind];
      clientPath = yield* tryScaffold('failed to resolve governed client path', () =>
        resolveContainedPath(vertical.directory, 'src', 'api', `${name}-${suffix}.ts`),
      );
      const clientMutation = yield* createOrAcceptGeneratedMutationEffect(
        clientPath,
        isApi ? renderApiClient(vertical, name) : renderProviderClient(kind, vertical, name),
        acceptsGeneratedClient(kind, vertical, name),
      );
      mutations.push(...EffectArray.getSomes([clientMutation]));
      if (isProviderContribution(kind)) {
        const providerContractPath = yield* tryScaffold(
          'failed to resolve provider contract path',
          () =>
            resolveContainedPath(
              vertical.directory,
              'shared',
              'apis',
              `${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts`,
            ),
        );
        const providerContractMutation = yield* createOrAcceptGeneratedMutationEffect(
          providerContractPath,
          renderProviderApiContract(kind, vertical, name),
          (current) =>
            current.startsWith(`${generatedHeader(kind)}\n`) &&
            hasGeneratedProviderApiContract(
              current,
              `${toPascalCase(name)}${kind === REPORT_KIND ? 'Report' : 'Search'}Api`,
              vertical.moduleId,
              name,
              kind === REPORT_KIND ? 'report' : 'search',
            ),
        );
        mutations.push(...EffectArray.getSomes([providerContractMutation]));
      }
      serverPath = yield* tryScaffold('failed to resolve governed server path', () =>
        resolveContainedPath(
          vertical.directory,
          'api',
          `${name}-${{ [MODULE_API_KIND]: 'read', [REPORT_KIND]: REPORT_KIND, [SEARCH_PROVIDER_KIND]: 'search' }[kind]}-server.ts`,
        ),
      );
      const serverMutation = yield* createOrAcceptGeneratedMutationEffect(
        serverPath,
        renderGovernedServer(kind, name),
      );
      mutations.push(
        ...EffectArray.getSomes([serverMutation]),
        ...(yield* patchGovernedHttpComposition(vertical, kind, name)),
        ...(yield* planOperationBoundary(workspaceRoot, vertical)),
      );
    }
    return { clientPath, mutations, serverPath };
  },
);

export const planGovernedContributionScaffold = Effect.fn('GovernedContributionScaffold.plan')(
  function* planGovernedContributionScaffold(
    workspaceRoot: string,
    kind: GovernedContributionKind,
    config: GovernedContributionScaffoldConfig,
  ) {
    const name = yield* tryScaffold('governed contribution name is invalid', () =>
      requireCanonicalSlug(config.name, kind),
    );
    const resource =
      config.resource === undefined
        ? undefined
        : yield* tryScaffold('governed contribution resource is invalid', () =>
            requireCanonicalSlug(config.resource ?? '', 'resource'),
          );
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
    const isComponent = kind === PUBLIC_COMPONENT_KIND;
    const isApi = kind === MODULE_API_KIND;
    const artifactSegments = {
      [MODULE_API_KIND]: ['shared', 'apis', `${name}.ts`],
      [PUBLIC_COMPONENT_KIND]: ['src', 'components', `${name}.tsx`],
      [REPORT_KIND]: ['src', 'reports', `${name}.provider.ts`],
      [SEARCH_PROVIDER_KIND]: ['src', 'search', `${name}.provider.ts`],
    };
    const artifactPath = yield* tryScaffold('failed to resolve governed contribution path', () =>
      resolveContainedPath(vertical.directory, ...artifactSegments[kind]),
    );
    const artifact = yield* tryScaffold('failed to render governed contribution', () => {
      if (isComponent) {
        return renderPublicComponent(name);
      }
      if (isApi) {
        return renderApiContract(name);
      }
      if (isProviderContribution(kind)) {
        return renderProvider(kind, vertical, name, config);
      }
      return raiseScaffoldFailure('unsupported governed contribution', kind);
    });
    const artifactMutation = isComponent
      ? Option.some(yield* createMutationEffect(artifactPath, artifact))
      : yield* createOrAcceptGeneratedMutationEffect(
          artifactPath,
          artifact,
          acceptsGovernedArtifact(kind, vertical, name, config),
        );
    const mutations: Mutation[] = EffectArray.getSomes([artifactMutation]);
    if (isApi) {
      const readPath = yield* tryScaffold('failed to resolve governed read path', () =>
        resolveContainedPath(vertical.directory, 'src', 'api', `${name}.read.ts`),
      );
      const readSource = yield* tryScaffold('failed to render governed read', () =>
        renderModuleApiRead(vertical, name, config),
      );
      const readMutation = yield* createOrAcceptGeneratedMutationEffect(
        readPath,
        readSource,
        (current) =>
          current.startsWith(`${generatedHeader(MODULE_API_KIND)}\n`) &&
          hasGeneratedModuleApiReadContract(
            current,
            vertical.moduleId,
            name,
            readAuthorizationExpectation(config),
          ),
      );
      mutations.push(...EffectArray.getSomes([readMutation]));
    }
    const transport = yield* planGovernedTransport(workspaceRoot, kind, vertical, name);
    const { clientPath, serverPath } = transport;
    mutations.push(...transport.mutations);
    const ownerImport = manifestImport(kind, name);
    const ownerImportIdentity = manifestImportIdentity(kind, name);
    let manifest = vertical.manifestContent;
    if (
      ownerImport !== undefined &&
      !hasUniqueExactNamedImport(
        manifest,
        ownerImportIdentity.binding,
        ownerImportIdentity.specifier,
      )
    ) {
      if (hasNamedImportBinding(manifest, ownerImportIdentity.binding)) {
        return yield* scaffoldFailure(
          `generated owner import binding conflicts with ${ownerImportIdentity.binding}`,
        );
      }
      manifest = yield* tryScaffold('failed to patch module manifest imports', () =>
        insertSortedSlotIdempotently(
          manifest,
          MODULE_MANIFEST_IMPORT_SLOT_START,
          MODULE_MANIFEST_IMPORT_SLOT_END,
          ownerImport,
          isModuleManifestImport,
        ),
      );
    }
    const slots = yield* tryScaffold('failed to plan governed contribution owner slots', () =>
      slotLine(kind, vertical, name, resource, config),
    );
    const registration = yield* tryScaffold('failed to patch governed contribution slots', () => {
      manifest = patchSlots(manifest, slots.manifest, manifestOwnerSlots);
      return patchSlots(vertical.registrationContent, slots.registration, registrationOwnerSlots);
    });
    const manifestMutation = yield* tryScaffold('failed to update module manifest', () =>
      updateMutation(vertical.manifestPath, vertical.manifestContent, manifest),
    );
    const registrationMutation = yield* tryScaffold('failed to update module registration', () =>
      updateMutation(vertical.registrationPath, vertical.registrationContent, registration),
    );
    if (manifestMutation !== undefined) {
      mutations.push(manifestMutation);
    }
    if (registrationMutation !== undefined) {
      mutations.push(registrationMutation);
    }
    if (isComponent) {
      mutations.push(yield* patchFederationExposure(vertical, name));
    }
    yield* tryScaffold('governed contribution mutation paths are invalid', () =>
      ensureUniqueMutationPaths(mutations),
    );
    const result =
      clientPath === undefined || serverPath === undefined
        ? { artifactPath }
        : { artifactPath, clientPath, serverPath };
    return { mutations, result };
  },
);
