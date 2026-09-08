import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../setup-agent-reference-repos.mts', import.meta.url)
);
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

const withFixture = (run: (root: string) => void): void => {
  const root = mkdtempSync(path.join(tmpdir(), 'ontos-agent-reference-'));
  try {
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
      { mode: 0o755 }
    );
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};
const runSetup = (
  root: string,
  args: readonly string[] = [],
  env: Record<string, string> = {}
) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: { PATH: path.join(root, 'bin'), ...env },
    timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
};

void test('optional reference setup warns, while check and required modes fail closed', () => {
  withFixture((root) => {
    rmSync(path.join(root, configPath));
    for (const [args, env, status] of [
      [[], {}, 0],
      [['--check'], {}, 1],
      [[], { ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true' }, 1],
    ] as const) {
      const result = runSetup(root, args, env);
      assert.equal(result.status, status, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /Missing \.agents\/agent-reference-repos\.json/u
      );
      assert.equal(existsSync(path.join(root, gitCallsPath)), false);
    }
  });
});

void test('disabled reference setup never invokes Git or writes a manifest', () => {
  withFixture((root) => {
    const disabledEnvironments: readonly Record<string, string>[] = [
      { ULTRAMODERN_SKIP_AGENT_REPOS: 'YES' },
      { ULTRAMODERN_AGENT_REPOS: 'OFF' },
    ];
    for (const env of disabledEnvironments) {
      const result = runSetup(root, [], env);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /setup skipped/u);
    }
    writeFileSync(
      path.join(root, configPath),
      JSON.stringify({ ...config, defaultEnabled: false })
    );
    assert.equal(runSetup(root).status, 0);
    assert.equal(existsSync(path.join(root, gitCallsPath)), false);
    assert.equal(existsSync(path.join(root, manifestPath)), false);
  });
});

void test('reference setup rejects malformed configuration and unsafe paths before Git', () => {
  withFixture((root) => {
    writeFileSync(path.join(root, configPath), '{invalid');
    const malformed = runSetup(root, ['--check']);
    assert.equal(malformed.status, 1);
    assert.match(
      malformed.stdout + malformed.stderr,
      /Invalid reference repository configuration/u
    );
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
        })
      );
      const result = runSetup(root, ['--check']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /Unsafe reference repository path/u
      );
    }
    assert.equal(existsSync(path.join(root, gitCallsPath)), false);
  });
});

void test('reference check requires subtree evidence and never mutates Git or the manifest', () => {
  withFixture((root) => {
    const missing = runSetup(root, ['--check']);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stdout + missing.stderr, /repos\/fixture is missing/u);
    mkdirSync(path.join(root, repository.path), { recursive: true });
    const present = runSetup(root, ['--check']);
    assert.equal(present.status, 0, present.stdout + present.stderr);
    const calls = readFileSync(path.join(root, gitCallsPath), 'utf-8');
    assert.match(calls, /log --grep git-subtree-dir: repos\/fixture/u);
    assert.doesNotMatch(calls, /^(?:fetch|add|commit|init|subtree add)\b/mu);
    assert.equal(existsSync(path.join(root, manifestPath)), false);
  });
});

void test('reference installation defaults check off and preserves commit hooks', () => {
  withFixture((root) => {
    const result = runSetup(root, [], {
      ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = readFileSync(path.join(root, manifestPath), 'utf-8');
    assert.match(manifest, /"status": "installed"/u);
    assert.match(manifest, /"commit": "a{40}"/u);
    assert.match(manifest, /"installedAt": "\d{4}-\d{2}-\d{2}T/u);
    const calls = readFileSync(path.join(root, gitCallsPath), 'utf-8');
    assert.match(
      calls,
      /fetch --depth 1 https:\/\/example.invalid\/fixture.git main/u
    );
    assert.match(
      calls,
      /subtree add --prefix repos\/fixture FETCH_HEAD --squash/u
    );
    assert.match(calls, /commit -m Record agent reference repo manifest/u);
    assert.doesNotMatch(calls, /--no-verify/u);
  });
});

void test('reference refresh refuses existing subtrees without fetching or overwriting', () => {
  withFixture((root) => {
    mkdirSync(path.join(root, repository.path), { recursive: true });
    const result = runSetup(root, [], {
      ULTRAMODERN_AGENT_REPOS_REFRESH: 'true',
      ULTRAMODERN_AGENT_REPOS_REQUIRED: 'true',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      /refresh for subtree references is intentionally manual/u
    );
    assert.doesNotMatch(
      readFileSync(path.join(root, gitCallsPath), 'utf-8'),
      /^(?:fetch|subtree add)\b/mu
    );
    assert.equal(existsSync(path.join(root, manifestPath)), false);
  });
});
