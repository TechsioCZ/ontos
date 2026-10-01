import { Effect, Layer, Option, Redacted, Stdio, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { CloudflareApiLive, CloudflareCredentials } from '../ops/cloudflare-api.mts';
import {
  PRODUCTION_PROJECT_NAME,
  ProductionEnvironmentConfiguration,
  ensureProductionSpicedbTls,
  parseZeropsProjectList,
  productionServices,
  provision,
  renderProductionImport,
  suppliedSecretNames,
} from '../ops/production-environment.mts';
import type { ProvisionOptions } from '../ops/production-environment.mts';
import { renderCommand } from '../ops/ops-shell.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID } from '../ops/stage-operations.mts';
import {
  APP_DIRECTORY,
  fakeCloudflareAccount,
  fakeFiles,
  fakeStage,
  fakeZeropsApi,
  mutatingCommands,
} from './stage-operations-fixture.mts';
import type { FakeFiles, FakeStage } from './stage-operations-fixture.mts';

const PRODUCTION = 'production';
const STAGE_ORG_ID = 'org-techsio';
const SPICEDB_ENDPOINT = 'spicedb.ontos.example:443';
const ZEROPS_TOKEN = 'production-zerops-token';
const SECRETS_FILE = 'production-secrets.env';
const DB_HOSTNAME = 'db18';
const SHELL_HOSTNAME = 'shellsuperapp';
const MIGRATOR_HOSTNAME = 'migrator';
const PROJECT_ID_VARIABLE = 'ZEROPS_PROJECT_ID';
const SHELL_VARIABLE = 'ZEROPS_SHELL_SERVICE_ID';
const SERVICE_IMPORT = 'project service-import';

const STAGE_PROJECT = { id: STAGE_ZEROPS_PROJECT_ID, name: 'ontos', orgId: STAGE_ORG_ID };

const options = (overrides: Partial<ProvisionOptions> = {}): ProvisionOptions => ({
  orgId: Option.none(),
  secretsFile: Option.some(`${APP_DIRECTORY}/${SECRETS_FILE}`),
  spicedbEndpoint: SPICEDB_ENDPOINT,
  zeropsTokenStdin: true,
  ...overrides,
});

const productionHostnames = productionServices.pipe(
  Effect.map((services) => services.map(({ entry }) => entry.hostname)),
);

/** A vault export holding every supplied secret the production services need. */
const secretsFiles = Effect.gen(function* secretsFilesEffect() {
  const services = yield* productionServices.pipe(Effect.provide(fakeFiles().layer));
  const names = suppliedSecretNames(services.map(({ entry }) => entry));
  return fakeFiles({ [SECRETS_FILE]: names.map((name) => `${name}='value-of-${name}'`).join('\n') });
});

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fakes: { readonly dryRun?: boolean; readonly files: FakeFiles; readonly stage: FakeStage },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(OpsMode, { dryRun: fakes.dryRun ?? false }),
        Layer.succeed(ProductionEnvironmentConfiguration, {
          repository: 'TechsioCZ/ontos',
          stageProjectId: STAGE_ZEROPS_PROJECT_ID,
        }),
        Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(`${ZEROPS_TOKEN}\n`)) }),
        fakes.stage.layer,
        fakes.files.layer,
      ),
    ),
  );

const rendered = (stage: FakeStage) => stage.commands.map(renderCommand);

it('parses the project table zcli prints', () => {
  expect(
    parseZeropsProjectList(
      [
        '┌────┬──────┬──────────┬────────┬────────┬─────────┐',
        '│ ID │ NAME │ ORG NAME │ ORG ID │ STATUS │ MODE    │',
        '├────┼──────┼──────────┼────────┼────────┼─────────┤',
        '│ p1 │ ontos │ Techsio │ o1 │ ACTIVE │ LIGHT │',
        '└────┴──────┴──────────┴────────┴────────┴─────────┘',
      ].join('\n'),
    ),
  ).toStrictEqual([{ id: 'p1', name: 'ontos', orgId: 'o1' }]);
});

