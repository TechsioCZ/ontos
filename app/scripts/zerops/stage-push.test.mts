import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const HEAD = 'b'.repeat(40);
const SCRIPT = 'stage-push.sh';
const SHOP_GROUP = '::group::push shop';
/**
 * Stands in for push-service.sh: records where it ran and with what, says its upload is done, then ends after
 * PUSH_SECONDS (default none), failing for FAIL_SERVICE or before the upload for EARLY_FAIL_SERVICE.
 */
const fakePush = `#!/usr/bin/env bash
printf '%s|%s|%s|%s|%s\\n' "$PUSH_SERVICE_NAME" "$1" "$2" "$3" "$PWD" >>"$RUNNER_TEMP/calls"
[ "\${EARLY_FAIL_SERVICE:-}" != "$PUSH_SERVICE_NAME" ] || { echo 'upload refused'; exit 7; }
echo 'build and deploy process test-process'
sleep "\${PUSH_SECONDS:-0}"
[ "\${FAIL_SERVICE:-}" != "$PUSH_SERVICE_NAME" ]
`;
/** Answers `git ls-remote` with REMOTE_HEAD, as the stage branch head. */
const fakeGit = `#!/usr/bin/env bash
[ -n "\${REMOTE_HEAD:-}" ] || exit 128
printf '%s\\trefs/heads/demo/sales-crm\\n' "$REMOTE_HEAD"
`;

const fixture = Effect.gen(function* stagePushFixture() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const scripts = path.join(directory, 'scripts');
  const bin = path.join(directory, 'bin');
  yield* fs.makeDirectory(scripts);
  yield* fs.makeDirectory(bin);
  yield* fs.copyFile(path.join(import.meta.dirname, SCRIPT), path.join(scripts, SCRIPT));
  yield* fs.writeFileString(path.join(scripts, 'push-service.sh'), fakePush);
  yield* fs.writeFileString(path.join(bin, 'git'), fakeGit);
  yield* fs.chmod(path.join(bin, 'git'), 0o700);
  for (const setup of ['storefront', 'n1']) {
    yield* fs.makeDirectory(path.join(directory, 'storefront-push', setup), { recursive: true });
  }
  const env = {
    GITHUB_SHA: HEAD,
    PATH: `${bin}:${yield* Config.String('PATH')}`,
    REMOTE_HEAD: HEAD,
    RUNNER_TEMP: directory,
    ZEROPS_APP_SERVICE_ID: 'app-id',
    ZEROPS_N1_STOREFRONT_SERVICE_ID: 'n1-id',
    ZEROPS_SHOP_STOREFRONT_SERVICE_ID: 'shop-id',
    ZEROPS_STOREFRONT_SERVICE_ID: 'storefront-id',
  };
  const stagePush = (args: readonly string[], extra: Readonly<Record<string, string>> = {}) =>
    collectToolingProcess(
      ChildProcess.make('bash', [path.join(scripts, SCRIPT), ...args], {
        cwd: directory,
        env: { ...env, ...extra },
        extendEnv: true,
      }),
    );
  const calls = Effect.gen(function* readCalls() {
    const file = path.join(directory, 'calls');
    return (yield* fs.exists(file)) ? (yield* fs.readFileString(file)).trim().split('\n') : [];
  });
  return { calls, directory, stagePush };
});

it.effect('pushes each service with its own setup, the storefronts from their staged runner builds', () =>
  Effect.gen(function* everyService() {
    const { calls, directory, stagePush } = yield* fixture;
    for (const service of ['app', 'storefront', 'shop', 'n1']) {
      const started = yield* stagePush(['start', service]);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain('build and deploy process');
    }
    const waited = yield* stagePush(['wait', 'app', 'storefront', 'shop', 'n1']);
    expect(waited.status, waited.stderr).toBe(0);
    expect(waited.stdout).toContain(SHOP_GROUP);
    expect(yield* calls).toEqual([
      `app|app-id|app|${HEAD}|${directory}`,
      `storefront|storefront-id|storefront|${HEAD}|${path.join(directory, 'storefront-push/storefront')}`,
      `shop|shop-id|storefront|${HEAD}|${path.join(directory, 'storefront-push/storefront')}`,
      `n1|n1-id|n1|${HEAD}|${path.join(directory, 'storefront-push/n1')}`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('returns once the upload is done while Zerops still builds, and the wait collects the end', () =>
  Effect.gen(function* uploadThenWait() {
    const { stagePush } = yield* fixture;
    const started = yield* stagePush(['start', 'app'], { PUSH_SECONDS: '3' });
    expect(started.status).toBe(0);
    const waited = yield* stagePush(['wait', 'app']);
    expect(waited.status).toBe(0);
    expect(waited.stdout).toMatch(/waited [1-9]\d*s for the Zerops builds and deploys of: app/u);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('never pushes when the stage branch moved on or cannot be read', () =>
  Effect.gen(function* staleHead() {
    for (const head of ['c'.repeat(40), '']) {
      const { calls, stagePush } = yield* fixture;
      const started = yield* stagePush(['start', 'app'], { REMOTE_HEAD: head });
      expect(started.status).not.toBe(0);
      expect(yield* calls).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a missing service ID before any push', () =>
  Effect.gen(function* missingServiceId() {
    const { calls, stagePush } = yield* fixture;
    const started = yield* stagePush(['start', 'shop'], { ZEROPS_SHOP_STOREFRONT_SERVICE_ID: '' });
    expect(started.status).not.toBe(0);
    expect(yield* calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('fails a push that ends before Zerops builds, and a wait that collects a failed deploy', () =>
  Effect.gen(function* failures() {
    const early = yield* fixture;
    const refused = yield* early.stagePush(['start', 'n1'], { EARLY_FAIL_SERVICE: 'n1' });
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('upload refused');
    const late = yield* fixture;
    expect((yield* late.stagePush(['start', 'app'], { FAIL_SERVICE: 'app' })).status).toBe(0);
    expect((yield* late.stagePush(['start', 'shop'])).status).toBe(0);
    const waited = yield* late.stagePush(['wait', 'app', 'shop']);
    expect(waited.status).not.toBe(0);
    expect(waited.stdout).toContain('::error::the app push failed');
    expect(waited.stdout).toContain(SHOP_GROUP);
    // After a failed step, every push the job started is still waited for.
    const all = yield* late.stagePush(['wait-started']);
    expect(all.stdout).toContain('::group::push app');
    expect(all.stdout).toContain(SHOP_GROUP);
    // A service whose push never started cannot be waited for.
    expect((yield* late.stagePush(['wait', 'n1'])).status).not.toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('ends a superseded run, and goes on when the head is this run or unreadable', () =>
  Effect.gen(function* superseded() {
    const { stagePush } = yield* fixture;
    expect((yield* stagePush(['superseded'])).status).toBe(0);
    expect((yield* stagePush(['superseded'], { REMOTE_HEAD: '' })).status).toBe(0);
    const moved = yield* stagePush(['superseded'], { REMOTE_HEAD: 'c'.repeat(40) });
    expect(moved.status).not.toBe(0);
    expect(moved.stdout).toContain('the stage branch moved on');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
