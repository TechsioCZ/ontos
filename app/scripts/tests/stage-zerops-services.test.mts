import { readFileSync } from 'node:fs';

import { Array as Arr, Effect, Layer, Option, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { serviceIdVariable } from '../publish-active-application-composition.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID } from '../ops/stage-operations.mts';
import {
  RETIRED_STAGE_SERVICES,
  RetirementRecordSchema,
  StageServicesConfiguration,
  classifyEnvironmentKeys,
  restore,
  retire,
} from '../ops/stage-zerops-services.mts';
import { APP_DIRECTORY, fakeFiles, fakeStage, mutatingCommands } from './stage-operations-fixture.mts';
import type { FakeFiles, FakeStage } from './stage-operations-fixture.mts';

const RECORD_PATH = `${APP_DIRECTORY}/scripts/ops/stage-zerops-retirement.json`;
// Retirement never touches these: the data plane, the migrator, the tunnel, the Outbox Worker host, and the dedicated
// workers, which host mode does not run and an operator may delete separately.
const OUTBOX_WORKERS = [
  'partyregistryworker',
  'commercecstmrcntxtworker',
  'pricegroupcatalogworker',
  'inventoryworker',
  'privacyworker',
  'financebillingworker',
  'coresystemworker',
];
const KEPT_ON_ZEROPS = new Set([
  'cloudflared',
  'coresystemworker',
  'db18',
  'migrator',
  'outboxworkerhost',
  'spicedb',
  ...OUTBOX_WORKERS,
]);

const ImportInventorySchema = Schema.Struct({ services: Schema.Array(Schema.Struct({ hostname: Schema.String })) });
const declaredHostnames = Schema.decodeUnknownSync(ImportInventorySchema)(
  parse(readFileSync(`${APP_DIRECTORY}/zerops-import.yaml`, 'utf-8')),
).services.map(({ hostname }) => hostname);
const TopologyInventorySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({ id: Schema.Literal('shell-super-app') }),
    verticals: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
);
const topology = Schema.decodeSync(TopologyInventorySchema)(
  readFileSync(`${APP_DIRECTORY}/topology/reference-topology.json`, 'utf-8'),
);
const applicationSetups = new Map<string, string>([
  ['shellsuperapp', 'shellsuperapp'],
  ...topology.verticals.map(({ id }): [string, string] => [id.replaceAll('-', ''), id]),
]);
// Independent of the retirement allowlist: only currently declared topology applications belong here.
const declaredApplications = declaredHostnames.flatMap((hostname) => {
  const setup = applicationSetups.get(hostname);
  return setup === undefined ? [] : [{ hostname, setup }];
});
const RuntimeEnvironmentSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.optionalKey(
        Schema.Struct({ envVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
      setup: Schema.String,
    }),
  ),
});
const declaredRuntimeKeys = new Map(
  Schema.decodeUnknownSync(RuntimeEnvironmentSchema)(
    parse(readFileSync(`${APP_DIRECTORY}/zerops.yaml`, 'utf-8')),
  ).zerops.map(({ run, setup }): [string, readonly string[]] => [setup, Object.keys(run?.envVariables ?? {})]),
);

// Recorded fixture IDs remain stable; newly declared applications receive synthetic IDs below.
const RECORDED_STAGE_SERVICE_IDS = new Map(
  Object.entries({
    assortment: 'assortment-id',
    availability: 'availability-id',
    catalog: 'IGOF5E9vQ7izD4ygQgoNiQ',
    commercecustomercontext: 'omIBMTDCR7iARcXTt4SqJw',
    commercemarketcatalog: '7nJtt1fnQMKsGRDTl6Wv1w',
    crm: 'crm-service-id',
    crmactivities: 'crm-activities-service-id',
    facilityoperations: 'facility-operations-service-id',
    financebilling: 'finance-billing-service-id',
    inventory: 'inventory-service-id',
    legalagreements: 'legal-agreements-service-id',
    merchandise: 'merchandise-service-id',
    partyregistry: 'cxNTAHZJSbiJr3xTqkypOg',
    paymenttermcatalog: '2FgvrWn9RzCJrfbMapwM6Q',
    pricegroupcatalog: 'aHab72wuSDS4AjkgxNbHDw',
    pricing: 'll1Dd1AiRiKSLlB1QKDhQw',
    privacy: 'privacy-service-id',
    projects: 'projects-service-id',
    propertyleasing: 'property-leasing-service-id',
    propertyportfolio: 'property-portfolio-service-id',
    salesinsights: 'sales-insights-service-id',
    salespipeline: 'sales-pipeline-service-id',
    shellsuperapp: 'E6Wy3B08Rn60XqS6T666fg',
    storefrontregistry: 't9lSg7HFRne0DJblYFwXbg',
    tagging: 'tagging-service-id',
    tax: 'tax-service-id',
    workforce: 'workforce-service-id',
    worktasks: 'work-tasks-service-id',
  }),
);

