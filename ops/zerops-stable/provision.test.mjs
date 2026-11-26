import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { parse } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

import { loadStableConfig, StableConfigError } from './config.mjs';
import {
  CANONICAL_IMPORT_PATH,
  loadDemoIdentities,
  main,
  mergeVariables,
  parseProvisionSpec,
  parseZcliProjectList,
  parseZcliServiceList,
  renderProjectImport,
} from './provision.mjs';

const readExample = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
const example = () => readExample('provision-spec.example.json');
/** Per-setup variables of config.mjs's example, as an operator variables file. */
const operatorVariables = () => readExample('example.config.json').variables;
const canonical = readFileSync(CANONICAL_IMPORT_PATH, 'utf8');
const workspace = () => mkdtempSync(path.join(tmpdir(), 'ontos-stable-provision-'));
const writeJson = (directory, name, value) => {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
};

const projectTable = (rows) =>
  [
    '┌──────┬──────┬──────────┬────────┬────────┬───────┐',
    '│ ID │ NAME │ ORG NAME │ ORG ID │ STATUS │ MODE │',
    '├──────┼──────┼──────────┼────────┼────────┼───────┤',
    ...rows.map((row) => `│ ${row.join(' │ ')} │`),
    '└──────┴──────┴──────────┴────────┴────────┴───────┘',
  ].join('\n');
const serviceTable = (rows) => ['│ ID │ NAME │ STATUS │', ...rows.map((row) => `│ ${row.join(' │ ')} │`)].join('\n');
const ORG = 'KyBprR6GQHePj6ahY0i0ew';
const DEMO = 't1ljmn3DRDafgi8AuPvhdQ';
const NEW_PROJECT = 'NewStableProject0001';
const HOSTS = ['app', 'storefront', 'shop', 'n1', 'spicedb', 'db18', 'migrator'];
const serviceId = (host) => `svc-${host}-0000000000000`.slice(0, 22);
const listedServices = serviceTable(HOSTS.map((host) => [serviceId(host), host, 'ACTIVE']));
const demoRow = [DEMO, 'OntOS', 'BDA', ORG, 'ACTIVE', 'LIGHT'];
const stableRow = [NEW_PROJECT, 'OntOS stable', 'BDA', ORG, 'ACTIVE', 'LIGHT'];
const demoIdentities = loadDemoIdentities();

test('the import keeps the canonical topology, names the new project and carries no variable or secret', () => {
  const spec = parseProvisionSpec(example());
  const rendered = renderProjectImport(spec, canonical);
  const document = parse(rendered);
  assert.deepEqual(document.project, { corePackage: 'LIGHT', name: 'OntOS stable' });
  assert.deepEqual(document.services, parse(canonical).services, 'every canonical service, unchanged and in order');
  assert.doesNotMatch(rendered, /ontos-stage|t1ljmn3DRDafgi8AuPvhdQ|vault|sensitive|PASSWORD|SECRET/u);
  assert.equal(renderProjectImport(spec, canonical), rendered, 'rendering is deterministic');
});

test('the spec refuses demo origins, the demo name, bad origins and IDs of the new project', () => {
  const cases = [
    [(spec) => (spec.origins.shop = 'https://ontos-stage-shop.web-revolution.cz'), /demo stage host/u],
    [(spec) => (spec.origins.n1 = 'http://ontos-n1.example'), /https origin/u],
    [(spec) => (spec.origins.n1 = spec.origins.shop), /distinct/u],
    [(spec) => (spec.projectName = 'OntOS'), /demo project name/u],
    [(spec) => (spec.projectId = 'x'.repeat(22)), /exactly the keys/u],
    [(spec) => (spec.corePackage = 'HUGE'), /corePackage/u],
  ];
  for (const [mutate, message] of cases) {
    const spec = example();
    mutate(spec);
    assert.throws(() => parseProvisionSpec(spec), message);
  }
});

test('zcli tables parse into projects and services', () => {
  assert.deepEqual(parseZcliProjectList(projectTable([demoRow])), [
    { id: DEMO, mode: 'LIGHT', name: 'OntOS', orgId: ORG, orgName: 'BDA', status: 'ACTIVE' },
  ]);
  assert.deepEqual(parseZcliServiceList(serviceTable([['s1abcdefghij', 'app', 'ACTIVE']])), [
    { hostname: 'app', id: 's1abcdefghij', status: 'ACTIVE' },
  ]);
});

