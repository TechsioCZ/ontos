#!/usr/bin/env node
/**
 * Stable environment provisioning: a completely new Zerops project with the topology of `app/zerops-import.yaml`,
 * never the demo project.
 *
 *   node ops/zerops-stable/provision.mjs --config <provision-spec.json> --output <import.yaml>
 *       Renders the Zerops project import (offline, no Zerops call): the new project name and core package and the
 *       canonical services, unchanged. It carries no variable and no secret: per-setup variables are written into the
 *       stable setups by materialize.mjs, credentials by secrets.mjs.
 *   node ops/zerops-stable/provision.mjs --config <spec> --output <import.yaml> --apply --confirm-paid-resources
 *       Creates the paid project with `zcli project project-import <import.yaml> --org-id <orgId>`, unless a project of
 *       that name already exists in the organization (Zerops allows duplicate names, so this is the idempotency guard).
 *   node ops/zerops-stable/provision.mjs --config <spec> --resolve --variables <file> [--variables <file>…]
 *       --output <stable.json>
 *       Reads the IDs Zerops assigned (`zcli project list`, `zcli service list --project-id`) and writes the stable
 *       config (config.mjs) with the spec's origins and the per-setup variables of the given files, merged.
 *
 * Before creation the project and its services have no IDs, so the provision spec names the project (`projectName`)
 * and carries no ID of the new project. Only `--resolve` produces the stable config with the assigned IDs.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { parse, stringify } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

import { STABLE_ORIGINS, STABLE_SERVICES, StableConfigError, validateStableConfig } from './config.mjs';

export const CANONICAL_IMPORT_PATH = fileURLToPath(new URL('../../app/zerops-import.yaml', import.meta.url));
/** Files whose UUIDs are demo identities: tenants, companies and Symmy routes of stage, the storefront's default company. */
export const DEMO_IDENTITY_SOURCES = [
  fileURLToPath(new URL('../../app/zerops.yaml', import.meta.url)),
  fileURLToPath(new URL('../../app/akros-storefront/src/ontos/config.ts', import.meta.url)),
];
/** The live demo stage's public hosts. A stable origin or variable never names one. */
export const DEMO_HOSTS = [
  'ontos-stage.web-revolution.cz',
  'ontos-stage-akros.web-revolution.cz',
  'ontos-stage-shop.web-revolution.cz',
  'ontos-stage-n1.web-revolution.cz',
  'ontos-stage-spicedb.web-revolution.cz',
];
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu;
const ZEROPS_ID = /^[\w-]{16,64}$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,62}$/u;

const refuse = (message) => {
  throw new StableConfigError(message);
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value, keys, where) => {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    refuse(`${where} must have exactly the keys ${expected.join(', ')} (found ${actual.join(', ') || 'none'})`);
  }
  return value;
};

const zeropsId = (value, where) =>
  typeof value === 'string' && ZEROPS_ID.test(value) ? value : refuse(`${where} must be a Zerops ID`);

/** Every UUID the demo deployment names, lowercased. */
export const loadDemoIdentities = (files = DEMO_IDENTITY_SOURCES) =>
  new Set(files.flatMap((file) => (readFileSync(file, 'utf8').match(UUID) ?? []).map((id) => id.toLowerCase())));

/** Refuses a value that names the demo project, a demo host or a demo identity. */
export const refuseDemoReferences = (value, { demoIdentities, demoProjectId }, where) => {
  const serialized = JSON.stringify(value);
  if (serialized.includes(demoProjectId)) refuse(`${where} names the demo project`);
  const host = DEMO_HOSTS.find((candidate) => serialized.includes(candidate));
  if (host !== undefined) refuse(`${where} names the demo host ${host}`);
  const id = (serialized.match(UUID) ?? []).find((candidate) => demoIdentities.has(candidate.toLowerCase()));
  if (id !== undefined) refuse(`${where} names the demo identity ${id}; stable identities are new`);
  return value;
};

/** Four distinct https origins (no path, query or credentials), none of them a demo host. */
export const parseOrigins = (value, where = 'origins') => {
  exactKeys(value, STABLE_ORIGINS, where);
  for (const name of STABLE_ORIGINS) {
    const raw = value[name];
    let url;
    try {
      url = new URL(raw);
    } catch {
      refuse(`${where}.${name} must be an https origin`);
    }
    if (url.protocol !== 'https:' || url.origin !== raw) {
      refuse(`${where}.${name} must be exactly an https origin such as https://host.example`);
    }
    if (DEMO_HOSTS.includes(url.hostname)) refuse(`${where}.${name} is a demo stage host (${url.hostname})`);
  }
  if (new Set(STABLE_ORIGINS.map((name) => value[name])).size !== STABLE_ORIGINS.length) {
    refuse(`${where} must be four distinct origins`);
  }
  return Object.freeze(Object.fromEntries(STABLE_ORIGINS.map((name) => [name, value[name]])));
};

/**
 * The provision spec, before the project exists: the new project's name, its organization and core package, the
 * demo project it must never be, and the public origins. It holds no ID of the new project.
 */
