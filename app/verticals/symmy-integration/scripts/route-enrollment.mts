#!/usr/bin/env node
/**
 * Operator command: enroll, replace or deactivate one Symmy route of one Tenant and company.
 *
 *   pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request route.json [--replace <revision> | --deactivate <revision>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment apply --request route.json --operator <ref> --reason <text> [--replace <revision> | --deactivate <revision>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment verify --request route.json
 *
 * The request is the reviewed route (`SymmyRouteEnrollmentRequestSchema`). --replace and --deactivate name the revision
 * the operator read as the route's current one; the change is refused once the route is at another. An apply records
 * the operator reference and reason with the change. The command connects with DATABASE_ADMIN_URL (the route is
 * writable only by the migration and operator login), reads the active Application Composition from
 * ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL and the retention configuration from ONTOS_SYMMY_JOB_RETENTION_POLICIES. It
 * prints every refusal, or the receipt with the bindings the route needs, the system principal that runs each executor
 * workload and the runtime configuration it cannot check. It grants no binding and calls no owner.
 */
import { DatabaseConfig, parseDatabaseConnectionPair, ActiveApplicationCompositionConfigLive } from '@app/core-runtime';
import { CoreDatabaseLive } from '@app/core-runtime/db/client';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { SymmyRouteEnrollmentRefused } from '../src/ops/symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentReceiptSchema, runSymmyRouteEnrollment } from '../src/ops/symmy-route-enrollment-store.ts';
import { SymmyRouteEnrollmentUnavailable } from '../src/ops/symmy-route-enrollment-unavailable.ts';
import type { SymmyRouteChange } from '../src/ops/symmy-route-enrollment.ts';

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
const replaceFlag = Flag.String('replace').pipe(
  Flag.withDescription(
    'Replace the enrolled route of this selector, which is at this revision; refused while it has outstanding jobs',
  ),
  Flag.optional,
);
const deactivateFlag = Flag.String('deactivate').pipe(
  Flag.withDescription(
    'Deactivate the enrolled route of this selector, which is at this revision; refused while it has outstanding jobs',
  ),
  Flag.optional,
);
const changeFlags = { deactivate: deactivateFlag, replace: replaceFlag, request: requestFlag };
const operatorFlag = Flag.String('operator').pipe(
  Flag.withDescription('Reference of the operator applying the change, recorded with it'),
);
const reasonFlag = Flag.String('reason').pipe(Flag.withDescription('Why the change is applied, recorded with it'));

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteEnrollmentReceiptSchema));
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);

/** Every refusal on its own line, so the operator sees the whole list of one run. */
const reportFailure = (failure: SymmyRouteEnrollmentRefused | SymmyRouteEnrollmentUnavailable) =>
  isRefused(failure)
    ? Effect.forEach(failure.refusals, ({ code, detail }) => Console.error(`${code}: ${detail}`), { discard: true })
    : Console.error(failure.reason);

/** The change the flags ask for: at most one of a replacement and a deactivation, each at its current revision. */
const changeOf = (flags: {
  readonly deactivate: Option.Option<string>;
  readonly replace: Option.Option<string>;
}): Effect.Effect<SymmyRouteChange, SymmyRouteEnrollmentRefused> => {
  if (Option.isSome(flags.replace) && Option.isSome(flags.deactivate)) {
    return Effect.fail(
      new SymmyRouteEnrollmentRefused({
        refusals: [{ code: 'invalid_request', detail: 'A run replaces or deactivates a route, never both' }],
      }),
    );
  }
  return Effect.succeed(
    Option.match(flags.replace, {
      onNone: () =>
        Option.match(flags.deactivate, {
          onNone: (): SymmyRouteChange => ({ kind: 'enroll' }),
          onSome: (currentRevision): SymmyRouteChange => ({ currentRevision, kind: 'deactivate' }),
        }),
      onSome: (currentRevision): SymmyRouteChange => ({ currentRevision, kind: 'replace' }),
    }),
  );
};

const enroll = Effect.fn('SymmyRouteEnrollmentCommand.enroll')(function* enroll(
  path: string,
  change: SymmyRouteChange,
  run: Parameters<typeof runSymmyRouteEnrollment>[0]['run'],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path);
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text);
  const receipt = yield* runSymmyRouteEnrollment({ change, request, run }).pipe(Effect.tapError(reportFailure));
  yield* Console.log(yield* encodeReceipt(receipt));
});

const cli = Command.make('symmy-route-enrollment').pipe(
  Command.withSubcommands([
    Command.make('dry-run', changeFlags, (flags) =>
      changeOf(flags).pipe(
        Effect.tapError(reportFailure),
        Effect.flatMap((change) => enroll(flags.request, change, { mode: 'dry-run' })),
      ),
    ).pipe(
      Command.withDescription('Check the change against Core, the composition and the retention policies'),
      Command.provide(() => EnrollmentLive),
    ),
    Command.make('apply', { ...changeFlags, operator: operatorFlag, reason: reasonFlag }, (flags) =>
      changeOf(flags).pipe(
        Effect.tapError(reportFailure),
        Effect.flatMap((change) =>
          enroll(flags.request, change, {
            attribution: { operatorRef: flags.operator, reason: flags.reason },
            mode: 'apply',
          }),
        ),
      ),
    ).pipe(
      Command.withDescription('Check, write, read back and record the change; an identical route stays unchanged'),
      Command.provide(() => EnrollmentLive),
    ),
    Command.make('verify', { request: requestFlag }, ({ request }) =>
      enroll(request, { kind: 'enroll' }, { mode: 'verify' }),
    ).pipe(
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
