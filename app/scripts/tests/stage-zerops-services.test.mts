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
const DATA_LAYER = new Set(['cloudflared', 'outboxworkerhost']);

// The 12 stage services and their IDs before the switch (backup bundle `zerops-service-list.txt`).
const STAGE_SERVICE_IDS = new Map(
  Object.entries({
    catalog: 'IGOF5E9vQ7izD4ygQgoNiQ',
    commercecstmrcntxtworker: '1knmWh09QLu586rn0hNdeQ',
    commercecustomercontext: 'omIBMTDCR7iARcXTt4SqJw',
    commercemarketcatalog: '7nJtt1fnQMKsGRDTl6Wv1w',
    partyregistry: 'cxNTAHZJSbiJr3xTqkypOg',
    partyregistryworker: '0D7df1MKRIaN80xBzB54vA',
    paymenttermcatalog: '2FgvrWn9RzCJrfbMapwM6Q',
    pricegroupcatalog: 'aHab72wuSDS4AjkgxNbHDw',
    pricegroupcatalogworker: '56xMc9pZSouLMhNRglBswQ',
    pricing: 'll1Dd1AiRiKSLlB1QKDhQw',
    shellsuperapp: 'E6Wy3B08Rn60XqS6T666fg',
    storefrontregistry: 't9lSg7HFRne0DJblYFwXbg',
  }),
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
  'SPICEDB_ENDPOINT',
  'SPICEDB_INSECURE',
  'SPICEDB_PRESHARED_KEY',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
  'ULTRAMODERN_MF_DEV_ORIGIN',
  'ULTRAMODERN_ZEROPS_SERVICE',
];
const SHELL_KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'BETTER_AUTH_URL',
  'DATABASE_URL',
  'MODERN_PUBLIC_SITE_URL',
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_GATEWAY_PRIVATE_JWK',
];

