// Sales-demo owner seed for commerce.customer-context: customer segments as Customer Groups.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo` after party-registry,
// with DATABASE_ADMIN_URL in the environment. It writes only the commerce_customer_context schema, through
// the owner's own scoped routines, and restores the segment baseline:
//   - the four segment groups from party-registry `customer-segment-definitions.ts` (reused by definition),
//   - one COUNTERPARTY purchasing profile per seeded customer (reused by Counterparty),
//   - exactly one current segment membership per seeded customer; any other segment membership of a seeded
//     customer (for example one made in the UI) is deleted.
import { NodeServices } from '@effect/platform-node';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { customerSegmentDefinitions } from '@app/party-registry/api/client';
import type { CustomerSegmentCode } from '@app/party-registry/api/client';
import { PgClient } from '@effect/sql-pg';
import { Console, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';

import {
  demoId,
  salesDemoCustomerCounterpartyId,
  salesDemoCustomers,
  salesDemoLegalEntityId as legalEntityId,
  salesDemoTenantId as tenantId,
} from '../../party-registry/scripts/demo-customers.mts';

class SegmentSeedError extends Schema.TaggedError<SegmentSeedError>()('SegmentSeedError', {
  reason: Schema.String,
}) {}

const SEED_KEY = 'sales-demo-segments';
const actorPrincipalId = demoId('commerce.seed-principal', SEED_KEY);
const invocationId = (operation: string) => demoId('commerce.seed-invocation', `${SEED_KEY}:${operation}`);

/** Baseline segment per seeded customer, aligned with `salesDemoCustomers` order (40 entries). */
const KEY = 'SALES_DEMO_KEY_ACCOUNTS';
const B2B = 'SALES_DEMO_B2B_STANDARD';
const RETAIL = 'SALES_DEMO_RETAIL';
const PUBLIC = 'SALES_DEMO_PUBLIC_SECTOR';
const baselineSegments: readonly CustomerSegmentCode[] = [
  KEY,
  RETAIL,
  B2B,
  B2B,
  KEY,
  PUBLIC,
  RETAIL,
  KEY,
  B2B,
  KEY,
  B2B,
  RETAIL,
  PUBLIC,
  B2B,
  RETAIL,
  PUBLIC,
  B2B,
  PUBLIC,
  B2B,
  RETAIL,
  B2B,
  B2B,
  B2B,
  KEY,
  RETAIL,
  RETAIL,
  B2B,
  B2B,
  PUBLIC,
  B2B,
  B2B,
  RETAIL,
  PUBLIC,
  RETAIL,
  B2B,
  PUBLIC,
  KEY,
  KEY,
  B2B,
  PUBLIC,
];

const ResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CommerceSeedResourceId'));
const GroupRowSchema = Schema.Struct({
  group_json: Schema.OptionFromNullOr(
    Schema.Struct({
      groupRef: Schema.Struct({ resourceId: ResourceIdSchema }),
      lifecycleHistory: Schema.NonEmptyArray(Schema.Struct({ activeFrom: Schema.String })),
    }),
  ),
  outcome: Schema.String,
});
const RoleRowSchema = Schema.Struct({ recorded_at: Schema.String, role_period_id: Schema.String });
const ProfileRowSchema = Schema.Struct({
  outcome: Schema.String,
  payload: Schema.OptionFromNullOr(Schema.Struct({ profileRef: Schema.Struct({ resourceId: ResourceIdSchema }) })),
});
const OutcomeRowSchema = Schema.Struct({ outcome: Schema.String });

const single = <S extends Schema.Top>(schema: S, rows: readonly unknown[], context: string) =>
  rows.length === 1
    ? Schema.decodeUnknownEffect(schema)(rows[0]).pipe(
        Effect.mapError((cause) => new SegmentSeedError({ reason: `${context}: ${String(cause)}` })),
      )
    : Effect.fail(new SegmentSeedError({ reason: `${context}: expected one row, got ${rows.length}` }));

const seedSegments = Effect.gen(function* seedSegments() {
  if (baselineSegments.length !== salesDemoCustomers.length) {
    return yield* new SegmentSeedError({ reason: 'Baseline segments no longer match the seeded customers' });
  }
  const connections = yield* loadDatabaseConnectionPair();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(connections.admin.host)) {
    return yield* new SegmentSeedError({ reason: 'The sales-demo seed requires local PostgreSQL' });
  }
  const sql = yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) });
  const query = (statement: string, parameters: readonly (string | null)[], context: string) =>
    sql
      .unsafe(statement, parameters)
      .pipe(Effect.mapError((cause) => new SegmentSeedError({ reason: `${context}: ${String(cause)}` })));
  const recordedAt = DateTime.formatIso(yield* DateTime.now);

  const counts = yield* sql.withTransaction(
    Effect.gen(function* restoreSegmentBaseline() {
      yield* query(
        `select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)`,
        [tenantId, legalEntityId],
        'scope',
      );

      const groups = new Map<CustomerSegmentCode, { readonly activeFrom: string; readonly groupId: string }>();
      for (const definition of customerSegmentDefinitions) {
        const rows = yield* query(
          `select outcome, group_json
             from commerce_customer_context.create_customer_group(
               $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::uuid, $12::uuid)`,
          [
            tenantId,
            legalEntityId,
            definition.businessCode,
            definition.meaningKey,
            definition.description,
            definition.membershipCriteria,
            definition.name,
            definition.purpose,
            'Výchozí segment obchodního dema',
            recordedAt,
            actorPrincipalId,
            invocationId(`group:${definition.businessCode}`),
          ],
          `create group ${definition.businessCode}`,
        );
        const row = yield* single(GroupRowSchema, rows, `create group ${definition.businessCode}`);
        if ((row.outcome !== 'CREATED' && row.outcome !== 'REUSED') || Option.isNone(row.group_json)) {
          return yield* new SegmentSeedError({ reason: `Group ${definition.businessCode}: ${row.outcome}` });
        }
        groups.set(definition.businessCode, {
          activeFrom: row.group_json.value.lifecycleHistory[0].activeFrom,
          groupId: row.group_json.value.groupRef.resourceId,
        });
      }
      const segmentGroupIds = [...groups.values()].map(({ groupId }) => groupId);

      let assigned = 0;
      for (const [index, customer] of salesDemoCustomers.entries()) {
        const counterpartyId = salesDemoCustomerCounterpartyId(customer.ico);
        const roleRows = yield* query(
          `select role_period_id::text as role_period_id,
                  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at
             from party.counterparty_role_periods
            where tenant_id = $1::uuid and legal_entity_id = $2::uuid and counterparty_id = $3::uuid
              and role_type = 'CUSTOMER' and is_current and state = 'ACTIVE'`,
          [tenantId, legalEntityId, counterpartyId],
          `customer role ${customer.ico}`,
        );
        const role = yield* single(RoleRowSchema, roleRows, `customer role ${customer.ico} (run party-registry first)`);
        const profileRows = yield* query(
          `select outcome, payload
             from commerce_customer_context.ensure_counterparty_profile(
               $1::uuid, $2::uuid, $3, null, $4, $5, $6::timestamptz, 'AUTHORIZED_ONBOARDING', $7::uuid, $8::uuid)`,
          [
            tenantId,
            legalEntityId,
            counterpartyId,
            role.role_period_id,
            role.recorded_at,
            recordedAt,
            invocationId(`profile:${customer.ico}`),
            actorPrincipalId,
          ],
          `profile ${customer.ico}`,
        );
        const profile = yield* single(ProfileRowSchema, profileRows, `profile ${customer.ico}`);
        if (
          Option.isNone(profile.payload) ||
          !/^(?:PROFILE_CREATED|PROFILE_ALREADY_EXISTS_ACTIVE)$/u.test(profile.outcome)
        ) {
          return yield* new SegmentSeedError({ reason: `Profile ${customer.ico}: ${profile.outcome}` });
        }
        const profileId = profile.payload.value.profileRef.resourceId;
        const target = groups.get(baselineSegments[index] ?? B2B);
        if (target === undefined) {
          return yield* new SegmentSeedError({ reason: `Unknown segment for ${customer.ico}` });
        }
        yield* query(
          `delete from commerce_customer_context.customer_group_memberships
            where tenant_id = $1::uuid and legal_entity_id = $2::uuid and customer_profile_id = $3::uuid
              and customer_group_id = any($4::uuid[])
              and not (customer_group_id = $5::uuid and lifecycle = 'ACTIVE' and effective_to is null
                       and effective_from = $6::timestamptz)`,
          [tenantId, legalEntityId, profileId, `{${segmentGroupIds.join(',')}}`, target.groupId, target.activeFrom],
          `reset memberships ${customer.ico}`,
        );
        const assignRows = yield* query(
          `select outcome
             from commerce_customer_context.assign_customer_group_membership(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COUNTERPARTY', $5::timestamptz, null, $6,
               $7::timestamptz, $8::uuid, $9::uuid)`,
          [
            tenantId,
            legalEntityId,
            target.groupId,
            profileId,
            target.activeFrom,
            'Výchozí segment obchodního dema',
            recordedAt,
            actorPrincipalId,
            invocationId(`membership:${customer.ico}`),
          ],
          `assign ${customer.ico}`,
        );
        const outcome = yield* single(OutcomeRowSchema, assignRows, `assign ${customer.ico}`);
        if (outcome.outcome !== 'ASSIGNED' && outcome.outcome !== 'ALREADY_ASSIGNED') {
          return yield* new SegmentSeedError({ reason: `Assign ${customer.ico}: ${outcome.outcome}` });
        }
        assigned += 1;
      }
      return { assigned, groups: groups.size };
    }),
  );
  return yield* Console.log(
    `commerce-customer-context: ${counts.groups} segments, ${counts.assigned} customers assigned to their baseline segment`,
  );
});

const command = Command.make(
  'commerce-customer-context-sales-demo-reset',
  { salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)) },
  ({ salesDemo }) =>
    salesDemo
      ? Layer.build(Layer.effectDiscard(seedSegments).pipe(Layer.provide(Reactivity.layer))).pipe(
          Effect.scoped,
          Effect.asVoid,
          Effect.tapError((failure) =>
            Console.error(`commerce-customer-context sales-demo seed failed: ${failure._tag}`, failure),
          ),
        )
      : Effect.fail(new SegmentSeedError({ reason: 'Run through `pnpm demo:reset:sales` (missing --sales-demo)' })),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
