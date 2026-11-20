#!/usr/bin/env node
/**
 * Operator command: enroll, replace or deactivate one Symmy route of one Tenant and company.
 *
 *   pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request route.json [--replace <token> | --deactivate <token>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment apply --request route.json --operator <ref> --reason <text> [--replace <token> | --deactivate <token>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment verify --request route.json
 *
 * The request is the reviewed route (`SymmyRouteEnrollmentRequestSchema`). --replace and --deactivate name the change
 * token the operator read from the stored route (every receipt reports it); the change is refused once the route
 * carries another. An apply records the operator reference and reason, as stated, with the change. The command connects with DATABASE_ADMIN_URL (the route is
 * writable only by the migration and operator login), reads the active Application Composition from
 * ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL and the retention configuration from ONTOS_SYMMY_JOB_RETENTION_POLICIES. It
 * prints every refusal, or the receipt with the bindings the route needs, the system principal that runs each executor
 * workload and the runtime configuration it cannot check. It grants no binding and calls no owner. A deactivation
 * checks nothing but the stored route and its token, so it stops a route of any kind.
 *
 * What main enrolls today, checked by deriving each route's bindings from the manifests of all main modules:
 * productsBatch, adminProducts, priceListsBatchUpsert, priceListPricesBatch, priceLists, customerGroupsBatch,
 * adminCustomers and adminRegions. It refuses customersBatch and customerGroupCustomersBatch with call_not_declared,
 * naming each requirement that Privacy, Party or Commerce customer context declares on their paths without
 * registering the call that serves it (declaring module, operation, provider module, entrypoint and version), which
 * only those owners can change; and inventoryStockBatch with stock_route_pending_inventory_setup until its Inventory
 * backend and positions are set up.
 */
import { parseDatabaseConnectionPair, ActiveApplicationCompositionConfigLive } from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { SymmyRouteEnrollmentRefused } from '../src/ops/symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentReceiptSchema, runSymmyRouteEnrollment } from '../src/ops/symmy-route-enrollment-store.ts';
import { SymmyRouteEnrollmentUnavailable } from '../src/ops/symmy-route-enrollment-unavailable.ts';
import type { SymmyRouteChange } from '../src/ops/symmy-route-enrollment.ts';

const adminUnavailable = (cause: unknown) =>
  new SymmyRouteEnrollmentUnavailable({
    cause,
    reason: 'DATABASE_ADMIN_URL and DATABASE_URL must name two identities',
  });

/** A client of the administrative identity, checked against the runtime identity it must differ from. */
const AdminDatabaseLive = Layer.unwrap(
  Effect.gen(function* adminDatabase() {
    const [runtimeUrl, adminUrl] = yield* Effect.all(
      [Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL')],
      { concurrency: 2 },
    ).pipe(Effect.mapError(adminUnavailable));
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(adminUrl),
      DATABASE_URL: Redacted.value(runtimeUrl),
    }).pipe(Effect.mapError(adminUnavailable));
    return PgClient.layer({ url: Redacted.make(connections.admin.connectionString) });
  }),
).pipe(Layer.provide(Reactivity.layer));

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

const EnrollmentLive = Layer.mergeAll(AdminDatabaseLive, CompositionLive);

const requestFlag = Flag.String('request').pipe(Flag.withDescription('Path of the reviewed route request JSON'));
const replaceFlag = Flag.Int('replace').pipe(
  Flag.withDescription(
    'Replace the enrolled route of this selector, which carries this change token; refused while it has outstanding jobs',
  ),
  Flag.optional,
);
const deactivateFlag = Flag.Int('deactivate').pipe(
  Flag.withDescription(
    'Deactivate the enrolled route of this selector, which carries this change token; the receipt lists the work it strands',
  ),
  Flag.optional,
);
const changeFlags = { deactivate: deactivateFlag, replace: replaceFlag, request: requestFlag };
const operatorFlag = Flag.String('operator').pipe(
  Flag.withDescription('Who applies the change, as the operator states it; recorded with it beside the database login'),
);
const reasonFlag = Flag.String('reason').pipe(Flag.withDescription('Why the change is applied, recorded with it'));

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteEnrollmentReceiptSchema));
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);

/** Every refusal on its own line, so the operator sees the whole list of one run. */
const reportFailure = (failure: SymmyRouteEnrollmentRefused | SymmyRouteEnrollmentUnavailable) =>
  isRefused(failure)
    ? Effect.forEach(failure.refusals, ({ code, detail }) => Console.error(`${code}: ${detail}`), { discard: true })
    : Console.error(failure.reason);

/** The change the flags ask for: at most one of a replacement and a deactivation, each at the token it names. */
const changeOf = (flags: {
  readonly deactivate: Option.Option<number>;
  readonly replace: Option.Option<number>;
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
          onSome: (expectedChangeToken): SymmyRouteChange => ({ expectedChangeToken, kind: 'deactivate' }),
        }),
      onSome: (expectedChangeToken): SymmyRouteChange => ({ expectedChangeToken, kind: 'replace' }),
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