const liveStage = (overrides: { readonly deployTarget?: string; readonly hostStatus?: string } = {}) =>
  fakeStage({
    projectUserKeys: [...PROJECT_KEYS, 'partyregistry_DATABASE_URL', 'shellsuperapp_BETTER_AUTH_SECRET'],
    services: [
      { hostname: 'db18', id: 'db18-id', status: 'ACTIVE' },
      { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' },
      { hostname: 'outboxworkerhost', id: 'host-id', status: overrides.hostStatus ?? 'ACTIVE' },
      ...RETIRED_STAGE_SERVICES.map(({ hostname }) => ({
        hostname,
        id: STAGE_SERVICE_IDS.get(hostname) ?? '',
        status: 'ACTIVE',
      })),
    ],
    serviceUserKeys: Object.fromEntries(
      RETIRED_STAGE_SERVICES.map(({ hostname }) => [
        hostname,
        hostname === 'shellsuperapp' ? SHELL_KEYS : VERTICAL_KEYS,
      ]),
    ),
    variables: {
      stage: {
        DEPLOY_TARGET: overrides.deployTarget ?? 'cloudflare',
        ...Object.fromEntries(
          RETIRED_STAGE_SERVICES.map(({ hostname, setup }) => [
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
    new Set(declared.filter((hostname) => !DATA_LAYER.has(hostname))),
  );
  for (const { setup } of RETIRED_STAGE_SERVICES) {
    expect(setups).toContain(setup);
  }
  // The variables the stage deploy reads today (backup bundle `github-stage-env-variables.txt`).
  expect(
    Arr.sort(
      RETIRED_STAGE_SERVICES.map(({ setup }) => serviceIdVariable(setup)),
      Order.String,
    ),
  ).toStrictEqual([
    'ZEROPS_CATALOG_SERVICE_ID',
    'ZEROPS_COMMERCE_CUSTOMER_CONTEXT_SERVICE_ID',
    'ZEROPS_COMMERCE_CUSTOMER_CONTEXT_WORKER_SERVICE_ID',
    'ZEROPS_COMMERCE_MARKET_CATALOG_SERVICE_ID',
    'ZEROPS_PARTY_REGISTRY_SERVICE_ID',
    'ZEROPS_PARTY_REGISTRY_WORKER_SERVICE_ID',
    'ZEROPS_PAYMENT_TERM_CATALOG_SERVICE_ID',
    'ZEROPS_PRICE_GROUP_CATALOG_SERVICE_ID',
    'ZEROPS_PRICE_GROUP_CATALOG_WORKER_SERVICE_ID',
    'ZEROPS_PRICING_SERVICE_ID',
    'ZEROPS_SHELL_SERVICE_ID',
    'ZEROPS_STOREFRONT_REGISTRY_SERVICE_ID',
  ]);
});

it('splits service keys into zerops.yaml, inherited project and service-secret keys', () => {
  expect(
    classifyEnvironmentKeys({
      projectKeys: [...PROJECT_KEYS, 'partyregistry_DATABASE_URL'],
      serviceHostnames: ['partyregistry', 'db18'],
      serviceKeys: VERTICAL_KEYS,
      zeropsYamlKeys: new Set([
        'DATABASE_URL',
        'NODE_ENV',
        'PORT',
        'SPICEDB_ENDPOINT',
        'SPICEDB_INSECURE',
        'SPICEDB_PRESHARED_KEY',
        'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
        'ULTRAMODERN_ZEROPS_SERVICE',
      ]),
    }),
  ).toStrictEqual({
    fromZeropsYaml: [
      'DATABASE_URL',
      'NODE_ENV',
      'PORT',
      'SPICEDB_ENDPOINT',
      'SPICEDB_INSECURE',
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

    yield* run(retire({ confirm: false }), { files, stage });

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
    // The record holds keys and IDs only; no service ever had its values read.
    expect(stage.commands.some(({ args }) => args.some((argument) => argument.includes('.Value')))).toBe(false);
  }),
);

it.effect('refuses to delete before stage deploys to Cloudflare', () =>
  Effect.gen(function* refusesBeforeCutover() {
    const stage = liveStage({ deployTarget: 'zerops' });

    const error = yield* run(retire({ confirm: true }), { files: fakeFiles(), stage }).pipe(Effect.flip);

    expect(error.message).toContain('does not deploy with DEPLOY_TARGET=cloudflare yet');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('keeps the per-vertical outbox workers until the combined host runs', () =>
  Effect.gen(function* refusesWithoutWorkerHost() {
    const stage = liveStage({ hostStatus: 'READY_TO_DEPLOY' });

    const error = yield* run(retire({ confirm: true }), { files: fakeFiles(), stage }).pipe(Effect.flip);

    expect(error.message).toContain('outboxworkerhost service is not ACTIVE');
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('records, then deletes each retired service by ID with --confirm, keeping every GitHub variable', () =>
  Effect.gen(function* deletesWithConfirm() {
    const stage = liveStage();
    const files = fakeFiles();
    const variablesBefore = new Map(stage.variables.get('stage'));

    yield* run(retire({ confirm: true }), { files, stage });

    const deleted = stage.commands
      .filter(({ args }) => args[0] === 'service' && args[1] === 'delete')
      .map(({ args }) => args[args.indexOf('--service-id') + 1]);
    expect(deleted).toStrictEqual(RETIRED_STAGE_SERVICES.map(({ hostname }) => STAGE_SERVICE_IDS.get(hostname)));
    expect(stage.commands.findIndex(({ args }) => args[1] === 'delete')).toBeGreaterThan(
      stage.commands.findIndex(({ command }) => command === 'git'),
    );
    expect(stage.services.map(({ hostname }) => hostname)).toStrictEqual(['db18', 'spicedb', 'outboxworkerhost']);
    expect(stage.variables.get('stage')).toStrictEqual(variablesBefore);
    expect(decodeRecord(files).services).toHaveLength(12);

    // A re-run after the deletion keeps the earlier records instead of emptying the file.
    yield* run(retire({ confirm: true }), { files, stage });
    expect(decodeRecord(files).services).toHaveLength(12);
  }),
);

const retiredFiles = Effect.gen(function* retiredFilesEffect() {
  const stage = liveStage();
  const files = fakeFiles();
  yield* run(retire({ confirm: true }), { files, stage });
  return { files, stage };
});

const vaultExport = (overrides: Readonly<Record<string, string>> = {}) =>
  Object.entries({
    ...Object.fromEntries(
      RETIRED_STAGE_SERVICES.filter(({ hostname }) => hostname !== 'shellsuperapp').map(({ hostname }) => [
        `${hostname}_ONTOS_GATEWAY_PUBLIC_JWKS`,
        PUBLIC_JWKS,
      ]),
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
    expect(document.services.find(({ hostname }) => hostname === 'shellsuperapp')?.envSecrets).toMatchObject({
      BETTER_AUTH_SECRET: AUTH_SECRET,
      ONTOS_GATEWAY_PRIVATE_JWK: '{"d":"private-jwk-secret"}',
    });
    const newIds = new Map(stage.services.map(({ hostname, id }) => [hostname, id]));
    for (const { hostname, setup } of RETIRED_STAGE_SERVICES) {
      expect(stage.variables.get('stage')?.get(serviceIdVariable(setup))).toBe(newIds.get(hostname));
    }
    expect(stage.variables.get('stage')?.get('DEPLOY_TARGET')).toBe('zerops');
    const rendered = stage.commands.slice(commandsBefore).map(({ args, command }) => [command, ...args].join(' '));
    expect(rendered.at(-1)).toBe(
      'gh workflow run ultramodern-workspace-gates.yml --repo TechsioCZ/ontos --ref main -f full=true',
    );
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
    const withoutWorkers = importText.replaceAll(/ {2}- hostname: \w+worker\n {4}type: nodejs@24\n/gu, '');
    files.writes.set(`${APP_DIRECTORY}/zerops-import.yaml`, withoutWorkers);
    files.writes.set(`${APP_DIRECTORY}/../vault.env`, vaultExport());

    yield* run(restore({ secretsFile: Option.some(`${APP_DIRECTORY}/../vault.env`) }), { files, stage });

    expect(
      stage.services.map(({ hostname }) => hostname).filter((hostname) => hostname.endsWith('worker')),
    ).toStrictEqual([]);
    expect(stage.variables.get('stage')?.get('ZEROPS_PARTY_REGISTRY_WORKER_SERVICE_ID')).toBe('0D7df1MKRIaN80xBzB54vA');
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
