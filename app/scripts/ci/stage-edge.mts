#!/usr/bin/env node
/// <reference lib="esnext" />
/// <reference types="node" />
// The one reviewed source of the stage edge's Cloudflare account, workers.dev subdomain, zone and public hostnames:
// topology/stage-edge.json. The demo deploy workflow exports it to its jobs, the release secret preparation derives
// every host-bearing binding from it, and the topology/** digest input rebuilds every unit when it changes.
// Dependency-free (Node builtins): the plan job runs it before any workspace install.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isJsonObject } from './unit-closure.mts';

export const STAGE_EDGE_FILE = 'topology/stage-edge.json';
const PLACEMENT_FILE = 'topology/cloudflare-placement.json';

export interface StageEdgeConfig {
  readonly accountId: string;
  readonly emailSender: string;
  readonly shellHostname: string;
  readonly spicedbHostname: string;
  /** Written by provisioning: empty until the namespace exists, and every deploy fails closed until then. */
  readonly storefrontCatalogKvId: string;
  readonly storefrontHostname: string;
  readonly workersDevSubdomain: string;
  readonly zone: string;
}

export class StageEdgeConfigError extends Error {
  override readonly name = 'StageEdgeConfigError';
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
const FIELDS = new Map<keyof StageEdgeConfig, RegExp>([
  ['accountId', /^[a-f0-9]{32}$/u],
  ['emailSender', /^[a-z0-9._+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u],
  ['shellHostname', HOSTNAME],
  ['spicedbHostname', HOSTNAME],
  ['storefrontCatalogKvId', /^(?:[a-f0-9]{32})?$/u],
  ['storefrontHostname', HOSTNAME],
  ['workersDevSubdomain', LABEL],
  ['zone', HOSTNAME],
]);

const FIELD_NAMES: ReadonlySet<string> = new Set(FIELDS.keys());

const inZone = (hostname: string, zone: string) => hostname === zone || hostname.endsWith(`.${zone}`);

/** The decoded config, or a StageEdgeConfigError naming the invalid fields (never their values). */
export const parseStageEdgeConfig = (text: string): StageEdgeConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StageEdgeConfigError(`${STAGE_EDGE_FILE} is not valid JSON`);
  }
  if (!isJsonObject(raw)) {
    throw new StageEdgeConfigError(`${STAGE_EDGE_FILE} must be a JSON object`);
  }
  const invalid = Object.keys(raw).filter((key) => !FIELD_NAMES.has(key));
  const field = (key: keyof StageEdgeConfig): string => {
    const value = raw[key];
    if (typeof value === 'string' && FIELDS.get(key)?.test(value) === true) {
      return value;
    }
    invalid.push(key);
    return '';
  };
  const config: StageEdgeConfig = Object.freeze({
    accountId: field('accountId'),
    emailSender: field('emailSender'),
    shellHostname: field('shellHostname'),
    spicedbHostname: field('spicedbHostname'),
    storefrontCatalogKvId: field('storefrontCatalogKvId'),
    storefrontHostname: field('storefrontHostname'),
    workersDevSubdomain: field('workersDevSubdomain'),
    zone: field('zone'),
  });
  if (invalid.length > 0) {
    throw new StageEdgeConfigError(`${STAGE_EDGE_FILE} has invalid or unknown fields: ${invalid.join(', ')}`);
  }
  const outside = (
    [
      ['shellHostname', config.shellHostname],
      ['storefrontHostname', config.storefrontHostname],
      ['spicedbHostname', config.spicedbHostname],
      ['emailSender', config.emailSender.slice(config.emailSender.indexOf('@') + 1)],
    ] as const
  ).filter(([, hostname]) => !inZone(hostname, config.zone));
  if (outside.length > 0) {
    throw new StageEdgeConfigError(
      `${STAGE_EDGE_FILE}: ${outside.map(([fieldName]) => fieldName).join(', ')} must be inside zone ${config.zone}`,
    );
  }
  return config;
};

/** The app workspace directory, which holds topology/. */
export const APP_ROOT = path.resolve(import.meta.dirname, '../..');

export const readStageEdgeConfig = (appRoot: string = APP_ROOT): StageEdgeConfig =>
  parseStageEdgeConfig(readFileSync(path.join(appRoot, STAGE_EDGE_FILE), 'utf-8'));

