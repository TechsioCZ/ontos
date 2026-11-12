import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Duration, Effect, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TenantAccessBootstrap } from '../../src/access/bootstrap/index.ts';
import { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import { activateCatalogRelease, releaseActorId } from '../../src/access/release/activation.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { installReleaseTenantModules, installUnderLock } from '../../src/install/release-tenant-modules.ts';
import type { ReleaseTenantModule } from '../../src/install/release-tenant-modules.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';
import {
  ownerScope,
  SCENARIO_COMPANY,
  scenarioUid,
  withProjectionTenant,
} from '../support/projection-tenant-scenario.ts';

/*
 * Release-time module installation end to end: a selling Tenant bootstrapped with "Plný přístup" on a deployment that
 * declares a tax module it has not installed. The release step installs it as the platform (state, history, the
 * Action's event and Outbox wake-up, recorded as `system`), projects the Tenant through the one Core writer, and the
 * owner's rights in the module are effective as soon as the step returns. A second release changes nothing; a state
 * a person set is never touched.
 */
const SELLING = 'billing.invoices';
const TAX = 'tax.rates';
const OTHER = 'crm.notes';
const TAX_READ = 'tax.rates.rule-set.read';
const TOPIC = 'core.modules.tenant-module-state-changed.v1';
const RUN = 'a'.repeat(64);

const entrypoint = (moduleKey: string, key: string) =>
  defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: `${moduleKey}.api.${key}`,
    moduleKey,
    role: 'api',
  });
const readOf = (key: string): AccessDeclarationInput => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'records', level: 'basic' },
  risk: 'routine',
  selectors: [],
});
const moduleOf = (moduleKey: string, key: string): AccessCatalogModule => ({
  descriptors: [{ accessDeclaration: readOf(key), entrypoint: entrypoint(moduleKey, 'read') }],
  moduleId: moduleKey,
});
/** The deployment: the selling module, the tax module, and one module the composition does not publish below. */
const deployment: readonly AccessCatalogModule[] = [
  moduleOf(SELLING, `${SELLING}.invoice.read`),
  moduleOf(TAX, TAX_READ),
  moduleOf(OTHER, `${OTHER}.note.read`),
];
const taxCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(readOf(TAX_READ), entrypoint(TAX, 'read')) };
/** The active composition publishes the selling and the tax module, not `crm.notes`. */
const catalog = makeInstalledCatalogFixture(
  makeModuleContractFixture({ appId: 'billing', moduleId: SELLING }),
  makeModuleContractFixture({ appId: 'tax', moduleId: TAX }),
);

/** The Tenant's owner bootstrapped with "Plný přístup" over the whole deployment, and projected. */
const bootstrapOwner = (tenantId: TenantId) =>
  Effect.gen(function* bootstrapTenantOwner() {
    const scope = yield* ownerScope(tenantId);
    const bootstrap = yield* TenantAccessBootstrap;
    yield* bootstrap
      .bootstrapTenantAccess({ legalEntityIds: [SCENARIO_COMPANY], modules: deployment, scope })
      .pipe(Effect.orDie);
    const writer = yield* AccessProjectionWriter;
    yield* writer.reconcileTenant({ scope }).pipe(Effect.orDie);
  });

const decide = (tenantId: TenantId) =>
  Effect.gen(function* decideTaxRead() {
    const gate = yield* AccessDecisionGate;
    const decision = yield* gate.decide({
      carrier: taxCarrier,
      legalEntityScope: 'required',
      now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z')),
      scope: yield* ownerScope(tenantId, SCENARIO_COMPANY),
    });
    return `${decision.outcome} ${decision.reasons.map(({ code }) => code).join(',')}`;
  });

const declared = (tenantId: TenantId): readonly ReleaseTenantModule[] => [
  { moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId },
  { moduleKey: OTHER, sellingModuleKeys: [], tenantId },
  { moduleKey: TAX, sellingModuleKeys: [], tenantId: scenarioUid(99) },
];

const install = (modules: readonly ReleaseTenantModule[]) =>
  installReleaseTenantModules({ catalog, modules, reconcileRetrySpacing: Duration.zero, runReference: RUN });

const HistoryRowSchema = Schema.Struct({
  action_invocation_id: Schema.Null,
  change_source: Schema.String,
  changed_by_principal_id: Schema.Null,
  module_key: Schema.String,
  new_state: Schema.String,
  previous_state: Schema.Null,
});
const historyOf = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select module_key, previous_state, new_state, change_source, changed_by_principal_id, action_invocation_id
         from core.tenant_module_state_changes where tenant_id = '${tenantId}' order by occurred_at`,
    )
    .pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HistoryRowSchema))), Effect.orDie);

/** The wake-ups the Core installation worker consumes, with their events. */
const wakeUpsOf = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select m.topic, m.producer_module_key, m.payload_json, e.subject_module_key, e.action_invocation_id
         from core.outbox_messages m join core.domain_events e
           on e.tenant_id = m.tenant_id and e.domain_event_id = m.domain_event_id
        where m.tenant_id = '${tenantId}' and m.topic = '${TOPIC}'`,
    )
    .pipe(Effect.orDie);

