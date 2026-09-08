import { Effect } from 'effect';
import { expect, it } from '@app/effect-rstest';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execPath } from 'node:process';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const workflowScript = path.join(workspaceRoot, 'scripts/locki-feature.sh');
const featureSlug = 'customer-search';

it.live('pins pnpm to the npm mise backend for cross-platform sandbox installation', () =>
  Effect.gen(function* testEffect1() {
    const miseConfiguration = yield* Effect.tryPromise(() =>
      readFile(path.join(workspaceRoot, '.mise.toml'), 'utf-8'),
    );
    expect(miseConfiguration).toMatch(/\[tool_alias\][\s\S]*pnpm = "npm:pnpm"/u);
    expect(miseConfiguration).toMatch(/\[tools\][\s\S]*pnpm = "11\.25\.0"/u);
  }),
);

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

const executable = (target: string, content: string) =>
  Effect.gen(function* testEffect2() {
    yield* Effect.tryPromise(() => writeFile(target, content, 'utf-8'));
    yield* Effect.tryPromise(() => chmod(target, 0o755));
  });

const makeFixture = (withEnvironment = true) =>
  Effect.gen(function* testEffect3() {
    const root = yield* Effect.tryPromise(() =>
      mkdtemp(path.join(os.tmpdir(), 'ontos-locki-feature-')),
    );
    const sourceRoot = path.join(root, 'source');
    const targetRoot = path.join(root, 'target');
    const binDirectory = path.join(root, 'bin');
    const logPath = path.join(root, 'commands.log');
    yield* Effect.tryPromise(() =>
      mkdir(path.join(sourceRoot, 'app/scripts'), { recursive: true }),
    );
    yield* Effect.tryPromise(() => mkdir(binDirectory, { recursive: true }));
    yield* Effect.tryPromise(() =>
      cp(workflowScript, path.join(sourceRoot, 'app/scripts/locki-feature.sh')),
    );
    if (withEnvironment) {
      yield* Effect.tryPromise(() =>
        writeFile(path.join(sourceRoot, 'app/.env'), Buffer.from('OPAQUE-SECRET\0VALUE\n')),
      );
    }
    yield* executable(
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
    yield* executable(
      path.join(binDirectory, 'mise'),
      `#!/bin/sh
printf 'mise %s\\n' "$*" >>"$TEST_LOG"
if [ "\${1-}" = "install" ] && [ -n "\${LOCKI_SANDBOX_ID-}" ]; then exit 18; fi
if [ "$*" = "exec -- pnpm install --frozen-lockfile" ] && [ "\${ULTRAMODERN_SKIP_CODEX_SKILLS-}" != "1" ]; then exit 19; fi
if [ "\${FAIL_PREPARATION-}" = "true" ] && [ "\${1-}" = "install" ]; then exit 17; fi
`,
    );
    yield* executable(
      path.join(binDirectory, 'docker'),
      `#!/bin/sh
printf 'docker %s\\n' "$*" >>"$TEST_LOG"
`,
    );
    yield* executable(
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
  });

const runWorkflow = (
  fixture: Fixture,
  commandArguments: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): WorkflowResult => {
  const result = spawnSync(
    '/bin/sh',
    [path.join(fixture.sourceRoot, 'app/scripts/locki-feature.sh'), ...commandArguments],
    {
      encoding: 'utf-8',
      env: {
        ...extraEnvironment,
        PATH: `${fixture.binDirectory}:${path.dirname(execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TEST_LOG: fixture.logPath,
        TEST_SOURCE_ROOT: fixture.sourceRoot,
        TEST_TARGET_ROOT: fixture.targetRoot,
      },
    },
  );
  expect(result.error).toBeUndefined();
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
};

it.live('creates one sandbox from main, copies .env opaquely, and prepares in order', () =>
  Effect.gen(function* testEffect4() {
    const fixture = yield* makeFixture();
    const result = runWorkflow(fixture, ['--', featureSlug, '--no-ai']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.includes('OPAQUE-SECRET')).toBe(false);
    expect(
      yield* Effect.tryPromise(() => readFile(path.join(fixture.targetRoot, 'app/.env'))),
    ).toEqual(yield* Effect.tryPromise(() => readFile(path.join(fixture.sourceRoot, 'app/.env'))));
    const environmentStat = yield* Effect.tryPromise(() =>
      stat(path.join(fixture.targetRoot, 'app/.env')),
    );
    expect(environmentStat.mode % 0o1000).toBe(0o600);
    const log = yield* Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'));
    expect(log).toMatch(/locki new --from main --branch codex\/customer-search --json/u);
    expect(log).toMatch(
      /locki exec --match sandbox-42 -- sh app\/scripts\/locki-feature\.sh --prepare/u,
    );
    expect(log.includes('locki ai')).toBe(false);
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
      expect(index > previous).toBe(true);
      previous = index;
    }
  }),
);

it.live('rejects unsafe slugs and alternate options before creating a sandbox', () =>
  Effect.gen(function* testEffect5() {
    const assertRejected = (commandArguments: readonly string[]) =>
      Effect.gen(function* testEffect6() {
        const fixture = yield* makeFixture();
        const result = runWorkflow(fixture, commandArguments);
        expect(result.code).toBe(2);
        expect(
          yield* Effect.flip(Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'))),
        ).toBeDefined();
      });
    yield* assertRejected(['Bad Slug']);
    yield* assertRejected(['feature', '--from', 'main']);
  }),
);

it.live('fails before Locki when the source environment is missing', () =>
  Effect.gen(function* testEffect7() {
    const fixture = yield* makeFixture(false);
    const result = runWorkflow(fixture, [featureSlug]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Source app\/\.env is required/u);
    const log = yield* Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'));
    expect(log.includes('locki new')).toBe(false);
  }),
);

it.live('fails before creating a sandbox when the workflow is not committed on main', () =>
  Effect.gen(function* testEffect8() {
    const fixture = yield* makeFixture();
    const result = runWorkflow(fixture, [featureSlug], {
      TEST_WORKFLOW_COMMITTED: 'false',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/workflow is not yet committed on main/u);
    const log = yield* Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'));
    expect(log.includes('locki new')).toBe(false);
  }),
);

it.live('refuses an app path that resolves outside the returned worktree', () =>
  Effect.gen(function* testEffect9() {
    const fixture = yield* makeFixture();
    const result = runWorkflow(fixture, [featureSlug], { ESCAPE_TARGET: 'true' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refusing to copy \.env outside the Locki worktree/u);
    expect(
      yield* Effect.tryPromise(() => readFile(path.join(fixture.sourceRoot, 'app/.env'))),
    ).toEqual(Buffer.from('OPAQUE-SECRET\0VALUE\n'));
  }),
);

it.live('preserves a failed sandbox and never launches AI', () =>
  Effect.gen(function* testEffect10() {
    const fixture = yield* makeFixture();
    const result = runWorkflow(fixture, [featureSlug], { FAIL_PREPARATION: 'true' });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/locki exec --match sandbox-42/u);
    expect(result.stdout).toMatch(/locki rm --match sandbox-42/u);
    const log = yield* Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'));
    expect(log.includes('locki ai')).toBe(false);
  }),
);

it.live('launches the configured AI only after successful preparation', () =>
  Effect.gen(function* testEffect11() {
    const fixture = yield* makeFixture();
    const result = runWorkflow(fixture, [featureSlug]);
    expect(result.code, result.stderr).toBe(0);
    const log = yield* Effect.tryPromise(() => readFile(fixture.logPath, 'utf-8'));
    expect(
      log.indexOf('mise exec -- pnpm db:verify') < log.indexOf('locki ai --match sandbox-42'),
    ).toBe(true);
  }),
);
