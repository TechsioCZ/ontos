import { readFile } from 'node:fs/promises';
import {
  ACTION_GENERATOR_HEADER,
  CORE_ACTION_SLOT_END,
  CORE_ACTION_SLOT_START,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  createMutation,
  discoverOntosModule,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  requireCanonicalSlug,
  requireCoreModuleKey,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  updateMutation,
  withCoreDependency,
} from '../shared.mts';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import type {
  ActionScaffoldConfig,
  ActionScaffoldResult,
  Mutation,
  OntosVerticalMetadata,
  ScaffoldPlan,
} from '../shared.mts';

const renderActionContract = (
  vertical: OntosVerticalMetadata,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
): string => {
  const type = toPascalCase(action);
  const value = `${toCamelCase(action)}Action`;
  return `${ACTION_GENERATOR_HEADER}
/* eslint-disable max-classes-per-file, unicorn/prefer-export-from -- generated closed Action vocabulary and schema re-exports */
// @ontos-action-owner ${vertical.moduleId}
// @ontos-action-slug ${action}
import { Schema } from 'effect';
import { defineActionContract, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ActionHandler } from '@app/core-runtime';
import { ${type}PayloadSchema, ${type}ResultSchema } from '../../shared/apis/${action}-action.ts';

export { ${type}PayloadSchema, ${type}ResultSchema };
export type { ${type}Payload, ${type}Result } from '../../shared/apis/${action}-action.ts';

export class ${type}NotFound extends Schema.TaggedErrorClass<${type}NotFound>()(
  '${type}NotFound',
  { code: Schema.Literal('action_target_not_found'), reason: Schema.String },
) {}
export class ${type}Conflict extends Schema.TaggedErrorClass<${type}Conflict>()(
  '${type}Conflict',
  { code: Schema.Literal('action_conflict'), reason: Schema.String },
) {}
export class ${type}Rejected extends Schema.TaggedErrorClass<${type}Rejected>()(
  '${type}Rejected',
  { code: Schema.Literal('action_semantically_rejected'), reason: Schema.String },
) {}

export const ${type}DomainErrorSchema = Schema.Union([
  ${type}NotFound,
  ${type}Conflict,
  ${type}Rejected,
]);
export type ${type}DomainError = typeof ${type}DomainErrorSchema.Type;

export const ${type}DomainEvents = {} as const;
export const ${type}PolicyDenialStatuses = {} as const satisfies Readonly<
  Record<string, 403 | 409 | 422>
>;

export const ${value} = defineActionContract({
  accessEvidencePolicy: {
    captureMode: 'metadata_only',
    policyKey: '${vertical.moduleId}.${action}.access.v1',
  },
  actionKey: '${vertical.moduleId}.${action}',
  auditProfile: 'standard',
  domainErrorSchema: ${type}DomainErrorSchema,
  domainEvents: ${type}DomainEvents,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    entrypointKey: '${vertical.moduleId}.${action}',
    moduleKey: '${vertical.moduleId}',
    role: 'action',
  }),
  idempotency: 'required',
  legalEntityScope: '${legalEntityScope}',
  owningModuleKey: '${vertical.moduleId}',
  payloadSchema: ${type}PayloadSchema,
  policies: [],
  resultSchema: ${type}ResultSchema,
  schemaVersion: '1',
});

export type ${type}ActionHandler<Services, Requirements = never> = ActionHandler<
  typeof ${type}PayloadSchema,
  typeof ${type}ResultSchema,
  typeof ${type}DomainErrorSchema,
  typeof ${type}DomainEvents,
  Services,
  Requirements
>;

${OUTBOX_SLOT_START}
${OUTBOX_SLOT_END}
`;
};

const problemSchema = (type: string, name: string, status: number, retryable = false): string =>
  `export const ${type}${name}ProblemSchema = Schema.TaggedStruct(
  '${type}${name}Problem',
  {
    detail: Schema.String,
    ${retryable ? 'retryable: Schema.Literal(true),\n    ' : ''}status: Schema.Literal(${status}),
    title: Schema.String,
    type: Schema.String,
  },
).pipe(
  HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
  HttpApiSchema.status(${status}),
);`;

