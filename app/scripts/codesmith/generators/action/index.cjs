const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readText = (workspaceRoot, relativePath) =>
  fs.readFile(path.join(workspaceRoot, relativePath), 'utf8');

const writeText = async (workspaceRoot, relativePath, content) => {
  assertWritableSourcePath(relativePath);
  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
};

const readJson = async (workspaceRoot, relativePath) =>
  JSON.parse(await readText(workspaceRoot, relativePath));

const writeJson = (workspaceRoot, relativePath, value) =>
  writeText(workspaceRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);

const formatFiles = (workspaceRoot, relativePaths) => {
  const oxfmtBin = path.join(
    workspaceRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'oxfmt.cmd' : 'oxfmt',
  );
  const result = spawnSync(oxfmtBin, relativePaths, {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'oxfmt failed for generated action files.');
  }
};

const assertWritableSourcePath = (relativePath) => {
  const normalised = relativePath.split(path.sep).join('/');
  if (
    normalised.includes('/node_modules/') ||
    normalised.startsWith('node_modules/') ||
    normalised.includes('/dist/') ||
    normalised.includes('/@mf-types/')
  ) {
    throw new Error(`Refusing to write generated/dependency path: ${relativePath}`);
  }
};

const normaliseKebab = (value, label) => {
  const kebab = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kebab)) {
    throw new Error(`${label} must resolve to a non-empty kebab-case slug.`);
  }

  return kebab;
};

const toWords = (value) => normaliseKebab(value, 'value').split('-');

const toPascalCase = (value) =>
  toWords(value)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join('');

const toCamelCase = (value) => {
  const pascal = toPascalCase(value);
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`;
};

const toTitleCase = (value) =>
  toWords(value)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');

const normaliseRoutePath = ({ actionSlug, routePath, verticalSlug }) => {
  const rawPath =
    typeof routePath === 'string' && routePath.trim().length > 0
      ? routePath.trim()
      : `/${verticalSlug}/actions/${actionSlug}`;
  const normalised = rawPath.replaceAll(/\/+/g, '/').replace(/\/+$/g, '');
  const withLeadingSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;

  if (withLeadingSlash === '/' || withLeadingSlash.includes('..')) {
    throw new Error(`Invalid route path: ${routePath}`);
  }

  return withLeadingSlash;
};

const assertIdentifier = (value, label) => {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) {
    throw new Error(`${label} must be a valid TypeScript identifier.`);
  }
};

const assertActionKey = (value) => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-zA-Z0-9]+)*$/.test(value)) {
    throw new Error('action key must be a dotted or dashed non-empty key.');
  }
};

const assertEnumValue = (value, allowed, label) => {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}.`);
  }
};

const createSharedActionContract = ({
  actionCamel,
  actionPascal,
  actionKey,
  title,
}) => `import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

export const ${actionCamel}ActionKey = '${actionKey}' as const;

export const ${actionCamel}ActionPayloadSchema = Schema.Struct({
  summary: Schema.String,
  targetResourceId: Schema.String,
});

export const ${actionCamel}ActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const ${actionCamel}ActionResponseSchema = Schema.Struct({
  accepted: Schema.Literal(true),
  actionKey: Schema.Literal(${actionCamel}ActionKey),
  message: Schema.String,
  targetResourceId: Schema.String,
});

export const ${actionCamel}ActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: ${actionCamel}ActionResponseSchema,
});

export const ${actionCamel}ActionFailureSchema = Schema.Struct({
    code: Schema.optional(Schema.String),
    errorTag: Schema.String,
    httpStatus: Schema.Finite,
    message: Schema.String,
    ok: Schema.Literal(false),
    state: Schema.optional(Schema.Json),
}).pipe(HttpApiSchema.status(409));

export type ${actionPascal}ActionPayload = typeof ${actionCamel}ActionPayloadSchema.Type;
export type ${actionPascal}ActionResponse = typeof ${actionCamel}ActionResponseSchema.Type;
export type ${actionPascal}ActionOutcome = typeof ${actionCamel}ActionOutcomeSchema.Type;
export type ${actionPascal}ActionFailure = typeof ${actionCamel}ActionFailureSchema.Type;

export const ${actionCamel}ActionTitle = ${JSON.stringify(title)} as const;
`;

