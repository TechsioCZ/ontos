#!/usr/bin/env node
// Builds a stable release in CI, installs it into the stable Zerops project and checks what runs there. The
// Zerops Stable Release workflow (.github/workflows/zerops-stable.yml) runs all three; an operator can too.
//
//   node ops/zerops-stable/deploy.mjs build --config PATH --tag TAG --output DIR [--demo-ref REF] [--remote NAME]
//     From a clean checkout at the tag (fetch-depth 0), workspace installed. Writes the install artifacts.
//   ZEROPS_TOKEN=… node ops/zerops-stable/deploy.mjs install --config PATH --tag TAG --artifacts DIR [--execute]
//     Without --execute a plan: every check runs, nothing changes. Prints the install kind.
//   ZEROPS_TOKEN=… node ops/zerops-stable/deploy.mjs verify --config PATH --tag TAG
//     Every workload of the stable project is ACTIVE on the tag's commit and every public origin answers.
//
// The live app versions decide what an install deploys (deploy-evidence.mjs installKind): the first install deploys
// the app alone, so the live app can issue the storefront keys; the next install of the same artifacts deploys only
// the fronts; every later one is an update of all four, app first. The app runs its migrations on start; Zerops'
// native backups cover the data, and a failed Zerops build leaves the running version serving.
//
// Every install proves the project is the stable one (not the demo, every service its own) and the artifacts are
// exactly what CI built from the tag and this config. The build runs the repository's own tooling: build-app.sh
// with the stable app setup's build variables, pack-prebuilt-units.sh and build-storefront.sh. The app package is a
// shallow clone of the tag, never the operator's checkout: the materialized zerops.yaml replaces app/zerops.yaml
// there with its index entry marked skip-worktree, so the Git tree reads clean and every release identity stays the
// tag's commit. Each push runs the tag's own push-service.sh with the full commit as the app version name.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { parse: parseYaml } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

import { loadStableConfig } from './config.mjs';
import { DEPLOYED_WORKLOADS, GateError, INSTALLED_WORKLOADS, installKind, readActiveVersions, readJson, sha256File } from './deploy-evidence.mjs';
import { assertProjectServices, createZeropsClient } from './maintenance.mjs';
import { materializeStableZerops } from './materialize.mjs';
import {
  ARTIFACTS_KIND,
  DEFAULT_DEMO_REF,
  DEFAULT_REMOTE,
  assertCleanCheckoutAt,
  configFileDigest,
  git,
  inspectDeployableRelease,
} from './release.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PREBUILT = 'app/.zerops-prebuilt.tar.zst';
/** In install order. `kind` is the storefront build a front deploys (its .zerops-storefront.json setup). */
export const PUSHES = Object.freeze([
  { service: 'app', setup: 'app', path: 'app.tar' },
  { service: 'storefront', setup: 'storefront', kind: 'storefront', package: 'akros-storefront', path: 'storefront' },
  { service: 'shop', setup: 'shop', kind: 'storefront', package: 'akros-storefront', path: 'shop' },
  { service: 'n1', setup: 'n1', kind: 'n1', package: 'n1-storefront', path: 'n1' },
]);
const FRONTS = PUSHES.filter((push) => push.kind);
const STOREFRONT_BUILDS = [
  ['akros-storefront', 'storefront'],
  ['n1-storefront', 'n1'],
];

const fail = (message) => {
  throw new GateError(message);
};

/** Runs a tool with its output on stderr (stdout carries this script's JSON). Arguments are never a shell string. */
export function runInherited(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', 2, 2] });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal})`);
}

/** The stable zerops.yaml of <commit>'s canonical app/zerops.yaml: the combined file and one file per setup. */
export function materializeRelease(repoRoot, commit, config) {
  const shown = spawnSync('git', ['show', `${commit}:app/zerops.yaml`], { cwd: repoRoot, encoding: 'utf8' });
  if (shown.status !== 0) fail(`cannot read app/zerops.yaml of ${commit}: ${shown.stderr.trim()}`);
  const { combined, setups } = materializeStableZerops(shown.stdout, config);
  return { combined, bySetup: Object.fromEntries(setups.map(({ setup, file }) => [setup, file])) };
}