it.effect('derives a high-availability import from stage and maps every runtime service to its setup', () =>
  Effect.gen(function* derivesProductionImport() {
    const services = yield* productionServices.pipe(Effect.provide(fakeFiles().layer));
    const byHostname = new Map(services.map((service) => [service.entry.hostname, service]));

    expect(byHostname.has('cloudflared')).toBe(false);
    expect(byHostname.has('outboxworkerhost')).toBe(false);
    expect(byHostname.get(DB_HOSTNAME)?.entry.type).toBe('postgresql:ha@18');
    expect(byHostname.get(DB_HOSTNAME)?.setup).toStrictEqual(Option.none());
    expect(byHostname.get(MIGRATOR_HOSTNAME)?.entry.minContainers).toBeUndefined();
    for (const { entry, setup } of services) {
      if (entry.hostname === DB_HOSTNAME) {
        continue;
      }
      expect(Option.isSome(setup)).toBe(true);
      if (entry.hostname !== MIGRATOR_HOSTNAME) {
        expect(entry.minContainers).toBe(2);
      }
    }
    const variableOf = (hostname: string) =>
      Option.fromNullishOr(byHostname.get(hostname)).pipe(
        Option.flatMap(({ setup }) => setup),
        Option.map(({ variable }) => variable),
      );
    expect(variableOf('commercecstmrcntxtworker')).toStrictEqual(
      Option.some('ZEROPS_COMMERCE_CUSTOMER_CONTEXT_WORKER_SERVICE_ID'),
    );
    expect(variableOf(SHELL_HOSTNAME)).toStrictEqual(Option.some(SHELL_VARIABLE));
  }),
);

it.effect('renders generated and supplied secrets into the import', () =>
  Effect.gen(function* rendersSecrets() {
    const services = yield* productionServices.pipe(Effect.provide(fakeFiles().layer));
    const shell = services.filter(({ entry }) => entry.hostname === SHELL_HOSTNAME).map(({ entry }) => entry);
    const document = Redacted.value(
      renderProductionImport(
        shell,
        new Map([['shellsuperapp_BETTER_AUTH_URL', Redacted.make('https://ontos.example')]]),
      ),
    );

    expect(document.startsWith('#yamlPreprocessor=on\n')).toBe(true);
    expect(document).toContain('BETTER_AUTH_SECRET: <@generateRandomString(<48>)>');
    expect(document).toContain('BETTER_AUTH_URL: https://ontos.example');
  }),
);

it.effect('provisions production from nothing and wires the production environment to it', () =>
  Effect.gen(function* provisionsFromNothing() {
    const stage = fakeStage({ projects: [STAGE_PROJECT] });
    const files = yield* secretsFiles;
    const hostnames = yield* productionHostnames.pipe(Effect.provide(files.layer));

    yield* run(provision(options()), { files, stage });

    expect(stage.environments.has(PRODUCTION)).toBe(true);
    expect(stage.branchPolicies).toStrictEqual([{ environment: PRODUCTION, name: 'main' }]);
    expect(stage.projects).toStrictEqual([
      STAGE_PROJECT,
      { id: 'project-2', name: PRODUCTION_PROJECT_NAME, orgId: STAGE_ORG_ID },
    ]);
    expect(stage.services.map(({ hostname }) => hostname)).toStrictEqual(hostnames);
    const serviceImport = stage.inputs.find(({ command }) => command.includes(SERVICE_IMPORT));
    expect(serviceImport?.command).toBe('zcli project service-import - --project-id project-2');
    expect(serviceImport?.stdin).toContain('type: postgresql:ha@18');
    expect(serviceImport?.stdin).toContain('ONTOS_GATEWAY_PUBLIC_JWKS: value-of-catalog_ONTOS_GATEWAY_PUBLIC_JWKS');
    expect(serviceImport?.stdin).not.toContain('cloudflared');

    const variables = stage.variables.get(PRODUCTION);
    expect(variables?.get(PROJECT_ID_VARIABLE)).toBe('project-2');
    expect(variables?.get('SPICEDB_ENDPOINT')).toBe(SPICEDB_ENDPOINT);
    expect(variables?.get('DEPLOY_TARGET')).toBe('zerops');
    expect(variables?.get('OUTBOX_WORKER_MODE')).toBe('dedicated');
    expect(variables?.get(SHELL_VARIABLE)).toBe(stage.services.find(({ hostname }) => hostname === SHELL_HOSTNAME)?.id);
    expect(variables?.get('ZEROPS_MIGRATOR_SERVICE_ID')).toBeDefined();
    expect(variables?.get('ZEROPS_SPICEDB_SERVICE_ID')).toBeDefined();
    expect(variables?.has('ZEROPS_DB18_SERVICE_ID')).toBe(false);
    expect(stage.secrets.get(PRODUCTION)).toStrictEqual(new Set(['ZEROPS_TOKEN']));
    expect(stage.inputs.find(({ command }) => command.startsWith('gh secret set'))?.stdin).toBe(ZEROPS_TOKEN);
    expect(rendered(stage).some((command) => command.includes(ZEROPS_TOKEN))).toBe(false);
    expect(stage.variables.has('stage')).toBe(false);
  }),
);