const createActionRegistration = ({
  actionCamel,
  actionFile,
  actionKey,
  actionPascal,
  idempotency,
  moduleStateAccess,
  permission,
  resourceId,
  resourceType,
  title,
  verticalSlug,
}) => `import { allowPolicy, denyPolicy, rejectAction } from '@app/core-runtime';
import type {
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
  PolicyCheck,
} from '@app/core-runtime';
import {
  ${actionCamel}ActionKey,
  ${actionCamel}ActionPayloadSchema,
  ${actionCamel}ActionResponseSchema,
} from '../../shared/actions/${actionFile}';
import type {
  ${actionPascal}ActionPayload,
  ${actionPascal}ActionResponse,
} from '../../shared/actions/${actionFile}';

const nonEmptyTargetResourcePolicyKey = '${actionKey}.targetResourceId.present';

const ${actionCamel}DomainEvent =
  {
    eventType: '${actionKey}.accepted',
    payload: (input) => ({
      summary: input.summary,
      targetResourceId: input.targetResourceId,
    }),
    producerModuleKey: '${verticalSlug}',
    subjectModuleKey: '${verticalSlug}',
    subjectResourceId: (_input, response) => response.targetResourceId,
    subjectResourceType: '${actionCamel}',
  } satisfies ActionDomainEventDescriptor<
    ${actionPascal}ActionPayload,
    ${actionPascal}ActionResponse
  >;

const ${actionCamel}ActionHandler: ActionHandler<
  ${actionPascal}ActionPayload,
  ${actionPascal}ActionResponse
> = (input) => {
  const targetResourceId = input.targetResourceId.trim();
  if (targetResourceId.length === 0) {
    throw rejectAction({
      code: '${actionKey}.target_resource_required',
      message: '${title} requires a targetResourceId.',
    });
  }

  return {
    accepted: true,
    actionKey: ${actionCamel}ActionKey,
    message: '${title} accepted by CoreSDK.',
    targetResourceId,
  };
};

const ${actionCamel}PolicyChecks: readonly PolicyCheck<${actionPascal}ActionPayload>[] = [
  ({ data }) =>
    data.targetResourceId.trim().length > 0
      ? allowPolicy({
          policyKey: nonEmptyTargetResourcePolicyKey,
          reason: 'The action targets a concrete resource.',
        })
      : denyPolicy({
          code: '${actionKey}.target_resource_required',
          message: '${title} requires a targetResourceId.',
          policyKey: nonEmptyTargetResourcePolicyKey,
          reason: '${title} requires a non-empty targetResourceId.',
          state: {
            targetResourceId: data.targetResourceId,
          },
        }),
];

export const ${actionCamel}ActionRegistration: ActionRegistration<
  ${actionPascal}ActionPayload,
  ${actionPascal}ActionResponse
> = {
  descriptor: {
    actionKey: ${actionCamel}ActionKey,
    auditProfile: 'standard',
    authorization: {
      permission: '${permission}',
      provider: 'spicedb',
      resourceObjectId: '${resourceId}',
      resourceObjectType: '${resourceType}',
    },
    domainEvent: ${actionCamel}DomainEvent,
    gatewayAudience: '${verticalSlug}',
    idempotency: '${idempotency}',
    moduleStateAccess: '${moduleStateAccess}',
    transportRequestSchema: ${actionCamel}ActionPayloadSchema,
    transportResponseSchema: ${actionCamel}ActionResponseSchema,
  },
  handler: ${actionCamel}ActionHandler,
  policyChecks: ${actionCamel}PolicyChecks,
};
`;