const STAGE_SERVICE_IDS = new Map(
  declaredApplications.map(({ hostname }): [string, string] => [
    hostname,
    RECORDED_STAGE_SERVICE_IDS.get(hostname) ?? `${hostname}-id`,
  ]),
);

const STAGE_SHELL_ORIGIN = 'https://stage.example';
const AUTH_SECRET = 'better-auth-secret';
const PUBLIC_JWKS = '{"keys":["public"]}';
const PROJECT_KEYS = ['MODERN_PUBLIC_SITE_URL', 'ONTOS_GATEWAY_ISSUER', 'ULTRAMODERN_MF_DEV_ORIGIN'];
const VERTICAL_KEYS = [
  'DATABASE_URL',
  'MODERN_PUBLIC_SITE_URL',
  'NODE_ENV',
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_GATEWAY_PUBLIC_JWKS',
  'PORT',
  'SPICEDB_CA_CERT',
  'SPICEDB_ENDPOINT',
  'SPICEDB_PRESHARED_KEY',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
  'ULTRAMODERN_MF_DEV_ORIGIN',
  'ULTRAMODERN_ZEROPS_SERVICE',
];
const PARTY_KEYS = [...VERTICAL_KEYS.filter((key) => key !== 'DATABASE_URL'), 'PARTY_REGISTRY_DATABASE_URL'];
const MIGRATOR_IDENTITY_SECRET_KEYS = [
  'PARTY_REGISTRY_DB_PASSWORD',
  'PARTY_REGISTRY_WORKER_DB_PASSWORD',
  'SHELL_GATEWAY_ISSUER_DB_PASSWORD',
];
const SHELL_KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'BETTER_AUTH_URL',
  'ONTOS_GATEWAY_PRIVATE_JWK',
  'SHELL_GATEWAY_ISSUER_DATABASE_URL',
];

