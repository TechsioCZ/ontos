import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { assertCleanCheckoutAt, inspectRelease, parseTag, pinCandidate, pragueDay } from './release.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const run = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A repository with a bare origin holding demo/sales-crm (two commits) and one local commit beyond it. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'stable-release-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  run(root, 'init', '--quiet', '--bare', origin);
  run(root, 'init', '--quiet', '--initial-branch', 'demo/sales-crm', work);
  run(work, 'config', 'user.email', 'test@example.invalid');
  run(work, 'config', 'user.name', 'test');
  run(work, 'config', 'tag.gpgSign', 'false');
  run(work, 'config', 'commit.gpgSign', 'false');
  run(work, 'remote', 'add', 'origin', origin);
  const commit = (name) => {
    writeFileSync(join(work, name), name);
    run(work, 'add', name);
    run(work, 'commit', '--quiet', '-m', name);
    return run(work, 'rev-parse', 'HEAD');
  };
  const first = commit('a');
  const published = commit('b');
  run(work, 'push', '--quiet', 'origin', 'demo/sales-crm');
  run(work, 'fetch', '--quiet', 'origin');
  const unpublished = commit('c');
  return { work, origin, first, published, unpublished };
}

const friday = new Date('2026-11-27T10:00:00Z');

test('tag names carry a real date and a same-day sequence from -2', () => {
  assert.deepEqual(parseTag('sales-stable/2026-11-27'), { date: '2026-11-27', sequence: 1 });
  assert.deepEqual(parseTag('sales-stable/2026-11-27-2'), { date: '2026-11-27', sequence: 2 });
  for (const bad of ['sales-stable/2026-02-30', 'sales-stable/2026-11-27-1', 'sales-stable/2026-11-27-01', 'v1', 'sales-stable/26-11-27']) {
    assert.throws(() => parseTag(bad), /tag|date|suffix/u, bad);
  }
});

test('Prague days follow Prague, not UTC', () => {
  assert.deepEqual(pragueDay(new Date('2026-11-27T23:30:00Z')), { weekday: 'Sat', date: '2026-11-28' });
});

test('pin creates an annotated tag on the demo line and inspect returns its exact commit', () => {
  const repo = repository();
  const pinned = pinCandidate({ cwd: repo.work, tag: 'sales-stable/2026-11-27', ref: repo.published, now: friday });
  assert.equal(pinned.commit, repo.published);
  assert.equal(run(repo.work, 'cat-file', '-t', 'refs/tags/sales-stable/2026-11-27'), 'tag');
  assert.match(pinned.notes.join('\n'), /not pushed/u);
  const local = inspectRelease({ cwd: repo.work, tag: 'sales-stable/2026-11-27' });
  assert.equal(local.published, false);
  assert.equal(local.commit, repo.published);
});

test('pin refuses commits off the published demo line and never replaces a tag', () => {
  const repo = repository();
  assert.throws(
    () => pinCandidate({ cwd: repo.work, tag: 'sales-stable/2026-11-27', ref: repo.unpublished, now: friday }),
    /not on origin\/demo\/sales-crm/u,
  );
  pinCandidate({ cwd: repo.work, tag: 'sales-stable/2026-11-27', ref: repo.first, now: friday });
  assert.throws(
    () => pinCandidate({ cwd: repo.work, tag: 'sales-stable/2026-11-27', ref: repo.published, now: friday }),
    /immutable/u,
  );
});

test('a pushed tag is published; a tag moved under the same name is refused', () => {
  const repo = repository();
  const tag = 'sales-stable/2026-11-28';
  const sunday = new Date('2026-11-29T10:00:00Z');
  const pushed = pinCandidate({ cwd: repo.work, tag, ref: repo.published, push: true, now: sunday });
  assert.equal(pushed.published, true);
  assert.match(pushed.notes.join('\n'), /pinned on Sun; the usual pin day is Friday/u);
  assert.match(pushed.notes.join('\n'), /names 2026-11-28, today in Prague is 2026-11-29/u);
  run(repo.work, 'tag', '--force', '--annotate', '--message', 'moved', tag, repo.first);
  assert.throws(() => inspectRelease({ cwd: repo.work, tag }), /moved/u);
});

test('lightweight tags and tags whose object names another tag are refused', () => {
  const repo = repository();
  run(repo.work, 'tag', 'sales-stable/2026-11-29', repo.published);
  assert.throws(() => inspectRelease({ cwd: repo.work, tag: 'sales-stable/2026-11-29', remote: null }), /lightweight/u);
  run(repo.work, 'tag', '--annotate', '--message', 'x', 'sales-stable/2026-11-30', repo.published);
  const object = run(repo.work, 'rev-parse', 'refs/tags/sales-stable/2026-11-30');
  run(repo.work, 'update-ref', 'refs/tags/sales-stable/2026-12-01', object);
  assert.throws(() => inspectRelease({ cwd: repo.work, tag: 'sales-stable/2026-12-01', remote: null }), /names itself/u);
});

test('builds refuse a checkout that is not exactly the candidate commit', () => {
  const repo = repository();
  assert.throws(() => assertCleanCheckoutAt(repo.work, repo.published), /not the candidate/u);
  assertCleanCheckoutAt(repo.work, repo.unpublished);
  writeFileSync(join(repo.work, 'untracked'), 'x');
  assert.throws(() => assertCleanCheckoutAt(repo.work, repo.unpublished), /differs/u);
});
