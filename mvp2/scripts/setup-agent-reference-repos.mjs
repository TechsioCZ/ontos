import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const configPath = path.join(root, '.agents', 'agent-reference-repos.json');
const manifestPath = path.join(root, '.modernjs', 'agent-reference-repos.json');

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? ''));
const falsy = (value) => /^(0|false|no|off)$/i.test(String(value ?? ''));

const skipRequested =
  truthy(process.env.ULTRAMODERN_SKIP_AGENT_REPOS) || falsy(process.env.ULTRAMODERN_AGENT_REPOS);
const required = truthy(process.env.ULTRAMODERN_AGENT_REPOS_REQUIRED);
const refresh = truthy(process.env.ULTRAMODERN_AGENT_REPOS_REFRESH);

const log = (message) => console.log(`[agent-reference-repos] ${message}`);
const warn = (message) => console.warn(`[agent-reference-repos] ${message}`);

function fail(message) {
  if (required || checkOnly) {
    throw new Error(message);
  }
  warn(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: 'utf-8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120000,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`${command} ${commandArgs.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function assertSafeRepoPath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).includes('..') ||
    !relativePath.startsWith('repos/')
  ) {
    throw new Error(`Unsafe reference repository path: ${relativePath}`);
  }
}

function hasGit() {
  const result = spawnSync('git', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function currentCommit(repoPath) {
  return run('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    timeout: 30000,
  });
}

function installedManifestEntry(repo) {
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const manifest = readJson(manifestPath);
    return manifest.repositories?.find((entry) => entry.id === repo.id);
  } catch {
    return undefined;
  }
}

function repoEntry(repo, status) {
  const repoPath = path.join(root, repo.path);

  return {
    schemaVersion: 1,
    id: repo.id,
    name: repo.name,
    url: repo.url,
    ref: repo.ref,
    commit: currentCommit(repoPath),
    path: repo.path,
    readOnly: repo.readOnly !== false,
    status,
    strategy: 'git-clone',
  };
}

function assertClonePresent(repo) {
  assertSafeRepoPath(repo.path);
  const targetPath = path.join(root, repo.path);
  if (!fs.existsSync(targetPath)) {
    fail(`${repo.path} is missing`);
    return undefined;
  }
  if (!fs.existsSync(path.join(targetPath, '.git'))) {
    fail(`${repo.path} is present but is not a git clone`);
    return undefined;
  }

  return installedManifestEntry(repo) ?? repoEntry(repo, 'present');
}

function installClone(repo) {
  assertSafeRepoPath(repo.path);
  const targetPath = path.join(root, repo.path);

  if (fs.existsSync(targetPath) && !refresh) {
    return assertClonePresent(repo);
  }

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }

  if (checkOnly) {
    fail(`${repo.path} is missing`);
    return undefined;
  }

  log(`cloning ${repo.name} into ${repo.path}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', repo.ref, repo.url, targetPath], {
    timeout: 600000,
  });

  return repoEntry(repo, 'installed');
}

function writeManifest(entries) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        installDir: 'repos',
        repositories: entries,
        strategy: 'git-clone',
      },
      null,
      2,
    )}\n`,
  );
}

function main() {
  if (!fs.existsSync(configPath)) {
    fail('Missing .agents/agent-reference-repos.json');
    return;
  }

  const config = readJson(configPath);
  const enabled = config.defaultEnabled !== false && !skipRequested;

  if (!enabled) {
    log('setup skipped; set ULTRAMODERN_SKIP_AGENT_REPOS=0 to enable it again');
    return;
  }

  if (!hasGit()) {
    fail('git is required to install agent reference repositories');
    return;
  }

  const entries = [];
  for (const repo of config.repositories ?? []) {
    const result = checkOnly ? assertClonePresent(repo) : installClone(repo);
    if (result) {
      entries.push(result);
    }
  }

  if (!checkOnly) {
    writeManifest(entries);
  }
}

try {
  main();
} catch (error) {
  if (required || checkOnly) {
    console.error(`[agent-reference-repos] ${error.message}`);
    process.exitCode = 1;
  } else {
    warn(error.message);
  }
}