/** An engine whose write fails while the countdown is above zero, as a lost race or a blip would. */
const failingFirst =
  (left: Ref.Ref<number>) =>
  (engine: AccessProjectionCompilerEngine): AccessProjectionCompilerEngine => ({
    ...engine,
    reconcile: (intent, options) =>
      Ref.getAndUpdate(left, (count) => count - 1).pipe(
        Effect.flatMap((count) =>
          count > 0
            ? Effect.fail([new AccessProjectionError({ code: 'access_projection_unavailable', reason: 'engine busy' })])
            : engine.reconcile(intent, options),
        ),
      ),
  });

it.layer(NodeServices.layer)('release-time Tenant module installation', (suite) => {
  suite.effect('installs a missing module as the platform, makes it effective at once, and repeats nothing', () =>
    withProjectionTenant({ activeModules: [SELLING] }, (tenantId, admin) =>
      Effect.gen(function* installsOnce() {
        yield* bootstrapOwner(tenantId);
        // Every deploy's migrator first activates the deployed catalog: "Plný přístup" follows it, tax rights included.
        const activation = yield* activateCatalogRelease({ modules: deployment }).pipe(Effect.orDie);
        expect(activation.tenants.find((entry) => entry.tenantId === tenantId)?.outcome).not.toBe('failed');
        const before = yield* decide(tenantId);

        const first = yield* install(declared(tenantId));
        expect(first.modules.map(({ moduleKey, outcome, tenantId: id }) => [id, moduleKey, outcome])).toEqual([
          [tenantId, TAX, 'installed'],
          [tenantId, OTHER, 'not_published'],
          [scenarioUid(99), TAX, 'tenant_absent'],
        ]);
        expect(first.reconciles).toHaveLength(1);
        expect(first.reconciles[0]).toMatchObject({ tenantId });
        expect(first.reconciles[0]).not.toHaveProperty('failure');
        // Recorded exactly as a module-state change, but by the platform: no person, no Action invocation.
        expect(yield* historyOf(admin, tenantId)).toEqual([
          {
            action_invocation_id: null,
            change_source: 'system',
            changed_by_principal_id: null,
            module_key: TAX,
            new_state: 'active',
            previous_state: null,
          },
        ]);
        // The Action's wake-up, so the Core installation worker stays the durable healer of the projection.
        expect(yield* wakeUpsOf(admin, tenantId)).toEqual([
          {
            action_invocation_id: null,
            payload_json: { data: { moduleKey: TAX } },
            producer_module_key: 'core.modules',
            subject_module_key: TAX,
            topic: TOPIC,
          },
        ]);
        // The preset already holds the tax cells, but they reach the engine only for an installed module: the owner's
        // right becomes effective the moment the step returns, with no Outbox worker in between.
        expect({ after: yield* decide(tenantId), before }).toEqual({
          after: 'ALLOWED allow.granted',
          before: 'DENIED deny.insufficient_grant',
        });
        const actor = yield* admin
          .unsafe(`select kind, status from core.principals where principal_id = '${releaseActorId(tenantId)}'`)
          .pipe(Effect.orDie);
        expect(actor).toEqual([{ kind: 'system', status: 'active' }]);

        // The next release finds it active: nothing installed, nothing reconciled, no new history or wake-up.
        const second = yield* install(declared(tenantId));
        expect(second.modules[0]).toMatchObject({ moduleKey: TAX, outcome: 'already_active' });
        expect(second.reconciles).toEqual([]);
        expect(yield* historyOf(admin, tenantId)).toHaveLength(1);
        expect(yield* wakeUpsOf(admin, tenantId)).toHaveLength(1);
      }),
    ),
  );

  suite.effect('a projection that loses a race once is tried again; one that keeps failing leaves the wake-up', () =>
    Effect.gen(function* retriedProjection() {
      const left = yield* Ref.make(0);
      yield* withProjectionTenant({ activeModules: [SELLING], wrapCompiler: failingFirst(left) }, (tenantId, admin) =>
        Effect.gen(function* raceAndFailure() {
          yield* bootstrapOwner(tenantId);
          yield* Ref.set(left, 1);
          const retried = yield* install([{ moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId }]);
          expect(retried.modules[0]).toMatchObject({ outcome: 'installed' });
          expect(retried.reconciles).toHaveLength(1);
          expect(retried.reconciles[0]).not.toHaveProperty('failure');

          yield* Ref.set(left, 100);
          const failed = yield* installReleaseTenantModules({
            catalog: makeInstalledCatalogFixture(
              makeModuleContractFixture({ appId: 'billing', moduleId: SELLING }),
              makeModuleContractFixture({ appId: 'tax-extra', moduleId: 'tax.extra' }),
            ),
            modules: [{ moduleKey: 'tax.extra', sellingModuleKeys: [], tenantId }],
            reconcileRetrySpacing: Duration.zero,
            runReference: RUN,
          });
          // The install committed; the projection did not, and the run says so. The wake-up written with the install
          // is what the Core worker (with its own retries) heals the tenant from.
          expect(failed.modules[0]).toMatchObject({ outcome: 'installed' });
          expect(failed.reconciles[0]?.failure).toContain('the projection could not be reconciled');
          expect(yield* wakeUpsOf(admin, tenantId)).toHaveLength(2);
          yield* Ref.set(left, 0);
        }),
      );
    }),
  );

  suite.effect('starts nothing past its deadline, and never starts a projection it may not have time to finish', () =>
    withProjectionTenant({ activeModules: [SELLING] }, (tenantId, admin) =>
      Effect.gen(function* boundedRun() {
        yield* bootstrapOwner(tenantId);
        // The suite runs on the test clock, which starts at the epoch: that is the step's `now` as well.
        const now = DateTime.makeUnsafe(0);
        const late = yield* installReleaseTenantModules({
          catalog,
          deadline: DateTime.subtract(now, { seconds: 1 }),
          modules: declared(tenantId),
          runReference: RUN,
        });
        expect(late.modules.map(({ outcome }) => outcome)).toEqual(['deferred', 'deferred', 'deferred']);
        expect(yield* historyOf(admin, tenantId)).toEqual([]);
        // Time for the install, not for the projection: the module is installed and its projection deferred.
        const tight = yield* installReleaseTenantModules({
          catalog,
          deadline: DateTime.add(now, { seconds: 30 }),
          modules: declared(tenantId),
          runReference: RUN,
        });
        expect(tight.modules[0]).toMatchObject({ outcome: 'installed' });
        expect(tight.reconciles).toEqual([
          {
            deletions: 0,
            failure: 'deferred: too little of the release budget was left to start the projection',
            tenantId,
            touches: 0,
          },
        ]);
      }),
    ),
  );

  suite.effect('never changes a state a person set, and installs nothing where the Tenant does not sell', () =>
    withProjectionTenant({}, (tenantId, admin) =>
      Effect.gen(function* additiveOnly() {
        yield* bootstrapOwner(tenantId);
        const notSelling = yield* install([{ moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId }]);
        expect(notSelling.modules[0]).toMatchObject({ outcome: 'selling_module_missing' });
        expect(yield* historyOf(admin, tenantId)).toEqual([]);

        yield* admin
          .unsafe(
            `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
               ('${scenarioUid(7)}', '${tenantId}', '${TAX}', 'inactive')`,
          )
          .pipe(Effect.orDie);
        const left = yield* install([{ moduleKey: TAX, sellingModuleKeys: [], tenantId }]);
        expect(left.modules[0]).toMatchObject({ detail: expect.stringContaining('inactive'), outcome: 'left_as_set' });
        expect(left.reconciles).toEqual([]);
        const state = yield* admin
          .unsafe(
            `select state from core.tenant_module_states where tenant_id = '${tenantId}' and module_key = '${TAX}'`,
          )
          .pipe(Effect.orDie);
        expect(state).toEqual([{ state: 'inactive' }]);
        expect(yield* decide(tenantId)).toBe('DENIED deny.insufficient_grant');
      }),
    ),
  );

  suite.effect('decides selling under the Tenant lock, so a selling module ended since the first read is seen', () =>
    withProjectionTenant({ activeModules: [SELLING] }, (tenantId, admin) =>
      Effect.gen(function* sellingUnderLock() {
        yield* bootstrapOwner(tenantId);
        // Between the step's first read and its lock, a person ended the selling module.
        yield* admin
          .unsafe(
            `update core.tenant_module_states set state = 'inactive' where tenant_id = '${tenantId}' and module_key = '${SELLING}'`,
          )
          .pipe(Effect.orDie);
        const { executor } = yield* CoreDatabase;
        const locked = yield* executor
          .transaction((transaction) =>
            installUnderLock(transaction, { moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId }, []),
          )
          .pipe(Effect.orDie);
        expect(locked).toEqual({ _tag: 'NotSelling' });
        expect(yield* historyOf(admin, tenantId)).toEqual([]);
      }),
    ),
  );
});