export const parseProvisionSpec = (value) => {
  exactKeys(value, ['schemaVersion', 'projectName', 'orgId', 'corePackage', 'demoProjectId', 'origins'], 'spec');
  if (value.schemaVersion !== 1) refuse('spec.schemaVersion must be 1');
  if (typeof value.projectName !== 'string' || !PROJECT_NAME.test(value.projectName)) {
    refuse('spec.projectName must be a project name (2-63 letters, digits, spaces, dots, dashes or underscores)');
  }
  if (value.projectName.toLowerCase() === 'ontos') refuse('spec.projectName must not be the demo project name OntOS');
  if (!['LIGHT', 'SERIOUS'].includes(value.corePackage)) refuse('spec.corePackage must be LIGHT or SERIOUS');
  return Object.freeze({
    corePackage: value.corePackage,
    demoProjectId: zeropsId(value.demoProjectId, 'spec.demoProjectId'),
    orgId: zeropsId(value.orgId, 'spec.orgId'),
    origins: parseOrigins(value.origins, 'spec.origins'),
    projectName: value.projectName,
    schemaVersion: 1,
  });
};

export const readJsonFile = (file, what) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    refuse(`${what} ${file} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return refuse(`${what} ${file} is not JSON`);
  }
};

export const loadProvisionSpec = (file) => parseProvisionSpec(readJsonFile(file, 'Provision spec'));

/**
 * The Zerops project import (documented keys `project.name`, `project.corePackage`, `services`): the canonical
 * services exactly as `app/zerops-import.yaml` declares them, in order. Re-rendering the same spec yields the same
 * bytes.
 */
export const renderProjectImport = (spec, canonicalImportText) => {
  const canonical = parse(canonicalImportText);
  const services = canonical?.services;
  if (!Array.isArray(services)) refuse('The canonical import has no services list');
  const hostnames = services.map((service) => service.hostname);
  if (hostnames.length !== STABLE_SERVICES.length || STABLE_SERVICES.some((name) => !hostnames.includes(name))) {
    refuse(`The canonical import must declare exactly ${STABLE_SERVICES.join(', ')} (found ${hostnames.join(', ')})`);
  }
  if (Object.hasOwn(canonical, 'project')) refuse('The canonical import must not declare a project');
  for (const service of services) {
    if (Object.keys(service).some((key) => /vault|env|secret|buildFromGit|zeropsYaml/iu.test(key))) {
      refuse(`The canonical service ${service.hostname} carries variables or code; the stable import copies none`);
    }
  }
  const origins = STABLE_ORIGINS.map((name) => `${name}=${spec.origins[name]}`).join(' ');
  return [
    '# Generated by ops/zerops-stable/provision.mjs from app/zerops-import.yaml. Contains no variable and no secret.',
    `# Stable project ${spec.projectName}; origins: ${origins}`,
    stringify({ project: { corePackage: spec.corePackage, name: spec.projectName }, services }, { lineWidth: 0 }),
  ].join('\n');
};

/** Rows of a `zcli` box table: each line split on `│`, header and borders dropped. */
const tableRows = (output, columns) =>
  output.split('\n').flatMap((line) => {
    if (!line.trim().startsWith('│') || !line.trim().endsWith('│')) return [];
    const cells = line
      .split('│')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === 'ID') return [];
    if (cells.length !== columns || cells[0] === '') refuse('Unrecognized zcli table row; refusing to infer that a project is absent');
    return [cells];
  });

/** `zcli project list`: `│ ID │ NAME │ ORG NAME │ ORG ID │ STATUS │ MODE │`. */
export const parseZcliProjectList = (output) =>
  tableRows(output, 6).map(([id, name, orgName, orgId, status, mode]) => ({ id, mode, name, orgId, orgName, status }));

/** `zcli service list --project-id <id>`: `│ ID │ NAME │ STATUS │`. */
export const parseZcliServiceList = (output) =>
  tableRows(output, 3).map(([id, hostname, status]) => ({ hostname, id, status }));

/** The one project of the spec's name in its organization, or none; two of that name are refused. */
export const findSpecProject = (spec, projects) => {
  const matches = projects.filter((project) => project.name === spec.projectName && project.orgId === spec.orgId);
  if (matches.length > 1) refuse(`Organization ${spec.orgId} has ${matches.length} projects named ${spec.projectName}`);
  const [match] = matches;
  if (match?.id === spec.demoProjectId) refuse(`Project ${spec.projectName} is the demo project`);
  return match;
};

/** Per-setup variable files merged; a key two files set differently is refused. */
export const mergeVariables = (files) => {
  const merged = {};
  for (const [index, file] of files.entries()) {
    if (!isRecord(file)) refuse(`variables file ${index + 1} must be an object of setups`);
    for (const [setup, entries] of Object.entries(file)) {
      if (!isRecord(entries)) refuse(`variables file ${index + 1}: ${setup} must be an object`);
      merged[setup] ??= {};
      for (const [key, value] of Object.entries(entries)) {
        if (Object.hasOwn(merged[setup], key) && merged[setup][key] !== value) {
          refuse(`variables ${setup}.${key} differ between the given files`);
        }
        merged[setup][key] = value;
      }
    }
  }
  return merged;
};

