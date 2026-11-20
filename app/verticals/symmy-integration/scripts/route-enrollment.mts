#!/usr/bin/env node
/**
 * Operator command: enroll one Symmy route of one Tenant and company.
 *
 *   pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request route.json
 *   pnpm --filter @app/symmy-integration ops:route-enrollment apply --request route.json [--replace]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment verify --request route.json

 *
 * The request is the reviewed route (`SymmyRouteEnrollmentRequestSchema`). The command connects with
 * DATABASE_ADMIN_URL (the route is writable only by the migration and operator login), reads the active Application
 * Composition from ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL and the retention configuration from
 * ONTOS_SYMMY_JOB_RETENTION_POLICIES. It grants no binding and calls no owner.
 */
import { DatabaseConfig, parseDatabaseConnectionPair, ActiveApplicationCompositionConfigLive } from '@app/core-runtime';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { SymmyRouteEnrollmentRefused } from '../src/ops/symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentReceiptSchema, runSymmyRouteEnrollment } from '../src/ops/symmy-route-enrollment-store.ts';
import { SymmyRouteEnrollmentUnavailable } from '../src/ops/symmy-route-enrollment-unavailable.ts';
import type { SymmyRouteEnrollmentMode } from '../src/ops/symmy-route-enrollment-store.ts';

const adminUnavailable = (cause: unknown) =>
  new SymmyRouteEnrollmentUnavailable({
    cause,
    reason: 'DATABASE_ADMIN_URL and DATABASE_URL must name two identities',
  });

/** The administrative identity, checked against the runtime identity it must differ from. */
const AdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* adminDatabaseConfig() {
    const [runtimeUrl, adminUrl] = yield* Effect.all(
      [Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL')],
      { concurrency: 2 },
    ).pipe(Effect.mapError(adminUnavailable));
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(adminUrl),
      DATABASE_URL: Redacted.value(runtimeUrl),
    }).pipe(Effect.mapError(adminUnavailable));
    return connections.admin;
  }),
);

const CompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(
    ActiveApplicationCompositionSourceLive.pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
        ),
      ),
    ),
  ),
);

const EnrollmentLive = Layer.mergeAll(CoreDatabaseLive.pipe(Layer.provide(AdminDatabaseConfigLive)), CompositionLive);

const requestFlag = Flag.String('request').pipe(Flag.withDescription('Path of the reviewed route request JSON'));
const replaceFlag = Flag.Boolean('replace').pipe(
  Flag.withDescription('Replace the enrolled route of this selector; refused while it has outstanding jobs'),
);

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteEnrollmentReceiptSchema));
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);

/** Every refusal on its own line, so the operator sees the whole list of one run. */
const reportFailure = (failure: SymmyRouteEnrollmentRefused | SymmyRouteEnrollmentUnavailable) =>
  isRefused(failure)
    ? Effect.forEach(failure.refusals, ({ code, detail }) => Console.error(`${code}: ${detail}`), { discard: true })
    : Console.error(failure.reason);

const enroll = Effect.fn('SymmyRouteEnrollmentCommand.enroll')(function* enroll(
  mode: SymmyRouteEnrollmentMode,
  path: string,
  replace: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path);
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text);
  const receipt = yield* runSymmyRouteEnrollment({ mode, replace, request }).pipe(Effect.tapError(reportFailure));
  yield* Console.log(yield* encodeReceipt(receipt));
});

const writeCommand = (mode: Exclude<SymmyRouteEnrollmentMode, 'verify'>, description: string) =>
  Command.make(mode, { replace: replaceFlag, request: requestFlag }, ({ replace, request }) =>
    enroll(mode, request, replace),
  ).pipe(
    Command.withDescription(description),
    Command.provide(() => EnrollmentLive),
  );

const cli = Command.make('symmy-route-enrollment').pipe(
  Command.withSubcommands([
    writeCommand('dry-run', 'Check the route against Core, the composition and the retention policies'),
    writeCommand('apply', 'Check, write and read back the route; an identical route stays unchanged'),
    Command.make('verify', { request: requestFlag }, ({ request }) => enroll('verify', request, false)).pipe(
      Command.withDescription('Check that the enrolled route equals the request and its facts still hold'),
      Command.provide(() => EnrollmentLive),
    ),
  ]),
);

export const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
