import { NodeRuntime } from '@effect/platform-node';
import { Effect, Redacted } from 'effect';

import { R2_MOCK_LABEL, startR2BehaviourMock } from './r2-behaviour-mock.ts';

/*
 * R2-behaviour MOCK built from documentation, NOT R2, as a standalone process: it lets an out-of-process run (the Shell
 * end-to-end suites, which read CORE_MEDIA_S3_* from the process environment) use the mock as their provider.
 *
 *   node packages/core-runtime/tests/support/r2-behaviour-mock-server.ts <env-file>
 *
 * It writes shell `export` lines for CORE_MEDIA_S3_* to <env-file> (mode 0600, generated credentials, never committed)
 * and serves until it is stopped. Source the file in the shell that starts the suite.
 */

const nodeFs = process.getBuiltinModule('node:fs');

const envFile = process.argv.at(2);

const program = Effect.gen(function* serve() {
  if (envFile === undefined) {
    return yield* Effect.die(new Error('usage: r2-behaviour-mock-server.ts <env-file>'));
  }
  const mock = yield* startR2BehaviourMock();
  const lines = [
    `export CORE_MEDIA_S3_ENDPOINT=${mock.origin.origin}`,
    `export CORE_MEDIA_S3_BUCKET=${mock.bucket}`,
    'export CORE_MEDIA_S3_REGION=auto',
    'export CORE_MEDIA_S3_ADDRESSING_STYLE=path',
    'export CORE_MEDIA_S3_CONDITIONAL_CREATE=supported',
    `export CORE_MEDIA_S3_ACCESS_KEY_ID=${Redacted.value(mock.credentials.accessKeyId)}`,
    `export CORE_MEDIA_S3_SECRET_ACCESS_KEY=${Redacted.value(mock.credentials.secretAccessKey)}`,
    '',
  ];
  yield* Effect.sync(() => {
    nodeFs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  });
  yield* Effect.logWarning(`${R2_MOCK_LABEL} listening on ${mock.origin.origin}; environment written to ${envFile}`);
  return yield* Effect.never;
}).pipe(Effect.scoped);

NodeRuntime.runMain(program);
