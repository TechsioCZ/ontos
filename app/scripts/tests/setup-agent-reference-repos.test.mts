import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

const script = fileURLToPath(new URL('../setup-agent-reference-repos.mts', import.meta.url));
const configPath = '.agents/agent-reference-repos.json';
const gitCallsPath = 'git-calls.txt';
const manifestPath = '.modernjs/agent-reference-repos.json';
const repository = {
  id: 'fixture',
  name: 'Fixture reference',
  path: 'repos/fixture',
  readOnly: true,
  ref: 'main',
  url: 'https://example.invalid/fixture.git',
};
const config = {
  defaultEnabled: true,
  installDir: 'repos',
  repositories: [repository],
  schemaVersion: 1,
  strategy: 'git-subtree-squash',
};

const fixtureDirectory = Effect.gen(function* fixtureDirectory() {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-agent-reference-'))),
    (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
  );
  mkdirSync(path.join(root, '.agents'));
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, configPath), JSON.stringify(config));
  // No real Git mutation or network access: record the exact native child-process contract.
  writeFileSync(
    path.join(root, 'bin/git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> git-calls.txt
case "$*" in
  '--version') printf 'git version fixture\\n' ;;
  'subtree -h') printf 'usage: git subtree\\n'; exit 129 ;;
  'rev-parse --is-inside-work-tree') printf 'true\\n' ;;
  'rev-parse --verify HEAD') printf 'fixture-head\\n' ;;
  'status --porcelain') ;;
  'status --porcelain -- '* ) printf ' M manifest\\n' ;;
  'log '* ) printf 'fixture-subtree-commit\\n' ;;
  'ls-remote '* ) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\\n' ;;
  'fetch '* | 'subtree add '* | 'add '* | 'commit '* ) ;;
  *) printf 'Unexpected git invocation: %s\\n' "$*" >&2; exit 91 ;;
esac
`,
    { mode: 0o755 },
  );
  return root;
});
const runSetup = (root: string, args: readonly string[] = [], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: { PATH: path.join(root, 'bin'), ...env },
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  return result;
};

it.live('optional reference setup warns, while check and required modes fail closed', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    rmSync(path.join(root, configPath));
    for (const [args, env, status] of [
      [[], {}, 0],
      [['--check'], {}, 1],
      [[], { ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true' }, 1],
    ] as const) {
      const result = runSetup(root, args, env);
      expect(result.status, result.stdout + result.stderr).toBe(status);
      expect(result.stdout + result.stderr).toMatch(/Missing \.agents\/agent-reference-repos\.json/u);
      expect(existsSync(path.join(root, gitCallsPath))).toBe(false);
    }
  }),
);

it.live('disabled reference setup never invokes Git or writes a manifest', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    const disabledEnvironments: readonly Record<string, string>[] = [
      { ULTRAMODERN_SKIP_AGENT_REPOS: 'YES' },
      { ULTRAMODERN_AGENT_REPOS: 'OFF' },
    ];
    for (const env of disabledEnvironments) {
      const result = runSetup(root, [], env);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/setup skipped/u);
    }
    writeFileSync(path.join(root, configPath), JSON.stringify({ ...config, defaultEnabled: false }));
    expect(runSetup(root).status).toBe(0);
    expect(existsSync(path.join(root, gitCallsPath))).toBe(false);
    expect(existsSync(path.join(root, manifestPath))).toBe(false);
  }),
);

it.live('reference setup rejects malformed configuration and unsafe paths before Git', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    writeFileSync(path.join(root, configPath), '{invalid');
    const malformed = runSetup(root, ['--check']);
    expect(malformed.status).toBe(1);
    expect(malformed.stdout + malformed.stderr).toMatch(/Invalid reference repository configuration/u);
    for (const unsafePath of [
      '../outside',
      'repos/../outside',
      String.raw`repos\..\outside`,
      '/repos/fixture',
      'repos/.',
      'repos/',
      'repos//.',
    ]) {
      writeFileSync(
        path.join(root, configPath),
        JSON.stringify({
          ...config,
          repositories: [{ ...repository, path: unsafePath }],
        }),
      );
      const result = runSetup(root, ['--check']);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/Unsafe reference repository path/u);
    }
    expect(existsSync(path.join(root, gitCallsPath))).toBe(false);
  }),
);

it.live('reference check requires subtree evidence and never mutates Git or the manifest', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    const missing = runSetup(root, ['--check']);
    expect(missing.status, missing.stdout + missing.stderr).toBe(1);
    expect(missing.stdout + missing.stderr).toMatch(/repos\/fixture is missing/u);
    mkdirSync(path.join(root, repository.path), { recursive: true });
    const present = runSetup(root, ['--check']);
    expect(present.status, present.stdout + present.stderr).toBe(0);
    const calls = readFileSync(path.join(root, gitCallsPath), 'utf-8');
    expect(calls).toMatch(/log --grep git-subtree-dir: repos\/fixture/u);
    expect(calls).not.toMatch(/^(?:fetch|add|commit|init|subtree add)\b/mu);
    expect(existsSync(path.join(root, manifestPath))).toBe(false);
  }),
);

it.live('reference installation defaults check off and preserves commit hooks', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    const result = runSetup(root, [], {
      ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifest = readFileSync(path.join(root, manifestPath), 'utf-8');
    expect(manifest).toMatch(/"status": "installed"/u);
    expect(manifest).toMatch(/"commit": "a{40}"/u);
    expect(manifest).toMatch(/"installedAt": "\d{4}-\d{2}-\d{2}T/u);
    const calls = readFileSync(path.join(root, gitCallsPath), 'utf-8');
    expect(calls).toMatch(/fetch --depth 1 https:\/\/example.invalid\/fixture.git main/u);
    expect(calls).toMatch(/subtree add --prefix repos\/fixture FETCH_HEAD --squash/u);
    expect(calls).toMatch(/commit -m Record agent reference repo manifest/u);
    expect(calls).not.toMatch(/--no-verify/u);
  }),
);

it.live('reference refresh refuses existing subtrees without fetching or overwriting', () =>
  Effect.gen(function* referenceScenario() {
    const root = yield* fixtureDirectory;
    mkdirSync(path.join(root, repository.path), { recursive: true });
    const result = runSetup(root, [], {
      ULTRAMODERN_AGENT_REPOS_REFRESH: 'true',
      ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true',
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/refresh for subtree references is intentionally manual/u);
    expect(readFileSync(path.join(root, gitCallsPath), 'utf-8')).not.toMatch(/^(?:fetch|subtree add)\b/mu);
    expect(existsSync(path.join(root, manifestPath))).toBe(false);
  }),
);