/** The public origins and URLs every stage consumer derives from the config. */
export const stageEdgeUrls = (config: StageEdgeConfig) => {
  const shellUrl = `https://${config.shellHostname}`;
  const shellApiBaseUrl = `${shellUrl}/shell-super-app-api`;
  return Object.freeze({
    emailDispatchUrl: `${shellApiBaseUrl}/email/dispatch`,
    oauthIssuer: `${shellApiBaseUrl}/oauth`,
    shellApiBaseUrl,
    shellUrl,
    storefrontUrl: `https://${config.storefrontHostname}`,
  });
};

/** The variables the demo deploy workflow's jobs read, by their environment names. */
export const stageEdgeWorkflowVariables = (config: StageEdgeConfig): Readonly<Record<string, string>> => {
  const urls = stageEdgeUrls(config);
  return Object.freeze({
    STAGE_SHELL_URL: urls.shellUrl,
    STAGE_STOREFRONT_CATALOG_KV_ID: config.storefrontCatalogKvId,
    STAGE_STOREFRONT_URL: urls.storefrontUrl,
    WORKERS_DEV_SUBDOMAIN: config.workersDevSubdomain,
  });
};

/**
 * The config a stage deploy can use, or a StageEdgeConfigError naming what is missing: the environment's account must
 * be the config's, and provisioning must have written the storefront KV and every placement build variable.
 */
export const deployableStageEdge = ({
  appRoot = APP_ROOT,
  expectedAccountId,
}: {
  readonly appRoot?: string;
  readonly expectedAccountId?: string | undefined;
}): StageEdgeConfig => {
  const config = readStageEdgeConfig(appRoot);
  if (expectedAccountId !== undefined && expectedAccountId !== config.accountId) {
    throw new StageEdgeConfigError(
      `the stage-edge CLOUDFLARE_ACCOUNT_ID variable does not match ${STAGE_EDGE_FILE} accountId: make them equal`,
    );
  }
  if (config.storefrontCatalogKvId === '') {
    throw new StageEdgeConfigError(
      `${STAGE_EDGE_FILE} storefrontCatalogKvId is empty: provision the storefront catalog KV namespace and record its ID`,
    );
  }
  let placement: unknown;
  try {
    placement = JSON.parse(readFileSync(path.join(appRoot, PLACEMENT_FILE), 'utf-8'));
  } catch {
    throw new StageEdgeConfigError(`${PLACEMENT_FILE} could not be read`);
  }
  const buildEnvironment = isJsonObject(placement) ? placement.buildEnvironment : undefined;
  if (!isJsonObject(buildEnvironment)) {
    throw new StageEdgeConfigError(`${PLACEMENT_FILE} has no buildEnvironment`);
  }
  const unset = Object.entries(buildEnvironment)
    .filter(([, value]) => typeof value !== 'string' || value === '')
    .map(([key]) => key);
  if (unset.length > 0) {
    throw new StageEdgeConfigError(
      `${PLACEMENT_FILE} leaves ${unset.join(', ')} empty: run cloudflare-stage-cutover.mts provision`,
    );
  }
  return config;
};

const USAGE = [
  'usage: stage-edge.mts export [--cloudflare-account-id <id>] [--github-env <file>] [--github-output <file>]',
  '       stage-edge.mts shell-gateway-url',
].join('\n');

const main = (argv: readonly string[]) => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'cloudflare-account-id': { type: 'string' },
      'github-env': { type: 'string' },
      'github-output': { type: 'string' },
    },
    strict: true,
  });
  // The Shell gateway base URL alone, for operator jobs that call the Shell but deploy nothing: it needs no
  // provisioned storefront KV or placement IDs.
  if (command === 'shell-gateway-url' && Object.keys(values).length === 0) {
    console.log(stageEdgeUrls(readStageEdgeConfig()).shellApiBaseUrl);
    return;
  }
  if (command !== 'export') {
    throw new StageEdgeConfigError(USAGE);
  }
  const entries = Object.entries(
    stageEdgeWorkflowVariables(deployableStageEdge({ expectedAccountId: values['cloudflare-account-id'] })),
  );
  if (values['github-env'] !== undefined) {
    appendFileSync(values['github-env'], entries.map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (values['github-output'] !== undefined) {
    appendFileSync(values['github-output'], entries.map(([key, value]) => `${key.toLowerCase()}=${value}\n`).join(''));
  }
  console.log(entries.map(([key, value]) => `${key}=${value}`).join('\n'));
};

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
