import { Config, Context, Duration, Effect, Layer, Match, Option, Redacted, Schedule, Schema, Stream } from 'effect';
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http';

import { ZeropsApiError } from './zerops-public-api-error.mts';

/**
 * Minimal adapter over the Zerops public REST API for the operations the deploy runs without zcli: project
 * variables, service stops, and subdomain access. Responses are decoded, never logged, because
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
const STOP_READBACK_TIMEOUT = Duration.seconds(60);

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
const StopServiceStackSchema = Schema.Struct({ ...ServiceStackSchema.fields, id: Schema.NonEmptyString });
/** Native identity needed before permanently retiring an executable service. */
const ServiceStackIdentitySchema = Schema.Struct({
  base: Schema.NonEmptyString,
  isSystem: Schema.Boolean,
  name: Schema.NonEmptyString,
  status: Schema.String,
  subdomainAccess: Schema.Boolean,
});
/** Zerops answers a read of a deleted or unknown service with HTTP 400 and this error code. */
const SERVICE_STACK_NOT_FOUND = 'serviceStackNotFound';
const ErrorBodySchema = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const EnvFileSchema = Schema.Struct({ envFile: Schema.String });
const ServiceUserDataPageSchema = Schema.Struct({
  list: Schema.Array(Schema.Struct({ content: Schema.String, key: Schema.String })),
  total: Schema.Number,
});
/** The page size for service user data listings; `total` tells whether another page follows. */
const SERVICE_USER_DATA_PAGE = 100;

export type ZeropsProjectEnv = typeof ProjectEnvSchema.Type;
export type ZeropsServiceStack = typeof ServiceStackSchema.Type;
export type ZeropsServiceStackIdentity = typeof ServiceStackIdentitySchema.Type;

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
  /** Permanently deletes a service and waits for the native deletion process to finish. */
  readonly deleteService: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  readonly enableSubdomainAccess: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  /** Reads a service like `serviceStack`, but a deleted or unknown service is `None` rather than an error. */
  readonly findServiceStack: (serviceId: string) => Effect.Effect<Option.Option<ZeropsServiceStack>, ZeropsApiError>;
  readonly findServiceStackIdentity: (
    serviceId: string,
  ) => Effect.Effect<Option.Option<ZeropsServiceStackIdentity>, ZeropsApiError>;
  readonly projectEnvFile: (projectId: string) => Effect.Effect<ReadonlyMap<string, string>, ZeropsApiError>;
  readonly projectEnvs: (projectId: string) => Effect.Effect<readonly ZeropsProjectEnv[], ZeropsApiError>;
  /**
   * Reads every secret on one service (its "user data" entries) with their values. Unlike `zcli project env`,
   * which prints `REDACTED` for sensitive secrets, the API returns the stored values to the owning token.
   */
  readonly serviceSecrets: (serviceId: string) => Effect.Effect<ReadonlyMap<string, Redacted.Redacted>, ZeropsApiError>;
  readonly serviceStack: (serviceId: string) => Effect.Effect<ZeropsServiceStack, ZeropsApiError>;
  /** Waits for the native stop process and independently reads the service as STOPPED. */
  readonly stopService: (serviceId: string) => Effect.Effect<void, ZeropsApiError>;
  /** Creates the project variable, or updates it in place when it exists, and waits until Zerops applied it. */
  readonly upsertProjectEnv: (
    projectId: string,
    existing: ZeropsProjectEnv | undefined,
    key: string,
    content: string,
    sensitive: boolean,
  ) => Effect.Effect<void, ZeropsApiError>;
}

export class ZeropsPublicApi extends Context.Service<ZeropsPublicApi, ZeropsPublicApiService>()(
  '@app/scripts/zerops-public-api/ZeropsPublicApi',
) {}

