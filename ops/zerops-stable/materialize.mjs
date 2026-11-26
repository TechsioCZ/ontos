#!/usr/bin/env node
// Writes the stable Zerops project's zerops.yaml from the canonical demo app/zerops.yaml and a stable config
// (config.mjs). The code, build and runtime mode stay those of stage (ULTRAMODERN_DEPLOYMENT_ENVIRONMENT stays `stage`,
// the Symmy REST ingress stays mounted): stable is another deployment identity of the same demo, not production.
// What changes:
//   - the app's public origins, at build and at run, become the stable origins;
//   - every per-environment value the config owns (STABLE_VARIABLES: mail sender and account, Symmy retention and
//     price read policies, source sync, storefront and N1 tenant identity) is removed from the canonical setup and set
//     only from the config, so nothing of stage's identity is inherited silently;
//   - `shop` gets its own copy of the `storefront` setup, so each storefront's identity is in its setup, not in
//     hand-set service variables;
//   - comments go: they describe stage.
// Within-project references (${db18_…}, ${migrator_…}, ${spicedb_…}, ${SMTP_PASSWORD}, spicedb:50051, http://app:3000)
// stay as they are: they resolve to the stable project's own services and its own secret service variables.
// Afterwards no host, UUID or long hex id of stage's removed values may remain unless the config states it itself.
//
//   node ops/zerops-stable/materialize.mjs --config PATH [--input app/zerops.yaml] --output-directory DIR
//     writes DIR/zerops.yaml (every stable setup) and DIR/<setup>.yaml (one setup each), each under 50 kB
//   node ops/zerops-stable/materialize.mjs --config PATH [--input app/zerops.yaml] --setup NAME --output FILE
//     writes one setup
// --input defaults to the repository's app/zerops.yaml.
// Prints a JSON summary (setup, service, service id, path, bytes) on stdout; no value of the config is printed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Document, parseDocument } from 'yaml';

import { STABLE_SERVICES, STABLE_VARIABLES, StableConfigError, loadStableConfig, validateStableConfig } from './config.mjs';

export class StableMaterializationError extends Error {
  name = 'StableMaterializationError';
}

/** Each stable setup and the canonical setup it copies; the stable service of the same name deploys it. */
export const STABLE_SETUPS = Object.freeze({
  app: 'app',
  storefront: 'storefront',
  shop: 'storefront',
  n1: 'n1',
  spicedb: 'spicedb',
});
/** The app's build and run variables that carry a public origin, and the stable origin each takes. */
export const ORIGIN_VARIABLES = Object.freeze({
  ONTOS_PUBLIC_ORIGIN: 'shell',
  ONTOS_STOREFRONT_ORIGIN: 'storefront',
  ONTOS_SHOP_STOREFRONT_ORIGIN: 'shop',
});
export const ZEROPS_BUILD_FILE_LIMIT_BYTES = 50_000;
/** The canonical demo zerops.yaml of this repository. */
export const CANONICAL_ZEROPS_YAML = fileURLToPath(new URL('../../app/zerops.yaml', import.meta.url));

const PHASES = ['build', 'run'];
const TOKEN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\da-f]{24,}|(?:[\da-z-]+\.)+[a-z][\da-z-]*/gu;
const SERVICE_REFERENCE = /\$\{([a-z][\da-z]*)_/gu;

const fail = (message) => {
  throw new StableMaterializationError(message);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const variableKeys = (setup) => [
  ...Object.keys(STABLE_VARIABLES[setup].required),
  ...Object.keys(STABLE_VARIABLES[setup].optional),
];
const tokensOf = (values) => new Set(values.flatMap((value) => value.toLowerCase().match(TOKEN) ?? []));

/** Every string in `value` (keys too) with its path, for the residue and reference checks. */
const strings = function* strings(value, at) {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* strings(item, `${at}[${String(index)}]`);
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      yield [`${at}.${key}`, key];
      yield* strings(item, `${at}.${key}`);
    }
  }
};