const createActionRuntime = () => `// @effect-diagnostics asyncFunction:off
import {
  coreSDKErrorHttpStatus,
  runAction,
} from '@app/core-runtime';
import type { ActionRegistration, CoreSDKError } from '@app/core-runtime';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type CoreSdkActionTransportOutcome<TResponse> =
  | {
      readonly actionInvocationId?: string;
      readonly ok: true;
      readonly response: TResponse;
    }
  | {
      readonly code?: string;
      readonly errorTag: CoreSDKError['_tag'];
      readonly httpStatus: number;
      readonly message: string;
      readonly ok: false;
      readonly state?: JsonValue;
    };

const errorCode = (error: CoreSDKError): string | undefined =>
  'code' in error ? error.code : undefined;

const toJsonValue = (value: unknown): JsonValue => structuredClone(value) as JsonValue;

const errorState = (error: CoreSDKError): JsonValue | undefined =>
  error._tag === 'OperationPolicyDenied' ? toJsonValue(error.state) : undefined;

export const runCoreSdkAction = async <TAction, TResponse>({
  headers,
  payload,
  registration,
}: {
  readonly headers: Headers;
  readonly payload: TAction;
  readonly registration: ActionRegistration<TAction, TResponse>;
}): Promise<CoreSdkActionTransportOutcome<TResponse>> => {
  const result = await runAction({
    payload,
    registration,
    transport: {
      headers,
    },
  });

  if (result._tag === 'OperationSucceeded') {
    return {
      ...(result.context.actionInvocation?.actionInvocationId === undefined
        ? {}
        : { actionInvocationId: result.context.actionInvocation.actionInvocationId }),
      ok: true,
      response: result.response,
    };
  }

  const code = errorCode(result);
  const state = errorState(result);

  return {
    ...(code === undefined ? {} : { code }),
    errorTag: result._tag,
    httpStatus: coreSDKErrorHttpStatus(result),
    message: result.message,
    ok: false,
    ...(state === undefined ? {} : { state }),
  };
};
`;

const updateSharedApi = async ({
  actionCamel,
  actionFile,
  routePath,
  verticalCamel,
  verticalPascal,
  workspaceRoot,
}) => {
  const relativePath = `verticals/${verticalCamel}/shared/api.ts`;
  const source = await readText(workspaceRoot, relativePath);
  const endpointName = `${actionCamel}Action`;
  if (source.includes(`HttpApiEndpoint.post('${endpointName}'`)) {
    return;
  }

  const importBlock = `import {
  ${actionCamel}ActionHeadersSchema,
  ${actionCamel}ActionFailureSchema,
  ${actionCamel}ActionOutcomeSchema,
  ${actionCamel}ActionPayloadSchema,
} from './actions/${actionFile}';

export type {
  ${toPascalCase(actionCamel)}ActionFailure,
  ${toPascalCase(actionCamel)}ActionOutcome,
  ${toPascalCase(actionCamel)}ActionPayload,
  ${toPascalCase(actionCamel)}ActionResponse,
} from './actions/${actionFile}';
`;
  const nextWithImport = source.replace(
    /(import \{[\s\S]*?\} from '@modern-js\/plugin-bff\/effect-client';\n)/,
    `$1${importBlock}`,
  );
  if (nextWithImport === source) {
    throw new Error(`Could not add action contract imports in ${relativePath}.`);
  }
  const endpointBlock = `    )
    .add(
      HttpApiEndpoint.post('${endpointName}', '${routePath}', {
        error: ${actionCamel}ActionFailureSchema,
        headers: ${actionCamel}ActionHeadersSchema,
        payload: ${actionCamel}ActionPayloadSchema,
        success: ${actionCamel}ActionOutcomeSchema,
      }),
    ),
);`;
  const withEndpoint = nextWithImport.replace(/\s{4}\),\n\);/, endpointBlock);
  if (withEndpoint === nextWithImport) {
    throw new Error(`Could not append action endpoint in ${relativePath}.`);
  }

  const operationEntry = `  ${endpointName}: {
    method: 'POST',
    operationId: '${verticalPascal}Api:${verticalCamel}:${endpointName}',
    routePath: '${routePath}',
    source: 'generated-client',
  },
`;
  const withOperation = withEndpoint.replace(
    /export const [a-zA-Z0-9_$]+OperationContexts = \{\n/,
    (match) => `${match}${operationEntry}`,
  );
  if (withOperation === withEndpoint) {
    throw new Error(`Could not append action operation context in ${relativePath}.`);
  }

  await writeText(workspaceRoot, relativePath, withOperation);
};