const renderHttpContract = (vertical: OntosVerticalMetadata, action: string): string => {
  const type = toPascalCase(action);
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${vertical.moduleId}
// @ontos-action-slug ${action}
import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from 'effect/unstable/httpapi';

export const ${type}PayloadSchema = Schema.Struct({});
export type ${type}Payload = typeof ${type}PayloadSchema.Type;
export const ${type}ResultSchema = Schema.Struct({});
export type ${type}Result = typeof ${type}ResultSchema.Type;

${problemSchema(type, 'Validation', 400)}
${problemSchema(type, 'Authentication', 401)}
${problemSchema(type, 'Forbidden', 403)}
${problemSchema(type, 'NotFound', 404)}
${problemSchema(type, 'Conflict', 409)}
${problemSchema(type, 'Rejected', 422)}
${problemSchema(type, 'Precondition', 428)}
${problemSchema(type, 'Internal', 500)}
${problemSchema(type, 'Unavailable', 503, true)}

export const ${type}ActionRequestHeadersSchema = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  'x-correlation-id': Schema.NonEmptyString,
  'x-idempotency-key': Schema.optionalKey(Schema.NonEmptyString),
});

export class ${type}SchemaErrorMiddleware extends HttpApiMiddleware.Service<${type}SchemaErrorMiddleware>()(
  '${vertical.moduleId}/${action}/SchemaErrorMiddleware',
  { error: ${type}ValidationProblemSchema },
) {}

export const ${type}ActionApi = HttpApi.make('${type}ActionApi').add(
  HttpApiGroup.make('${toCamelCase(action)}Actions').add(
    HttpApiEndpoint.post('execute', '/actions/${action}', {
      error: [
        ${type}ValidationProblemSchema,
        ${type}AuthenticationProblemSchema,
        ${type}ForbiddenProblemSchema,
        ${type}NotFoundProblemSchema,
        ${type}ConflictProblemSchema,
        ${type}RejectedProblemSchema,
        ${type}PreconditionProblemSchema,
        ${type}InternalProblemSchema,
        ${type}UnavailableProblemSchema,
      ],
      headers: ${type}ActionRequestHeadersSchema,
      payload: ${type}PayloadSchema,
      success: ${type}ResultSchema,
    }).middleware(${type}SchemaErrorMiddleware),
  ),
);
`;
};

const renderBinding = (action: string): string => {
  const type = toPascalCase(action);
  const value = `${toCamelCase(action)}Action`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-slug ${action}
import { bindAction } from '@app/core-runtime';
import type { ActionServiceFactory } from '@app/core-runtime';
import { ${value} } from './${action}.action.ts';
import type { ${type}ActionHandler } from './${action}.action.ts';

export const bind${type}Action = <Services, Requirements = never>(
  handler: ${type}ActionHandler<Services, Requirements>,
  serviceFactory: ActionServiceFactory<Services, Requirements>,
) => bindAction(${value}, handler, serviceFactory);
`;
};

