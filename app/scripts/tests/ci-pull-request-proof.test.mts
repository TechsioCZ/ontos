import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'effect-rstest';

/*
 * scripts/ci/pull-request-proof.sh decides whether a merge queue entry skips its gates because its pull request's own
 * run of the same workflow already passed on exactly the entry's tree and base. Each case below breaks one soundness
 * rule of that decision and must leave the gates running. Git is real: a bare origin holds main, the pull request heads
 * and the queue entries; the GitHub API is a fake gh that answers each recorded call exactly.
 */

const SCRIPT = fileURLToPath(new URL('../ci/pull-request-proof.sh', import.meta.url));
const REPOSITORY = 'TechsioCZ/ontos';
const WORKFLOW_ID = 342_952_200;
const RUN_ID = 44_520_000_000;
const PULL_REQUEST = 7;
const SECOND_PULL_REQUEST = 8;
const PR_RUN = 44_510_000_000;
const OLDER_PR_RUN = 44_500_000_000;
const STEP_PATH = '/usr/bin:/bin';
const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;
const RUN_LOOKUP = `api repos/${REPOSITORY}/actions/runs/${RUN_ID} --jq .workflow_id`;
const runList = (head: string) =>
  `api --method GET repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs -f event=pull_request -f head_sha=${head} -f per_page=100`;
/** The record download of one run; the fake gh takes the destination directory after it. */
const download = (run: number) => `run download ${run} --repo ${REPOSITORY} --name ci-comparison --dir`;
const queueRef = (pullRequest: number, base: string) => `refs/heads/gh-readonly-queue/main/pr-${pullRequest}-${base}`;

const GIT_ENVIRONMENT = {
  GIT_AUTHOR_DATE: '2026-11-19T00:00:00Z',
  GIT_AUTHOR_EMAIL: 'ci@example.com',
  GIT_AUTHOR_NAME: 'CI',
  GIT_COMMITTER_DATE: '2026-11-19T00:00:00Z',
  GIT_COMMITTER_EMAIL: 'ci@example.com',
  GIT_COMMITTER_NAME: 'CI',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  PATH: STEP_PATH,
};
const git = (cwd: string, ...args: readonly string[]) =>
  execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...GIT_ENVIRONMENT, HOME: cwd },
    stdio: 'pipe',
  }).trim();
/** Commits the given file contents on top of the checked-out commit and returns the new commit. */
const commit = (work: string, files: Readonly<Record<string, string>>, message: string) => {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(work, name), content);
  }
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
};
/** A queue entry: a new commit of the given tree on the given parent, as the queue's rebase writes it. */
const queueCommit = (work: string, tree: string, parent: string) =>
  git(work, 'commit-tree', tree, '-p', parent, '-m', 'queue entry');

interface Run {
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly event: string;
  readonly head_repository: { readonly full_name: string };
  readonly head_sha: string;
  readonly id: number;
  readonly repository: { readonly full_name: string };
  readonly run_attempt?: number;
  readonly status: string;
  readonly workflow_id: number;
}
const runs = (list: readonly Run[]) =>
  JSON.stringify({
    total_count: list.length,
    workflow_runs: list.map((run) => ({ ...run, html_url: runUrl(run.id) })),
  });
const pullRequestRun = (head: string, id = PR_RUN, created = '2026-11-19T01:00:00Z'): Run => ({
  conclusion: 'success',
  created_at: created,
  event: 'pull_request',
  head_repository: { full_name: REPOSITORY },
  head_sha: head,
  id,
  repository: { full_name: REPOSITORY },
  status: 'completed',
  workflow_id: WORKFLOW_ID,
});
interface Route {
  readonly exit?: number;
  /** Files a download writes into the directory its last argument names. */
  readonly files?: Readonly<Record<string, string>>;
  readonly stderr?: string;
  readonly stdout?: string;
}
interface Entry {
  /** The event's base commit. */
  readonly base: string;
  /** The queue entry ref. */
  readonly ref: string;
  /** The checked-out queue entry. */
  readonly sha: string;
}

