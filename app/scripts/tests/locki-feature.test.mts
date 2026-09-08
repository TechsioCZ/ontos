import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const workflowScript = path.join(workspaceRoot, 'scripts/locki-feature.sh');
const featureSlug = 'customer-search';

void test('pins pnpm to the npm mise backend for cross-platform sandbox installation', async () => {
  const miseConfiguration = await readFile(
    path.join(workspaceRoot, '.mise.toml'),
    'utf-8'
  );
  assert.match(miseConfiguration, /\[tool_alias\][\s\S]*pnpm = "npm:pnpm"/u);
  assert.match(miseConfiguration, /\[tools\][\s\S]*pnpm = "11\.25\.0"/u);
});

interface Fixture {
  readonly binDirectory: string;
  readonly logPath: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
}

interface WorkflowResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const executable = async (target: string, content: string): Promise<void> => {
  await writeFile(target, content, 'utf-8');
  await chmod(target, 0o755);
};

const makeFixture = async (withEnvironment = true): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-locki-feature-'));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const binDirectory = path.join(root, 'bin');
  const logPath = path.join(root, 'commands.log');
  await mkdir(path.join(sourceRoot, 'app/scripts'), { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await cp(
    workflowScript,
    path.join(sourceRoot, 'app/scripts/locki-feature.sh')
  );
  if (withEnvironment) {
    await writeFile(
      path.join(sourceRoot, 'app/.env'),
      Buffer.from('OPAQUE-SECRET\0VALUE\n')
    );
  }
  await executable(
    path.join(binDirectory, 'git'),
    `#!/bin/sh
if [ "$3" = "rev-parse" ]; then printf '%s\\n' "$TEST_SOURCE_ROOT"; exit 0; fi
if [ "$3" = "check-ignore" ]; then exit 0; fi
if [ "$3" = "cat-file" ]; then
  if [ "\${TEST_WORKFLOW_COMMITTED-true}" = "false" ]; then exit 1; fi
  exit 0
fi
if [ "$3" = "diff" ]; then exit 0; fi
exit 9
`
  );
  await executable(
    path.join(binDirectory, 'mise'),
    `#!/bin/sh
printf 'mise %s\\n' "$*" >>"$TEST_LOG"
if [ "\${1-}" = "install" ] && [ -n "\${LOCKI_SANDBOX_ID-}" ]; then exit 18; fi
if [ "$*" = "exec -- pnpm install --frozen-lockfile" ] && [ "\${ULTRAMODERN_SKIP_CODEX_SKILLS-}" != "1" ]; then exit 19; fi
if [ "\${FAIL_PREPARATION-}" = "true" ] && [ "\${1-}" = "install" ]; then exit 17; fi
`
  );
  await executable(
    path.join(binDirectory, 'docker'),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >>"$TEST_LOG"
`
  );
  await executable(
    path.join(binDirectory, 'locki'),
    `#!/bin/sh
command_name=$1
shift
printf 'locki %s %s\\n' "$command_name" "$*" >>"$TEST_LOG"
case "$command_name" in
  --version)
    printf '%s\\n' 'locki, version 0.0.27'
    ;;
  new)
    if [ "\${ESCAPE_TARGET-}" = "true" ]; then
      mkdir -p "$TEST_TARGET_ROOT"
      ln -s "$TEST_SOURCE_ROOT/app" "$TEST_TARGET_ROOT/app"
    else
      mkdir -p "$TEST_TARGET_ROOT/app/scripts"
      cp "$TEST_SOURCE_ROOT/app/scripts/locki-feature.sh" "$TEST_TARGET_ROOT/app/scripts/locki-feature.sh"
      printf '%s\\n' 'STALE-ENVIRONMENT' >"$TEST_TARGET_ROOT/app/.env"
    fi
    printf '{"id":"sandbox-42","path":"%s","branch":"codex/test#locki-sandbox-42"}\\n' "$TEST_TARGET_ROOT"
    ;;
  exec)
    while [ "\${1-}" != "--" ]; do shift; done
    shift
    (cd "$TEST_TARGET_ROOT" && LOCKI_SANDBOX_ID=sandbox-42 "$@")
    ;;
  ai) ;;
  *) exit 8 ;;