const updateApiIndex = async ({ actionCamel, actionFile, verticalCamel, workspaceRoot }) => {
  const relativePath = `verticals/${verticalCamel}/api/index.ts`;
  const source = await readText(workspaceRoot, relativePath);
  const endpointName = `${actionCamel}Action`;
  if (source.includes(`.handle('${endpointName}'`)) {
    return;
  }

  const importBlock = `import { runCoreSdkAction } from './action-runtime.ts';
import { ${actionCamel}ActionRegistration } from '../src/actions/${actionFile}.ts';
`;
  const withImports = source.replace(
    /(import type \{[\s\S]*?\} from '\.\.\/shared\/api\.ts';\n)/,
    `$1${importBlock}`,
  );
  if (withImports === source) {
    throw new Error(`Could not add action imports in ${relativePath}.`);
  }

  const handlerBlock = `    )
    .handle('${endpointName}', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: ${actionCamel}ActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome),
        ),
      ).pipe(
        Effect.withSpan('ultramodern.api.${verticalCamel}.${endpointName}', {
          attributes: operationAttributes(${verticalCamel}OperationContexts.${endpointName}),
          kind: 'server',
        }),
      ),
    ),
);`;
  const withHandler = withImports.replace(/\s{4}\),\n\);/, handlerBlock);
  if (withHandler === withImports) {
    throw new Error(`Could not append action handler in ${relativePath}.`);
  }

  await writeText(workspaceRoot, relativePath, withHandler);
};

const updateEffectApiExpose = async ({ verticalSlug, workspaceRoot }) => {
  const relativePath = `verticals/${verticalSlug}/api/effect-api.ts`;
  const source = await readText(workspaceRoot, relativePath);
  if (source.includes('export const runtime = apiRuntime as unknown;')) {
    return;
  }

  const nextSource = source.replace(
    'export const runtime = apiRuntime;',
    'export const runtime = apiRuntime as unknown;',
  );
  if (nextSource === source) {
    throw new Error(`Could not make runtime export opaque in ${relativePath}.`);
  }

  await writeText(workspaceRoot, relativePath, nextSource);
};

const updateClient = async ({
  actionCamel,
  actionPascal,
  verticalCamel,
  verticalPascal,
  workspaceRoot,
}) => {
  const relativePath = `verticals/${verticalCamel}/src/api/${verticalCamel}-client.ts`;
  const source = await readText(workspaceRoot, relativePath);
  const functionName = `run${actionPascal}Action`;
  if (source.includes(`export const ${functionName} =`)) {
    return;
  }

  const withActionTypes = source.replace(
    /(import type \{[^}]*)(\} from '..\/..\/shared\/api';)/,
    `$1  ${actionPascal}ActionFailure,\n  ${actionPascal}ActionOutcome,\n  ${actionPascal}ActionPayload,\n$2`,
  );
  if (withActionTypes === source) {
    throw new Error(`Could not add action client types in ${relativePath}.`);
  }

  const withHeadersOption = withActionTypes.includes('headers?: Record<string, string>;')
    ? withActionTypes
    : withActionTypes.replace(
        /export interface [a-zA-Z0-9_$]+ClientOptions \{\n/,
        (match) => `${match}  headers?: Record<string, string>;\n`,
      );
  if (
    withHeadersOption === withActionTypes &&
    !withActionTypes.includes('headers?: Record<string, string>;')
  ) {
    throw new Error(`Could not add raw header client option in ${relativePath}.`);
  }
  const withClientError = withHeadersOption.includes(`| ${actionPascal}ActionFailure`)
    ? withHeadersOption
    : withHeadersOption.replace(
        new RegExp(`(export type ${verticalPascal}ClientError =\\n)`, 'u'),
        `$1  | ${actionPascal}ActionFailure\n`,
      );
  if (withClientError === withHeadersOption) {
    throw new Error(`Could not add action failure to client error union in ${relativePath}.`);
  }
  const helper = `

export const ${functionName} = (
  payload: ${actionPascal}ActionPayload,
  options: ${verticalPascal}ClientOptions & { idempotencyKey?: string } = {},
): ${verticalPascal}ClientEffect<${actionPascal}ActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return create${verticalPascal}Client({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext: options.operationContext ?? ${verticalCamel}OperationContexts.${actionCamel}Action,
  }).pipe(
    Effect.flatMap((client) =>
      client.${verticalCamel}.${actionCamel}Action({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};
`;

  await writeText(workspaceRoot, relativePath, `${withClientError}${helper}`);
};