/** Runs the finder in the queue checkout with a fake gh that answers only the given calls. */
const find = (directory: string, routes: Readonly<Record<string, Route>>, entry: Entry) => {
  const queue = path.join(directory, 'queue');
  git(queue, 'checkout', '--quiet', '--detach', entry.sha);
  const bin = path.join(directory, 'bin');
  rmSync(bin, { force: true, recursive: true });
  mkdirSync(bin);
  const calls = path.join(directory, 'calls');
  const output = path.join(directory, 'outputs');
  const summary = path.join(directory, 'summary');
  for (const file of [calls, output, summary]) {
    writeFileSync(file, '');
  }
  const branches = Object.entries(routes).map(([args, { exit = 0, files = {}, stderr = '', stdout = '' }], index) => {
    writeFileSync(path.join(bin, `stdout-${index}`), stdout);
    writeFileSync(path.join(bin, `stderr-${index}`), stderr);
    const copies = Object.entries(files).map(([name, content], file) => {
      writeFileSync(path.join(bin, `file-${index}-${file}`), content);
      return `cp '${bin}/file-${index}-${file}' "$dir/${name}"; `;
    });
    const store = copies.length > 0 ? `dir="\${*: -1}"; mkdir -p "$dir"; ${copies.join('')}` : '';
    return `  '${args}' | '${args} '*) ${store}cat '${bin}/stdout-${index}'; cat '${bin}/stderr-${index}' >&2; exit ${exit} ;;`;
  });
  writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case "$*" in',
      ...branches,
      '  *) echo "unexpected gh $*" >&2; exit 97 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const log = execFileSync('/bin/bash', [SCRIPT, 'find'], {
    cwd: queue,
    encoding: 'utf-8',
    env: {
      ...GIT_ENVIRONMENT,
      BASE_SHA: entry.base,
      GITHUB_OUTPUT: output,
      GITHUB_REF: entry.ref,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_RUN_ID: String(RUN_ID),
      GITHUB_SHA: entry.sha,
      GITHUB_STEP_SUMMARY: summary,
      HOME: directory,
      PATH: `${bin}:${STEP_PATH}`,
    },
    stdio: 'pipe',
  });
  const outputs = readFileSync(output, 'utf-8');
  return {
    calls: readFileSync(calls, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((call) => call.replace(/ --dir \S+$/u, ' --dir')),
    log,
    proven: /^proven=(?<proven>\w+)$/mu.exec(outputs)?.groups?.proven,
    run: /^run=(?<run>.+)$/mu.exec(outputs)?.groups?.run,
    summary: readFileSync(summary, 'utf-8'),
  };
};
const unproven = (directory: string, routes: Readonly<Record<string, Route>>, entry: Entry, label: string) => {
  const result = find(directory, routes, entry);
  expect(result.proven, label).toBe('false');
  expect(result.run, label).toBeUndefined();
  expect(result.summary, label).toBe('');
  expect(result.log, label).toContain('The gates run.');
  return result;
};