test('a blank optional MODE cell cannot hide an existing paid project', () => {
  const row = [...stableRow];
  row[5] = '';
  const projects = parseZcliProjectList(projectTable([row]));
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, NEW_PROJECT);
  assert.equal(projects[0].mode, '');
  assert.throws(() => parseZcliProjectList('│ truncated │ row │'), /Unrecognized zcli table row/u);
});

test('the command renders without Zerops, and creation needs both paid flags', () => {
  const directory = workspace();
  const specFile = writeJson(directory, 'spec.json', example());
  const output = path.join(directory, 'import.yaml');
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return projectTable([demoRow]);
  };
  const quiet = { demoIdentities, log: () => undefined, run };
  main(['--config', specFile, '--output', output], quiet);
  assert.deepEqual(calls, [], 'rendering never calls zcli');
  assert.match(readFileSync(output, 'utf8'), /name: OntOS stable/u);
  assert.throws(() => main(['--config', specFile, '--output', output, '--apply'], quiet), /confirm-paid-resources/u);
  assert.throws(() => main(['--config', specFile, '--output', output, '--confirm-paid-resources'], quiet), /--apply/u);
  assert.deepEqual(calls, []);
  main(['--config', specFile, '--output', output, '--apply', '--confirm-paid-resources'], quiet);
  assert.deepEqual(calls, [
    ['project', 'list'],
    ['project', 'project-import', output, '--org-id', ORG],
  ]);
});

test('apply creates nothing when the project exists; resolve writes a stable config that config.mjs loads', async () => {
  const directory = workspace();
  const specFile = writeJson(directory, 'spec.json', example());
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === 'project' ? projectTable([demoRow, stableRow]) : listedServices;
  };
  const quiet = { demoIdentities, log: () => undefined, run };
  main(
    ['--config', specFile, '--output', path.join(directory, 'import.yaml'), '--apply', '--confirm-paid-resources'],
    quiet,
  );
  assert.deepEqual(calls, [['project', 'list']], 'no second project is imported');
  const { shop, ...rest } = operatorVariables();
  const shopIdentity = writeJson(directory, 'storefront-variables.json', { shop });
  const operator = writeJson(directory, 'operator-variables.json', rest);
  const stable = path.join(directory, 'stable.json');
  main(
    ['--config', specFile, '--resolve', '--variables', operator, '--variables', shopIdentity, '--output', stable],
    quiet,
  );
  const config = await loadStableConfig(stable);
  assert.equal(config.projectId, NEW_PROJECT);
  assert.equal(config.demoProjectId, DEMO);
  assert.equal(config.services.shop, serviceId('shop'));
  assert.equal(config.origins.shell, 'https://ontos.web-revolution.cz');
  assert.deepEqual(calls.at(-1), ['service', 'list', '--project-id', NEW_PROJECT]);
});

test('resolve refuses a missing project or service, demo identities and conflicting variable files', () => {
  const directory = workspace();
  const specFile = writeJson(directory, 'spec.json', example());
  const stable = path.join(directory, 'stable.json');
  const variables = writeJson(directory, 'variables.json', operatorVariables());
  const argv = ['--config', specFile, '--resolve', '--variables', variables, '--output', stable];
  const none = () => projectTable([demoRow]);
  assert.throws(() => main(argv, { demoIdentities, run: none }), StableConfigError);
  const partial = (args) =>
    args[0] === 'project' ? projectTable([stableRow]) : serviceTable([[serviceId('app'), 'app', 'ACTIVE']]);
  assert.throws(() => main(argv, { demoIdentities, run: partial }), /storefront/u);
  const full = (args) => (args[0] === 'project' ? projectTable([stableRow]) : listedServices);
  const copied = operatorVariables();
  copied.storefront.ONTOS_STOREFRONT_LEGAL_ENTITY_ID = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
  const copiedFile = writeJson(directory, 'copied.json', copied);
  assert.throws(
    () =>
      main(['--config', specFile, '--resolve', '--variables', copiedFile, '--output', stable], {
        demoIdentities,
        run: full,
      }),
    /demo identity/u,
  );
  assert.throws(
    () => mergeVariables([{ shop: { STOREFRONT_BRAND: 'a' } }, { shop: { STOREFRONT_BRAND: 'b' } }]),
    /differ/u,
  );
  assert.throws(() => main(['--config', specFile, '--resolve', '--output', stable], { run: full }), /--variables/u);
});