const updateShellVerticalClients = async ({ actionPascal, workspaceRoot }) => {
  const relativePath = 'apps/shell-super-app/src/api/vertical-clients.ts';
  const source = await readText(workspaceRoot, relativePath);
  const exportName = `run${actionPascal}Action`;
  if (source.includes(exportName)) {
    return;
  }

  const withExport = source.replace(
    /(export \{\n)([\s\S]*?)(\} from '@app\/[a-z0-9-]+\/api\/client';\n)/,
    `$1  ${exportName},\n$2$3`,
  );
  if (withExport === source) {
    throw new Error(`Could not add shell vertical client export in ${relativePath}.`);
  }

  await writeText(workspaceRoot, relativePath, withExport);
};

const updatePackageJson = async ({ verticalSlug, workspaceRoot }) => {
  const relativePath = `verticals/${verticalSlug}/package.json`;
  const packageJson = await readJson(workspaceRoot, relativePath);
  packageJson.dependencies = {
    ...packageJson.dependencies,
    '@app/core-runtime': 'workspace:*',
  };
  await writeJson(workspaceRoot, relativePath, packageJson);
};

const updateTsconfig = async ({ verticalSlug, workspaceRoot }) => {
  const relativePath = `verticals/${verticalSlug}/tsconfig.json`;
  const tsconfig = await readJson(workspaceRoot, relativePath);
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
  if (!include.includes('shared/**/*.json')) {
    tsconfig.include = [...include, 'shared/**/*.json'];
  }
  const references = Array.isArray(tsconfig.references) ? tsconfig.references : [];
  if (!references.some((entry) => entry.path === '../../packages/core-runtime')) {
    tsconfig.references = [{ path: '../../packages/core-runtime' }, ...references];
  }
  await writeJson(workspaceRoot, relativePath, tsconfig);
};

const assertVerticalIsInstalledModule = async ({ verticalSlug, workspaceRoot }) => {
  const moduleState = await readText(
    workspaceRoot,
    'packages/shared-contracts/src/module-state.ts',
  );
  const match = moduleState.match(/installedModuleKeys\s*=\s*\[([\s\S]*?)\]\s*as const/);

  if (match === null || !match[1].includes(`'${verticalSlug}'`)) {
    throw new Error(
      `Module "${verticalSlug}" is not listed in packages/shared-contracts/src/module-state.ts.`,
    );
  }
};