it('skips the gates of a merge queue entry only on a sound pull request run of the same tree and base', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-pull-request-proof-'));
  try {
    const origin = path.join(directory, 'origin.git');
    const work = path.join(directory, 'work');
    git(directory, 'init', '--quiet', '--bare', origin);
    git(directory, 'init', '--quiet', '--initial-branch=main', work);
    const base = commit(work, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'main');
    const head = commit(work, { 'a.txt': 'a changed\n' }, 'pull request 7');
    git(work, 'checkout', '--quiet', '--detach', base);
    const secondHead = commit(work, { 'b.txt': 'b changed\n' }, 'pull request 8');
    // Another head of pull request 7, whose run would record whatever its own workflow wrote.
    git(work, 'checkout', '--quiet', '--detach', base);
    const otherHead = commit(
      work,
      { 'a.txt': 'a changed\n', 'workflow.yml': 'record anything\n' },
      'a head with its own workflow',
    );
    git(work, 'checkout', '--quiet', '--detach', base);
    const movedBase = commit(work, { 'c.txt': 'c\n' }, 'main moved');
    const tree = git(work, 'rev-parse', `${head}^{tree}`);
    const entry = queueCommit(work, tree, base);
    // A group of both pull requests: the entry of pull request 8 holds pull request 7 too.
    const groupTree = git(work, 'merge-tree', '--write-tree', entry, secondHead);
    const group = queueCommit(work, groupTree, entry);
    const movedEntry = queueCommit(work, git(work, 'merge-tree', '--write-tree', movedBase, head), movedBase);
    // What the pull request run tests: GitHub's merge of the head into the base, whose record the script writes.
    git(work, 'checkout', '--quiet', '--detach', base);
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'Merge head into base', head);
    expect(git(work, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    const recordFile = path.join(directory, 'record', 'comparison.json');
    execFileSync('/bin/bash', [SCRIPT, 'record', recordFile], {
      cwd: work,
      env: { ...GIT_ENVIRONMENT, HOME: directory, PLAN_MODE: 'affected' },
      stdio: 'pipe',
    });
    const record: unknown = JSON.parse(readFileSync(recordFile, 'utf-8'));
    expect(record).toEqual({ base, head, mode: 'affected', tree });
    const recorded = (fields: Readonly<Record<string, string | null>> = {}) =>
      JSON.stringify({ base, head, mode: 'affected', tree, ...fields });

    for (const [ref, sha] of [
      [queueRef(PULL_REQUEST, base), entry],
      [queueRef(SECOND_PULL_REQUEST, base), group],
      [queueRef(PULL_REQUEST, movedBase), movedEntry],
      ['refs/heads/main', base],
      [`refs/pull/${PULL_REQUEST}/head`, head],
      [`refs/pull/${SECOND_PULL_REQUEST}/head`, secondHead],
    ] as const) {
      git(work, 'push', '--quiet', origin, `${sha}:${ref}`);
    }
    const queue = path.join(directory, 'queue');
    git(directory, 'clone', '--quiet', '--no-checkout', origin, queue);
    git(queue, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*');

    const single: Entry = { base, ref: queueRef(PULL_REQUEST, base), sha: entry };
    /** The answers of a sound proof: one successful pull request run on the head that recorded this tree. */
    const sound = (content = recorded()) => ({
      [download(PR_RUN)]: { files: { 'comparison.json': content } },
      [RUN_LOOKUP]: { stdout: `${WORKFLOW_ID}\n` },
      [runList(head)]: { stdout: runs([pullRequestRun(head)]) },
    });

    // A sound proof: the entry skips its gates, and its log and step summary name the proving run.
    for (const mode of ['affected', 'full']) {
      const proven = find(directory, sound(recorded({ mode })), single);
      expect(proven.proven, mode).toBe('true');
      expect(proven.run, mode).toBe(runUrl(PR_RUN));
      expect(proven.summary, mode).toContain(`Pull request run ${runUrl(PR_RUN)} already passed every gate`);
      expect(proven.calls, mode).toEqual([RUN_LOOKUP, runList(head), download(PR_RUN)]);
    }

    // The tree is checked on Git objects before any run is looked at: two pull requests in the group, or a head whose
    // merge onto the base is another tree, prove nothing whatever a record says.
    const pair: Entry = { base, ref: queueRef(SECOND_PULL_REQUEST, base), sha: group };
    expect(unproven(directory, sound(), pair, 'two pull requests in the group').calls).toEqual([]);
    git(work, 'push', '--quiet', '--force', origin, `${otherHead}:refs/pull/${PULL_REQUEST}/head`);
    const lying = { ...sound(), [runList(otherHead)]: { stdout: runs([pullRequestRun(otherHead)]) } };
    expect(unproven(directory, lying, single, 'a head that merges to another tree').calls).toEqual([]);
    git(work, 'push', '--quiet', '--force', origin, `${head}:refs/pull/${PULL_REQUEST}/head`);
    // The base moved: the same head merges onto the new base cleanly, but its run tested the old base.
    const moved: Entry = { base: movedBase, ref: queueRef(PULL_REQUEST, movedBase), sha: movedEntry };
    expect(unproven(directory, sound(), moved, 'a moved base').calls).toEqual([
      RUN_LOOKUP,
      runList(head),
      download(PR_RUN),
    ]);
    // A ref that names no queue entry of main, a base the ref does not name, a checkout of another commit.
    for (const [label, wrong] of [
      ['not a queue ref', { ...single, ref: 'refs/heads/main' }],
      ['a queue entry of another branch', { ...single, ref: `refs/heads/gh-readonly-queue/demo/pr-7-${base}` }],
      ['a ref of another base', { ...single, base: movedBase }],
      ['a checkout of another commit', { ...single, sha: group }],
      ['a pull request without a head', { ...single, ref: queueRef(9, base) }],
    ] as const) {
      expect(unproven(directory, sound(), wrong, label).calls, label).toEqual([]);
    }

    // Only a completed, successful pull_request run of this workflow in this repository, from a head in this
    // repository, on this head is looked at; its record is never read otherwise.
    for (const [label, run] of [
      ['another head', { ...pullRequestRun(head), head_sha: secondHead }],
      ['another workflow', { ...pullRequestRun(head), workflow_id: WORKFLOW_ID + 1 }],
      ['a push run', { ...pullRequestRun(head), event: 'push' }],
      ['a merge group run', { ...pullRequestRun(head), event: 'merge_group' }],
      ['a run of another repository', { ...pullRequestRun(head), repository: { full_name: 'someone/ontos' } }],
      ['a fork head', { ...pullRequestRun(head), head_repository: { full_name: 'someone/ontos' } }],
      ['a running run', { ...pullRequestRun(head), conclusion: null, status: 'in_progress' }],
      ['a failed run', { ...pullRequestRun(head), conclusion: 'failure' }],
      ['a cancelled run', { ...pullRequestRun(head), conclusion: 'cancelled' }],
      ['a red rerun', { ...pullRequestRun(head), conclusion: 'failure', run_attempt: 2 }],
    ] as const) {
      const result = unproven(directory, { ...sound(), [runList(head)]: { stdout: runs([run]) } }, single, label);
      expect(result.calls, label).not.toContain(download(PR_RUN));
    }
    unproven(directory, { ...sound(), [runList(head)]: { stdout: runs([]) } }, single, 'no run');

    // The run's own record must say it tested this tree, merged from this head onto this base, with a plan that ran
    // the gates this entry would run.
    for (const [label, fields] of [
      ['another tree', { tree: groupTree }],
      ['another base', { base: movedBase }],
      ['another head', { head: secondHead }],
      ['a documentation plan', { mode: 'docs' }],
      ['a proven plan', { mode: 'proven' }],
      ['no plan', { mode: null }],
    ] as const) {
      unproven(directory, sound(recorded(fields)), single, label);
    }
    const noRecord = { exit: 1, stderr: 'no valid artifacts found to download\n' };
    unproven(directory, { ...sound(), [download(PR_RUN)]: noRecord }, single, 'an expired or missing record');
    const otherFile = { files: { 'other.json': '{}' } };
    unproven(directory, { ...sound(), [download(PR_RUN)]: otherFile }, single, 'no record file');
    unproven(directory, sound('not json'), single, 'an unreadable record');
    // A newer run with an unfit record does not hide an older one that recorded this tree.
    const older = find(
      directory,
      {
        ...sound(recorded({ mode: 'docs' })),
        [download(OLDER_PR_RUN)]: { files: { 'comparison.json': recorded() } },
        [runList(head)]: {
          stdout: runs([pullRequestRun(head, OLDER_PR_RUN, '2026-11-19T00:30:00Z'), pullRequestRun(head)]),
        },
      },
      single,
    );
    expect(older.proven).toBe('true');
    expect(older.run).toBe(runUrl(OLDER_PR_RUN));
    expect(older.log).toContain(`${runUrl(PR_RUN)} recorded`);

    // Every failed lookup is no proof and never fails the step: the gates run.
    for (const [label, route, answer] of [
      ['an unreadable workflow', RUN_LOOKUP, { exit: 1, stderr: 'gh: Server Error (HTTP 502)\n' }],
      ['unreadable runs', runList(head), { exit: 1, stderr: 'gh: API rate limit exceeded (HTTP 403)\n' }],
      ['unparsable runs', runList(head), { stdout: '<html>unicorn</html>' }],
      ['an undownloadable record', download(PR_RUN), { exit: 1, stderr: 'gh: Server Error (HTTP 500)\n' }],
    ] as const) {
      unproven(directory, { ...sound(), [route]: answer }, single, label);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
