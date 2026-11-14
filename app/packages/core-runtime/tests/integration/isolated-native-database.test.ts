import { eq, sql } from 'drizzle-orm';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';

import { AuthenticationNamespaceRegistry } from '../../src/auth/external-identity/verifier.ts';
import { validateActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import { loadDatabaseIdentityConnections, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { makeLiveOperationFixture } from '../../src/testing/actions.ts';
import { makeContextAccessLive } from '../../src/permissions/context-access.ts';
import { LegalEntityRefSchema } from '../../src/resources/legal-entity.ts';
import {
  IsolatedNativeDatabaseError,
  makeIsolatedNativeDatabaseFixture,
  requireOwnedNativeDatabaseFixture,
} from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { coreRelations, tenants } from '../../src/db/schema.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import {
  FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  testDatabaseIdentityConnection,
} from '../support/database-identities.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

interface MutableOwnershipPurposeInput {
  mode: 'empty';
  purpose: 'implementation-1118-symmy-job-admission' | 'stabilization-1287-core-operation-fence';
}

// Test the cloner here, not as a repeated precondition of unrelated business scenarios.
// Structured metadata produces an object-level diff and never reads table data or trust keys.
const readSchemaCloneCatalog = Effect.fn('SchemaCloneTests.readCatalog')(function* readCatalog(
  connectionString: string,
) {
  const client = yield* makeTestPgClient(connectionString);
  const database = yield* makeTestDatabaseFromClient(client, coreRelations);
  return yield* database.transaction(
    Effect.fn('SchemaCloneTests.catalogSnapshot')(function* catalogSnapshot(transaction) {
      yield* transaction.execute(sql`select set_config('search_path','pg_catalog',true)`, 'objects');
      const [row] = yield* transaction.execute<{ readonly catalog: unknown }>(
        sql`
select json_build_object(
  'relations', (select json_agg(row_to_json(r) order by r.schema, r.name) from (
    select n.nspname as schema, c.relname as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      array(select a::text from unnest(coalesce(c.relacl,acldefault((case when c.relkind='S' then 's' else 'r' end)::"char",c.relowner))) a order by a::text)::text as acl,pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
      and c.relkind in ('r','p','v','m','S')
  ) r),
  'policies', (select json_agg(row_to_json(p) order by p.schemaname,p.tablename,p.policyname)
    from pg_policies p where p.schemaname not in ('pg_catalog','information_schema')),
  'constraints', (select json_agg(row_to_json(k) order by k.schema,k.table_name,k.name) from (
    select n.nspname as schema,c.relname as table_name,k.conname as name,pg_get_constraintdef(k.oid,true) as definition
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
  ) k),
  'functions', (select json_agg(row_to_json(f) order by f.schema,f.name,f.arguments) from (
    select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as definition,array(select a::text from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a order by a::text)::text as acl,pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
  ) f)
) as catalog`,
        'objects',
      );
      if (row === undefined) {
        return yield* Effect.die('The clone integration test could not read its schema catalog');
      }
      return row.catalog;
    }),
  );
});

it.layer(nativeServices, { excludeTestServices: true })('isolated native database', (suite) => {
  suite.effect('accepts only the exact live owned clone and refuses forged, changed or expired ownership', () =>
    Effect.gen(function* ownedFixtureLease() {
      const closed = yield* Effect.scoped(
        Effect.gen(function* verifyLiveOwnedFixture() {
          const fixtureInput: MutableOwnershipPurposeInput = {
            mode: 'empty',
            purpose: 'implementation-1118-symmy-job-admission',
          };
          const fixture = yield* makeIsolatedNativeDatabaseFixture(fixtureInput);
          const expected = {
            adminConnectionString: Redacted.make(fixture.connections.admin.connectionString),
            purpose: 'implementation-1118-symmy-job-admission' as const,
            runtimeConnectionString: Redacted.make(fixture.connections.runtime.connectionString),
          };
          yield* requireOwnedNativeDatabaseFixture(fixture, expected);
          fixtureInput.purpose = 'stabilization-1287-core-operation-fence';
          expect(
            Exit.isFailure(
              yield* requireOwnedNativeDatabaseFixture(fixture, {
                ...expected,
                purpose: fixtureInput.purpose,
              }).pipe(Effect.exit),
            ),
          ).toBe(true);
          yield* requireOwnedNativeDatabaseFixture(fixture, expected);
          fixtureInput.purpose = 'implementation-1118-symmy-job-admission';
          const copiedLease = { connections: fixture.connections };
          Object.defineProperties(copiedLease, Object.getOwnPropertyDescriptors(fixture));
          const forgedLease = { connections: fixture.connections };
          Object.defineProperty(forgedLease, 'ownedNativeDatabaseLease', { value: 'forged' });
          const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const refusals = [
            requireOwnedNativeDatabaseFixture({ connections: fixture.connections }, expected),
            requireOwnedNativeDatabaseFixture({ ...fixture }, expected),
            requireOwnedNativeDatabaseFixture(copiedLease, expected),
            requireOwnedNativeDatabaseFixture(forgedLease, expected),
            requireOwnedNativeDatabaseFixture(fixture, {
              ...expected,
              adminConnectionString: Redacted.make(source.admin.connectionString),
            }),
            requireOwnedNativeDatabaseFixture(fixture, {
              ...expected,
              runtimeConnectionString: expected.adminConnectionString,
            }),
            requireOwnedNativeDatabaseFixture(fixture, {
              ...expected,
              purpose: 'implementation-1126-group-definition',
            }),
          ];
          for (const attempt of refusals) {
            expect(Exit.isFailure(yield* Effect.exit(attempt))).toBe(true);
          }
          const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const database = sql.identifier(fixture.connections.admin.database);
          const originalOwner = sql.identifier(fixture.connections.admin.user);
          const changedOwner = sql.identifier(fixture.connections.runtime.user);
          const databaseClient = yield* makeTestDatabaseFromClient(admin, coreRelations);
          yield* databaseClient.execute(sql`alter database ${database} owner to ${changedOwner}`, 'objects');
          yield* Effect.gen(function* rejectsChangedDatabaseOwner() {
            expect(Exit.isFailure(yield* requireOwnedNativeDatabaseFixture(fixture, expected).pipe(Effect.exit))).toBe(
              true,
            );
          }).pipe(
            Effect.ensuring(
              databaseClient
                .execute(sql`alter database ${database} owner to ${originalOwner}`, 'objects')
                .pipe(Effect.orDie),
            ),
          );
          yield* requireOwnedNativeDatabaseFixture(fixture, expected);
          return { expected, fixture };
        }),
      );
      expect(
        Exit.isFailure(yield* requireOwnedNativeDatabaseFixture(closed.fixture, closed.expected).pipe(Effect.exit)),
      ).toBe(true);
    }),
  );

  suite.effect(
    'TEST-1258 retains original proof across real replacement and refuses controls or a closed scope',
    () =>
      Effect.gen(function* retainedReplacement() {
        const observeAfterClose = yield* Effect.scoped(
          Effect.gen(function* liveReplacement() {
            const fixture = yield* makeIsolatedNativeDatabaseFixture({
              mode: 'empty',
              purpose: 'stabilization-1258-privacy-drain',
            });
            expect(Exit.isFailure(yield* fixture.composition.observeRetainedOriginal().pipe(Effect.exit))).toBe(true);
            yield* fixture.migrateCoreSchema();
            const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1258-old');
            const next = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1258-current');
            const replacement = yield* validateActiveApplicationCompositionSnapshot({
              ...next,
              observedAt: DateTime.add(initial.observedAt, { milliseconds: 1 }),
              validUntil: DateTime.add(initial.validUntil, { milliseconds: 1000 }),
            });
            yield* fixture.publishInitialComposition(initial);
            const retainedRenewal = yield* fixture.composition.renewObservation(initial).pipe(Effect.flip);
            expect(retainedRenewal.reason).toBe(
              'Observation renewal requires a live owned non-retained test controller',
            );
            const before = yield* fixture.composition.observeRetainedOriginal();
            expect(before.originalRevision).toBe(initial.composition.revision);
            expect(before.currentRevision).toBe(initial.composition.revision);
            expect(before.unexpired).toBe(true);
            yield* fixture.composition.closeAdmission();
            yield* fixture.composition.drain();
            const attempts = yield* Effect.all(
              [
                fixture.composition.publishReplacement(replacement).pipe(Effect.exit),
                fixture.composition.publishReplacement(replacement).pipe(Effect.exit),
              ],
              { concurrency: 2 },
            );
            expect(attempts.filter(Exit.isSuccess)).toHaveLength(1);
            expect(attempts.filter(Exit.isFailure)).toHaveLength(1);
            const retained = yield* fixture.composition.observeRetainedOriginal();
            expect(retained).toEqual({
              currentRevision: replacement.composition.revision,
              durableWorkAdmission: 'closed',
              hasMoreDurableWork: false,
              observedAtEpochMilliseconds: retained.observedAtEpochMilliseconds,
              originalRevision: initial.composition.revision,
              pendingDurableWork: [],
              phase: 'draining',
              unexpired: true,
              validUntilEpochMilliseconds: DateTime.toEpochMillis(initial.validUntil),
            });
            expect(retained.observedAtEpochMilliseconds).toBeGreaterThanOrEqual(before.observedAtEpochMilliseconds);
            expect(Object.isFrozen(retained)).toBe(true);
            expect(Object.isFrozen(retained.pendingDurableWork)).toBe(true);
            for (const operation of [
              fixture.composition.observe,
              fixture.composition.closeAdmission,
              fixture.composition.drain,
              fixture.composition.seal,
              () => fixture.composition.publishReplacement(replacement),
            ]) {
              expect(Exit.isFailure(yield* operation().pipe(Effect.exit))).toBe(true);
            }
            return fixture.composition.observeRetainedOriginal;
          }),
        );
        expect(Exit.isFailure(yield* observeAfterClose().pipe(Effect.exit))).toBe(true);
      }),
    30_000,
  );
  suite.effect(
    'TEST-1258 observes real elapsed original expiry and bounded original durable debt without reopening controls',
    () =>
      Effect.scoped(
        Effect.gen(function* retainedExpiry() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1258-privacy-drain',
          });
          yield* fixture.migrateCoreSchema();
          const candidate = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1258-expiry');
          const initial = yield* validateActiveApplicationCompositionSnapshot({
            ...candidate,
            validUntil: DateTime.add(candidate.observedAt, { seconds: 21 }),
          });
          yield* fixture.publishInitialComposition(initial);
          const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          // Supported native debt producer while admission is open; no raw row insertion or completion/ACK.
          for (let index = 0; index < 26; index += 1) {
            const workId = `retained-${String(index).padStart(2, '0')}`;
            yield* admin`select core.track_application_composition_durable_work('owner.fixture',${initial.composition.revision},${workId},true)`;
          }
          yield* fixture.composition.closeAdmission();
          expect(Exit.isFailure(yield* fixture.composition.drain().pipe(Effect.exit))).toBe(true);
          const before = yield* fixture.composition.observeRetainedOriginal();
          expect(before.unexpired).toBe(true);
          expect(before.pendingDurableWork).toHaveLength(25);
          expect(before.hasMoreDurableWork).toBe(true);
          expect(before.pendingDurableWork.every((row) => row.originalRevision === initial.composition.revision)).toBe(
            true,
          );
          expect(before.pendingDurableWork[0]?.workId).toBe('retained-00');
          expect(before.pendingDurableWork[24]?.workId).toBe('retained-24');
          // excludeTestServices keeps this a real elapsed wait; retry-clock advance is not PostgreSQL expiry.
          yield* Effect.sleep('21 seconds');
          const expired = yield* fixture.composition.observeRetainedOriginal();
          expect(expired.unexpired).toBe(false);
          expect(expired.observedAtEpochMilliseconds).toBeGreaterThanOrEqual(expired.validUntilEpochMilliseconds);
          expect(expired.validUntilEpochMilliseconds).toBe(DateTime.toEpochMillis(initial.validUntil));
          expect(expired.originalRevision).toBe(initial.composition.revision);
          expect(expired.currentRevision).toBe(initial.composition.revision);
          expect(expired.phase).toBe(before.phase);
          expect(expired.durableWorkAdmission).toBe('closed');
          expect(expired.pendingDurableWork).toEqual(before.pendingDurableWork);
          expect(expired.hasMoreDurableWork).toBe(true);
          for (const operation of [
            fixture.composition.observe,
            fixture.composition.closeAdmission,
            fixture.composition.drain,
            fixture.composition.seal,
          ]) {
            expect(Exit.isFailure(yield* operation().pipe(Effect.exit))).toBe(true);
          }
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(candidate).pipe(Effect.exit))).toBe(true);
          expect((yield* fixture.composition.observeRetainedOriginal()).pendingDurableWork).toEqual(
            before.pendingDurableWork,
          );
        }),
      ),
    60_000,
  );
  suite.effect(
    'TEST-1258 failed open-admission replacement is consumed while readonly original observation remains available',
    () =>
      Effect.scoped(
        Effect.gen(function* failedRetainedReplacement() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1258-privacy-drain',
          });
          yield* fixture.migrateCoreSchema();
          const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1258-hold');
          yield* fixture.publishInitialComposition(initial);
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(initial).pipe(Effect.exit))).toBe(true);
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(initial).pipe(Effect.exit))).toBe(true);
          expect(Exit.isFailure(yield* fixture.composition.closeAdmission().pipe(Effect.exit))).toBe(true);
          const observed = yield* fixture.composition.observeRetainedOriginal();
          expect(observed.originalRevision).toBe(initial.composition.revision);
          expect(observed.currentRevision).toBe(initial.composition.revision);
          expect(observed.phase).toBe('active');
          expect(observed.durableWorkAdmission).toBe('open');
        }),
      ),
    30_000,
  );
  suite.effect(
    'refuses retained observation for the existing TEST-1271 replacement purpose',
    () =>
      Effect.scoped(
        Effect.gen(function* retainedPurposeDenied() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1271-exact-obligation-deadline',
          });
          yield* fixture.migrateCoreSchema();
          const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-observer-denied');
          yield* fixture.publishInitialComposition(initial);
          expect(Exit.isFailure(yield* fixture.composition.observeRetainedOriginal().pipe(Effect.exit))).toBe(true);
          expect((yield* fixture.composition.observe()).revision).toBe(initial.composition.revision);
        }),
      ),
    30_000,
  );
  suite.effect(
    'publishes one exact drained replacement without retargeting the initial controller',
    () =>
      Effect.scoped(
        Effect.gen(function* dedicatedReplacement() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1271-exact-obligation-deadline',
          });
          yield* fixture.migrateCoreSchema();
          const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-old');
          const next = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-current');
          const replacement = yield* validateActiveApplicationCompositionSnapshot({
            ...next,
            observedAt: DateTime.add(initial.observedAt, { milliseconds: 1 }),
            validUntil: DateTime.add(initial.validUntil, { milliseconds: 1000 }),
          });
          yield* fixture.publishInitialComposition(initial);
          yield* fixture.composition.closeAdmission();
          yield* fixture.composition.drain();
          const concurrent = yield* Effect.all(
            [
              fixture.composition.publishReplacement(replacement).pipe(Effect.exit),
              fixture.composition.publishReplacement(replacement).pipe(Effect.exit),
            ],
            { concurrency: 2 },
          );
          const successes = concurrent.filter(Exit.isSuccess);
          expect(successes).toHaveLength(1);
          expect(concurrent.filter(Exit.isFailure)).toHaveLength(1);
          expect(successes[0]?.value).toEqual({
            durableWorkAdmission: 'open',
            phase: 'active',
            revision: replacement.composition.revision,
          });
          for (const operation of [
            fixture.composition.closeAdmission,
            fixture.composition.drain,
            fixture.composition.observe,
            fixture.composition.seal,
            () => fixture.composition.publishReplacement(replacement),
          ]) {
            expect(Exit.isFailure(yield* operation().pipe(Effect.exit))).toBe(true);
          }
          const isolated = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const [current] = yield* isolated<{
            readonly phase: string;
            readonly revision: string;
          }>`select revision,phase from core.application_composition_authority`;
          expect(current).toEqual({ phase: 'active', revision: replacement.composition.revision });
        }),
      ),
    30_000,
  );
  suite.effect(
    'holds a failed replacement closed instead of retrying or changing the initial authority',
    () =>
      Effect.scoped(
        Effect.gen(function* replacementHold() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1271-exact-obligation-deadline',
          });
          yield* fixture.migrateCoreSchema();
          const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-old');
          const next = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-current');
          const replacement = yield* validateActiveApplicationCompositionSnapshot({
            ...next,
            observedAt: DateTime.add(initial.observedAt, { milliseconds: 1 }),
            validUntil: DateTime.add(initial.validUntil, { milliseconds: 1000 }),
          });
          yield* fixture.publishInitialComposition(initial);
          // Actual open admission is rejected by the native guarded transition; this consumes the one shot.
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(replacement).pipe(Effect.exit))).toBe(
            true,
          );
          expect(Exit.isFailure(yield* fixture.composition.closeAdmission().pipe(Effect.exit))).toBe(true);
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(replacement).pipe(Effect.exit))).toBe(
            true,
          );
          const isolated = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const [current] = yield* isolated<{
            readonly phase: string;
            readonly revision: string;
          }>`select revision,phase from core.application_composition_authority`;
          expect(current).toEqual({ phase: 'active', revision: initial.composition.revision });
        }),
      ),
    30_000,
  );
  suite.effect(
    'rejects non-newer and unchanged replacement candidates without changing native authority',
    () =>
      Effect.scoped(
        Effect.gen(function* narrowingReplacement() {
          for (const unchanged of [true, false]) {
            yield* Effect.scoped(
              Effect.gen(function* oneInvalidCandidate() {
                const fixture = yield* makeIsolatedNativeDatabaseFixture({
                  mode: 'empty',
                  purpose: 'stabilization-1271-exact-obligation-deadline',
                });
                yield* fixture.migrateCoreSchema();
                const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-old');
                const next = unchanged
                  ? initial
                  : yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-current');
                const candidate = yield* validateActiveApplicationCompositionSnapshot({
                  ...next,
                  observedAt: unchanged ? DateTime.add(initial.observedAt, { milliseconds: 1 }) : initial.observedAt,
                  validUntil: DateTime.add(initial.validUntil, { milliseconds: 1000 }),
                });
                yield* fixture.publishInitialComposition(initial);
                yield* fixture.composition.closeAdmission();
                yield* fixture.composition.drain();
                expect(Exit.isFailure(yield* fixture.composition.publishReplacement(candidate).pipe(Effect.exit))).toBe(
                  true,
                );
                const isolated = yield* makeTestPgClient(fixture.connections.admin.connectionString);
                const [authority] = yield* isolated<{
                  readonly phase: string;
                  readonly revision: string;
                }>`select revision,phase from core.application_composition_authority`;
                expect(authority).toEqual({ phase: 'draining', revision: initial.composition.revision });
              }),
            );
          }
        }),
      ),
    30_000,
  );
  suite.effect(
    'rejects late native debt fault injection after drain and holds the original authority',
    () =>
      Effect.scoped(
        Effect.gen(function* lateDebtFaultInjection() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1271-exact-obligation-deadline',
          });
          yield* fixture.migrateCoreSchema();
          const initial = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-old');
          const next = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-1271-current');
          const candidate = yield* validateActiveApplicationCompositionSnapshot({
            ...next,
            observedAt: DateTime.add(initial.observedAt, { milliseconds: 1 }),
            validUntil: DateTime.add(initial.validUntil, { milliseconds: 1000 }),
          });
          yield* fixture.publishInitialComposition(initial);
          yield* fixture.composition.closeAdmission();
          yield* fixture.composition.drain();
          const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const { revision } = initial.composition;
          // The real producer correctly refuses NEW work after closure. This negative backstop then
          // injects only a constrained Core debt row, never a business authority/proof or completion.
          expect(
            Exit.isFailure(
              yield* admin`select core.track_application_composition_durable_work('owner.fixture',${revision},'late-work',true)`.pipe(
                Effect.exit,
              ),
            ),
          ).toBe(true);
          yield* admin`insert into core.application_composition_durable_work(owner_module_key,original_revision,work_id) values('owner.fixture',${revision},'fault-injected-debt')`;
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(candidate).pipe(Effect.exit))).toBe(true);
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(candidate).pipe(Effect.exit))).toBe(true);
          const [authority] = yield* admin<{
            readonly phase: string;
            readonly revision: string;
          }>`select revision,phase from core.application_composition_authority`;
          expect(authority).toEqual({ phase: 'draining', revision });
          const [debt] = yield* admin<{
            readonly count: number;
          }>`select count(*)::int as count from core.application_composition_durable_work where original_revision=${revision} and work_id='fault-injected-debt'`;
          expect(debt?.count).toBe(1);
        }),
      ),
    30_000,
  );
  suite.effect('rejects a deployed environment before database or process I/O', () =>
    Effect.scoped(
      Effect.gen(function* deployedEnvironmentGuard() {
        const context = yield* Layer.build(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' })),
        );
        const failure = yield* Effect.flip(
          makeIsolatedNativeDatabaseFixture({
            mode: 'empty',
            purpose: 'stabilization-1281-party-legacy',
          }).pipe(Effect.provideContext(context)),
        );
        expect(Predicate.isTagged(failure, 'IsolatedNativeDatabaseError')).toBe(true);
      }),
    ),
  );
  suite.effect('initializes clone-local trust without copying source secrets, grants or business data', () =>
    Effect.gen(function* cloneLocalTrust() {
      const configuredSource = yield* loadDatabaseConnectionPair();
      const sourceFixture = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'stabilization-1281-party-legacy',
        sourceConnections: configuredSource,
      });
      yield* sourceFixture.migrateCoreSchema();
      const sourceConnections = sourceFixture.connections;
      const source = yield* makeTestPgClient(sourceConnections.admin.connectionString);
      const sourceDatabase = yield* makeTestDatabaseFromClient(source, coreRelations);
      const sourceTenantId = '22222222-2222-4222-8222-222222222222';
      yield* sourceDatabase.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Source only tenant',
        slug: 'source-only-tenant',
        status: 'active',
        tenantId: sourceTenantId,
      });
      // Deliberately noncanonical enrollment and an unredeemable grant belong only to this
      // disposable source. Neither may be copied or removed by cloning.
      yield* source`insert into trust.gateway_audience_roles (audience,role_name) values ('source-only','source_only_role')`;
      yield* source`insert into trust.gateway_scope_grants
        (assertion_digest,audience,jti,principal_id,tenant_id,expires_at,registered_at,registered_by)
        values (sha256(convert_to('source-only-assertion','UTF8')),'source-only',
          '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
          ${sourceTenantId}::uuid,statement_timestamp()+interval '5 minutes',statement_timestamp(),session_user)`;
      // Only fingerprints leave the source database, never sealing material or grant contents.
      const sourceState = source<{ readonly fingerprint: string }>`select pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(json_build_array(
          (select json_agg(k order by key_id) from trust.scope_sealing_keys k),
          (select json_agg(a order by audience) from trust.gateway_audience_roles a),
          (select json_agg(g order by assertion_digest) from trust.gateway_scope_grants g),
          (select json_agg(t order by tenant_id) from core.tenants t),
          (select json_agg(p order by principal_id) from core.principals p)
        )::text, 'UTF8')), 'hex') as fingerprint`;
      const before = yield* sourceState;
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['party-registry'], 'clone-local-trust');
      const signatures: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        yield* Effect.scoped(
          Effect.gen(function* independentClone() {
            const fixture = yield* makeIsolatedNativeDatabaseFixture({
              compositionSnapshot: snapshot,
              // The clone mirrors exactly the enrollment it is given, never the source's noncanonical rows.
              databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
              mode: 'schema-only',
              purpose: 'stabilization-1267-party-gateway',
              sourceConnections,
            });
            const clone = yield* makeTestPgClient(fixture.connections.admin.connectionString);
            const [key] = yield* clone<{ readonly count: number; readonly valid: boolean }>`select
              count(*)::int as count, bool_and(key_id=1 and length(inner_pad)=64 and length(outer_pad)=64) as valid
              from trust.scope_sealing_keys`;
            expect(key).toEqual({ count: 1, valid: true });
            expect(yield* clone`select audience,role_name from trust.gateway_audience_roles order by audience`).toEqual(
              [{ audience: 'party-registry', role_name: 'party_registry_runtime' }],
            );
            const [empty] = yield* clone<{
              readonly grants: number;
              readonly principals: number;
              readonly tenants: number;
            }>`select
              (select count(*)::int from trust.gateway_scope_grants) as grants,
              (select count(*)::int from core.principals) as principals,
              (select count(*)::int from core.tenants) as tenants`;
            expect(empty).toEqual({ grants: 0, principals: 0, tenants: 0 });
            const [signature] = yield* clone<{
              readonly mac: string;
            }>`select trust.scope_mac('clone-independence') as mac`;
            expect(signature?.mac).toMatch(/^[a-f0-9]{64}$/u);
            if (signature !== undefined) {
              signatures.push(signature.mac);
            }
            // Sign an otherwise valid clone transaction payload with the source key. The clone
            // must reject that seal, while accepting its own signature for the same payload.
            for (const foreignKey of [false, true]) {
              const result = yield* clone
                .withTransaction(
                  Effect.gen(function* verifyCloneSeal() {
                    const tenantId = '11111111-1111-4111-8111-111111111111';
                    const [payload] = yield* clone<{ readonly payload: string }>`select trust.scope_payload(
                  pg_current_xact_id(),clock_timestamp()+interval '1 minute',${tenantId}::uuid,null) as payload`;
                    if (payload === undefined) {
                      return yield* Effect.die('Native trust payload is missing');
                    }
                    const signer = foreignKey ? source : clone;
                    const [signed] = yield* signer<{
                      readonly mac: string;
                    }>`select trust.scope_mac(${payload.payload}) as mac`;
                    const seal = `${payload.payload}|${signed?.mac}`;
                    yield* clone`select set_config('ontos_trust.scope',${seal},true)`;
                    const [verified] = yield* clone<{
                      readonly tenant: string;
                    }>`select trust.current_tenant_id() as tenant`;
                    expect(verified?.tenant).toBe(tenantId);
                    return yield* Effect.void;
                  }),
                )
                .pipe(Effect.exit);
              if (foreignKey) {
                expect(Exit.isFailure(result)).toBe(true);
                if (Exit.isFailure(result)) {
                  expect(Option.map(findPostgresFailure(result.cause), ({ code }) => code)).toEqual(
                    Option.some('42501'),
                  );
                }
              } else {
                expect(Exit.isSuccess(result)).toBe(true);
              }
            }
            expect(yield* readSchemaCloneCatalog(fixture.connections.admin.connectionString)).toEqual(
              yield* readSchemaCloneCatalog(sourceConnections.admin.connectionString),
            );
          }),
        );
      }
      expect(signatures).toHaveLength(2);
      expect(signatures[0]).not.toBe(signatures[1]);
      const [sourceSignature] = yield* source<{
        readonly mac: string;
      }>`select trust.scope_mac('clone-independence') as mac`;
      expect(signatures).not.toContain(sourceSignature?.mac);
      expect(yield* sourceState).toEqual(before);
    }),
  );

  suite.effect('supports schema-only clones of older databases without trust', () =>
    Effect.gen(function* olderTrustlessSchema() {
      const sourceConnections = yield* loadDatabaseConnectionPair();
      const legacy = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'stabilization-1281-party-legacy',
        sourceConnections,
      });
      yield* legacy.migrateCoreSchema();
      const admin = yield* makeTestPgClient(legacy.connections.admin.connectionString);
      yield* admin`drop schema trust cascade`;
      const fixture = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: yield* makeApplicationCompositionSnapshotFixture([], 'legacy-without-trust'),
        mode: 'schema-only',
        purpose: 'stabilization-1267-party-gateway',
        sourceConnections: legacy.connections,
      });
      expect(yield* readSchemaCloneCatalog(fixture.connections.admin.connectionString)).toEqual(
        yield* readSchemaCloneCatalog(legacy.connections.admin.connectionString),
      );
      const clone = yield* makeTestPgClient(fixture.connections.admin.connectionString);
      expect(yield* clone`select exists(select 1 from pg_namespace where nspname='trust') as present`).toEqual([
        { present: false },
      ]);
    }),
  );

  suite.effect('clones only schema into an owned database and preserves source authority and history', () =>
    Effect.gen(function* cloneSchemaOnly() {
      const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const sourceCatalog = yield* readSchemaCloneCatalog(source.admin.connectionString);
      const client = yield* makeTestPgClient(source.admin.connectionString);
      const baseline = yield* client<{
        readonly phase: string;
        readonly revision: string;
      }>`select revision,phase from core.application_composition_authority order by authority_key`;
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['party-registry'], 'isolated-test-build');
      const databaseName = yield* Effect.scoped(
        Effect.gen(function* exerciseIsolatedDatabase() {
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            compositionSnapshot: snapshot,
            mode: 'schema-only',
            purpose: 'stabilization-1267-party-gateway',
          });
          expect(fixture.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
          expect(fixture.connections.admin.database).not.toBe(source.admin.database);
          const isolated = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const cloneCatalog = readSchemaCloneCatalog(fixture.connections.admin.connectionString);
          expect(yield* cloneCatalog).toEqual(sourceCatalog);
          const [authority] = yield* isolated<{
            readonly revision: string;
          }>`select revision from core.application_composition_authority`;
          expect(authority?.revision).toBe(snapshot.composition.revision);
          const [tenantCount] = yield* isolated<{
            readonly count: number;
          }>`select count(*)::int as count from core.tenants`;
          expect(tenantCount?.count).toBe(0);
          expect(Exit.isFailure(yield* fixture.composition.publishReplacement(snapshot).pipe(Effect.exit))).toBe(true);
          const failure = yield* Effect.flip(fixture.publishInitialComposition(snapshot));
          expect(Predicate.isTagged(failure, 'IsolatedNativeDatabaseError')).toBe(true);
          const admin = yield* makeTestDatabaseFromClient(isolated, coreRelations);
          const role = sql.identifier(fixture.connections.runtime.user);
          yield* admin.execute(sql`revoke select on table core.tenants from ${role}`, 'objects');
          expect(yield* cloneCatalog).not.toEqual(sourceCatalog);
          yield* admin.execute(sql`grant select on table core.tenants to ${role}`, 'objects');
          expect(yield* cloneCatalog).toEqual(sourceCatalog);
          const [sequence] = yield* isolated<{
            readonly name: string;
            readonly schema: string;
            readonly usage: boolean;
          }>`select c.relname as name,n.nspname as schema,
              has_sequence_privilege(${fixture.connections.runtime.user},c.oid,'USAGE') as usage
            from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where c.relkind='S' and n.nspname not in ('pg_catalog','information_schema')
            order by n.nspname,c.relname limit 1`;
          expect(sequence).toBeDefined();
          if (sequence === undefined) {
            return yield* Effect.die('The native schema must contain a migration journal sequence');
          }
          const sequenceName = sql`${sql.identifier(sequence.schema)}.${sql.identifier(sequence.name)}`;
          yield* admin.execute(
            sequence.usage
              ? sql`revoke usage on sequence ${sequenceName} from ${role}`
              : sql`grant usage on sequence ${sequenceName} to ${role}`,
            'objects',
          );
          expect(yield* cloneCatalog).not.toEqual(sourceCatalog);
          yield* admin.execute(
            sequence.usage
              ? sql`grant usage on sequence ${sequenceName} to ${role}`
              : sql`revoke usage on sequence ${sequenceName} from ${role}`,
            'objects',
          );
          expect(yield* cloneCatalog).toEqual(sourceCatalog);
          yield* admin.execute(
            sql`alter table core.tenants add constraint isolated_test_name_limit check (char_length(name) < 2000)`,
            'objects',
          );
          expect(yield* cloneCatalog).not.toEqual(sourceCatalog);
          return fixture.connections.admin.database;
        }),
      );
      const [exists] = yield* client<{
        readonly exists: boolean;
      }>`select exists(select 1 from pg_database where datname=${databaseName}) as exists`;
      expect(exists?.exists).toBe(false);
      expect(yield* readSchemaCloneCatalog(source.admin.connectionString)).toEqual(sourceCatalog);
      expect(
        yield* client<{
          readonly phase: string;
          readonly revision: string;
        }>`select revision,phase from core.application_composition_authority order by authority_key`,
      ).toEqual(baseline);
    }),
  );
  suite.effect(
    'binds closed composition controls to only its created database and successfully published initial revision',
    () =>
      Effect.gen(function* boundCompositionController() {
        const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const sourceClient = yield* makeTestPgClient(source.admin.connectionString);
        const before = yield* sourceClient<{
          readonly phase: string;
          readonly revision: string;
        }>`select phase,revision from core.application_composition_authority order by authority_key`;
        const fixture = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1258-privacy-drain',
        });
        yield* fixture.migrateCoreSchema();
        for (const operation of [
          fixture.composition.closeAdmission,
          fixture.composition.observe,
          fixture.composition.drain,
          fixture.composition.seal,
        ]) {
          expect(Exit.isFailure(yield* operation().pipe(Effect.exit))).toBe(true);
        }
        const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'bound-controller');
        yield* fixture.publishInitialComposition(snapshot);
        expect(Object.isFrozen(fixture.composition)).toBe(true);
        expect(Object.keys(fixture.composition).toSorted()).toEqual([
          'closeAdmission',
          'drain',
          'observe',
          'observeRetainedOriginal',
          'publishReplacement',
          'renewObservation',
          'seal',
        ]);
        expect(yield* fixture.composition.observe()).toEqual({
          durableWorkAdmission: 'open',
          hasMoreDurableWork: false,
          pendingDurableWork: [],
          phase: 'active',
          revision: snapshot.composition.revision,
        });
        expect(Exit.isFailure(yield* fixture.composition.seal().pipe(Effect.exit))).toBe(true);
        yield* fixture.composition.closeAdmission();
        expect((yield* fixture.composition.observe()).durableWorkAdmission).toBe('closed');
        yield* fixture.composition.drain();
        expect((yield* fixture.composition.observe()).phase).toBe('draining');
        yield* fixture.composition.seal();
        expect((yield* fixture.composition.observe()).phase).toBe('sealed');
        // An attempted TEST-1258 replacement consumes this controller, even on refusal.
        // Dedicated replacement tests above cover active candidate refusals; finish
        // this controller's normal lifecycle before probing its terminal refusal.
        expect(Exit.isFailure(yield* fixture.composition.publishReplacement(snapshot).pipe(Effect.exit))).toBe(true);
        expect(
          yield* sourceClient<{
            readonly phase: string;
            readonly revision: string;
          }>`select phase,revision from core.application_composition_authority order by authority_key`,
        ).toEqual(before);
      }),
  );

  suite.effect(
    'bounds debt observations and uses native debt checks before draining or sealing the created composition',
    () =>
      Effect.gen(function* boundedCompositionDebt() {
        const fixture = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1258-privacy-drain',
        });
        yield* fixture.migrateCoreSchema();
        const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'bounded-controller');
        yield* fixture.publishInitialComposition(snapshot);
        const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
        const { revision } = snapshot.composition;
        for (let index = 0; index < 26; index += 1) {
          const workId = `work-${index.toString().padStart(2, '0')}`;
          yield* admin`select core.track_application_composition_durable_work('owner.fixture',${revision},${workId},true)`;
        }
        const observed = yield* fixture.composition.observe();
        expect(observed.pendingDurableWork).toHaveLength(25);
        expect(observed.hasMoreDurableWork).toBe(true);
        expect(observed.pendingDurableWork[0]).toEqual({
          originalRevision: revision,
          ownerModuleKey: 'owner.fixture',
          workId: 'work-00',
        });
        expect(Object.isFrozen(observed.pendingDurableWork)).toBe(true);
        yield* fixture.composition.closeAdmission();
        expect(Exit.isFailure(yield* fixture.composition.drain().pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* fixture.composition.seal().pipe(Effect.exit))).toBe(true);
        for (let index = 0; index < 26; index += 1) {
          const workId = `work-${index.toString().padStart(2, '0')}`;
          yield* admin`select core.track_application_composition_durable_work('owner.fixture',${revision},${workId},false)`;
        }
        expect((yield* fixture.composition.observe()).pendingDurableWork).toEqual([]);
        expect((yield* fixture.composition.observe()).hasMoreDurableWork).toBe(false);
        yield* fixture.composition.drain();
        yield* fixture.composition.seal();
      }),
  );

  suite.effect('rejects a foreign native authority instead of operating on a replacement revision', () =>
    Effect.gen(function* foreignCompositionController() {
      const fixture = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'stabilization-1258-privacy-drain',
      });
      yield* fixture.migrateCoreSchema();
      yield* fixture.publishInitialComposition(
        yield* makeApplicationCompositionSnapshotFixture([], 'foreign-controller'),
      );
      const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
      const foreignRevision = 'f'.repeat(64);
      yield* admin`update core.application_composition_authority set revision=${foreignRevision}`;
      for (const operation of [
        fixture.composition.closeAdmission,
        fixture.composition.observe,
        fixture.composition.drain,
        fixture.composition.seal,
      ]) {
        const failure = yield* operation().pipe(Effect.exit);
        expect(Exit.isFailure(failure)).toBe(true);
      }
      const [authority] = yield* admin<{
        readonly admission: string;
        readonly phase: string;
        readonly revision: string;
      }>`select durable_work_admission as admission,phase,revision from core.application_composition_authority`;
      expect(authority).toEqual({ admission: 'open', phase: 'active', revision: foreignRevision });
    }),
  );

  suite.effect('creates an empty owned database for immutable migration compatibility without copying data', () =>
    Effect.gen(function* emptyDatabase() {
      const fixture = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'stabilization-1281-party-legacy',
      });
      const runtime = yield* makeTestPgClient(fixture.connections.runtime.connectionString);
      const [tables] = yield* runtime<{
        readonly count: number;
      }>`select count(*)::int as count from pg_tables where schemaname not in ('pg_catalog','information_schema')`;
      expect(tables?.count).toBe(0);
      yield* fixture.migrateCoreSchema();
      yield* fixture.migrateCoreSchema();
      const [coreTables] = yield* runtime<{
        readonly count: number;
      }>`select count(*)::int as count from pg_tables where schemaname='core'`;
      expect(coreTables?.count).toBeGreaterThan(0);
      const [role] = yield* runtime<{
        readonly bypass: boolean;
        readonly superuser: boolean;
      }>`select rolbypassrls as bypass,rolsuper as superuser from pg_roles where rolname=current_user`;
      expect(role).toEqual({ bypass: false, superuser: false });
      const [privileges] = yield* runtime<{
        readonly authoritySelect: boolean;
        readonly authorityWrite: boolean;
        readonly delete: boolean;
        readonly durableSelect: boolean;
        readonly durableWrite: boolean;
        readonly insert: boolean;
        readonly select: boolean;
        readonly track: boolean;
        readonly update: boolean;
        readonly usage: boolean;
      }>`select has_schema_privilege(current_user,'core','USAGE') as usage,
        has_table_privilege(current_user,'core.tenants','SELECT') as select,
        has_table_privilege(current_user,'core.tenants','INSERT') as insert,
        has_table_privilege(current_user,'core.tenants','UPDATE') as update,
        has_table_privilege(current_user,'core.tenants','DELETE') as delete,
        has_table_privilege(current_user,'core.application_composition_authority','SELECT') as "authoritySelect",
        has_table_privilege(current_user,'core.application_composition_authority','INSERT,UPDATE,DELETE') as "authorityWrite",
        has_table_privilege(current_user,'core.application_composition_durable_work','SELECT') as "durableSelect",
        has_table_privilege(current_user,'core.application_composition_durable_work','INSERT,UPDATE,DELETE') as "durableWrite",
        has_function_privilege(current_user,'core.track_application_composition_durable_work(text,text,text,boolean)','EXECUTE') as track`;
      expect(privileges).toEqual({
        authoritySelect: true,
        authorityWrite: false,
        delete: true,
        durableSelect: true,
        durableWrite: false,
        insert: true,
        select: true,
        track: false,
        update: true,
        usage: true,
      });
      const sourceConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const sourceClient = yield* makeTestPgClient(sourceConnections.admin.connectionString);
      const expectedRls = yield* sourceClient<{
        readonly enabled: boolean;
        readonly forced: boolean;
        readonly table: string;
      }>`select c.relname as table,c.relrowsecurity as enabled,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='core' and c.relkind in ('r','p') order by c.relname`;
      const actualRls = yield* runtime<{
        readonly enabled: boolean;
        readonly forced: boolean;
        readonly table: string;
      }>`select c.relname as table,c.relrowsecurity as enabled,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='core' and c.relkind in ('r','p') order by c.relname`;
      expect(actualRls).toEqual(expectedRls);
      const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      yield* database.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Core grant control',
        slug: `isolated-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* database.update(tenants).set({ name: 'Updated grant control' }).where(eq(tenants.tenantId, tenantId));
      expect((yield* database.select().from(tenants).where(eq(tenants.tenantId, tenantId)))[0]?.name).toBe(
        'Updated grant control',
      );
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantId));
      const authorityDenial = yield* Effect.flip(
        runtime`delete from core.application_composition_authority where false`,
      );
      const durableDenial = yield* Effect.flip(
        runtime`delete from core.application_composition_durable_work where false`,
      );
      expect(Option.map(findPostgresFailure(authorityDenial), ({ code }) => code)).toEqual(Option.some('42501'));
      expect(Option.map(findPostgresFailure(durableDenial), ({ code }) => code)).toEqual(Option.some('42501'));
    }),
  );
  suite.effect(
    '#1294 same-R native observation renewal preserves a real revoked resource permission',
    () =>
      Effect.gen(function* renewedObservationCannotGrantPermission() {
        const renewAfterClose = yield* Effect.scoped(
          Effect.gen(function* liveOwnedPermission() {
            const isolated = yield* makeIsolatedNativeDatabaseFixture({
              mode: 'empty',
              purpose: 'stabilization-1248-price-group-effective-period',
            });
            yield* isolated.migrateCoreSchema();
            const initial = yield* makeApplicationCompositionSnapshotFixture([]);
            yield* isolated.publishInitialComposition(initial);
            const live = yield* makeLiveOperationFixture({
              adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
              authenticationNamespaceId: 'core-native-renewal-permission',
              compositionRevision: initial.composition.revision,
              runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
            });
            yield* Effect.addFinalizer(() => live.close().pipe(Effect.orDie));
            const authenticationNamespaceRegistry = Context.get(
              yield* Layer.build(live.layer),
              AuthenticationNamespaceRegistry,
            );
            const access = yield* makeContextAccessLive();
            const resource = yield* Schema.decodeUnknownEffect(LegalEntityRefSchema)({
              moduleId: 'core.identity',
              resourceId: live.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: live.tenantId,
            });
            // This is the actual permission service in a real Core scope, not the fixture's scripted Action/Read runtime.
            const permission = live
              .prepareOwner((_transaction, scope) => {
                const { legalEntityId } = scope;
                if (legalEntityId === undefined) {
                  return Effect.die('Native permission proof requires its real Legal Entity scope');
                }
                return access.resources({
                  legalEntityId,
                  principalId: scope.principalId,
                  resources: [resource],
                  tenantId: scope.tenantId,
                });
              }, 'required')
              .pipe(Effect.provideService(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry));
            expect((yield* permission).map(({ decision }) => decision)).toEqual(['denied']);
            yield* Effect.acquireRelease(live.grantResourceAccess(resource, live.manager.principalId), () =>
              live.revokeResourceAccess(resource, live.manager.principalId).pipe(Effect.orDie),
            );
            expect((yield* permission).map(({ decision }) => decision)).toEqual(['allowed']);
            yield* live.revokeResourceAccess(resource, live.manager.principalId);
            expect((yield* permission).map(({ decision }) => decision)).toEqual(['denied']);
            const before = yield* isolated.composition.observe();
            const nonlater = yield* isolated.composition.renewObservation(initial).pipe(Effect.flip);
            expect(Schema.is(IsolatedNativeDatabaseError)(nonlater)).toBe(true);
            const other = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'renewal-other-release');
            const different = yield* isolated.composition.renewObservation(other).pipe(Effect.flip);
            expect(Schema.is(IsolatedNativeDatabaseError)(different)).toBe(true);
            const observedAt = yield* DateTime.now;
            const noExtension = yield* isolated.composition
              .renewObservation({ ...initial, observedAt })
              .pipe(Effect.flip);
            expect(Schema.is(IsolatedNativeDatabaseError)(noExtension)).toBe(true);
            const window = DateTime.toEpochMillis(initial.validUntil) - DateTime.toEpochMillis(initial.observedAt);
            const renewed = yield* isolated.composition.renewObservation({
              ...initial,
              observedAt,
              validUntil: DateTime.add(observedAt, { milliseconds: window }),
            });
            expect(renewed.composition).toEqual(initial.composition);
            expect(DateTime.toEpochMillis(renewed.observedAt)).toBeGreaterThan(
              DateTime.toEpochMillis(initial.observedAt),
            );
            expect(DateTime.toEpochMillis(renewed.validUntil)).toBeGreaterThan(
              DateTime.toEpochMillis(initial.validUntil),
            );
            expect(yield* isolated.composition.observe()).toEqual(before);
            expect((yield* permission).map(({ decision }) => decision)).toEqual(['denied']);
            return () => isolated.composition.renewObservation(renewed);
          }),
        );
        const closed = yield* renewAfterClose().pipe(Effect.flip);
        expect(Schema.is(IsolatedNativeDatabaseError)(closed)).toBe(true);
        expect(closed.reason).toBe('Observation renewal requires a live owned non-retained test controller');
      }),
    60_000,
  );
  suite.effect(
    '#1296 browser clone keeps all schemas and canonical roles but leaves publication to the browser',
    () =>
      Effect.gen(function* unpublishedBrowserClone() {
        const source = yield* loadDatabaseIdentityConnections({
          enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          envPath: '/dev/null',
        });
        const client = yield* makeTestPgClient(source.admin.connectionString);
        const sourceCatalog = client<{ fingerprint: string }>`select encode(sha256(convert_to(json_build_object(
        'relations',(select json_agg(row_to_json(r) order by r.schema,r.name) from (
          select n.nspname as schema,c.relname as name,c.relkind,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname not in('pg_catalog','information_schema') and n.nspname !~ '^pg_'
        ) r),
        'policies',(select json_agg(row_to_json(p) order by p.schemaname,p.tablename,p.policyname) from pg_policies p),
        'constraints',(select json_agg(row_to_json(k) order by k.schema,k.table_name,k.name) from (
          select n.nspname as schema,c.relname as table_name,k.conname as name,pg_get_constraintdef(k.oid,true) as definition
          from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
          where n.nspname not in('pg_catalog','information_schema')
        ) k)
      )::text,'UTF8')),'hex') as fingerprint`;
        const beforeCatalog = yield* sourceCatalog;
        const beforeAuthority =
          yield* client`select * from core.application_composition_authority order by authority_key`;
        const sourceSchemas = yield* client<{
          name: string;
        }>`select nspname as name from pg_namespace where nspname not in('pg_catalog','information_schema') and nspname !~ '^pg_' order by nspname`;
        const closed = yield* Effect.scoped(
          Effect.gen(function* ownBrowserDatabase() {
            const fixture = yield* makeIsolatedNativeDatabaseFixture({
              mode: 'schema-only',
              purpose: 'implementation-1296-browser-composition',
              sourceConnections: {
                admin: source.admin,
                runtime: testDatabaseIdentityConnection(source, 'shared_runtime'),
              },
            });
            const { database } = fixture.connections.admin;
            expect(database).toMatch(/^ontos_test_party_gateway_[a-f0-9]{32}$/u);
            expect(database).not.toBe(source.admin.database);
            const clone = yield* makeTestPgClient(fixture.connections.admin.connectionString);
            expect(yield* readSchemaCloneCatalog(fixture.connections.admin.connectionString)).toEqual(
              yield* readSchemaCloneCatalog(source.admin.connectionString),
            );
            expect(
              yield* clone`select nspname as name from pg_namespace where nspname not in('pg_catalog','information_schema') and nspname !~ '^pg_' order by nspname`,
            ).toEqual(sourceSchemas);
            expect(yield* clone`select count(*)::int as count from core.application_composition_authority`).toEqual([
              { count: 0 },
            ]);
            expect(yield* clone`select count(*)::int as count from core.tenants`).toEqual([{ count: 0 }]);
            expect(Exit.isFailure(yield* fixture.composition.observe().pipe(Effect.exit))).toBe(true);
            const snapshot = yield* makeApplicationCompositionSnapshotFixture([]);
            expect(Exit.isFailure(yield* fixture.publishInitialComposition(snapshot).pipe(Effect.exit))).toBe(true);
            expect(yield* clone`select count(*)::int as count from core.application_composition_authority`).toEqual([
              { count: 0 },
            ]);
            const environment = {
              ...Object.fromEntries(
                FIXTURE_DATABASE_IDENTITY_ENROLLMENT.identities.map(({ id, urlKey }) => {
                  const url = new URL(testDatabaseIdentityConnection(source, id).connectionString);
                  url.pathname = `/${database}`;
                  return [urlKey, url.href];
                }),
              ),
              DATABASE_ADMIN_URL: fixture.connections.admin.connectionString,
            };
            const routed = yield* loadDatabaseIdentityConnections({
              enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
              environment,
              envPath: '/dev/null',
            });
            for (const identity of FIXTURE_DATABASE_IDENTITY_ENROLLMENT.identities) {
              const connection = testDatabaseIdentityConnection(routed, identity.id);
              const sourceConnection = testDatabaseIdentityConnection(source, identity.id);
              expect(connection.database).toBe(database);
              expect(connection.user).toBe(identity.role);
              expect(connection.host).toBe(sourceConnection.host);
              expect(connection.port).toBe(sourceConnection.port);
              const role = yield* makeTestPgClient(connection.connectionString);
              expect(yield* role`select current_database() as database,current_user as "user"`).toEqual([
                { database, user: identity.role },
              ]);
            }
            return { database, observe: fixture.composition.observe };
          }),
        );
        expect(Exit.isFailure(yield* closed.observe().pipe(Effect.exit))).toBe(true);
        expect(
          yield* client`select exists(select 1 from pg_database where datname=${closed.database}) as present`,
        ).toEqual([{ present: false }]);
        expect(yield* sourceCatalog).toEqual(beforeCatalog);
        expect(yield* client`select * from core.application_composition_authority order by authority_key`).toEqual(
          beforeAuthority,
        );
      }),
    60_000,
  );
});
