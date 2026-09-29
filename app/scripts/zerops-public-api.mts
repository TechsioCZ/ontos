import { Config, Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { ZeropsApiError } from './zerops-public-api-error.mts';

/**
 * Minimal adapter over the Zerops public REST API for the operations the deploy runs without zcli: project
 * variables, service restarts and stops, and subdomain access. Responses are decoded, never logged, because
 * project variable listings can contain secrets. The token is read per request, so commands that
 * never call Zerops need no credentials.
 */
export const ZEROPS_PUBLIC_API_URL = 'https://api.app-prg1.zerops.io/api/rest/public';

const REQUEST_TIMEOUT = Duration.seconds(30);
/**
 * The project env file lists service-scoped variables such as `<hostname>_zeropsSubdomain` only when service
 * isolation is overridden, exactly as `zcli project env` requests it; without it only project variables return.
 */
const PROJECT_ENV_FILE_QUERY = 'name=&overrideEnvIsolation=none&userOnly=false&reveal=false';
const PROCESS_POLL_INTERVAL = Duration.seconds(3);
const PROCESS_TIMEOUT = Duration.minutes(15);

const ZeropsClientIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsClientId'));
const ZeropsEnvIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsEnvId'));
const ZeropsProcessIdSchema = Schema.NonEmptyString.pipe(Schema.brand('ZeropsProcessId'));

const ProcessSchema = Schema.Struct({
  id: ZeropsProcessIdSchema,
  status: Schema.String,
});
type ZeropsProcess = typeof ProcessSchema.Type;
const ProjectSchema = Schema.Struct({ clientId: ZeropsClientIdSchema });
const ProjectEnvSchema = Schema.Struct({
  content: Schema.String,
  id: ZeropsEnvIdSchema,
  key: Schema.String,
});
const ProjectSearchSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ envList: Schema.Array(ProjectEnvSchema) })),
});
const ServiceStackSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  /** Zerops lifecycle status, such as `ACTIVE` for a running service or `STOPPED`. */
  status: Schema.String,
  subdomainAccess: Schema.Boolean,
});
const EnvFileSchema = Schema.Struct({ envFile: Schema.String });

export type ZeropsProjectEnv = typeof ProjectEnvSchema.Type;
export type ZeropsServiceStack = typeof ServiceStackSchema.Type;

interface ProjectEnvBody {
  readonly content: string;
  readonly key: string;
  readonly sensitive: boolean;
}

interface ProjectSearchBody {
  readonly search: readonly { readonly name: string; readonly operator: 'eq'; readonly value: string }[];
  readonly sort: readonly never[];
}

const failure = (message: string) => (cause: unknown) => new ZeropsApiError({ cause, message });

const terminalProcessStatuses: ReadonlySet<string> = new Set(['CANCELED', 'FAILED', 'FINISHED']);

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

/** Reads Zerops `KEY="VALUE"` env-file lines into a map of variable values. */
export const parseZeropsEnvFile = (envFile: string): ReadonlyMap<string, string> =>
  new Map(
    envFile.split('\n').flatMap((line) => {
      const separator = line.indexOf('=');
      return separator <= 0 ? [] : [[line.slice(0, separator), unquote(line.slice(separator + 1))] as const];
    }),
  );

export interface ZeropsPublicApiService {
  /** Creates a sensitive secret on one service (a Zerops service "user data" entry) and waits until Zerops applied it. */
  readonly createServiceSecret: (
    serviceId: string,
    key: string,
    content: string,
  ) => Effect.Effect<void, ZeropsApiError>;
  readonly enableSubdomainAccess: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  readonly projectEnvFile: (projectId: string) => Effect.Effect<ReadonlyMap<string, string>, ZeropsApiError>;
  readonly projectEnvs: (projectId: string) => Effect.Effect<readonly ZeropsProjectEnv[], ZeropsApiError>;
  readonly restartService: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  readonly serviceStack: (serviceId: string) => Effect.Effect<ZeropsServiceStack, ZeropsApiError>;
  readonly stopService: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  /** Creates the project variable, or updates it in place when it exists, and waits until Zerops applied it. */
  readonly upsertProjectEnv: (
    projectId: string,
    existing: ZeropsProjectEnv | undefined,
    key: string,
    content: string,
  ) => Effect.Effect<void, ZeropsApiError>;
}

export class ZeropsPublicApi extends Context.Service<ZeropsPublicApi, ZeropsPublicApiService>()(
  '@app/scripts/zerops-public-api/ZeropsPublicApi',
) {}