/** The stable app setup's build variables, as the Zerops build container gets them, minus its pnpm store location. */
export function appBuildVariables(appSetupYaml) {
  const setup = parseYaml(appSetupYaml)?.zerops?.find((entry) => entry.setup === 'app');
  const variables = setup?.build?.envVariables;
  if (!variables || typeof variables !== 'object') fail('the stable app setup declares no build variables');
  return Object.fromEntries(
    Object.entries(variables)
      .filter(([key]) => !key.startsWith('PNPM_') && !key.startsWith('ZE_'))
      .map(([key, value]) => [key, String(value)]),
  );
}

/** The unit directories build-app.sh builds (the Shell and each module of the release intent), relative to app/. */
export function unitDirectories(appDirectory) {
  const intent = JSON.parse(readFileSync(join(appDirectory, 'topology/application-release-intent.json'), 'utf8'));
  return ['apps/shell-super-app', ...intent.modules.map((module) => `verticals/${module.appId}`)];
}

/** A built unit names a commit of this release's history as its source revision, never `workspace`. */
export function assertUnitRevision(repoRoot, appDirectory, unitDirectory, commit) {
  const dist = join(appDirectory, unitDirectory, 'dist');
  if (!existsSync(join(dist, 'zerops-entry.mjs'))) fail(`${unitDirectory} has no built dist/zerops-entry.mjs`);
  const revision = JSON.parse(readFileSync(join(dist, 'ultramodern-build.json'), 'utf8'))?.deliveryUnit?.sourceRevision;
  if (!/^[\da-f]{40}$/u.test(String(revision))) fail(`${unitDirectory} was built as ${revision}, not from a commit`);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', revision, commit], { cwd: repoRoot });
  if (ancestor.status !== 0) fail(`${unitDirectory} was built from ${revision}, which is not in ${commit}'s history`);
}

/**
 * The app package source: a shallow clone of <tag> with the runner-built units and the materialized app setup as
 * app/zerops.yaml (skip-worktree, so the tree reads clean). Never the operator's checkout.
 */
export function stageAppSource({ repoRoot, tag, commit, prebuilt, zeropsYaml, directory }) {
  git(repoRoot, ['clone', '--quiet', '--depth', '1', '--no-tags', '--branch', tag, pathToFileURL(repoRoot).href, directory]);
  git(directory, ['remote', 'remove', 'origin']);
  copyFileSync(prebuilt, join(directory, PREBUILT));
  writeFileSync(join(directory, 'app/zerops.yaml'), zeropsYaml);
  git(directory, ['update-index', '--skip-worktree', '--', 'app/zerops.yaml']);
  assertAppSource(directory, { commit, zeropsYaml });
}

/** What the app push ships: exactly <commit>, the stable app setup, the unit archive and nothing else. */
export function assertAppSource(directory, { commit, zeropsYaml }) {
  const head = git(directory, ['rev-parse', 'HEAD']);
  if (head !== commit) fail(`the app package is at ${head}, not ${commit}`);
  if (readFileSync(join(directory, 'app/zerops.yaml'), 'utf8') !== zeropsYaml) {
    fail('the app package does not carry the stable app setup');
  }
  if (!git(directory, ['ls-files', '-v', '--', 'app/zerops.yaml']).startsWith('S ')) {
    fail('app/zerops.yaml of the app package is not skip-worktree; its release identity would read workspace');
  }
  const status = git(directory, ['status', '--porcelain', '--untracked-files=all']);
  if (status !== '' && status !== `?? ${PREBUILT}`) fail(`the app package differs from ${commit}:\n${status}`);
  if (!existsSync(join(directory, PREBUILT))) fail(`the app package has no ${PREBUILT}`);
}

const listFiles = (root, prefix = '') =>
  readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, path);
    if (!entry.isFile()) fail(`artifact ${path} is not a regular file`);
    return [path];
  });