const renderClient = (action: string): string => {
  const type = toPascalCase(action);
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-slug ${action}
import { Effect } from 'effect';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { ${type}ActionApi } from '../../shared/apis/${action}-action.ts';
import type { ${type}Payload } from '../../shared/apis/${action}-action.ts';
import { operationGateway } from './action-gateway.ts';

export interface ${type}ActionRequestOptions {
  readonly baseUrl?: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export const execute${type}ActionWithAuthorization = (
  payload: ${type}Payload,
  authorization: string,
  options: ${type}ActionRequestOptions,
) =>
  makeEffectHttpApiClient(
    ${type}ActionApi,
    options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
  ).pipe(
    Effect.flatMap((client) =>
      client.${toCamelCase(action)}Actions.execute({
        headers: {
        authorization,
        'x-correlation-id': options.correlationId,
        'x-idempotency-key': options.idempotencyKey,
        },
        payload,
      }),
    ),
  );

export const makeExecute${type}Action = (
  gateway: Pick<typeof operationGateway, 'invoke'> = operationGateway,
) =>
  (payload: ${type}Payload, options: ${type}ActionRequestOptions) =>
    gateway.invoke((authorization) =>
      execute${type}ActionWithAuthorization(payload, authorization, options),
    );

export const execute${type}Action = makeExecute${type}Action();
`;
};

const renderServer = (vertical: OntosVerticalMetadata, action: string): string => {
  const type = toPascalCase(action);
  const value = `${toCamelCase(action)}Action`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${vertical.moduleId}
// @ontos-action-slug ${action}
import { ActionRuntime } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import {
  Config,
  Effect,
  HttpApiBuilder,
  HttpEffect,
  HttpApiMiddleware,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import { Cause } from 'effect';
import {
  ${type}ActionApi,
  ${type}SchemaErrorMiddleware,
} from '../shared/apis/${action}-action.ts';
import {
  ${type}PolicyDenialStatuses,
  ${value},
} from '../src/actions/${action}.action.ts';
import type { ${type}DomainError } from '../src/actions/${action}.action.ts';
import { verifyActionPrincipal } from './auth/action-principal.ts';
import type { ActionPrincipalError } from './auth/action-principal.ts';

const problem = <Tag extends string, Status extends number>(
  _tag: Tag,
  status: Status,
  title: string,
  detail: string,
  type: string,
) => ({ _tag, detail, status, title, type });
const validationProblem = () =>
  problem('${type}ValidationProblem' as const, 400 as const, 'Invalid Action request', 'The Action request is structurally invalid.', 'https://ontos.dev/problems/action-validation');
const authenticationProblem = () =>
  problem('${type}AuthenticationProblem' as const, 401 as const, 'Authentication required', 'A valid audience-scoped Bearer assertion is required.', 'https://ontos.dev/problems/action-authentication-required');
const forbiddenProblem = () =>
  problem('${type}ForbiddenProblem' as const, 403 as const, 'Action forbidden', 'The principal is not permitted to execute this Action.', 'https://ontos.dev/problems/action-forbidden');
const notFoundProblem = () =>
  problem('${type}NotFoundProblem' as const, 404 as const, 'Action target not found', 'The requested Action target was not found.', 'https://ontos.dev/problems/action-not-found');
const conflictProblem = () =>
  problem('${type}ConflictProblem' as const, 409 as const, 'Action conflict', 'The Action conflicts with current state.', 'https://ontos.dev/problems/action-conflict');
const rejectedProblem = () =>
  problem('${type}RejectedProblem' as const, 422 as const, 'Action rejected', 'The Action is not semantically eligible.', 'https://ontos.dev/problems/action-rejected');
const preconditionProblem = () =>
  problem('${type}PreconditionProblem' as const, 428 as const, 'Action precondition required', 'The Action requires an idempotency key.', 'https://ontos.dev/problems/action-precondition-required');
const internalProblem = () =>
  problem('${type}InternalProblem' as const, 500 as const, 'Action failed', 'The Action could not be completed.', 'https://ontos.dev/problems/action-failed');
const unavailableProblem = () => ({
  ...problem('${type}UnavailableProblem' as const, 503 as const, 'Action unavailable', 'The Action is temporarily unavailable.', 'https://ontos.dev/problems/action-unavailable'),
  retryable: true as const,
});
type EndpointProblem =
  | ReturnType<typeof validationProblem>
  | ReturnType<typeof authenticationProblem>
  | ReturnType<typeof forbiddenProblem>
  | ReturnType<typeof notFoundProblem>
  | ReturnType<typeof conflictProblem>
  | ReturnType<typeof rejectedProblem>
  | ReturnType<typeof preconditionProblem>
  | ReturnType<typeof internalProblem>
  | ReturnType<typeof unavailableProblem>;
type ActionFailure = ActionCoreError | ${type}DomainError;
type ActionFailureTag = ActionFailure['_tag'];
type ActionProblemFactory = (error: ActionFailure) => EndpointProblem | undefined;

const policyDenialStatuses: Readonly<Record<string, 403 | 409 | 422>> =
  ${type}PolicyDenialStatuses;
const policyProblem = (reasonCode: string): EndpointProblem | undefined => {
  switch (policyDenialStatuses[reasonCode]) {
    case 403: return forbiddenProblem();
    case 409: return conflictProblem();
    case 422: return rejectedProblem();
    default: return undefined;
  }
};

const actionProblemByTag = {
  ActionPayloadValidationError: () => validationProblem(),
  ActionTrustedContextValidationError: () => authenticationProblem(),
  OperationAuthenticationRequired: () => authenticationProblem(),
  ActionPermissionDenied: () => forbiddenProblem(),
  ModuleStateDeniedError: () => forbiddenProblem(),
  OperationContextDenied: () => forbiddenProblem(),
  OperationContextInvalid: () => forbiddenProblem(),
  ActionInvocationNotFound: () => notFoundProblem(),
  ${type}NotFound: () => notFoundProblem(),
  ActionAlreadyCommitted: () => conflictProblem(),
  ActionInvocationStateError: () => conflictProblem(),
  ActionRequestHashConflict: () => conflictProblem(),
  ${type}Conflict: () => conflictProblem(),
  ActionPolicyDenied: (error) =>
    error._tag === 'ActionPolicyDenied' ? policyProblem(error.policyReasonCode) : undefined,
  ${type}Rejected: () => rejectedProblem(),
  ActionIdempotencyKeyRequired: () => preconditionProblem(),
  ActionCommitIndeterminate: () => unavailableProblem(),
  ActionInvocationPersistenceError: () => unavailableProblem(),
  ActionPermissionCheckError: () => unavailableProblem(),
  ActionPolicyEvaluationError: () => unavailableProblem(),
  ModuleStateCheckUnavailableError: () => unavailableProblem(),
  OperationContextUnavailable: () => unavailableProblem(),
  ActionCollectorError: () => internalProblem(),
  ActionHandlerExecutionError: () => internalProblem(),
  ActionResultValidationError: () => internalProblem(),
  ActionTransactionError: () => internalProblem(),
} satisfies Record<ActionFailureTag, ActionProblemFactory>;

const actionProblem = (error: unknown): EndpointProblem | undefined => {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('_tag' in error) ||
    typeof error._tag !== 'string' ||
    !Object.hasOwn(actionProblemByTag, error._tag)
  ) {
    return undefined;
  }
  return actionProblemByTag[error._tag as ActionFailureTag](error as ActionFailure);
};

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
type VerificationProblem =
  | ReturnType<typeof authenticationProblem>
  | ReturnType<typeof unavailableProblem>;

const ${toCamelCase(action)}ActionSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  ${type}SchemaErrorMiddleware,
  () => Effect.fail(validationProblem()),
);

export const ${toCamelCase(action)}ActionApiLive = HttpApiBuilder.group(
  ${type}ActionApi,
  '${toCamelCase(action)}Actions',
  (handlers) =>
    handlers.handle('execute', ({ headers, payload }) =>
      Effect.gen(function* execute${type}Action() {
        const environment = yield* Config.all({
          ONTOS_GATEWAY_ISSUER: Config.string('ONTOS_GATEWAY_ISSUER'),
          ONTOS_GATEWAY_PUBLIC_JWKS: Config.string('ONTOS_GATEWAY_PUBLIC_JWKS'),
        }).pipe(Effect.mapError(unavailableProblem));
        const principal = yield* verifyActionPrincipal(headers.authorization, {
          environment,
        }).pipe(
          Effect.catch((error: ActionPrincipalError) => {
            if (
              error._tag === 'ActionPrincipalConfigurationError' ||
              error._tag === 'ActionPrincipalUnavailableError'
            ) {
              return Effect.fail<VerificationProblem>(unavailableProblem());
            }
            return bearerChallenge.pipe(
              Effect.andThen(Effect.fail<VerificationProblem>(authenticationProblem())),
            );
          }),
        );
        const runtime = yield* ActionRuntime;
        return yield* runtime
          .runAction({
            payload,
            principal,
            registration: ${value},
            transport: {
              correlationId: headers['x-correlation-id'],
              idempotencyKey: headers['x-idempotency-key'],
              targetModuleKey: '${vertical.moduleId}',
              targetResourceId: '${vertical.moduleId}',
              targetResourceType: 'module',
            },
          })
          .pipe(
            Effect.catchCause((cause) => {
              const failure = Cause.findErrorOption(cause);
              const mapped = failure._tag === 'Some' ? actionProblem(failure.value) : undefined;
              if (mapped !== undefined) {
                return mapped.status === 401
                  ? bearerChallenge.pipe(Effect.andThen(Effect.fail<EndpointProblem>(mapped)))
                  : Effect.fail<EndpointProblem>(mapped);
              }
              return Effect.logError('Unexpected ${type} Action transport defect', cause).pipe(
                Effect.andThen(Effect.fail<EndpointProblem>(internalProblem())),
              );
            }),
          );
      }),
  ),
).pipe(Layer.provide(${toCamelCase(action)}ActionSchemaErrorLive));
`;
};

const renderCoreAction = (
  moduleKey: string,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
): string => {
  const type = toPascalCase(action);
  const value = `${toCamelCase(action)}Action`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${moduleKey}
// @ontos-action-slug ${action}
import { Schema } from 'effect';
import { defineActionContract } from '../../actions/definition.ts';
import type { ActionHandler } from '../../actions/definition.ts';
import { defineSystemModuleEntrypoint } from '../module-entrypoint.ts';

export const ${type}Payload = Schema.Struct({});
export const ${type}Result = Schema.Struct({});
export const ${type}DomainError = Schema.Never;
export const ${type}DomainEvents = {} as const;

export const ${value} = defineActionContract({
  accessEvidencePolicy: {
    captureMode: 'metadata_only',
    policyKey: '${moduleKey}.${action}.access.v1',
  },
  actionKey: '${moduleKey}.${action}',
  auditProfile: 'standard',
  domainErrorSchema: ${type}DomainError,
  domainEvents: ${type}DomainEvents,
  entrypoint: defineSystemModuleEntrypoint({
    access: 'write',
    entrypointKey: '${moduleKey}.${action}',
    moduleKey: '${moduleKey}',
    role: 'action',
  }),
  idempotency: 'required',
  legalEntityScope: '${legalEntityScope}',
  owningModuleKey: '${moduleKey}',
  payloadSchema: ${type}Payload,
  policies: [],
  resultSchema: ${type}Result,
  schemaVersion: '1',
});

export type ${type}ActionHandler<Services, Requirements = never> = ActionHandler<
  typeof ${type}Payload,
  typeof ${type}Result,
  typeof ${type}DomainError,
  typeof ${type}DomainEvents,
  Services,
  Requirements
>;
`;
};

const renderCoreBinding = (moduleKey: string, action: string): string => {
  const type = toPascalCase(action);
  const value = `${toCamelCase(action)}Action`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${moduleKey}
// @ontos-action-slug ${action}
import { bindAction } from '../../actions/definition.ts';
import type { ActionServiceFactory } from '../../actions/definition.ts';
import { ${value} } from './${action}.action.ts';
import type { ${type}ActionHandler } from './${action}.action.ts';

export const bind${type}Action = <Services, Requirements = never>(
  handler: ${type}ActionHandler<Services, Requirements>,
  serviceFactory: ActionServiceFactory<Services, Requirements>,
) => bindAction(${value}, handler, serviceFactory);
`;
};

const coreExportEntry = (action: string): string =>
  `export { ${toCamelCase(action)}Action } from './modules/actions/${action}.action.ts';`;

const isCoreActionExport = (candidate: string): boolean =>
  /^export \{ [a-z][A-Za-z0-9]*Action \} from '\.\/modules\/actions\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.action\.ts';$/u.test(
    candidate,
  );

const planCoreActionScaffold = async (
  workspaceRoot: string,
  moduleKeyInput: string,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const moduleKey = requireCoreModuleKey(moduleKeyInput);
  const actionPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'modules',
    'actions',
    `${action}.action.ts`,
  );
  const bindingPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'modules',
    'actions',
    `${action}.registration.ts`,
  );
  const indexPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'index.ts',
  );
  const actionMutation = await createMutation(
    actionPath,
    renderCoreAction(moduleKey, action, legalEntityScope),
  );
  const bindingMutation = await createMutation(bindingPath, renderCoreBinding(moduleKey, action));
  const indexContent = await readFile(indexPath, 'utf-8');
  const nextIndex = insertSortedSlot(
    indexContent,
    CORE_ACTION_SLOT_START,
    CORE_ACTION_SLOT_END,
    [coreExportEntry(action)],
    isCoreActionExport,
  );
  const indexMutation = updateMutation(indexPath, indexContent, nextIndex);
  const mutations =
    indexMutation === undefined
      ? [actionMutation, bindingMutation]
      : [actionMutation, bindingMutation, indexMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export const planActionScaffold = async (
  workspaceRoot: string,
  config: ActionScaffoldConfig,
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  if (config.scope === 'core') {
    return planCoreActionScaffold(workspaceRoot, config.module, action, config.legalEntityScope);
  }
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const actionValue = `${toCamelCase(action)}Action`;
  const apiValue = `${toPascalCase(action)}ActionApi`;
  const ownerImport = `import { ${actionValue} } from './src/actions/${action}.action.ts';`;
  const apiImport = `import { ${apiValue} } from './shared/apis/${action}-action.ts';`;
  if (
    (vertical.manifestContent.includes(`import { ${actionValue} }`) &&
      !vertical.manifestContent.includes(ownerImport)) ||
    (vertical.manifestContent.includes(`import { ${apiValue} }`) &&
      !vertical.manifestContent.includes(apiImport))
  ) {
    throw new Error(`Action identifier collision for ${action}`);
  }
  const actionPath = resolveContainedPath(
    vertical.directory,
    'src',
    'actions',
    `${action}.action.ts`,
  );
  const bindingPath = resolveContainedPath(
    vertical.directory,
    'src',
    'actions',
    `${action}.registration.ts`,
  );
  const contractPath = resolveContainedPath(
    vertical.directory,
    'shared',
    'apis',
    `${action}-action.ts`,
  );
  const clientPath = resolveContainedPath(
    vertical.directory,
    'src',
    'api',
    `${action}-action-client.ts`,
  );
  const serverPath = resolveContainedPath(vertical.directory, 'api', `${action}-action-server.ts`);
  const mutations: Mutation[] = [
    await createMutation(
      actionPath,
      renderActionContract(vertical, action, config.legalEntityScope),
    ),
    await createMutation(bindingPath, renderBinding(action)),
    await createMutation(contractPath, renderHttpContract(vertical, action)),
    await createMutation(clientPath, renderClient(action)),
    await createMutation(serverPath, renderServer(vertical, action)),
  ];

  let nextManifest = insertSortedSlot(
    vertical.manifestContent,
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
    [ownerImport, apiImport],
    (candidate) => /^import \{ [A-Za-z][A-Za-z0-9]* \} from '.+';$/u.test(candidate),
  );
  nextManifest = insertSortedSlot(
    nextManifest,
    MODULE_MANIFEST_ACTION_SLOT_START,
    MODULE_MANIFEST_ACTION_SLOT_END,
    [`${actionValue},`],
    (candidate) => /^[a-z][A-Za-z0-9]*Action,$/u.test(candidate),
  );
  nextManifest = insertSortedSlot(
    nextManifest,
    MODULE_MANIFEST_API_SLOT_START,
    MODULE_MANIFEST_API_SLOT_END,
    [`'${action}-action': ${apiValue},`],
    (candidate) => /^'[a-z][a-z0-9-]*': [A-Za-z][A-Za-z0-9]*,$/u.test(candidate),
  );

  let nextRegistration = insertSortedSlot(
    vertical.registrationContent,
    MODULE_REGISTRATION_IMPORT_SLOT_START,
    MODULE_REGISTRATION_IMPORT_SLOT_END,
    [ownerImport],
    (candidate) =>
      /^import \{ [a-z][A-Za-z0-9]*Action \} from '\.\/src\/actions\/[a-z][a-z0-9-]*\.action\.ts';$/u.test(
        candidate,
      ),
  );
  nextRegistration = insertSortedSlot(
    nextRegistration,
    MODULE_REGISTRATION_ACTION_SLOT_START,
    MODULE_REGISTRATION_ACTION_SLOT_END,
    [`${actionValue},`],
    (candidate) => /^[a-z][A-Za-z0-9]*Action,$/u.test(candidate),
  );
  nextRegistration = insertSortedSlot(
    nextRegistration,
    MODULE_REGISTRATION_API_SLOT_START,
    MODULE_REGISTRATION_API_SLOT_END,
    [`'${action}-action': () => import('./src/api/${action}-action-client.ts'),`],
    (candidate) =>
      /^'[a-z][a-z0-9-]*': \(\) => import\('\.\/src\/api\/[a-z][a-z0-9-]*\.ts'\),$/u.test(
        candidate,
      ),
  );

  const manifestMutation = updateMutation(
    vertical.manifestPath,
    vertical.manifestContent,
    nextManifest,
  );
  const registrationMutation = updateMutation(
    vertical.registrationPath,
    vertical.registrationContent,
    nextRegistration,
  );
  const dependencyMutation = withCoreDependency(vertical);
  if (manifestMutation !== undefined) mutations.push(manifestMutation);
  if (registrationMutation !== undefined) mutations.push(registrationMutation);
  if (dependencyMutation !== undefined) mutations.push(dependencyMutation);
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export default createCodesmithGenerator(planActionScaffold);