const liveStage = (overrides: { readonly deployTarget?: string } = {}) =>
  fakeStage({
    projectUserKeys: [
      ...PROJECT_KEYS,
      ...MIGRATOR_IDENTITY_SECRET_KEYS.map((key) => `migrator_${key}`),
      'partyregistry_PARTY_REGISTRY_DATABASE_URL',
      'shellsuperapp_BETTER_AUTH_SECRET',
    ],
    services: [
      { hostname: 'db18', id: 'db18-id', status: 'ACTIVE' },
      { hostname: 'migrator', id: 'migrator-id', status: 'ACTIVE' },
      { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' },
      { hostname: 'outboxworkerhost', id: 'host-id', status: 'ACTIVE' },
      { hostname: 'cloudflared', id: 'tunnel-id', status: 'ACTIVE' },
      ...OUTBOX_WORKERS.map((hostname) => ({ hostname, id: `${hostname}-id`, status: 'STOPPED' })),
      ...declaredApplications.map(({ hostname }) => ({
        hostname,
        id: STAGE_SERVICE_IDS.get(hostname) ?? '',
        status: 'ACTIVE',
      })),
    ],
    serviceUserKeys: {
      ...Object.fromEntries(
        declaredApplications.map(({ hostname, setup }) => [
          hostname,
          [
            ...new Set([
              ...(declaredRuntimeKeys.get(setup) ?? []),
              ...PROJECT_KEYS,
              ...(hostname === 'shellsuperapp' ? SHELL_KEYS : ['ONTOS_GATEWAY_PUBLIC_JWKS']),
            ]),
          ],
        ]),
      ),
      migrator: MIGRATOR_IDENTITY_SECRET_KEYS,
      partyregistry: PARTY_KEYS,
      partyregistryworker: [
        ...VERTICAL_KEYS.filter((key) => key !== 'DATABASE_URL'),
        'PARTY_REGISTRY_WORKER_DATABASE_URL',
      ],
    },
    variables: {
      stage: {
        DEPLOY_TARGET: overrides.deployTarget ?? 'cloudflare',
        ...Object.fromEntries(
          declaredApplications.map(({ hostname, setup }) => [
            serviceIdVariable(setup),
            STAGE_SERVICE_IDS.get(hostname) ?? '',
          ]),
        ),
      },
    },
  });

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fakes: { readonly dryRun?: boolean; readonly files: FakeFiles; readonly stage: FakeStage },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(OpsMode, { dryRun: fakes.dryRun ?? false }),
        Layer.succeed(StageServicesConfiguration, {
          projectId: STAGE_ZEROPS_PROJECT_ID,
          repository: 'TechsioCZ/ontos',
        }),
        fakes.stage.layer,
        fakes.files.layer,
      ),
    ),
  );

const decodeRecord = (files: FakeFiles) =>
  Schema.decodeUnknownSync(RetirementRecordSchema)(files.writes.get(RECORD_PATH));

it('retires exactly the application services zerops-import.yaml declares, each with its stage variable', () => {
  const ImportSchema = Schema.Struct({ services: Schema.Array(Schema.Struct({ hostname: Schema.String })) });
  const declared = Schema.decodeUnknownSync(ImportSchema)(
    parse(readFileSync(`${APP_DIRECTORY}/zerops-import.yaml`, 'utf-8')),
  ).services.map(({ hostname }) => hostname);
  const SetupsSchema = Schema.Struct({ zerops: Schema.Array(Schema.Struct({ setup: Schema.String })) });
  const setups = new Set(
    Schema.decodeUnknownSync(SetupsSchema)(parse(readFileSync(`${APP_DIRECTORY}/zerops.yaml`, 'utf-8'))).zerops.map(
      ({ setup }) => setup,
    ),
  );

  expect(new Set(RETIRED_STAGE_SERVICES.map(({ hostname }) => hostname))).toStrictEqual(
    new Set(declared.filter((hostname) => !KEPT_ON_ZEROPS.has(hostname))),
  );
  expect(new Set(declaredApplications.map(({ hostname }) => hostname))).toStrictEqual(
    new Set(declared.filter((hostname) => !KEPT_ON_ZEROPS.has(hostname))),
  );
  for (const { setup } of RETIRED_STAGE_SERVICES) {
    expect(setups).toContain(setup);
  }
  // The stage variables follow the independently declared application setups, including generated verticals.
  expect(
    Arr.sort(
      RETIRED_STAGE_SERVICES.map(({ setup }) => serviceIdVariable(setup)),
      Order.String,
    ),
  ).toStrictEqual(
    Arr.sort(
      declaredApplications.map(({ setup }) => serviceIdVariable(setup)),
      Order.String,
    ),
  );
});

it('splits service keys into zerops.yaml, inherited project and service-secret keys', () => {
  expect(
    classifyEnvironmentKeys({
      projectKeys: [...PROJECT_KEYS, 'partyregistry_PARTY_REGISTRY_DATABASE_URL'],
      serviceHostnames: ['partyregistry', 'db18'],
      serviceKeys: PARTY_KEYS,
      zeropsYamlKeys: new Set([
        'NODE_ENV',
        'PARTY_REGISTRY_DATABASE_URL',
        'PORT',
        'SPICEDB_CA_CERT',
        'SPICEDB_ENDPOINT',
        'SPICEDB_PRESHARED_KEY',
        'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
        'ULTRAMODERN_ZEROPS_SERVICE',
      ]),
    }),
  ).toStrictEqual({
    fromZeropsYaml: [
      'NODE_ENV',
      'PARTY_REGISTRY_DATABASE_URL',
      'PORT',
      'SPICEDB_CA_CERT',
      'SPICEDB_ENDPOINT',
      'SPICEDB_PRESHARED_KEY',
      'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
      'ULTRAMODERN_ZEROPS_SERVICE',
    ],
    inheritedFromProject: ['MODERN_PUBLIC_SITE_URL', 'ONTOS_GATEWAY_ISSUER', 'ULTRAMODERN_MF_DEV_ORIGIN'],
    serviceSecrets: ['ONTOS_GATEWAY_PUBLIC_JWKS'],
  });
});