/** CI: builds every service of <tag> and stages the install artifacts in <output>, bound by manifest.json. */
export async function buildArtifacts({
  repoRoot = REPO_ROOT,
  configPath,
  tag,
  output,
  demoRef = DEFAULT_DEMO_REF,
  remote = DEFAULT_REMOTE,
  run = runInherited,
  now = new Date(),
}) {
  const release = inspectDeployableRelease({ cwd: repoRoot, tag, demoRef, remote });
  const { commit } = release;
  assertCleanCheckoutAt(repoRoot, commit);
  if (existsSync(output) && readdirSync(output).length > 0) fail(`${output} is not empty`);
  const config = await loadStableConfig(configPath);
  const configDigest = configFileDigest(configPath);
  const yaml = materializeRelease(repoRoot, commit, config);
  const app = join(repoRoot, 'app');
  const work = mkdtempSync(join(tmpdir(), 'zerops-stable-build-'));
  try {
    run('mise', ['exec', '--', 'sh', 'scripts/zerops/build-app.sh'], {
      cwd: app,
      env: { ...process.env, ...appBuildVariables(yaml.bySetup.app) },
    });
    const units = join(work, 'units');
    for (const unit of unitDirectories(app)) {
      assertUnitRevision(repoRoot, app, unit, commit);
      cpSync(join(app, unit, 'dist'), join(units, unit, 'dist'), { recursive: true, verbatimSymlinks: true });
    }
    run('sh', ['scripts/zerops/pack-prebuilt-units.sh', units, join(work, 'units.tar.zst')], { cwd: app });
    const runner = join(work, 'runner');
    for (const [pkg, setup] of STOREFRONT_BUILDS) {
      run('bash', ['scripts/zerops/build-storefront.sh', pkg, setup], {
        cwd: app,
        env: { ...process.env, RUNNER_TEMP: runner, GITHUB_SHA: commit, GITHUB_ENV: join(work, 'github-env') },
      });
    }
    // The builds wrote only ignored outputs: what they built is the tagged source.
    assertCleanCheckoutAt(repoRoot, commit);
    return stageArtifacts({
      repoRoot,
      release,
      config,
      configDigest,
      yaml,
      output,
      storefronts: join(runner, 'storefront-push'),
      prebuilt: join(work, 'units.tar.zst'),
      work,
      now,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Writes the install artifacts of built outputs into <output>: each front's archive with its stable setup, the app
 * package (stageAppSource, as app.tar), the combined stable zerops.yaml and manifest.json with every file's sha256.
 * <storefronts> holds build-storefront.sh's staging (<kind>/app/.zerops-storefront.{tar.gz,json}).
 */
export function stageArtifacts({ repoRoot, release, config, configDigest, yaml, output, storefronts, prebuilt, work, now }) {
  const { tag, commit } = release;
  mkdirSync(output, { recursive: true });
  for (const front of FRONTS) {
    const staged = join(storefronts, front.kind, 'app');
    const target = join(output, front.path, 'app');
    mkdirSync(target, { recursive: true });
    for (const file of ['.zerops-storefront.tar.gz', '.zerops-storefront.json']) copyFileSync(join(staged, file), join(target, file));
    writeFileSync(join(target, 'zerops.yaml'), yaml.bySetup[front.setup]);
  }
  const source = join(work, 'app-source');
  stageAppSource({ repoRoot, tag, commit, prebuilt, zeropsYaml: yaml.bySetup.app, directory: source });
  runInherited('tar', ['-cf', join(output, 'app.tar'), '-C', source, '.']);
  rmSync(source, { recursive: true, force: true });
  writeFileSync(join(output, 'zerops.yaml'), yaml.combined);
  const files = Object.fromEntries(listFiles(output).sort().map((path) => [path, sha256File(join(output, path))]));
  const manifest = {
    kind: ARTIFACTS_KIND,
    schemaVersion: 1,
    tag,
    tagObject: release.tagObject,
    commit,
    configDigest,
    projectId: config.projectId,
    builtAt: now.toISOString(),
    services: Object.fromEntries(PUSHES.map(({ service, setup, path }) => [service, { setup, path }])),
    files,
  };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { tag, commit, configDigest, manifestDigest: sha256File(join(output, 'manifest.json')), output };
}

/** Proves <directory> is exactly what CI built for this release and config; returns the manifest and its digest. */
export function verifyArtifacts(directory, { release, configDigest, projectId, yaml }) {
  const manifest = readJson(join(directory, 'manifest.json'), 'artifact manifest');
  const expected = { kind: ARTIFACTS_KIND, schemaVersion: 1, tag: release.tag, tagObject: release.tagObject, commit: release.commit, configDigest, projectId };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) fail(`the artifacts' ${key} is ${manifest[key]}, not ${value}`);
  }
  const listed = Object.keys(manifest.files ?? {}).sort();
  const present = listFiles(directory).filter((path) => path !== 'manifest.json').sort();
  if (JSON.stringify(listed) !== JSON.stringify(present)) fail('the artifact files differ from the manifest');
  for (const path of listed) {
    if (sha256File(join(directory, path)) !== manifest.files[path]) fail(`artifact ${path} changed since CI built it`);
  }
  if (readFileSync(join(directory, 'zerops.yaml'), 'utf8') !== yaml.combined) {
    fail('the artifacts were materialized from another config or source than this one');
  }
  for (const front of FRONTS) {
    const base = join(directory, front.path, 'app');
    if (readFileSync(join(base, 'zerops.yaml'), 'utf8') !== yaml.bySetup[front.setup]) {
      fail(`the ${front.service} setup differs from this config's`);
    }
    const built = readJson(join(base, '.zerops-storefront.json'), `${front.service} storefront manifest`);
    if (built.setup !== front.kind || built.package !== front.package || built.sourceRevision !== release.commit) {
      fail(`the ${front.service} archive is ${built.package}/${built.setup} of ${built.sourceRevision}`);
    }
    if (built.archiveSha256 !== sha256File(join(base, '.zerops-storefront.tar.gz'))) fail(`the ${front.service} archive digest differs`);
  }
  return { manifest, manifestDigest: sha256File(join(directory, 'manifest.json')) };
}

/** push-service.sh needs bash 5, GNU find and tar, jq, curl and git; a missing one fails here, before any change. */
export function assertPushTools(run = spawnSync) {
  const ok = (command, args) => run(command, args, { encoding: 'utf8' });
  const bash = ok('bash', ['-c', 'printf %s "${BASH_VERSINFO[0]}"']);
  const missing = [];
  if (bash.status !== 0 || Number(bash.stdout) < 5) missing.push('bash 5 or later');
  if (ok('find', ['.', '-maxdepth', '0', '-printf', '']).status !== 0) missing.push('GNU find');
  if (!String(ok('tar', ['--version']).stdout).includes('GNU tar')) missing.push('GNU tar');
  for (const tool of ['jq', 'curl', 'git']) if (ok(tool, ['--version']).status !== 0) missing.push(tool);
  if (missing.length > 0) {
    fail(`the push needs ${missing.join(', ')} first on PATH (macOS: brew install bash findutils gnu-tar jq, then put their gnubin directories first)`);
  }
}

/** Every check of an install, read-only. Returns the plan executeInstall carries out. */
export async function planInstall({
  repoRoot = REPO_ROOT,
  configPath,
  tag,
  artifacts,
  demoRef = DEFAULT_DEMO_REF,
  remote = DEFAULT_REMOTE,
  token,
  client,
  fetchImpl = fetch,
  checkTools = assertPushTools,
  work,
}) {
  const release = inspectDeployableRelease({ cwd: repoRoot, tag, demoRef, remote });
  const config = await loadStableConfig(configPath);
  const configDigest = configFileDigest(configPath);
  const yaml = materializeRelease(repoRoot, release.commit, config);
  const { manifestDigest } = verifyArtifacts(artifacts, { release, configDigest, projectId: config.projectId, yaml });
  await assertProjectServices(config, { client });
  const versions = await readActiveVersions(config, { token, fetchImpl });
  const kind = installKind(versions, release.commit);
  checkTools();

  const source = join(work, 'app-source');
  mkdirSync(source, { recursive: true });
  runInherited('tar', ['-xf', join(artifacts, 'app.tar'), '-C', source]);
  assertAppSource(source, { commit: release.commit, zeropsYaml: yaml.bySetup.app });
  const pushScript = join(source, 'app/scripts/zerops/push-service.sh');
  if (!existsSync(pushScript)) fail(`${tag} carries no app/scripts/zerops/push-service.sh`);

  return {
    tag,
    tagObject: release.tagObject,
    commit: release.commit,
    configDigest,
    manifestDigest,
    projectId: config.projectId,
    kind,
    versions,
    pushScript,
    projectHosts: Object.values(config.origins).map((origin) => new URL(origin).hostname),
    pushes: PUSHES.filter(({ service }) => INSTALLED_WORKLOADS[kind].includes(service)).map(({ service, setup, path }) => ({
      service,
      serviceId: config.services[service],
      setup,
      cwd: service === 'app' ? source : join(artifacts, path),
    })),
  };
}

/** One push through the tag's push-service.sh; the app version is named by the full commit. */
export function runPush(plan, push, { token }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [plan.pushScript, push.serviceId, push.setup, plan.commit], {
      cwd: push.cwd,
      env: { ...process.env, ZEROPS_TOKEN: token, PUSH_SERVICE_NAME: push.service, PUSH_PROJECT_HOSTS: plan.projectHosts.join(' ') },
      stdio: ['ignore', 2, 2],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new GateError(`the ${push.service} push failed (exit ${code ?? signal})`)),
    );
  });
}