const readCanonical = (zeropsYamlText) => {
  const document = parseDocument(zeropsYamlText);
  if (document.errors.length > 0) fail('the canonical zerops.yaml is not valid YAML');
  const value = document.toJS();
  if (!isObject(value) || !Array.isArray(value.zerops)) fail('the canonical zerops.yaml has no zerops setups');
  const setups = new Map();
  for (const setup of value.zerops) {
    if (!isObject(setup) || typeof setup.setup !== 'string') fail('every canonical zerops.yaml setup needs a name');
    if (setups.has(setup.setup)) fail(`the canonical zerops.yaml names setup "${setup.setup}" twice`);
    if (!isObject(setup.run?.envVariables)) fail(`canonical setup "${setup.setup}" has no run.envVariables`);
    setups.set(setup.setup, setup);
  }
  const expected = [...new Set(Object.values(STABLE_SETUPS))].sort();
  const found = [...setups.keys()].sort();
  if (found.join() !== expected.join()) {
    fail(`the canonical zerops.yaml must hold exactly the setups ${expected.join(', ')}; it holds ${found.join(', ')}`);
  }
  for (const phase of PHASES) {
    for (const variable of Object.keys(ORIGIN_VARIABLES)) {
      if (typeof setups.get('app')[phase]?.envVariables?.[variable] !== 'string') {
        fail(`canonical setup "app" sets no ${phase}.envVariables.${variable}; the stable origins replace it`);
      }
    }
  }
  return setups;
};

/** Hosts, UUIDs and long hex ids of every canonical value the stable config replaces. */
const demoTokens = (setups) => {
  const values = PHASES.flatMap((phase) =>
    Object.keys(ORIGIN_VARIABLES).map((variable) => setups.get('app')[phase].envVariables[variable]),
  );
  for (const [setup, source] of Object.entries(STABLE_SETUPS)) {
    const env = setups.get(source).run.envVariables;
    for (const key of variableKeys(setup)) if (typeof env[key] === 'string') values.push(env[key]);
  }
  return tokensOf(values);
};