const makeZeropsPublicApi = Effect.gen(function* makeZeropsPublicApi() {
  const baseClient = yield* HttpClient.HttpClient;
  const client = baseClient.pipe(
    HttpClient.mapRequestEffect((request) =>
      Config.Redacted('ZEROPS_TOKEN').pipe(
        Effect.map((token) => HttpClientRequest.bearerToken(request, Redacted.value(token))),
      ),
    ),
    HttpClient.filterStatusOk,
  );

  const send = <A, I>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>, label: string) =>
    client.execute(request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(failure(`Zerops ${label} failed`)),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new ZeropsApiError({ message: `Zerops ${label} timed out` })),
      }),
    );

  const get = <A, I>(path: string, schema: Schema.Codec<A, I>, label: string) =>
    send(HttpClientRequest.get(`${ZEROPS_PUBLIC_API_URL}${path}`), schema, label);

  const withJson = <Body extends ProjectEnvBody | ProjectSearchBody, A, I>(
    request: HttpClientRequest.HttpClientRequest,
    body: Body,
    schema: Schema.Codec<A, I>,
    label: string,
  ) => send(HttpClientRequest.bodyJsonUnsafe(request, body), schema, label);

  const awaitProcess = Effect.fn('ZeropsPublicApi.awaitProcess')(function* awaitProcess(
    process: ZeropsProcess,
    label: string,
  ) {
    const finished = yield* get(`/process/${process.id}`, ProcessSchema, `${label} process`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(PROCESS_POLL_INTERVAL),
        until: ({ status }) => terminalProcessStatuses.has(status),
      }),
      Effect.timeoutOrElse({
        duration: PROCESS_TIMEOUT,
        orElse: () => Effect.fail(new ZeropsApiError({ message: `Zerops ${label} process did not finish in time` })),
      }),
    );
    if (finished.status !== 'FINISHED') {
      return yield* new ZeropsApiError({ message: `Zerops ${label} process ended as ${finished.status}` });
    }
    return yield* Effect.void;
  });

  const projectEnvs = Effect.fn('ZeropsPublicApi.projectEnvs')(function* readProjectEnvs(projectId: string) {
    const { clientId } = yield* get(`/project/${projectId}`, ProjectSchema, 'project read');
    const search = yield* withJson(
      HttpClientRequest.post(`${ZEROPS_PUBLIC_API_URL}/project/search`),
      {
        search: [
          { name: 'clientId', operator: 'eq', value: clientId },
          { name: 'id', operator: 'eq', value: projectId },
        ],
        sort: [],
      },
      ProjectSearchSchema,
      'project search',
    );
    const [project] = search.items;
    if (project === undefined) {
      return yield* new ZeropsApiError({
        message: 'Zerops project search did not return the project',
        reason: 'project_not_indexed',
      });
    }
    return project.envList;
  });

  const upsertProjectEnv = Effect.fn('ZeropsPublicApi.upsertProjectEnv')(function* writeProjectEnv(
    projectId: string,
    existing: ZeropsProjectEnv | undefined,
    key: string,
    content: string,
  ) {
    const body: ProjectEnvBody = { content, key, sensitive: false };
    const process =
      existing === undefined
        ? yield* withJson(
            HttpClientRequest.post(`${ZEROPS_PUBLIC_API_URL}/project/${projectId}/env`),
            body,
            ProcessSchema,
            'variable create',
          )
        : yield* withJson(
            HttpClientRequest.put(`${ZEROPS_PUBLIC_API_URL}/project-env/${existing.id}`),
            body,
            ProcessSchema,
            'variable update',
          );
    yield* awaitProcess(process, `project variable ${key}`);
  });

  const createServiceSecret = Effect.fn('ZeropsPublicApi.createServiceSecret')(function* writeServiceSecret(
    serviceId: string,
    key: string,
    content: string,
  ) {
    const process = yield* withJson(
      HttpClientRequest.post(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}/user-data`),
      { content, key, sensitive: true },
      ProcessSchema,
      'service secret create',
    );
    yield* awaitProcess(process, `service secret ${key}`);
  });

  const serviceAction = Effect.fn('ZeropsPublicApi.serviceAction')(function* runServiceAction(
    serviceId: string,
    action: 'enable-subdomain-access' | 'restart' | 'stop',
  ) {
    const process = yield* send(
      HttpClientRequest.put(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}/${action}`),
      ProcessSchema,
      `service ${action}`,
    );
    yield* awaitProcess(process, `service ${action}`);
  });

  return ZeropsPublicApi.of({
    createServiceSecret,
    enableSubdomainAccess: (serviceId) => serviceAction(serviceId, 'enable-subdomain-access'),
    projectEnvFile: (projectId) =>
      get(`/project/${projectId}/env-file?${PROJECT_ENV_FILE_QUERY}`, EnvFileSchema, 'project env file').pipe(
        Effect.map(({ envFile }) => parseZeropsEnvFile(envFile)),
      ),
    projectEnvs,
    restartService: (serviceId) => serviceAction(serviceId, 'restart'),
    serviceStack: (serviceId) => get(`/service-stack/${serviceId}`, ServiceStackSchema, 'service read'),
    stopService: (serviceId) => serviceAction(serviceId, 'stop'),
    upsertProjectEnv,
  });
});

export const ZeropsPublicApiLive = Layer.effect(ZeropsPublicApi, makeZeropsPublicApi);