/**
 * The stable config of the created project, from what Zerops lists: every canonical service must exist once, and
 * neither the variables nor the origins may name the demo project, a demo host or a demo identity.
 */
export const resolveStableConfig = (spec, projects, servicesOf, variables, demoIdentities) => {
  const project = findSpecProject(spec, projects);
  if (project === undefined) {
    refuse(`No project named ${spec.projectName} in organization ${spec.orgId}; create it first`);
  }
  const listed = servicesOf(project.id);
  const services = {};
  for (const hostname of STABLE_SERVICES) {
    const matches = listed.filter((service) => service.hostname === hostname);
    if (matches.length !== 1) {
      refuse(`Project ${project.id} must have exactly one ${hostname} service (found ${matches.length})`);
    }
    services[hostname] = matches[0].id;
  }
  refuseDemoReferences(variables, { demoIdentities, demoProjectId: spec.demoProjectId }, 'variables');
  return validateStableConfig({
    demoProjectId: spec.demoProjectId,
    origins: spec.origins,
    projectId: project.id,
    schemaVersion: 1,
    services,
    variables,
  });
};

const zcli = (args) => execFileSync('zcli', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Writes through a sibling temporary file and a rename, so a reader never sees half a file. */
export const writeFileAtomically = (file, text, mode) => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, file);
};

const USAGE = [
  'Usage:',
  '  provision.mjs --config <spec.json> --output <import.yaml>                                    render the import',
  '  provision.mjs --config <spec.json> --output <import.yaml> --apply --confirm-paid-resources   create the project',
  '  provision.mjs --config <spec.json> --resolve --variables <file> [--variables <file>…] --output <stable.json>',
].join('\n');

/** Reads the command line exactly; any other flag, a repeat or a missing value is refused. */
export const parseArguments = (argv) => {
  const options = {
    apply: false,
    config: undefined,
    confirmPaid: false,
    output: undefined,
    resolve: false,
    variables: [],
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--variables' && seen.has(flag)) refuse(`${flag} is given twice\n${USAGE}`);
    seen.add(flag);
    if (flag === '--config' || flag === '--output' || flag === '--variables') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) refuse(`${flag} needs a path\n${USAGE}`);
      if (flag === '--variables') options.variables.push(value);
      else options[flag.slice(2)] = value;
      index += 1;
    } else if (flag === '--apply') options.apply = true;
    else if (flag === '--confirm-paid-resources') options.confirmPaid = true;
    else if (flag === '--resolve') options.resolve = true;
    else refuse(`Unknown argument ${flag}\n${USAGE}`);
  }
  if (options.config === undefined || options.output === undefined) {
    refuse(`--config and --output are required\n${USAGE}`);
  }
  if (options.resolve !== options.variables.length > 0)
    refuse(`--resolve takes --variables, and only it does\n${USAGE}`);
  if (options.resolve && (options.apply || options.confirmPaid))
    refuse(`--resolve creates nothing; drop --apply\n${USAGE}`);
  if (options.apply !== options.confirmPaid) {
    refuse(
      `Creating the project is paid: --apply needs --confirm-paid-resources, and that flag needs --apply\n${USAGE}`,
    );
  }
  return options;
};

/** One run of the command, with zcli behind `run` so tests never reach Zerops. */
export const main = (argv, { demoIdentities = loadDemoIdentities(), log = console.log, run = zcli } = {}) => {
  const options = parseArguments(argv);
  const spec = loadProvisionSpec(options.config);
  if (options.resolve) {
    const variables = mergeVariables(options.variables.map((file) => readJsonFile(file, 'Variables file')));
    const projects = parseZcliProjectList(run(['project', 'list']));
    const config = resolveStableConfig(
      spec,
      projects,
      (projectId) => parseZcliServiceList(run(['service', 'list', '--project-id', projectId])),
      variables,
      demoIdentities,
    );
    writeFileAtomically(options.output, `${JSON.stringify(config, null, 2)}\n`, 0o644);
    log(`Stable config written to ${options.output}: project ${config.projectId}`);
    for (const service of STABLE_SERVICES) log(`  ${service}: ${config.services[service]}`);
    return config;
  }
  writeFileAtomically(options.output, renderProjectImport(spec, readFileSync(CANONICAL_IMPORT_PATH, 'utf8')), 0o644);
  log(
    `Import for new project "${spec.projectName}" written to ${options.output} (7 services, no variables or secrets)`,
  );
  if (!options.apply) {
    log('Nothing was created. Create the paid project with the same command plus --apply --confirm-paid-resources.');
    return undefined;
  }
  const existing = findSpecProject(spec, parseZcliProjectList(run(['project', 'list'])));
  if (existing !== undefined) {
    log(`Project "${spec.projectName}" already exists (${existing.id}, ${existing.status}); nothing was created.`);
    return existing;
  }
  run(['project', 'project-import', options.output, '--org-id', spec.orgId]);
  log(`Project "${spec.projectName}" import submitted. Record its IDs with --resolve once the services are listed.`);
  return undefined;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof StableConfigError ? error.message : `Provisioning failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
