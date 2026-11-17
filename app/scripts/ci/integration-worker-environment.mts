import { Option, Schema } from 'effect';

const LocalDatabaseUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'postgresql:' && ['localhost', '127.0.0.1'].includes(url.hostname)
      ? undefined
      : 'CI integration workers require a local PostgreSQL cluster',
  ),
);
const workerSlots = ['1', '2', '3', '4'] as const;
const WorkerSlotSchema = Schema.Literals(workerSlots);
export const isIntegrationWorkerEndpoint = (input: {
  readonly container: string;
  readonly isolatedWorkers: string;
  readonly port: number;
}) =>
  ['2', '3', '4'].includes(input.isolatedWorkers) &&
  workerSlots
    .filter((worker) => Number(worker) <= Number(input.isolatedWorkers))
    .some((worker) => input.container === `ontos-ci-db-${worker}` && input.port === 5540 + Number(worker));
export const IntegrationWorkerSettingsSchema = Schema.Union([
  Schema.Struct({ ONTOS_CI_ISOLATED_WORKERS: Schema.optionalKey(Schema.Undefined) }),
  Schema.Struct({
    DATABASE_ADMIN_URL: LocalDatabaseUrl,
    DATABASE_URL: LocalDatabaseUrl,
    ONTOS_CI_ISOLATED_WORKERS: Schema.Literals(['2', '3', '4']),
    ONTOS_CI_WORKER_SLOT: Schema.optionalKey(WorkerSlotSchema),
    PARTY_REGISTRY_DATABASE_URL: LocalDatabaseUrl,
    PARTY_REGISTRY_WORKER_DATABASE_URL: LocalDatabaseUrl,
    RSTEST_WORKER_ID: WorkerSlotSchema,
    SHELL_GATEWAY_ISSUER_DATABASE_URL: LocalDatabaseUrl,
  }).check(
    Schema.makeFilter((settings) =>
      Number(settings.ONTOS_CI_WORKER_SLOT ?? settings.RSTEST_WORKER_ID) <= Number(settings.ONTOS_CI_ISOLATED_WORKERS)
        ? undefined
        : 'CI integration worker slot is not provisioned',
    ),
  ),
]);
type IntegrationWorkerSettings = typeof IntegrationWorkerSettingsSchema.Type;

const retargetDatabase = (original: URL, worker: string) => {
  const url = new URL(original.href);
  url.port = String(5540 + Number(worker));
  return url.href;
};

/** Each Rstest slot owns a whole cluster: ALTER ROLE is not database-local. */
export const integrationWorkerEnvironment = (settings: IntegrationWorkerSettings) => {
  if (settings.ONTOS_CI_ISOLATED_WORKERS === undefined) {
    return Option.none();
  }
  const worker = settings.ONTOS_CI_WORKER_SLOT ?? settings.RSTEST_WORKER_ID;
  return Option.some({
    DATABASE_ADMIN_URL: retargetDatabase(settings.DATABASE_ADMIN_URL, worker),
    DATABASE_URL: retargetDatabase(settings.DATABASE_URL, worker),
    ONTOS_TEST_DB_CONTAINER: `ontos-ci-db-${worker}`,
    ONTOS_TEST_SCHEMA_TEMPLATE: 'ontos_ci_schema_template',
    ONTOS_TEST_SCHEMA_TEMPLATE_SOURCE: settings.DATABASE_ADMIN_URL.pathname.slice(1),
    PARTY_REGISTRY_DATABASE_URL: retargetDatabase(settings.PARTY_REGISTRY_DATABASE_URL, worker),
    PARTY_REGISTRY_WORKER_DATABASE_URL: retargetDatabase(settings.PARTY_REGISTRY_WORKER_DATABASE_URL, worker),
    POSTGRES_PORT: String(5540 + Number(worker)),
    SHELL_GATEWAY_ISSUER_DATABASE_URL: retargetDatabase(settings.SHELL_GATEWAY_ISSUER_DATABASE_URL, worker),
    SPICEDB_ENDPOINT: `localhost:${55_050 + Number(worker)}`,
    SPICEDB_GRPC_PORT: String(55_050 + Number(worker)),
    SPICEDB_HTTP_PORT: String(58_440 + Number(worker)),
  });
};