const stableSetup = (setups, config, setup) => {
  const copy = structuredClone(setups.get(STABLE_SETUPS[setup]));
  copy.setup = setup;
  const env = copy.run.envVariables;
  for (const key of variableKeys(setup)) delete env[key];
  Object.assign(env, config.variables[setup]);
  if (setup === 'app') {
    for (const phase of PHASES) {
      for (const [variable, origin] of Object.entries(ORIGIN_VARIABLES)) {
        copy[phase].envVariables[variable] = config.origins[origin];
      }
    }
  }
  for (const phase of PHASES) {
    const variables = copy[phase]?.envVariables;
    if (isObject(variables)) copy[phase].envVariables = Object.fromEntries(Object.entries(variables).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return copy;
};

const checkSetup = (setup, residue) => {
  for (const [at, value] of strings(setup, `setup ${setup.setup}`)) {
    const lower = value.toLowerCase();
    for (const token of residue) {
      if (lower.includes(token)) fail(`${at} still carries a stage value the stable config does not state`);
    }
    for (const [, service] of value.matchAll(SERVICE_REFERENCE)) {
      if (!STABLE_SERVICES.includes(service)) fail(`${at} references service "${service}", which the stable project does not have`);
    }
  }
};

const render = (setups, comment) => {
  const document = new Document({ zerops: setups });
  document.commentBefore = comment;
  const file = document.toString({ lineWidth: 0 });
  const bytes = Buffer.byteLength(file);
  if (bytes >= ZEROPS_BUILD_FILE_LIMIT_BYTES) {
    fail(`${comment.trim()} is ${String(bytes)} bytes; Zerops accepts less than ${String(ZEROPS_BUILD_FILE_LIMIT_BYTES)}`);
  }
  return file;
};

const GENERATED = ' Generated by ops/zerops-stable/materialize.mjs from app/zerops.yaml and the stable config. Do not edit.';

/**
 * The stable zerops.yaml: `combined` holds every stable setup (app, storefront, shop, n1, spicedb); `setups` holds one
 * file per setup with the service that deploys it. Every file is under Zerops' 50 kB limit.
 */
export const materializeStableZerops = (zeropsYamlText, configValue) => {
  const config = validateStableConfig(configValue);
  const canonical = readCanonical(zeropsYamlText);
  const demo = demoTokens(canonical);
  for (const [name, origin] of Object.entries(config.origins)) {
    if (demo.has(new URL(origin).hostname)) fail(`stable config origins.${name} is a stage host`);
  }
  const stated = JSON.stringify(config).toLowerCase();
  const residue = [...demo].filter((token) => !stated.includes(token));
  const setups = Object.keys(STABLE_SETUPS).map((setup) => stableSetup(canonical, config, setup));
  for (const setup of setups) checkSetup(setup, residue);
  return {
    combined: render(setups, GENERATED),
    setups: setups.map((setup) => ({
      setup: setup.setup,
      service: setup.setup,
      serviceId: config.services[setup.setup],
      file: render([setup], `${GENERATED} Setup "${setup.setup}" only.`),
    })),
  };
};

/** One stable setup as its own zerops.yaml. */
export const materializeStableSetup = (zeropsYamlText, configValue, setup) => {
  if (!Object.hasOwn(STABLE_SETUPS, setup)) fail(`"${setup}" is not a stable setup (${Object.keys(STABLE_SETUPS).join(', ')})`);
  return materializeStableZerops(zeropsYamlText, configValue).setups.find((entry) => entry.setup === setup).file;
};

const USAGE = [
  'usage: node ops/zerops-stable/materialize.mjs --config PATH [--input app/zerops.yaml] --output-directory DIR',
  '       node ops/zerops-stable/materialize.mjs --config PATH [--input app/zerops.yaml] --setup NAME --output FILE',
].join('\n');

export const main = async (argv) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      'output-directory': { type: 'string' },
      setup: { type: 'string' },
    },
    strict: true,
  });
  const directory = values['output-directory'];
  const single = values.setup !== undefined || values.output !== undefined;
  if (values.config === undefined || (directory === undefined) === !single) fail(USAGE);
  if (single && (values.setup === undefined || values.output === undefined)) fail(USAGE);
  const config = await loadStableConfig(values.config);
  const text = await readFile(values.input ?? CANONICAL_ZEROPS_YAML, 'utf8');
  if (single) {
    const file = materializeStableSetup(text, config, values.setup);
    await mkdir(path.dirname(values.output), { recursive: true });
    await writeFile(values.output, file);
    return [{ setup: values.setup, service: values.setup, serviceId: config.services[values.setup], path: values.output, bytes: Buffer.byteLength(file) }];
  }
  const { combined, setups } = materializeStableZerops(text, config);
  await mkdir(directory, { recursive: true });
  const combinedPath = path.join(directory, 'zerops.yaml');
  await writeFile(combinedPath, combined);
  const written = [{ setup: null, service: null, serviceId: null, path: combinedPath, bytes: Buffer.byteLength(combined) }];
  for (const { setup, service, serviceId, file } of setups) {
    const target = path.join(directory, `${setup}.yaml`);
    await writeFile(target, file);
    written.push({ setup, service, serviceId, path: target, bytes: Buffer.byteLength(file) });
  }
  return written;
};

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const known = error instanceof StableConfigError || error instanceof StableMaterializationError || error?.code?.startsWith?.('ERR_PARSE_ARGS');
    process.stderr.write(`${known ? error.message : `stable materialization failed: ${error?.name ?? 'error'} ${error?.code ?? ''}`}\n`);
    process.exitCode = 1;
  }
}
