import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowScript = path.join(workspaceRoot, 'scripts/locki-feature.sh');

test('pins pnpm to the npm mise backend for cross-platform sandbox installation', async () => {
  const miseConfiguration = await readFile(path.join(workspaceRoot, '.mise.toml'), 'utf-8');
  assert.match(miseConfiguration, /\[tool_alias\][\s\S]*pnpm = "npm:pnpm"/u);
  assert.match(miseConfiguration, /\[tools\][\s\S]*pnpm = "11\.17\.0"/u);
});

interface Fixture {
  readonly binDirectory: string;
  readonly logPath: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
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
  await cp(workflowScript, path.join(sourceRoot, 'app/scripts/locki-feature.sh'));
  if (withEnvironment) {
    await writeFile(path.join(sourceRoot, 'app/.env'), Buffer.from('OPAQUE-SECRET\0VALUE\n'));
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
`,
  );
  await executable(
    path.join(binDirectory, 'mise'),
    `#!/bin/sh
printf 'mise %s\\n' "$*" >>"$TEST_LOG"
if [ "\${1-}" = "install" ] && [ -n "\${LOCKI_SANDBOX_ID-}" ]; then exit 18; fi
if [ "$*" = "exec -- pnpm install --frozen-lockfile" ] && [ "\${ULTRAMODERN_SKIP_CODEX_SKILLS-}" != "1" ]; then exit 19; fi
if [ "\${FAIL_PREPARATION-}" = "true" ] && [ "\${1-}" = "install" ]; then exit 17; fi
`,
  );
  await executable(
    path.join(binDirectory, 'docker'),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >>"$TEST_LOG"
`,
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
`,
  );
  return { binDirectory, logPath, sourceRoot, targetRoot };
};

const runWorkflow = async (
  fixture: Fixture,
  arguments_: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(
      'sh',
      [path.join(fixture.sourceRoot, 'app/scripts/locki-feature.sh'), ...arguments_],
      {
        env: {
          ...process.env,
          ...extraEnvironment,
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? ''}`,
          TEST_LOG: fixture.logPath,
          TEST_SOURCE_ROOT: fixture.sourceRoot,
          TEST_TARGET_ROOT: fixture.targetRoot,
        },
      },
    );
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf-8').on('data', (value) => {
      stderr += value;
    });
    child.stdout.setEncoding('utf-8').on('data', (value) => {
      stdout += value;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });

test('creates one sandbox from develop, copies .env opaquely, and prepares in order', async () => {
  const fixture = await makeFixture();
  const result = await runWorkflow(fixture, ['--', 'customer-search', '--no-ai']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes('OPAQUE-SECRET'), false);
  assert.deepEqual(
    await readFile(path.join(fixture.targetRoot, 'app/.env')),
    await readFile(path.join(fixture.sourceRoot, 'app/.env')),
  );
  assert.equal((await stat(path.join(fixture.targetRoot, 'app/.env'))).mode & 0o777, 0o600);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.match(log, /locki new --from develop --branch codex\/customer-search --json/u);
  assert.match(
    log,
    /locki exec --match sandbox-42 -- sh app\/scripts\/locki-feature\.sh --prepare/u,
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
    assert.ok(index > previous, `${command} must follow the previous preparation step`);
    previous = index;
  }
});

test('rejects unsafe slugs and alternate options before creating a sandbox', async () => {
  for (const arguments_ of [['Bad Slug'], ['feature', '--from', 'main']]) {
    const fixture = await makeFixture();
    const result = await runWorkflow(fixture, arguments_);
    assert.equal(result.code, 2);
    await assert.rejects(readFile(fixture.logPath, 'utf-8'));
  }
});

test('fails before Locki when the source environment is missing', async () => {
  const fixture = await makeFixture(false);
  const result = await runWorkflow(fixture, ['customer-search']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Source app\/\.env is required/u);
  assert.equal((await readFile(fixture.logPath, 'utf-8')).includes('locki new'), false);
});

test('fails before creating a sandbox when the workflow is not committed on develop', async () => {
  const fixture = await makeFixture();
  const result = await runWorkflow(fixture, ['customer-search'], {
    TEST_WORKFLOW_COMMITTED: 'false',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /workflow is not yet committed on develop/u);
  assert.equal((await readFile(fixture.logPath, 'utf-8')).includes('locki new'), false);
});

test('refuses an app path that resolves outside the returned worktree', async () => {
  const fixture = await makeFixture();
  const result = await runWorkflow(fixture, ['customer-search'], { ESCAPE_TARGET: 'true' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to copy \.env outside the Locki worktree/u);
  assert.deepEqual(
    await readFile(path.join(fixture.sourceRoot, 'app/.env')),
    Buffer.from('OPAQUE-SECRET\0VALUE\n'),
  );
});

test('preserves a failed sandbox and never launches AI', async () => {
  const fixture = await makeFixture();
  const result = await runWorkflow(fixture, ['customer-search'], { FAIL_PREPARATION: 'true' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /locki exec --match sandbox-42/u);
  assert.match(result.stdout, /locki rm --match sandbox-42/u);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.equal(log.includes('locki ai'), false);
});

test('launches the configured AI only after successful preparation', async () => {
  const fixture = await makeFixture();
  const result = await runWorkflow(fixture, ['customer-search']);
  assert.equal(result.code, 0, result.stderr);
  const log = await readFile(fixture.logPath, 'utf-8');
  assert.ok(
    log.indexOf('mise exec -- pnpm db:verify') < log.indexOf('locki ai --match sandbox-42'),
  );
});