/** Carries out a plan, one push at a time in install order; the first failure stops the install and names what was pushed. */
export async function executeInstall(plan, { push, log = () => {} }) {
  const pushed = [];
  for (const step of plan.pushes) {
    log(`pushing ${step.service} (${step.serviceId}) as ${plan.commit}`);
    try {
      await push(step);
    } catch (error) {
      throw new GateError(`the install of ${plan.tag} failed after ${pushed.join(', ') || 'no push'}: ${error.message}. Rerun the install.`);
    }
    pushed.push(step.service);
  }
  return { pushed };
}

/** An origin answers when it serves a 2xx or 3xx (redirects not followed: a login redirect is an answer). */
const readOrigin = async (origin, fetchImpl) => {
  try {
    const response = await fetchImpl(origin, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    return response.status;
  } catch (error) {
    return `unreachable (${error.cause?.code ?? error.name})`;
  }
};

/**
 * What runs in the stable project now: every workload ACTIVE on the tag's commit (the project and its services
 * proven the stable ones), and every public origin of the config answering. Throws on anything else.
 */
export async function verifyDeployment({
  repoRoot = REPO_ROOT,
  configPath,
  tag,
  demoRef = DEFAULT_DEMO_REF,
  remote = DEFAULT_REMOTE,
  token,
  client,
  fetchImpl = fetch,
}) {
  const release = inspectDeployableRelease({ cwd: repoRoot, tag, demoRef, remote });
  const config = await loadStableConfig(configPath);
  const services = await assertProjectServices(config, { client });
  const versions = await readActiveVersions(config, { token, fetchImpl });
  const failures = [];
  for (const name of DEPLOYED_WORKLOADS) {
    if (versions[name] !== release.commit) failures.push(`${name} runs ${versions[name]}, not ${release.commit}`);
    if (services[name].status !== 'ACTIVE') failures.push(`${name} is ${services[name].status}`);
  }
  const origins = {};
  for (const [name, origin] of Object.entries(config.origins)) {
    origins[name] = await readOrigin(origin, fetchImpl);
    if (!(typeof origins[name] === 'number' && origins[name] >= 200 && origins[name] < 400)) {
      failures.push(`${origin} answered ${origins[name]}`);
    }
  }
  if (failures.length > 0) fail(`${tag} is not live in ${config.projectId}: ${failures.join('; ')}`);
  return { tag, commit: release.commit, projectId: config.projectId, versions, origins };
}

const USAGE = `usage:
  deploy.mjs build   --config PATH --tag TAG --output DIR [--demo-ref REF] [--remote NAME]
  deploy.mjs install --config PATH --tag TAG --artifacts DIR [--execute] [--demo-ref REF] [--remote NAME]   (env: ZEROPS_TOKEN)
  deploy.mjs verify  --config PATH --tag TAG [--demo-ref REF] [--remote NAME]                               (env: ZEROPS_TOKEN)`;

export async function main(argv, { env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      tag: { type: 'string' },
      output: { type: 'string' },
      artifacts: { type: 'string' },
      'demo-ref': { type: 'string' },
      remote: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (rest.length > 0 || !values.config || !values.tag) fail(USAGE);
  const common = { configPath: values.config, tag: values.tag, demoRef: values['demo-ref'] ?? DEFAULT_DEMO_REF, remote: values.remote ?? DEFAULT_REMOTE };
  const only = (...allowed) => {
    for (const option of ['output', 'artifacts', 'execute']) if (values[option] && !allowed.includes(option)) fail(USAGE);
  };
  if (command === 'build') {
    only('output');
    if (!values.output) fail(USAGE);
    return buildArtifacts({ ...common, output: values.output });
  }
  if (command !== 'install' && command !== 'verify') fail(USAGE);
  const token = env.ZEROPS_TOKEN;
  if (!token) fail('ZEROPS_TOKEN is required');
  const client = createZeropsClient({ token });
  if (command === 'verify') {
    only();
    return verifyDeployment({ ...common, token, client });
  }
  only('artifacts', 'execute');
  if (!values.artifacts) fail(USAGE);
  const work = mkdtempSync(join(tmpdir(), 'zerops-stable-install-'));
  try {
    const plan = await planInstall({ ...common, artifacts: values.artifacts, token, client, work });
    const { pushScript, ...summary } = plan;
    if (!values.execute) return { ...summary, executed: false };
    return { ...summary, executed: true, ...(await executeInstall(plan, { push: (step) => runPush(plan, step, { token }), log })) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