it.effect('records every service without --confirm and deletes nothing', () =>
  Effect.gen(function* recordsWithoutDeleting() {
    const stage = liveStage({ deployTarget: 'zerops' });
    const files = fakeFiles();

    yield* run(retire({ confirm: false, dnsCutOver: false }), { files, stage });

    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
    const record = decodeRecord(files);
    expect(record.schemaVersion).toBe(1);
    expect(record.sourceRevision).toBe('0123456789abcdef');
    expect(record.services.map(({ hostname }) => hostname)).toStrictEqual(
      RETIRED_STAGE_SERVICES.map(({ hostname }) => hostname),
    );
    const shell = record.services.find(({ hostname }) => hostname === 'shellsuperapp');
    expect(shell?.serviceId).toBe('E6Wy3B08Rn60XqS6T666fg');
    expect(shell?.serviceIdVariable).toBe('ZEROPS_SHELL_SERVICE_ID');
    expect(shell?.environmentKeys.serviceSecrets).toStrictEqual([
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_TRUSTED_ORIGINS',
      'BETTER_AUTH_URL',
      'ONTOS_GATEWAY_PRIVATE_JWK',
    ]);
    expect(shell?.importEntry).toStrictEqual(
      Option.some({ enableSubdomainAccess: true, hostname: 'shellsuperapp', type: 'nodejs@24' }),
    );
    expect(shell?.environmentKeys.fromZeropsYaml).toContain('SHELL_GATEWAY_ISSUER_DATABASE_URL');
    const party = record.services.find(({ hostname }) => hostname === 'partyregistry');
    expect(party?.environmentKeys.fromZeropsYaml).toContain('PARTY_REGISTRY_DATABASE_URL');
    expect(party?.environmentKeys.fromZeropsYaml).not.toContain('DATABASE_URL');
    expect(party?.environmentKeys.serviceSecrets).toStrictEqual(['ONTOS_GATEWAY_PUBLIC_JWKS']);
    // The record holds keys and IDs only; no service ever had its values read.
    expect(stage.commands.some(({ args }) => args.some((argument) => argument.includes('.Value')))).toBe(false);
  }),
);