it.effect('changes nothing in a dry run', () =>
  Effect.gen(function* changesNothingInDryRun() {
    const stage = fakeStage({ projects: [STAGE_PROJECT] });

    yield* run(provision(options()), { dryRun: true, files: yield* secretsFiles, stage });

    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
    expect(stage.projects).toStrictEqual([STAGE_PROJECT]);
  }),
);

it.effect('changes nothing when re-run against a provisioned production', () =>
  Effect.gen(function* convergesOnReRun() {
    const stage = fakeStage({ projects: [STAGE_PROJECT] });
    const files = yield* secretsFiles;
    yield* run(provision(options()), { files, stage });
    const before = stage.commands.length;

    yield* run(provision(options({ secretsFile: Option.none(), zeropsTokenStdin: false })), { files, stage });

    expect(mutatingCommands(stage.commands.slice(before))).toStrictEqual([]);
  }),
);

it.effect('imports only the services a partial production lacks, into the project named ontos-production', () =>
  Effect.gen(function* resumesPartialImport() {
    const stage = fakeStage({
      environments: ['stage', PRODUCTION],
      projects: [STAGE_PROJECT, { id: 'prod-id', name: PRODUCTION_PROJECT_NAME, orgId: STAGE_ORG_ID }],
      secrets: { [PRODUCTION]: ['ZEROPS_TOKEN'] },
      services: [
        { hostname: DB_HOSTNAME, id: 'db-id', status: 'ACTIVE' },
        { hostname: SHELL_HOSTNAME, id: 'shell-id', status: 'ACTIVE' },
      ],
    });

    yield* run(provision(options({ zeropsTokenStdin: false })), { files: yield* secretsFiles, stage });

    const serviceImport = stage.inputs.find(({ command }) => command.includes(SERVICE_IMPORT));
    expect(serviceImport?.stdin).not.toContain(`hostname: ${DB_HOSTNAME}`);
    expect(serviceImport?.stdin).not.toContain(`hostname: ${SHELL_HOSTNAME}`);
    expect(stage.projects).toHaveLength(2);
    expect(stage.variables.get(PRODUCTION)?.get(SHELL_VARIABLE)).toBe('shell-id');
    expect(stage.variables.get(PRODUCTION)?.get(PROJECT_ID_VARIABLE)).toBe('prod-id');
    expect(rendered(stage).some((command) => command.startsWith('gh secret set'))).toBe(false);
  }),
);

