#!/usr/bin/env node
/**
 * Operator command: enroll, replace or deactivate one Symmy route of one Tenant and company.
 *
 *   pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request route.json [--replace <token>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment apply --request route.json --operator <ref> --reason <text> [--replace <token>]
 *   pnpm --filter @app/symmy-integration ops:route-enrollment verify --request route.json
 *   pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request reference.json --deactivate <token>
 *   pnpm --filter @app/symmy-integration ops:route-enrollment apply --request reference.json --operator <ref> --reason <text> --deactivate <token>
 *
 * The request is the reviewed route (`SymmyRouteEnrollmentRequestSchema`): the reference of the route (tenantId,
 * legalEntityId, principalId, routeKey, routeCode, routeId; `SymmyRouteReferenceSchema`) and what it enrolls
 * (configuration, lifecyclePolicy, mappingVersion, routeRevision). A deactivation takes the reference alone and
 * refuses a request carrying anything else, as it stops the stored route whatever that route enrolls. --replace and
 * --deactivate name the change token the operator read from the stored route (every receipt reports it); the change
 * is refused once the route carries another. An apply records the operator reference and reason, as stated, with the
 * change. The command connects with DATABASE_ADMIN_URL (the route is writable only by the migration and operator
 * login), reads the active Application Composition from ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL and the retention
 * configuration from ONTOS_SYMMY_JOB_RETENTION_POLICIES. It prints every refusal, or the receipt with the bindings the
 * route needs, the system principal that runs each executor workload and the runtime configuration it cannot check.
 * It grants no binding and calls no owner. It requires the integration principal to hold an active, unrevoked API-key
 * binding, and does not prove that a key is issued for that binding: issue or rotate the key through the Shell's
 * API-key management. On a company route every binding a call runs under in that company (`companyScoped` in the
 * receipt) must also be registered for the company; Core's workload registration writes that registration. This
 * command's own `verify` is the proof of those registrations: it checks each one as the company gate admits it, the
 * integration principal by any of its active bindings registered for the company and an executor by exactly the
 * binding it runs under. The stage workload registration's read-back (`scripts/demo/register-stage-workloads.mts`)
 * asks only whether the principal is registered for the company through any of its bindings, so it can report an
 * executor verified whose own binding is not registered there. A deactivation checks nothing but the stored route and
 * its token, so it stops a route of any kind.
 *
 * A customerGroupsBatch route enrolls Commerce's Group definition read beside its group create and names its company:
 * the Shell reads each group code's current definition with the integration principal before it admits. Commerce
 * answers that read only for a named reader of its GROUP_DEFINITION source route of that company and of the group
 * route's source (its sourceRouteId, or its route id), configured through
 * commerce.customer-context.configure-customer-source-route; without it, every request the route has not already
 * admitted under its idempotency key answers 403. The command cannot check this: Commerce shows a source route only to
 * an administrator through its customer-source-route read, which no workload reads, and the command calls no owner.
 *
 * An inventoryStockBatch route names no company, its Inventory backend (inventoryBackendId) and its positions
 * (stockScope), each a Stock Position with the item and location keys, namespace, scope and Customer Configuration its
 * rows are asserted under. Inventory accepts a row only once an operator has, through its governed Actions and for that
 * Customer Configuration: selected the External Business System of the route's backend id
 * (commerce.inventory.select-inventory-backend), before the business time of the rows it sends; registered the Stock
 * Item (register-stock-item), created the Stock Location (create-stock-location) and established the Stock Position of
 * that Item, Location and Unit under the selection (establish-stock-position); and correlated the entry's item key as an
 * ITEM and its location key as a LOCATION, in its namespace and scope and issued by that backend, to the Item and the
 * Location (establish-external-stock-correlation). A row names the Position's Unit. Until then every row of a request
 * is not accepted: Inventory answers its effect unavailable while the Customer Configuration has selected no backend,
 * and invalid or stale while the selection, the Position or a correlation differs. The command cannot check this:
 * Inventory shows its selection only through its backend-configuration read, which an operator's permission and no
 * workload carries, and the command calls no owner.
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

const requestFlag = Flag.String('request').pipe(
  Flag.withDescription('Path of the reviewed route request JSON; with --deactivate, of the route reference alone'),
);
const replaceFlag = Flag.Int('replace').pipe(
  Flag.withDescription(
    'Replace the enrolled route of this selector, which carries this change token; refused while it has outstanding jobs',
  ),
  Flag.optional,
);
const deactivateFlag = Flag.Int('deactivate').pipe(
  Flag.withDescription(
    'Deactivate the enrolled route the reference names, which carries this change token; the receipt lists the work it strands',
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