it.effect('refuses to delete before stage deploys to Cloudflare', () =>
  Effect.gen(function* refusesBeforeCutover() {
    const stage = liveStage({ deployTarget: 'zerops' });

    const error = yield* run(retire({ confirm: true, dnsCutOver: true }), { files: fakeFiles(), stage }).pipe(
      Effect.flip,
    );

    expect(error.message).toContain('does not deploy with DEPLOY_TARGET=cloudflare yet');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('refuses to delete until the operator confirms the DNS cut-over', () =>
  Effect.gen(function* refusesWithoutDnsCutOver() {
    const stage = liveStage();

    const error = yield* run(retire({ confirm: true, dnsCutOver: false }), { files: fakeFiles(), stage }).pipe(
      Effect.flip,
    );

    expect(error.message).toContain('add --dns-cut-over');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('records, then deletes each retired service by ID with --confirm, keeping every GitHub variable', () =>
  Effect.gen(function* deletesWithConfirm() {
    const stage = liveStage();
    const files = fakeFiles();
    const variablesBefore = new Map(stage.variables.get('stage'));

    yield* run(retire({ confirm: true, dnsCutOver: true }), { files, stage });

    const deleted = stage.commands
      .filter(({ args }) => args[0] === 'service' && args[1] === 'delete')
      .map(({ args }) => args[args.indexOf('--service-id') + 1]);
    expect(deleted).toStrictEqual(RETIRED_STAGE_SERVICES.map(({ hostname }) => STAGE_SERVICE_IDS.get(hostname)));
    expect(stage.commands.findIndex(({ args }) => args[1] === 'delete')).toBeGreaterThan(
      stage.commands.findIndex(({ command }) => command === 'git'),
    );
    // The Cloudflare target still deploys the migrator, SpiceDB and the host, and reads the stopped workers.
    expect(stage.services.map(({ hostname }) => hostname)).toStrictEqual([
      'db18',
      'migrator',
      'spicedb',
      'outboxworkerhost',
      'cloudflared',
      ...OUTBOX_WORKERS,
    ]);
    expect(stage.variables.get('stage')).toStrictEqual(variablesBefore);
    expect(decodeRecord(files).services).toHaveLength(RETIRED_STAGE_SERVICES.length);

    // A re-run after the deletion keeps the earlier records instead of emptying the file.
    yield* run(retire({ confirm: true, dnsCutOver: true }), { files, stage });
    expect(decodeRecord(files).services).toHaveLength(RETIRED_STAGE_SERVICES.length);
  }),
);

const retiredFiles = Effect.gen(function* retiredFilesEffect() {
  const stage = liveStage();
  const files = fakeFiles();
  yield* run(retire({ confirm: true, dnsCutOver: true }), { files, stage });
  return { files, stage };
});

const vaultExport = (overrides: Readonly<Record<string, string>> = {}) =>
  Object.entries({
    ...Object.fromEntries(
      declaredApplications
        .filter(({ hostname }) => hostname !== 'shellsuperapp')
        .map(({ hostname }) => [`${hostname}_ONTOS_GATEWAY_PUBLIC_JWKS`, PUBLIC_JWKS]),
    ),
    shellsuperapp_BETTER_AUTH_SECRET: AUTH_SECRET,
    shellsuperapp_BETTER_AUTH_TRUSTED_ORIGINS: STAGE_SHELL_ORIGIN,
    shellsuperapp_BETTER_AUTH_URL: STAGE_SHELL_ORIGIN,
    shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK: '{"d":"private-jwk-secret"}',
    ...overrides,
  })
    // Single quotes keep JSON literal under dotenv rules, as a vault export writes it.
    .map(([key, value]) => `${key}='${value}'`)
    .join('\n');

it.effect('restores nothing when the secrets file lacks a recorded secret', () =>
  Effect.gen(function* refusesIncompleteSecrets() {
    const { files, stage } = yield* retiredFiles;
    const incomplete = vaultExport().replace(/^shellsuperapp_BETTER_AUTH_SECRET=.*$/mu, '');
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, incomplete);
    const commandsBefore = stage.commands.length;

    const error = yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), {
      files,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toBe('the secrets file lacks shellsuperapp_BETTER_AUTH_SECRET; nothing was restored');
    expect(mutatingCommands(stage.commands.slice(commandsBefore))).toStrictEqual([]);
  }),
);

it.effect('re-imports the retired services with their secrets, re-points the variables and redeploys Zerops', () =>
  Effect.gen(function* restoresServices() {
    const { files, stage } = yield* retiredFiles;
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, vaultExport());
    const commandsBefore = stage.commands.length;

    yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), { files, stage });

    const imported = stage.inputs.find(({ command }) => command.startsWith('zcli project service-import -'));
    const document = Schema.decodeUnknownSync(
      Schema.Struct({
        services: Schema.Array(
          Schema.Struct({
            envSecrets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            hostname: Schema.String,
          }),
        ),
      }),
    )(parse(imported?.stdin ?? ''));
    expect(document.services.map(({ hostname }) => hostname)).toStrictEqual(
      RETIRED_STAGE_SERVICES.map(({ hostname }) => hostname),
    );
    expect(document.services.find(({ hostname }) => hostname === 'shellsuperapp')?.envSecrets).toStrictEqual({
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_TRUSTED_ORIGINS: STAGE_SHELL_ORIGIN,
      BETTER_AUTH_URL: STAGE_SHELL_ORIGIN,
      ONTOS_GATEWAY_PRIVATE_JWK: '{"d":"private-jwk-secret"}',
    });
    expect(document.services.find(({ hostname }) => hostname === 'partyregistry')?.envSecrets).toStrictEqual({
      ONTOS_GATEWAY_PUBLIC_JWKS: PUBLIC_JWKS,
    });
    // Dedicated passwords stay on the retained migrator; the next deploy rebuilds the identity URLs.
    expect(stage.services.find(({ hostname }) => hostname === 'migrator')?.id).toBe('migrator-id');
    expect(stage.serviceUserKeys.get('migrator')).toStrictEqual(MIGRATOR_IDENTITY_SECRET_KEYS);
    expect(stage.serviceUserKeys.get('partyregistryworker')).toContain('PARTY_REGISTRY_WORKER_DATABASE_URL');
    expect(stage.serviceUserKeys.get('partyregistryworker')).not.toContain('DATABASE_URL');
    const newIds = new Map(stage.services.map(({ hostname, id }) => [hostname, id]));
    for (const { hostname, setup } of RETIRED_STAGE_SERVICES) {
      expect(stage.variables.get('stage')?.get(serviceIdVariable(setup))).toBe(newIds.get(hostname));
    }
    expect(stage.variables.get('stage')?.get('DEPLOY_TARGET')).toBe('zerops');
    const rendered = stage.commands.slice(commandsBefore).map(({ args, command }) => [command, ...args].join(' '));
    // Main deploys only production: a restore never dispatches a deploy.
    expect(rendered.join('\n')).not.toContain('gh workflow run');
    expect(rendered.join('\n')).not.toContain('private-jwk-secret');
    expect(rendered.join('\n')).not.toContain(AUTH_SECRET);
  }),
);

it.effect('changes no stage variable when Zerops does not list an imported service', () =>
  Effect.gen(function* refusesUnlistedImport() {
    const { files, stage } = yield* retiredFiles;
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, vaultExport());
    stage.hiddenOnImport.add('pricing');
    const variablesBefore = new Map(stage.variables.get('stage'));
    const commandsBefore = stage.commands.length;

    const error = yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), {
      files,
      stage,
    }).pipe(Effect.flip);

    expect(error.message).toContain('Zerops lists no pricing after the import; no stage variable was changed');
    expect(stage.variables.get('stage')).toStrictEqual(variablesBefore);
    expect(
      mutatingCommands(stage.commands.slice(commandsBefore)).map(({ args, command }) => `${command} ${args[0] ?? ''}`),
    ).toStrictEqual(['zcli project']);
  }),
);