module.exports = async function actionGenerator(context, generator) {
  const workspaceRoot = context.materials.default.basePath;
  const config = context.config;
  const verticalSlug = normaliseKebab(String(config.vertical ?? ''), 'vertical');
  const actionSlug = normaliseKebab(String(config.action ?? ''), 'action');
  const verticalCamel = toCamelCase(verticalSlug);
  const verticalPascal = toPascalCase(verticalSlug);
  const actionCamel = toCamelCase(actionSlug);
  const actionFile = actionSlug;
  const actionPascal = toPascalCase(actionSlug);
  const title = typeof config.title === 'string' ? config.title : toTitleCase(actionSlug);
  const actionKey =
    typeof config.actionKey === 'string' && config.actionKey.trim().length > 0
      ? config.actionKey.trim()
      : `${verticalSlug}.${actionCamel}`;
  const routePath = normaliseRoutePath({
    actionSlug,
    routePath: typeof config.path === 'string' ? config.path : undefined,
    verticalSlug,
  });
  const idempotency =
    typeof config.idempotency === 'string' && config.idempotency.trim().length > 0
      ? config.idempotency.trim()
      : 'optional';
  const moduleStateAccess =
    typeof config.moduleStateAccess === 'string' && config.moduleStateAccess.trim().length > 0
      ? config.moduleStateAccess.trim()
      : 'mutate';
  const permission =
    typeof config.permission === 'string' && config.permission.trim().length > 0
      ? config.permission.trim()
      : 'create';
  const resourceType =
    typeof config.resourceType === 'string' && config.resourceType.trim().length > 0
      ? config.resourceType.trim()
      : 'resource_type';
  const resourceId =
    typeof config.resourceId === 'string' && config.resourceId.trim().length > 0
      ? config.resourceId.trim()
      : actionKey;

  assertIdentifier(verticalCamel, 'vertical camel name');
  assertIdentifier(actionCamel, 'action camel name');
  assertActionKey(actionKey);
  assertEnumValue(idempotency, ['optional', 'required'], 'idempotency');
  assertEnumValue(moduleStateAccess, ['load', 'read', 'mutate'], 'module-state access');

  await fs.access(path.join(workspaceRoot, `verticals/${verticalSlug}/package.json`));
  await assertVerticalIsInstalledModule({ verticalSlug, workspaceRoot });

  await writeText(
    workspaceRoot,
    `verticals/${verticalSlug}/shared/actions/${actionFile}.ts`,
    createSharedActionContract({
      actionCamel,
      actionKey,
      actionPascal,
      title,
    }),
  );
  await writeText(
    workspaceRoot,
    `verticals/${verticalSlug}/src/actions/${actionFile}.ts`,
    createActionRegistration({
      actionCamel,
      actionFile,
      actionKey,
      actionPascal,
      idempotency,
      moduleStateAccess,
      permission,
      resourceId,
      resourceType,
      title,
      verticalSlug,
    }),
  );
  await writeText(
    workspaceRoot,
    `verticals/${verticalSlug}/api/action-runtime.ts`,
    createActionRuntime(),
  );

  await updateSharedApi({
    actionCamel,
    actionFile,
    routePath,
    verticalCamel,
    verticalPascal,
    workspaceRoot,
  });
  await updateApiIndex({
    actionCamel,
    actionFile,
    verticalCamel,
    workspaceRoot,
  });
  await updateEffectApiExpose({
    verticalSlug,
    workspaceRoot,
  });
  await updateClient({
    actionCamel,
    actionPascal,
    verticalCamel,
    verticalPascal,
    workspaceRoot,
  });
  await updateShellVerticalClients({
    actionPascal,
    workspaceRoot,
  });
  await updatePackageJson({ verticalSlug, workspaceRoot });
  await updateTsconfig({ verticalSlug, workspaceRoot });

  formatFiles(workspaceRoot, [
    `verticals/${verticalSlug}/shared/actions/${actionFile}.ts`,
    `verticals/${verticalSlug}/src/actions/${actionFile}.ts`,
    `verticals/${verticalSlug}/api/action-runtime.ts`,
    `verticals/${verticalSlug}/shared/api.ts`,
    `verticals/${verticalSlug}/api/index.ts`,
    `verticals/${verticalSlug}/api/effect-api.ts`,
    `verticals/${verticalSlug}/src/api/${verticalCamel}-client.ts`,
    `apps/shell-super-app/src/api/vertical-clients.ts`,
    `verticals/${verticalSlug}/package.json`,
    `verticals/${verticalSlug}/tsconfig.json`,
  ]);

  generator.logger.info(`Generated CoreSDK action ${actionKey} in ${verticalSlug}.`);
};
