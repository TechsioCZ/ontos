import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  APP_ROOT,
  deployableStageEdge,
  parseStageEdgeConfig,
  readStageEdgeConfig,
  StageEdgeConfigError,
  stageEdgeUrls,
  stageEdgeWorkflowVariables,
} from '../ci/stage-edge.mts';
import type { StageEdgeConfig } from '../ci/stage-edge.mts';
import { publicOrigin } from '../ops/cloudflare-stage-cutover.mts';
import { readEdgeUnits } from '../ops/stage-edge-units.mts';

const ACCOUNT = 'a'.repeat(32);
const CONFIG: StageEdgeConfig = {
  accountId: ACCOUNT,
  emailSender: 'noreply@ontos-stage.example.test',
  shellHostname: 'ontos-stage.example.test',
  spicedbHostname: 'ontos-stage-spicedb.example.test',
  storefrontCatalogKvId: 'b'.repeat(32),
  storefrontHostname: 'ontos-stage-akros.example.test',
  workersDevSubdomain: 'example',
  zone: 'example.test',
};
interface Placement {
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly units: readonly string[];
}
const PLACEMENT: Placement = { buildEnvironment: { ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'c'.repeat(32) }, units: [] };

const withAppRoot = (
  files: { readonly edge: StageEdgeConfig; readonly placement?: Placement },
  check: (appRoot: string) => void,
) => {
  const appRoot = mkdtempSync(path.join(os.tmpdir(), 'stage-edge-test-'));
  try {
    mkdirSync(path.join(appRoot, 'topology'));
    writeFileSync(path.join(appRoot, 'topology/stage-edge.json'), JSON.stringify(files.edge));
    writeFileSync(
      path.join(appRoot, 'topology/cloudflare-placement.json'),
      JSON.stringify(files.placement ?? PLACEMENT),
    );
    check(appRoot);
  } finally {
    rmSync(appRoot, { force: true, recursive: true });
  }
};
/** The message of the StageEdgeConfigError `run` throws. */
const failureOf = (run: () => StageEdgeConfig) => {
  let message = 'no StageEdgeConfigError';
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StageEdgeConfigError);
    message = String(error).replace(/^StageEdgeConfigError: /u, '');
  }
  return message;
};

it('derives every stage URL and workflow variable from the one config', () => {
  expect(stageEdgeUrls(CONFIG)).toEqual({
    emailDispatchUrl: 'https://ontos-stage.example.test/shell-super-app-api/email/dispatch',
    oauthIssuer: 'https://ontos-stage.example.test/shell-super-app-api/oauth',
    shellApiBaseUrl: 'https://ontos-stage.example.test/shell-super-app-api',
    shellUrl: 'https://ontos-stage.example.test',
    storefrontUrl: 'https://ontos-stage-akros.example.test',
  });
  expect(stageEdgeWorkflowVariables(CONFIG)).toEqual({
    STAGE_SHELL_URL: 'https://ontos-stage.example.test',
    STAGE_STOREFRONT_CATALOG_KV_ID: 'b'.repeat(32),
    STAGE_STOREFRONT_URL: 'https://ontos-stage-akros.example.test',
    STAGE_ZONE: 'example.test',
    WORKERS_DEV_SUBDOMAIN: 'example',
  });
});

it('rejects malformed, unknown, foreign-zone and missing fields by name only', () => {
  expect(failureOf(() => parseStageEdgeConfig('{'))).toContain('not valid JSON');
  expect(failureOf(() => parseStageEdgeConfig('[]'))).toContain('must be a JSON object');
  expect(failureOf(() => parseStageEdgeConfig(JSON.stringify({ ...CONFIG, accountId: '' })))).toContain('accountId');
  expect(failureOf(() => parseStageEdgeConfig(JSON.stringify({ ...CONFIG, extra: 'x' })))).toContain('extra');
  expect(failureOf(() => parseStageEdgeConfig(JSON.stringify({ ...CONFIG, workersDevSubdomain: 'a.b' })))).toContain(
    'workersDevSubdomain',
  );
  const foreign = failureOf(() =>
    parseStageEdgeConfig(
      JSON.stringify({ ...CONFIG, emailSender: 'noreply@other.test', storefrontHostname: 'shop.other.test' }),
    ),
  );
  expect(foreign).toBe('topology/stage-edge.json: storefrontHostname, emailSender must be inside zone example.test');
  expect(parseStageEdgeConfig(JSON.stringify({ ...CONFIG, storefrontCatalogKvId: '' })).storefrontCatalogKvId).toBe('');
});