const awaitStoppedService = Effect.fn('ZeropsPublicApi.awaitStoppedService')(function* awaitStoppedService(
  authorizedClient: HttpClient.HttpClient.With<Config.ConfigError | HttpClientError.HttpClientError>,
  serviceId: string,
) {
  let lastRead = 'no response';
  const readStopped = Effect.gen(function* readStoppedService() {
    const response = yield* authorizedClient
      .execute(HttpClientRequest.get(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}`))
      .pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) =>
            HttpClientError.isHttpClientError(error) &&
            Match.value(error.reason).pipe(
              Match.tag('TransportError', () => true),
              Match.orElse(() => false),
            ),
          () =>
            Effect.sync(() => {
              lastRead = 'transport failure';
              return Option.none();
            }),
        ),
        Effect.mapError(() => new ZeropsApiError({ message: 'Zerops service stop readback request failed' })),
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            Effect.sync(() => {
              lastRead = 'request timed out';
              return Option.none();
            }),
        }),
      );
    if (Option.isNone(response)) {
      return false;
    }
    const { status } = response.value;
    lastRead = `HTTP ${String(status)}`;
    if (status === 429 || (status >= 500 && status <= 599)) {
      yield* response.value.stream.pipe(
        Stream.runDrain,
        Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.void }),
        Effect.ignore,
      );
      return false;
    }
    if (status >= 200 && status < 300) {
      const body = yield* response.value.json.pipe(
        Effect.mapError(() => new ZeropsApiError({ message: 'Zerops service stop readback returned invalid JSON' })),
      );
      const service = yield* Schema.decodeUnknownEffect(StopServiceStackSchema)(body).pipe(
        Effect.mapError(
          () => new ZeropsApiError({ message: 'Zerops service stop readback returned an invalid service state' }),
        ),
      );
      if (service.id !== serviceId) {
        return yield* new ZeropsApiError({
          message: 'Zerops service stop readback returned a different service identity',
        });
      }
      const lifecycle = /^[A-Z][A-Z_]{0,31}$/u.test(service.status) ? service.status : 'unknown';
      lastRead += `; status ${lifecycle}`;
      return service.status === 'STOPPED';
    }
    if (status === 400) {
      const body = yield* response.value.json.pipe(
        Effect.mapError(() => new ZeropsApiError({ message: 'Zerops service stop readback returned invalid JSON' })),
      );
      if (
        Schema.decodeUnknownOption(ErrorBodySchema)(body).pipe(
          Option.exists(({ error }) => error.code === SERVICE_STACK_NOT_FOUND),
        )
      ) {
        return yield* new ZeropsApiError({ message: 'Zerops service disappeared while verifying its stop' });
      }
    }
    return yield* new ZeropsApiError({ message: `Zerops service stop readback failed with HTTP ${String(status)}` });
  });
  yield* readStopped.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(PROCESS_POLL_INTERVAL),
      until: (stopped) => stopped,
    }),
    Effect.timeoutOrElse({
      duration: STOP_READBACK_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ZeropsApiError({
            message: `Zerops service did not become STOPPED within 60 seconds; last read: ${lastRead}`,
          }),
        ),
    }),
  );
});

const makeZeropsPublicApi = Effect.gen(function* makeZeropsPublicApi() {
  const baseClient = yield* HttpClient.HttpClient;
  const authorizedClient = baseClient.pipe(
    HttpClient.mapRequestEffect((request) =>
      Config.Redacted('ZEROPS_TOKEN').pipe(
        Effect.map((token) => HttpClientRequest.bearerToken(request, Redacted.value(token))),
      ),
    ),
  );
  const client = authorizedClient.pipe(HttpClient.filterStatusOk);

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
    sensitive: boolean,
  ) {
    const body: ProjectEnvBody = { content, key, sensitive };
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

  const serviceSecrets = Effect.fn('ZeropsPublicApi.serviceSecrets')(function* readServiceSecrets(serviceId: string) {
    const secrets = new Map<string, Redacted.Redacted>();
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const page = yield* get(
        `/service-stack/${serviceId}/user-data?limit=${String(SERVICE_USER_DATA_PAGE)}&offset=${String(offset)}`,
        ServiceUserDataPageSchema,
        'service secret list',
      );
      for (const { content, key } of page.list) {
        secrets.set(key, Redacted.make(content));
      }
      if (page.list.length === 0) {
        break;
      }
      offset += page.list.length;
      ({ total } = page);
    }
    return secrets;
  });

  const serviceAction = Effect.fn('ZeropsPublicApi.serviceAction')(function* runServiceAction(
    serviceId: string,
    action: 'enable-subdomain-access' | 'stop',
  ) {
    const process = yield* send(
      HttpClientRequest.put(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}/${action}`),
      ProcessSchema,
      `service ${action}`,
    );
    yield* awaitProcess(process, `service ${action}`);
  });

  const deleteService = Effect.fn('ZeropsPublicApi.deleteService')(function* deleteService(serviceId: string) {
    const process = yield* send(
      HttpClientRequest.make('DELETE')(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}`),
      ProcessSchema,
      'service delete',
    );
    yield* awaitProcess(process, 'service delete');
  });

  const findServiceStackWith = <A, I>(serviceId: string, schema: Schema.Codec<A, I>) =>
    Effect.gen(function* readServiceStack() {
      const readFailed = failure('Zerops service read failed');
      const response = yield* authorizedClient
        .execute(HttpClientRequest.get(`${ZEROPS_PUBLIC_API_URL}/service-stack/${serviceId}`))
        .pipe(
          Effect.mapError(readFailed),
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT,
            orElse: () => Effect.fail(new ZeropsApiError({ message: 'Zerops service read timed out' })),
          }),
        );
      const body = yield* response.json.pipe(Effect.mapError(readFailed));
      if (response.status >= 200 && response.status < 300) {
        return Option.some(yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(readFailed)));
      }
      const notFound = Schema.decodeUnknownOption(ErrorBodySchema)(body).pipe(
        Option.exists(({ error }) => error.code === SERVICE_STACK_NOT_FOUND),
      );
      if (response.status === 400 && notFound) {
        return Option.none();
      }
      return yield* new ZeropsApiError({ message: `Zerops service read failed with HTTP ${String(response.status)}` });
    });

  return ZeropsPublicApi.of({
    createServiceSecret,
    deleteService,
    enableSubdomainAccess: (serviceId) => serviceAction(serviceId, 'enable-subdomain-access'),
    findServiceStack: (serviceId) => findServiceStackWith(serviceId, ServiceStackSchema),
    findServiceStackIdentity: (serviceId) => findServiceStackWith(serviceId, ServiceStackIdentitySchema),
    projectEnvFile: (projectId) =>
      get(`/project/${projectId}/env-file?${PROJECT_ENV_FILE_QUERY}`, EnvFileSchema, 'project env file').pipe(
        Effect.map(({ envFile }) => parseZeropsEnvFile(envFile)),
      ),
    projectEnvs,
    serviceSecrets,
    serviceStack: (serviceId) => get(`/service-stack/${serviceId}`, ServiceStackSchema, 'service read'),
    stopService: (serviceId) =>
      serviceAction(serviceId, 'stop').pipe(Effect.andThen(awaitStoppedService(authorizedClient, serviceId))),
    upsertProjectEnv,
  });
});

export const ZeropsPublicApiLive = Layer.effect(ZeropsPublicApi, makeZeropsPublicApi);