it.effect('refuses a production project ID that names the stage project', () =>
  Effect.gen(function* refusesStageProject() {
    const stage = fakeStage({
      environments: ['stage', PRODUCTION],
      projects: [STAGE_PROJECT],
      variables: { [PRODUCTION]: { [PROJECT_ID_VARIABLE]: STAGE_ZEROPS_PROJECT_ID } },
    });

    const error = yield* run(provision(options()), { files: yield* secretsFiles, stage }).pipe(Effect.flip);

    expect(error.message).toContain('names the stage project');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('refuses a service-ID variable that names another service than Zerops runs', () =>
  Effect.gen(function* refusesDrift() {
    const stage = fakeStage({
      environments: ['stage', PRODUCTION],
      projects: [STAGE_PROJECT, { id: 'prod-id', name: PRODUCTION_PROJECT_NAME, orgId: STAGE_ORG_ID }],
      services: [{ hostname: SHELL_HOSTNAME, id: 'shell-id', status: 'ACTIVE' }],
      variables: { [PRODUCTION]: { [SHELL_VARIABLE]: 'other-id' } },
    });

    const error = yield* run(provision(options()), { files: yield* secretsFiles, stage }).pipe(Effect.flip);

    expect(error.message).toContain(`${SHELL_VARIABLE} names other-id`);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('fails before importing when the secrets file lacks a supplied secret', () =>
  Effect.gen(function* failsOnMissingSecrets() {
    const stage = fakeStage({ projects: [STAGE_PROJECT] });
    const files = fakeFiles({ [SECRETS_FILE]: "shellsuperapp_BETTER_AUTH_URL='https://ontos.example'\n" });

    const error = yield* run(provision(options()), { files, stage }).pipe(Effect.flip);

    expect(error.message).toContain('the secrets file lacks shellsuperapp_BETTER_AUTH_TRUSTED_ORIGINS');
    expect(rendered(stage).some((command) => command.includes(SERVICE_IMPORT))).toBe(false);
    expect(stage.variables.get(PRODUCTION)?.size ?? 0).toBe(0);
  }),
);

it.effect('fails before any change when production has no Zerops token and none is piped', () =>
  Effect.gen(function* failsWithoutToken() {
    const stage = fakeStage({ environments: ['stage', PRODUCTION], projects: [STAGE_PROJECT] });

    const error = yield* run(provision(options({ zeropsTokenStdin: false })), {
      files: yield* secretsFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain('has no ZEROPS_TOKEN secret');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('rejects a SpiceDB endpoint that is not host:port', () =>
  Effect.gen(function* rejectsEndpoint() {
    const stage = fakeStage({ projects: [STAGE_PROJECT] });

    const error = yield* run(provision(options({ spicedbEndpoint: 'https://spicedb' })), {
      files: yield* secretsFiles,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain('--spicedb-endpoint');
    expect(stage.commands).toStrictEqual([]);
  }),
);

it.effect('plans a dry run without the Zerops token or the secrets file and changes nothing', () =>
  Effect.gen(function* dryRunWithoutInputs() {
    const stage = fakeStage({ environments: ['stage', PRODUCTION], projects: [STAGE_PROJECT] });

    yield* run(provision(options({ secretsFile: Option.none(), zeropsTokenStdin: false })), {
      dryRun: true,
      files: fakeFiles(),
      stage,
    });

    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
    expect(stage.variables.get(PRODUCTION)?.size ?? 0).toBe(0);
  }),
);

it.effect('plans a dry run before the production environment exists without reading it', () =>
  Effect.gen(function* dryRunWithoutEnvironment() {
    const stage = fakeStage({ environments: ['stage'], projects: [STAGE_PROJECT] });

    yield* run(provision(options({ secretsFile: Option.none(), zeropsTokenStdin: false })), {
      dryRun: true,
      files: fakeFiles(),
      stage,
    });

    expect(stage.environments.has(PRODUCTION)).toBe(false);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
    expect(
      rendered(stage).filter((command) => /(?:variable|secret) list .*--env production/u.test(command)),
    ).toStrictEqual([]);
  }),
);

const GATEWAY_HOSTNAME = 'ontos-production-spicedb.ontos.example';
const PRODUCTION_PROJECT_ID = 'prod-id';

const runSpicedbTls = (stage: FakeStage) => {
  const zerops = fakeZeropsApi(stage);
  const account = fakeCloudflareAccount({});
  return {
    account,
    effect: run(ensureProductionSpicedbTls(GATEWAY_HOSTNAME), { files: fakeFiles(), stage }).pipe(
      Effect.provide(
        Layer.merge(
          CloudflareApiLive.pipe(
            Layer.provide(
              Layer.succeed(CloudflareCredentials, { accountId: 'account-1', apiToken: Redacted.make('api-token') }),
            ),
            Layer.provide(account.layer),
          ),
          zerops.layer,
        ),
      ),
    ),
    zerops,
  };
};

it.effect("creates the SpiceDB TLS pairs on the production project's spicedb service", () =>
  Effect.gen(function* createsProductionSpicedbTls() {
    const stage = fakeStage({
      environments: ['stage', PRODUCTION],
      services: [{ hostname: 'spicedb', id: 'prod-spicedb-id', status: 'ACTIVE' }],
      variables: { [PRODUCTION]: { [PROJECT_ID_VARIABLE]: PRODUCTION_PROJECT_ID } },
    });
    const { effect, zerops } = runSpicedbTls(stage);

    yield* effect;

    expect(zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      'prod-spicedb-id SPICEDB_GRPC_TLS_KEY',
      'prod-spicedb-id SPICEDB_GRPC_TLS_CERT',
      'prod-spicedb-id SPICEDB_HTTP_TLS_KEY',
      'prod-spicedb-id SPICEDB_HTTP_TLS_CERT',
    ]);
    expect(rendered(stage).some((command) => command.includes(`--project-id ${PRODUCTION_PROJECT_ID}`))).toBe(true);
  }),
);

it.effect('refuses SpiceDB TLS before provision records the production project', () =>
  Effect.gen(function* refusesWithoutProject() {
    const stage = fakeStage({ environments: ['stage', PRODUCTION] });
    const { effect, zerops } = runSpicedbTls(stage);

    const error = yield* effect.pipe(Effect.flip);

    expect(error.message).toContain('run provision first');
    expect(zerops.serviceSecrets).toStrictEqual([]);
  }),
);

it.effect('refuses SpiceDB TLS when the production project ID names the stage project', () =>
  Effect.gen(function* refusesStageSpicedbTls() {
    const stage = fakeStage({
      environments: ['stage', PRODUCTION],
      variables: { [PRODUCTION]: { [PROJECT_ID_VARIABLE]: STAGE_ZEROPS_PROJECT_ID } },
    });
    const { effect, zerops } = runSpicedbTls(stage);

    const error = yield* effect.pipe(Effect.flip);

    expect(error.message).toContain('names the stage project');
    expect(zerops.serviceSecrets).toStrictEqual([]);
  }),
);