it.effect('restores only what the current zerops-import.yaml still declares', () =>
  Effect.gen(function* skipsUndeclaredServices() {
    const { files, stage } = yield* retiredFiles;
    const importText = readFileSync(`${APP_DIRECTORY}/zerops-import.yaml`, 'utf-8');
    const withoutPricing = importText.replace(/ {2}- hostname: pricing\n(?: {4}.*\n)+/u, '');
    expect(withoutPricing).not.toBe(importText);
    files.writes.set(`${APP_DIRECTORY}/zerops-import.yaml`, withoutPricing);
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, vaultExport());

    yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), { files, stage });

    expect(stage.services.map(({ hostname }) => hostname)).not.toContain('pricing');
    expect(stage.variables.get('stage')?.get('ZEROPS_PRICING_SERVICE_ID')).toBe('ll1Dd1AiRiKSLlB1QKDhQw');
  }),
);

it.effect('reports the restore plan in a dry run without changing Zerops or GitHub', () =>
  Effect.gen(function* dryRunRestore() {
    const { files, stage } = yield* retiredFiles;
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, vaultExport());
    const commandsBefore = stage.commands.length;

    yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), { dryRun: true, files, stage });

    expect(mutatingCommands(stage.commands.slice(commandsBefore))).toStrictEqual([]);
  }),
);