it('refuses to deploy with a foreign account, an unprovisioned storefront KV or an incomplete placement', () => {
  withAppRoot({ edge: CONFIG }, (appRoot) => {
    expect(deployableStageEdge({ appRoot, expectedAccountId: ACCOUNT })).toEqual(CONFIG);
    expect(deployableStageEdge({ appRoot })).toEqual(CONFIG);
    expect(failureOf(() => deployableStageEdge({ appRoot, expectedAccountId: '' }))).toContain('accountId');
    expect(failureOf(() => deployableStageEdge({ appRoot, expectedAccountId: 'd'.repeat(32) }))).toContain(
      'CLOUDFLARE_ACCOUNT_ID',
    );
  });
  withAppRoot({ edge: { ...CONFIG, storefrontCatalogKvId: '' } }, (appRoot) => {
    expect(failureOf(() => deployableStageEdge({ appRoot }))).toContain('storefrontCatalogKvId is empty');
  });
  withAppRoot(
    { edge: CONFIG, placement: { buildEnvironment: { A_ID: '', B_ID: 'set', C_ID: '' }, units: [] } },
    (appRoot) => {
      expect(failureOf(() => deployableStageEdge({ appRoot }))).toBe(
        'topology/cloudflare-placement.json leaves A_ID, C_ID empty: run cloudflare-stage-cutover.mts provision',
      );
    },
  );
});

it('exports the workflow variables to the step environment and outputs only for a deployable config', () => {
  const script = path.join(APP_ROOT, 'scripts/ci/stage-edge.mts');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stage-edge-export-'));
  try {
    const env = path.join(directory, 'env');
    const output = path.join(directory, 'output');
    const run = (args: readonly string[]) => {
      const result = spawnSync(process.execPath, [script, 'export', ...args], { encoding: 'utf-8' });
      return result.status === 0 ? 'ok' : result.stderr;
    };
    const config = readStageEdgeConfig();
    const result = run(['--cloudflare-account-id', config.accountId, '--github-env', env, '--github-output', output]);
    let deployable = true;
    try {
      deployableStageEdge({ expectedAccountId: config.accountId });
    } catch {
      deployable = false;
    }
    if (deployable) {
      const variables = Object.entries(stageEdgeWorkflowVariables(config));
      expect(result).toBe('ok');
      expect(readFileSync(env, 'utf-8')).toBe(variables.map(([key, value]) => `${key}=${value}\n`).join(''));
      expect(readFileSync(output, 'utf-8')).toBe(
        variables.map(([key, value]) => `${key.toLowerCase()}=${value}\n`).join(''),
      );
    } else {
      // Until provisioning records the storefront KV and placement IDs, every deploy job fails here.
      expect(result).toMatch(/storefrontCatalogKvId is empty|cloudflare-placement\.json leaves/u);
    }
    expect(run(['--cloudflare-account-id', 'd'.repeat(32)])).toContain('CLOUDFLARE_ACCOUNT_ID');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it.effect('places every unit, the Shell origin, the storefront and the sender on the reviewed stage hostnames', () =>
  Effect.gen(function* placementMatchesStageEdge() {
    const config = readStageEdgeConfig();
    const urls = stageEdgeUrls(config);
    const placement = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ buildEnvironment: Schema.Record(Schema.String, Schema.String) })),
    )(readFileSync(path.join(APP_ROOT, 'topology/cloudflare-placement.json'), 'utf-8'));
    const origins = { shellHostname: config.shellHostname, stageZone: config.zone };
    const units = yield* readEdgeUnits;
    const expected = new Map<string, string>([
      ['ULTRAMODERN_EMAIL_SENDER', config.emailSender],
      ['ULTRAMODERN_MF_DEV_ORIGIN', urls.shellUrl],
      ['ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT', urls.storefrontUrl],
      ...units.map((unit): [string, string] => [unit.publicUrlEnv, publicOrigin(unit, origins)]),
    ]);
    for (const [key, value] of expected) {
      expect(placement.buildEnvironment[key], key).toBe(value);
    }
    expect(config.spicedbHostname).toBe(`ontos-stage-spicedb.${config.zone}`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