esac
`
  );
  return { binDirectory, logPath, sourceRoot, targetRoot };
};

const runWorkflow = (
  fixture: Fixture,
  commandArguments: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {}
): WorkflowResult => {
  const result = spawnSync(
    '/bin/sh',
    [
      path.join(fixture.sourceRoot, 'app/scripts/locki-feature.sh'),
      ...commandArguments,
    ],
    {
      encoding: 'utf-8',
      env: {
        ...extraEnvironment,
        PATH: `${fixture.binDirectory}:${path.dirname(execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TEST_LOG: fixture.logPath,
        TEST_SOURCE_ROOT: fixture.sourceRoot,
        TEST_TARGET_ROOT: fixture.targetRoot,
      },
    }
  );
  assert.ifError(result.error);
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
};

void test('creates one sandbox from main, copies .env opaquely, and prepares in order', async () => {
  const fixture = await makeFixture();
  const result = runWorkflow(fixture, ['--', featureSlug, '--no-ai']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes('OPAQUE-SECRET'), false);
  assert.deepEqual(
    await readFile(path.join(fixture.targetRoot, 'app/.env')),
    await readFile(path.join(fixture.sourceRoot, 'app/.env'))
  );
  const environmentStat = await stat(path.join(fixture.targetRoot, 'app/.env'));
  assert.equal(environmentStat.mode % 0o1000, 0o600);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.match(
    log,
    /locki new --from main --branch codex\/customer-search --json/u
  );
  assert.match(
    log,
    /locki exec --match sandbox-42 -- sh app\/scripts\/locki-feature\.sh --prepare/u
  );
  assert.equal(log.includes('locki ai'), false);
  const expectedOrder = [
    'mise install',
    'mise exec -- pnpm install --frozen-lockfile',
    'mise exec -- pnpm env:local:ensure',
    'docker compose up --detach --wait',
    'mise exec -- pnpm db:migrate',
    'mise exec -- pnpm local:initialize',
    'mise exec -- pnpm db:verify',
  ];
  let previous = -1;
  for (const command of expectedOrder) {
    const index = log.indexOf(command);
    assert.ok(
      index > previous,
      `${command} must follow the previous preparation step`
    );
    previous = index;
  }
});

void test('rejects unsafe slugs and alternate options before creating a sandbox', async () => {
  const assertRejected = async (
    commandArguments: readonly string[]
  ): Promise<void> => {
    const fixture = await makeFixture();
    const result = runWorkflow(fixture, commandArguments);
    assert.equal(result.code, 2);
    await assert.rejects(readFile(fixture.logPath, 'utf-8'));
  };
  await assertRejected(['Bad Slug']);
  await assertRejected(['feature', '--from', 'main']);
});

void test('fails before Locki when the source environment is missing', async () => {
  const fixture = await makeFixture(false);
  const result = runWorkflow(fixture, [featureSlug]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Source app\/\.env is required/u);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.equal(log.includes('locki new'), false);
});

void test('fails before creating a sandbox when the workflow is not committed on main', async () => {
  const fixture = await makeFixture();
  const result = runWorkflow(fixture, [featureSlug], {
    TEST_WORKFLOW_COMMITTED: 'false',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /workflow is not yet committed on main/u);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.equal(log.includes('locki new'), false);
});

void test('refuses an app path that resolves outside the returned worktree', async () => {
  const fixture = await makeFixture();
  const result = runWorkflow(fixture, [featureSlug], { ESCAPE_TARGET: 'true' });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Refusing to copy \.env outside the Locki worktree/u
  );
  assert.deepEqual(
    await readFile(path.join(fixture.sourceRoot, 'app/.env')),
    Buffer.from('OPAQUE-SECRET\0VALUE\n')
  );
});

void test('preserves a failed sandbox and never launches AI', async () => {
  const fixture = await makeFixture();
  const result = runWorkflow(fixture, [featureSlug], {
    FAIL_PREPARATION: 'true',
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /locki exec --match sandbox-42/u);
  assert.match(result.stdout, /locki rm --match sandbox-42/u);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.equal(log.includes('locki ai'), false);
});

void test('launches the configured AI only after successful preparation', async () => {
  const fixture = await makeFixture();
  const result = runWorkflow(fixture, [featureSlug]);
  assert.equal(result.code, 0, result.stderr);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.ok(
    log.indexOf('mise exec -- pnpm db:verify') <
      log.indexOf('locki ai --match sandbox-42')
  );
});
