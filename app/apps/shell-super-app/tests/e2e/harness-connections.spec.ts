import { APP_WORKSPACE_ROOT } from '@app/core-runtime/workspace-environment';
import { NodeServices } from '@effect/platform-node';
import { expect, test } from '@playwright/test';
import { Effect, FileSystem, Path } from 'effect';

// The suite's own connection rules, read from source before any browser starts. Both broke the job intermittently
// on 2026-11-15 while the services stayed healthy.

const readWorkspaceFile = (relativePath: string) =>
  Effect.gen(function* readHarnessFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFileString(path.join(APP_WORKSPACE_ROOT, relativePath));
  }).pipe(Effect.provide(NodeServices.layer));

const specSources = Effect.gen(function* readSpecSources() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(APP_WORKSPACE_ROOT, 'apps/shell-super-app/tests/e2e');
  const names = (yield* fileSystem.readDirectory(directory)).filter((name) => name.endsWith('.spec.ts')).toSorted();
  return yield* Effect.all(
    names.map((name) =>
      fileSystem.readFileString(path.join(directory, name)).pipe(Effect.map((source) => ({ name, source }))),
    ),
  );
}).pipe(Effect.provide(NodeServices.layer));

test('sends every API request of the specs on a connection of its own', async () => {
  // An API call without `onOwnConnection` reuses Playwright's pooled keep-alive sockets (run 43757038239). A call
  // statement runs from the method to its semicolon.
  const apiCall = /\brequest\.(?:delete|fetch|get|head|patch|post|put)\([^;]*;/gu;
  const sources = await Effect.runPromise(specSources);
  const calls = sources.flatMap(({ name, source }) =>
    [...source.matchAll(apiCall)].map((match) => ({ name, statement: match[0] })),
  );
  expect(calls.length).toBeGreaterThan(0);
  const offenders = calls
    .filter(({ statement }) => !statement.includes('onOwnConnection('))
    .map(({ name, statement }) => `${name}: ${statement}`);
  expect(offenders).toEqual([]);
});

test('keeps each SpiceDB client on one gRPC connection for the whole job', async () => {
  // SpiceDB's default 30-second connection age makes it end every client connection mid-suite (run 43742187508).
  const compose = await Effect.runPromise(readWorkspaceFile('docker-compose.yml'));
  const age = /^\s*- --grpc-max-conn-age=(?<hours>\d+)h$/mu.exec(compose)?.groups?.['hours'];
  // The browser job's timeout is 30 minutes.
  expect(Number(age ?? 0)).toBeGreaterThanOrEqual(1);
});
