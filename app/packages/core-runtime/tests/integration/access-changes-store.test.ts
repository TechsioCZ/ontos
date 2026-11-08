import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Cause, Crypto, DateTime, Deferred, Effect, Exit, FileSystem, Option, Ref, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import type { AdoptionSelection } from '../../src/access/changes/adoption.ts';
import { planAdoption, planDecline } from '../../src/access/changes/adoption.ts';
import { diffCatalogSnapshots } from '../../src/access/changes/catalog-diff.ts';
import { blueprintChangeItems, changeItemIdentityKey, planChangeItems } from '../../src/access/changes/items.ts';
import { makeAccessChangesDrizzleStore } from '../../src/access/changes/persistence/drizzle-store.ts';
import type { AccessChangesStoreError } from '../../src/access/changes/persistence/errors/index.ts';
import type { AccessChangesState, AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { previewAdoption } from '../../src/access/changes/preview.ts';
import { projectPublishedCatalog } from '../../src/access/changes/publication.ts';
import type { AdoptionTarget } from '../../src/access/changes/targets.ts';
import { capabilityEffectLabel } from '../../src/access/changes/targets.ts';
import type { UndoPlan } from '../../src/access/changes/undo.ts';
import { planUndo } from '../../src/access/changes/undo.ts';
import {
  AccessChangeItemIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { AccessChangeItem, CatalogSnapshot, Cell, Role, RoleRevision } from '../../src/access/model.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The Novinky store is only worth its guarantees if PostgreSQL keeps them. These suites apply the
 * real access-intent migration into a database of their own, record the plans L44 computes and read
 * them back, and probe every refusal beside the write that must be accepted.
 *
 * Each suite owns its database and drops it again: the access tables are append-only by design, so
 * intent written into a shared test database could never be cleaned up afterwards.
 */
const databasePrefix = 'ontos_test_access_changes_';
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantA = uid(1);
const tenantB = uid(2);
const principalA = uid(3);
const principalB = uid(4);
const authBinding = uid(60);
const roleA = uid(10);
const roleB = uid(11);
const roleARevision1 = uid(12);
const roleBRevision1 = uid(13);
const roleARevision2 = uid(14);
const roleARevision3 = uid(15);
const roleARevision4 = uid(16);
const roleARevision5 = uid(17);
const snapshot1 = uid(20);
const snapshot2 = uid(21);
const snapshot3 = uid(22);
const noteItem = uid(30);
const commentItem = uid(31);
const exportItem = uid(32);
const voidItem = uid(33);
const tenantBItem = uid(34);
const tagItem = uid(35);
const labelItem = uid(36);
const adoptNoteDecision = uid(40);
const adoptCommentDecision = uid(41);
const undoNoteDecision = uid(42);
const undoCommentDecision = uid(43);
const adoptExportDecision = uid(44);
const declineVoidDecision = uid(45);
const adoptTagDecision = uid(46);
const adoptLabelDecision = uid(47);
const batchAdopt = uid(50);
const batchUndo = uid(51);
const batchExport = uid(52);
const batchDecline = uid(53);
const batchTag = uid(54);
const batchLabel = uid(55);

const moduleId = 'test.access';
const noteKey = 'test.access.note.read';
const commentKey = 'test.access.comment.read';
const exportKey = 'test.access.report.export';
const voidKey = 'test.access.invoice.void';
const tagKey = 'test.access.tag.read';
const labelKey = 'test.access.label.read';

const dateAt = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const NOW = dateAt('2026-11-03T09:35:47Z');
const LATER = dateAt('2026-11-04T09:35:47Z');
const LATEST = dateAt('2026-11-05T09:35:47Z');
const FINAL = dateAt('2026-11-05T12:35:47Z');

const tenantOf = (value: string) => TenantIdSchema.make(value);
const principalOf = (value: string) => PrincipalIdSchema.make(value);
const roleIdOf = (value: string) => RoleIdSchema.make(value);
const revisionIdOf = (value: string) => RoleRevisionIdSchema.make(value);
const snapshotIdOf = (value: string) => CatalogSnapshotIdSchema.make(value);
const itemIdOf = (value: string) => AccessChangeItemIdSchema.make(value);

const declaration = (input: {
  readonly key: string;
  readonly kind: AccessDeclarationInput['kind'];
  readonly modes: AccessDeclarationInput['modes'];
  readonly risk: AccessDeclarationInput['risk'];
  readonly selectors: AccessDeclarationInput['selectors'];
}): AccessDeclarationInput => ({
  key: input.key,
  kind: input.kind,
  modes: input.modes,
  placement: { group: 'test', level: 'basic' },
  risk: input.risk,
  selectors: input.selectors,
});

const routineRead = (key: string) => declaration({ key, kind: 'read', modes: ['run'], risk: 'routine', selectors: [] });

/** Two routine reads, one sensitive export and one critical action in one release. */
const releaseTwoDeclarations: readonly AccessDeclarationInput[] = [
  routineRead(noteKey),
  routineRead(commentKey),
  declaration({ key: exportKey, kind: 'export', modes: ['run'], risk: 'sensitive', selectors: [] }),
  declaration({
    key: voidKey,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    risk: 'critical',
    selectors: ['all'],
  }),
];

const catalogOf = (declarations: readonly AccessDeclarationInput[]) =>
  Effect.fromResult(
    projectPublishedCatalog(declarations.map((value) => ({ declaration: value, moduleId, published: true }))),
  ).pipe(Effect.tapError((failure) => Effect.logError(`CATALOG ${failure.code}`)));

const release = (id: string, publishedAt: Date, entries: CatalogSnapshot['entries']): CatalogSnapshot => ({
  digest: CatalogDigestSchema.make(Hex.encode(sha256(utf8ToBytes(JSON.stringify(entries))))),
  entries,
  id: snapshotIdOf(id),
  publishedAt,
});

/** The trusted request scope a Novinky write runs in: one session principal of one tenant. */
const scopeOf = (tenantId: string, principalId: string): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: authBinding,
    authContextRef: 'better-auth-session:access-changes-store',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-changes-store' })),
    Effect.orDie,
  );

const roleOf = (ofRole: string, tenantId: string, createdBy: string, createdAt: Date): Role => ({
  createdAt,
  createdBy: principalOf(createdBy),
  id: roleIdOf(ofRole),
  name: 'Účetní',
  tenantId: tenantOf(tenantId),
});

const revisionOf = (input: {
  readonly catalogSnapshotId: string;
  readonly cells: readonly Cell[];
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly id: string;
  readonly revision: number;
  readonly roleId: string;
  readonly tenantId: string;
}): RoleRevision => ({
  catalogSnapshotId: snapshotIdOf(input.catalogSnapshotId),
  cells: input.cells,
  createdAt: input.createdAt,
  createdBy: principalOf(input.createdBy),
  id: revisionIdOf(input.id),
  provenance: 'manual',
  revision: input.revision,
  roleId: roleIdOf(input.roleId),
  tenantId: tenantOf(input.tenantId),
});

/** Every adopted cell in these suites is a run cell over every record of its scope. */
const runAllTarget = (ofRole: string): AdoptionTarget => ({
  modes: ['run'],
  roleId: roleIdOf(ofRole),
  selector: 'all',
});

const selectionOf = (itemId: string, ofRole: string): AdoptionSelection => ({
  itemId: itemIdOf(itemId),
  targets: [runAllTarget(ofRole)],
});

const previewOf = (itemIds: readonly string[], at: Date) =>
  previewAdoption({
    assignments: [],
    at,
    items: itemIds.map((itemId) => ({ itemId: itemIdOf(itemId), roleIds: [roleIdOf(roleA)] })),
  });

/** A plan or a publication is a `Result`; entering Effect keeps its refusal in the error channel. */
const attempt = Effect.fromResult;

/** The exact refusal a store operation produced, so a suite asserts a code and never a message. */
const failureOf = <Value>(effect: Effect.Effect<Value, AccessChangesStoreError>) =>
  Effect.gen(function* storeFailureOf() {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  });

const itemStatus = (state: AccessChangesState, itemId: string): string | undefined =>
  state.items.find(({ id }) => id === itemId)?.status;

const currentRevisionOf = (state: AccessChangesState, ofRole: string) =>
  state.roles.find(({ role }) => role.id === ofRole)?.revision;

const cellKeys = (state: AccessChangesState, ofRole: string): readonly string[] => {
  const revision = currentRevisionOf(state, ofRole);
  return revision === undefined ? [] : revision.cells.map(({ capabilityKey }) => capabilityKey);
};

const ownerOf = (principalId: string) => ({ _tag: 'Principal', principalId: principalOf(principalId) }) as const;

const REQUIRED_IDENTITY_TABLES = [
  'create schema "core"',
  `create table "core"."tenants" (tenant_id uuid primary key)`,
  `create table "core"."legal_entities" (
     tenant_id uuid not null,
     legal_entity_id uuid primary key,
     unique (tenant_id, legal_entity_id)
   )`,
  `create table "core"."principals" (
     tenant_id uuid not null,
     principal_id uuid primary key,
     kind text not null,
     unique (tenant_id, principal_id)
   )`,
  // The access migration scopes its gateway-request policies by the redeemed trusted scope
  // (`trust.current_tenant_id()`, D6); the real database carries that function from the trusted
  // gateway-scope migration, which runs before this one. This isolated database applies the access
  // migration alone, so it declares the same schema and function the policies resolve against at
  // creation time. The suite runs as the shared runtime, so the gateway policies are never used.
  `create schema "trust"`,
  `create function "trust"."current_tenant_id"() returns uuid language sql stable as $$
     select nullif(current_setting('ontos.tenant_id', true), '')::uuid
   $$`,
] as const;

const replacedDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

interface AccessSchema {
  readonly admin: PgClient.PgClient;
  readonly otherStore: AccessChangesStoreService;
  readonly scopeA: OperationalScope;
  readonly scopeB: OperationalScope;
  readonly store: AccessChangesStoreService;
}

/** A database of this run's own, with the access migration applied and the runtime role granted. */
const makeAccessSchema = Effect.gen(function* accessChangesSchema() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const database = `${databasePrefix}${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const sourceAdmin = yield* makeTestPgClient(connections.admin.connectionString);
  yield* sourceAdmin.unsafe(`create database "${database}"`);
  yield* Effect.addFinalizer(() =>
    database.startsWith(databasePrefix)
      ? sourceAdmin.unsafe(`drop database if exists "${database}"`).pipe(Effect.orDie)
      : Effect.die('Unsafe isolated database cleanup target'),
  );
  const isolated = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: replacedDatabase(connections.admin.connectionString, database),
    DATABASE_URL: replacedDatabase(connections.runtime.connectionString, database),
  });
  const admin = yield* makeTestPgClient(isolated.admin.connectionString);
  for (const statement of REQUIRED_IDENTITY_TABLES) {
    yield* admin.unsafe(statement);
  }
  const migration = yield* fileSystem.readFileString(migrationPath);
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) {
      yield* admin.unsafe(statement);
    }
  }
  // The runtime role's Core privileges, exactly what `db:bootstrap-runtime-role` grants after a migrate.
  for (const statement of [
    'grant usage on schema "core" to ontos_runtime',
    'grant select, insert, update, delete on all tables in schema "core" to ontos_runtime',
  ]) {
    yield* admin.unsafe(statement);
  }
  const runtime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const runtimeDatabase = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  // A second pool, so two writers really race instead of queueing on one connection.
  const otherRuntime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const otherDatabase = yield* makeTestDatabaseFromClient(otherRuntime, coreRelations);
  const schema: AccessSchema = Object.freeze({
    admin,
    otherStore: makeAccessChangesDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: otherDatabase,
    }),
    scopeA: yield* scopeOf(tenantA, principalA),
    scopeB: yield* scopeOf(tenantB, principalB),
    store: makeAccessChangesDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
  });
  return schema;
});

it.layer(NodeServices.layer)('the Access changes store', (suite) => {
  suite.effect(
    'publishes a release, adopts it in one batch and undoes it, and keeps each tenant to its own intent',
    Effect.fnUntraced(function* accessChangesStoreIntegration() {
      const schema = yield* makeAccessSchema;
      const { admin, scopeA, scopeB, store } = schema;

      // ---- the identities the access tables reference -------------------------------------
      yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}'), ('${tenantB}')`);
      yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind) values
        ('${tenantA}', '${principalA}', 'human'),
        ('${tenantB}', '${principalB}', 'human')`);

      // ---- publication: the release catalog is global, append-only and repaired by retry (D3) --
      const firstRelease = release(snapshot1, NOW, []);
      expect((yield* store.publishCatalog({ snapshot: firstRelease })).inserted).toBe(true);
      expect((yield* store.publishCatalog({ snapshot: firstRelease })).inserted).toBe(false);
      const secondRelease = release(snapshot2, LATER, (yield* catalogOf(releaseTwoDeclarations)).entries);
      const thirdRelease = release(
        snapshot3,
        LATEST,
        (yield* catalogOf([...releaseTwoDeclarations, routineRead(tagKey)])).entries,
      );
      expect((yield* store.publishCatalog({ snapshot: secondRelease })).inserted).toBe(true);
      expect((yield* store.publishCatalog({ snapshot: thirdRelease })).inserted).toBe(true);
      // A second snapshot under a digest that already names a release is a different release claim.
      const foreignClaim = yield* failureOf(
        store.publishCatalog({ snapshot: { ...firstRelease, id: snapshotIdOf(uid(90)) } }),
      );
      expect(foreignClaim?.code).toBe('access_changes_catalog_conflict');
      expect(Option.getOrUndefined(yield* store.loadPublishedCatalog())?.entries.map(({ key }) => key)).toEqual([
        commentKey,
        voidKey,
        noteKey,
        exportKey,
        tagKey,
      ]);

      // ---- roles: a role exists only together with the revision it holds ----------------------
      yield* store.recordRole({
        revision: revisionOf({
          catalogSnapshotId: snapshot1,
          cells: [],
          createdAt: NOW,
          createdBy: principalA,
          id: roleARevision1,
          revision: 1,
          roleId: roleA,
          tenantId: tenantA,
        }),
        role: roleOf(roleA, tenantA, principalA, NOW),
        scope: scopeA,
      });
      yield* store.recordRole({
        revision: revisionOf({
          catalogSnapshotId: snapshot1,
          cells: [],
          createdAt: NOW,
          createdBy: principalB,
          id: roleBRevision1,
          revision: 1,
          roleId: roleB,
          tenantId: tenantB,
        }),
        role: roleOf(roleB, tenantB, principalB, NOW),
        scope: scopeB,
      });
      const foreignRole = yield* failureOf(
        store.recordRole({
          revision: revisionOf({
            catalogSnapshotId: snapshot1,
            cells: [],
            createdAt: NOW,
            createdBy: principalB,
            id: uid(91),
            revision: 1,
            roleId: roleB,
            tenantId: tenantB,
          }),
          role: roleOf(roleB, tenantB, principalB, NOW),
          scope: scopeA,
        }),
      );
      expect(foreignRole?.code).toBe('access_changes_scope_mismatch');
      // A role is created once: an identical retry is a replay that writes nothing, and other content
      // under the same identity is a conflict, never a second role.
      yield* store.recordRole({
        revision: revisionOf({
          catalogSnapshotId: snapshot1,
          cells: [],
          createdAt: NOW,
          createdBy: principalA,
          id: roleARevision1,
          revision: 1,
          roleId: roleA,
          tenantId: tenantA,
        }),
        role: roleOf(roleA, tenantA, principalA, NOW),
        scope: scopeA,
      });
      const duplicateRole = yield* failureOf(
        store.recordRole({
          revision: revisionOf({
            catalogSnapshotId: snapshot1,
            cells: [],
            createdAt: NOW,
            createdBy: principalA,
            id: roleARevision1,
            revision: 1,
            roleId: roleA,
            tenantId: tenantA,
          }),
          role: { ...roleOf(roleA, tenantA, principalA, NOW), name: 'Fakturantka' },
          scope: scopeA,
        }),
      );
      expect(duplicateRole?.code).toBe('access_changes_record_conflict');

      // ---- Novinky: a release creates one pending item per change -----------------------------
      const releaseTwoBlueprints = yield* attempt(
        blueprintChangeItems({
          drafts: yield* attempt(diffCatalogSnapshots(firstRelease, secondRelease)),
          entries: secondRelease.entries,
          roles: [],
        }),
      );
      const releaseTwoPlan = yield* attempt(
        planChangeItems({
          assignments: [],
          blueprints: releaseTwoBlueprints,
          catalogSnapshotId: snapshot2,
          createdAt: LATER,
          itemIds: new Map(
            [
              [noteKey, noteItem],
              [commentKey, commentItem],
              [exportKey, exportItem],
              [voidKey, voidItem],
            ].map(([key, item]) => [changeItemIdentityKey('new', key ?? ''), item ?? '']),
          ),
          tenantId: tenantA,
        }),
      );
      yield* store.recordChangeItems({ plan: releaseTwoPlan, scope: scopeA });
      // The same release written twice is the same items, never a second copy of each change.
      yield* store.recordChangeItems({ plan: releaseTwoPlan, scope: scopeA });
      yield* store.recordChangeItems({
        plan: yield* attempt(
          planChangeItems({
            assignments: [],
            blueprints: yield* attempt(
              blueprintChangeItems({
                drafts: yield* attempt(diffCatalogSnapshots(secondRelease, thirdRelease)),
                entries: thirdRelease.entries,
                roles: [],
              }),
            ),
            catalogSnapshotId: snapshot3,
            createdAt: LATEST,
            itemIds: new Map([[changeItemIdentityKey('new', tagKey), tagItem]]),
            tenantId: tenantA,
          }),
        ),
        scope: scopeA,
      });
      const tenantBPlan = yield* attempt(
        planChangeItems({
          assignments: [],
          blueprints: releaseTwoBlueprints.filter(({ capabilityKey }) => capabilityKey === noteKey),
          catalogSnapshotId: snapshot2,
          createdAt: LATER,
          itemIds: new Map([[changeItemIdentityKey('new', noteKey), tenantBItem]]),
          tenantId: tenantB,
        }),
      );
      yield* store.recordChangeItems({ plan: tenantBPlan, scope: scopeB });
      const foreignItems = yield* failureOf(store.recordChangeItems({ plan: tenantBPlan, scope: scopeA }));
      expect(foreignItems?.code).toBe('access_changes_scope_mismatch');

      const pendingA = yield* store.loadTenantChanges(scopeA);
      const pendingB = yield* store.loadTenantChanges(scopeB);
      expect(pendingA.items.map(({ id }) => id)).toEqual([noteItem, commentItem, exportItem, voidItem, tagItem]);
      expect(pendingA.items.every(({ status }) => status === 'pending')).toBe(true);
      // Tenant isolation: B's intent is invisible under A's scope, and A's under B's.
      expect(pendingB.items.map(({ id }) => id)).toEqual([tenantBItem]);
      expect(pendingB.roles.map(({ role }) => role.id)).toEqual([roleB]);

      // ---- one batch adopts both routine items and writes one shared revision ------------------
      const routinePreview = previewOf([noteItem, commentItem], LATER);
      const adoptionPlan = yield* attempt(
        planAdoption({
          actor: ownerOf(principalA),
          assignments: [],
          authority: { _tag: 'Owner' },
          batchId: batchAdopt,
          decidedAt: LATER,
          decisionIds: new Map([
            [noteItem, adoptNoteDecision],
            [commentItem, adoptCommentDecision],
          ]),
          entries: secondRelease.entries,
          items: pendingA.items,
          membership: { legalEntities: [], members: [], suspended: [] },
          namedEffects: new Map(),
          newRevisionIds: new Map([[roleA, roleARevision2]]),
          preview: routinePreview,
          roles: pendingA.roles,
          selections: [selectionOf(noteItem, roleA), selectionOf(commentItem, roleA)],
          tenantId: tenantA,
        }),
      );
      yield* store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: adoptionPlan, scope: scopeA });
      const adopted = yield* store.loadTenantChanges(scopeA);
      expect(itemStatus(adopted, noteItem)).toBe('adopted');
      expect(itemStatus(adopted, commentItem)).toBe('adopted');
      expect(currentRevisionOf(adopted, roleA)?.id).toBe(roleARevision2);
      expect(currentRevisionOf(adopted, roleA)?.revision).toBe(2);
      expect(cellKeys(adopted, roleA).toSorted()).toEqual([commentKey, noteKey]);
      const storedAdoption = yield* admin.unsafe<{
        readonly decision: string;
        readonly role_revision_ids: readonly string[];
      }>(
        `select decision, role_revision_ids from "core"."access_change_decisions"
          where tenant_id = '${tenantA}' and decision_id in ('${adoptNoteDecision}', '${adoptCommentDecision}')
          order by decision_id`,
      );
      expect(storedAdoption.map(({ decision }) => decision)).toEqual(['adopt', 'adopt']);
      expect(storedAdoption.every(({ role_revision_ids }) => role_revision_ids.join(',') === roleARevision2)).toBe(
        true,
      );
      // The same batch replayed is a second decision on decided items: refused, never applied twice.
      const replayedAdoption = yield* failureOf(
        store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: adoptionPlan, scope: scopeA }),
      );
      expect(replayedAdoption?.code).toBe('access_changes_item_not_pending');

      // ---- undo: append-only, narrow, and it names the adoption it undoes ---------------------
      const undoSources = [noteItem, commentItem].flatMap((itemId) => {
        const adoption = adoptionPlan.decisions.find((decided) => decided.itemId === itemId);
        const item = adopted.items.find(({ id }) => id === itemId);
        return adoption === undefined || item === undefined ? [] : [{ adoption, item }];
      });
      expect(undoSources).toHaveLength(2);
      const undoPlan = yield* attempt(
        planUndo({
          actor: ownerOf(principalA),
          assignments: [],
          authority: { _tag: 'Owner' },
          batchId: batchUndo,
          decidedAt: LATER,
          decisionIds: new Map([
            [noteItem, undoNoteDecision],
            [commentItem, undoCommentDecision],
          ]),
          entries: secondRelease.entries,
          membership: { legalEntities: [], members: [], suspended: [] },
          newRevisionIds: new Map([[roleA, roleARevision3]]),
          preview: routinePreview,
          revisions: adopted.revisions,
          revocations: [],
          roles: adopted.roles,
          selections: undoSources,
          tenantId: tenantA,
        }),
      );
      yield* store.recordUndo({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: undoPlan, scope: scopeA });
      const undone = yield* store.loadTenantChanges(scopeA);
      expect(itemStatus(undone, noteItem)).toBe('undone');
      expect(itemStatus(undone, commentItem)).toBe('undone');
      expect(currentRevisionOf(undone, roleA)?.revision).toBe(3);
      expect(cellKeys(undone, roleA)).toEqual([]);
      const storedUndo = yield* admin.unsafe<{ readonly undoes_decision_id: string | null }>(
        `select undoes_decision_id from "core"."access_change_decisions"
          where tenant_id = '${tenantA}' and decision_id in ('${undoNoteDecision}', '${undoCommentDecision}')
          order by decision_id`,
      );
      expect(storedUndo.map(({ undoes_decision_id }) => undoes_decision_id)).toEqual([
        adoptNoteDecision,
        adoptCommentDecision,
      ]);
      const storedUndoRevisions = yield* admin.unsafe<{ readonly role_revision_ids: readonly string[] }>(
        `select role_revision_ids from "core"."access_change_decisions"
          where tenant_id = '${tenantA}' and decision_id in ('${undoNoteDecision}', '${undoCommentDecision}')`,
      );
      expect(storedUndoRevisions.every(({ role_revision_ids }) => role_revision_ids.join(',') === roleARevision3)).toBe(
        true,
      );
      // O54: an undone item is final. The store refuses the second undo, and the table refuses the
      // state change a hand-written update would try behind its back.
      const replayedUndo = yield* failureOf(
        store.recordUndo({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: undoPlan, scope: scopeA }),
      );
      expect(replayedUndo?.code).toBe('access_changes_item_not_pending');
      const rawReAdoption = yield* Effect.exit(
        admin.unsafe(`update "core"."access_change_items" set status = 'adopted' where item_id = '${noteItem}'`),
      );
      expect(Exit.isFailure(rawReAdoption)).toBe(true);
      expect(Option.getOrUndefined(findPostgresFailure(rawReAdoption))?.code).toBe('55000');

      // ---- a sensitive item is adopted alone, naming the effect it grants (D7c) ---------------
      const exportEntry = secondRelease.entries.find(({ key }) => key === exportKey);
      if (exportEntry === undefined) {
        return;
      }
      const exportRequest = {
        actor: ownerOf(principalA),
        assignments: [],
        authority: { _tag: 'Owner' } as const,
        batchId: batchExport,
        decidedAt: LATER,
        decisionIds: new Map([[exportItem, adoptExportDecision]]),
        entries: secondRelease.entries,
        items: undone.items,
        membership: { legalEntities: [], members: [], suspended: [] },
        newRevisionIds: new Map([[roleA, roleARevision4]]),
        preview: previewOf([exportItem], LATER),
        roles: undone.roles,
        selections: [selectionOf(exportItem, roleA)],
        tenantId: tenantA,
      };
      const unnamedEffect = yield* Effect.exit(attempt(planAdoption({ ...exportRequest, namedEffects: new Map() })));
      expect(Exit.isFailure(unnamedEffect)).toBe(true);
      const exportPlan = yield* attempt(
        planAdoption({ ...exportRequest, namedEffects: new Map([[exportItem, capabilityEffectLabel(exportEntry)]]) }),
      );
      yield* store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: exportPlan, scope: scopeA });
      const exported = yield* store.loadTenantChanges(scopeA);
      expect(itemStatus(exported, exportItem)).toBe('adopted');
      expect(currentRevisionOf(exported, roleA)?.revision).toBe(4);
      expect(cellKeys(exported, roleA)).toEqual([exportKey]);

      // ---- declining narrows access and changes no role (O35) --------------------------------
      const declinePlan = yield* attempt(
        planDecline({
          actor: ownerOf(principalA),
          authority: { _tag: 'Owner' },
          batchId: batchDecline,
          decidedAt: LATER,
          decisionIds: new Map([[voidItem, declineVoidDecision]]),
          itemIds: [voidItem],
          items: exported.items,
          tenantId: tenantA,
        }),
      );
      yield* store.recordDecline({ plan: declinePlan, scope: scopeA });
      const declined = yield* store.loadTenantChanges(scopeA);
      expect(itemStatus(declined, voidItem)).toBe('declined');
      expect(currentRevisionOf(declined, roleA)?.revision).toBe(4);
      const storedDecline = yield* admin.unsafe<{ readonly role_revision_ids: readonly string[] }>(
        `select role_revision_ids from "core"."access_change_decisions" where decision_id = '${declineVoidDecision}'`,
      );
      expect(storedDecline.at(0)?.role_revision_ids).toEqual([]);
    }),
  );

  suite.effect(
    'moves the grant incarnations a decision witnesses with every role edit (S1, O52)',
    Effect.fnUntraced(function* accessChangesStoreIncarnations() {
      const schema = yield* makeAccessSchema;
      const { admin, scopeA, store } = schema;
      const scopeTenant = uid(200);
      const assignment = uid(201);

      yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}')`);
      yield* admin.unsafe(
        `insert into "core"."principals" (tenant_id, principal_id, kind) values ('${tenantA}', '${principalA}', 'human')`,
      );
      // The binding scope the role's cells are projected in, and the one live holder of the role.
      yield* admin.unsafe(
        `insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id)
         values ('${scopeTenant}', '${tenantA}', '${tenantA}', null)`,
      );
      const firstRelease = release(snapshot1, NOW, []);
      const secondRelease = release(snapshot2, LATER, (yield* catalogOf([routineRead(noteKey)])).entries);
      yield* store.publishCatalog({ snapshot: firstRelease });
      yield* store.publishCatalog({ snapshot: secondRelease });
      yield* store.recordRole({
        revision: revisionOf({
          catalogSnapshotId: snapshot1,
          cells: [],
          createdAt: NOW,
          createdBy: principalA,
          id: roleARevision1,
          revision: 1,
          roleId: roleA,
          tenantId: tenantA,
        }),
        role: roleOf(roleA, tenantA, principalA, NOW),
        scope: scopeA,
      });
      yield* admin.unsafe(
        `insert into "core"."access_assignments"
           (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
         values ('${assignment}', '${tenantA}', '${scopeTenant}', '${roleA}', '${roleARevision1}',
                 '${principalA}', '${principalA}', 'active', now())`,
      );

      const incarnationRows = () =>
        admin.unsafe<{ readonly grant_incarnation_id: string; readonly status: string }>(
          `select grant_incarnation_id, status from "core"."access_grant_incarnations"
            where tenant_id = '${tenantA}' and role_id = '${roleA}' and capability_key = '${noteKey}'`,
        );
      const revisionOfAssignment = () =>
        admin.unsafe<{ readonly role_revision_id: string }>(
          `select role_revision_id from "core"."access_assignments" where incarnation_id = '${assignment}'`,
        );

      // Negative control: nothing witnesses the capability before it is adopted into the role.
      expect(yield* incarnationRows()).toEqual([]);

      const itemPlan = yield* attempt(
        planChangeItems({
          assignments: [],
          blueprints: yield* attempt(
            blueprintChangeItems({
              drafts: yield* attempt(diffCatalogSnapshots(firstRelease, secondRelease)),
              entries: secondRelease.entries,
              roles: [],
            }),
          ),
          catalogSnapshotId: snapshot2,
          createdAt: LATER,
          itemIds: new Map([[changeItemIdentityKey('new', noteKey), noteItem]]),
          tenantId: tenantA,
        }),
      );
      yield* store.recordChangeItems({ plan: itemPlan, scope: scopeA });
      const pending = yield* store.loadTenantChanges(scopeA);
      const adoptionPlan = yield* attempt(
        planAdoption({
          actor: ownerOf(principalA),
          assignments: [],
          authority: { _tag: 'Owner' },
          batchId: batchAdopt,
          decidedAt: LATER,
          decisionIds: new Map([[noteItem, adoptNoteDecision]]),
          entries: secondRelease.entries,
          items: pending.items,
          membership: { legalEntities: [], members: [], suspended: [] },
          namedEffects: new Map(),
          newRevisionIds: new Map([[roleA, roleARevision2]]),
          preview: previewOf([noteItem], LATER),
          roles: pending.roles,
          selections: [selectionOf(noteItem, roleA)],
          tenantId: tenantA,
        }),
      );
      yield* store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: adoptionPlan, scope: scopeA });

      // Adoption inserts the incarnation the decision witnesses and re-points the live holder at the
      // successor revision, so the adopted capability becomes usable (S1, guarantee 2).
      const afterAdoption = yield* incarnationRows();
      expect(afterAdoption).toHaveLength(1);
      expect(afterAdoption.at(0)?.status).toBe('active');
      expect((yield* revisionOfAssignment()).at(0)?.role_revision_id).toBe(roleARevision2);

      // Undo removes the cell and retires its incarnation, so no later decision can witness it (O52).
      const adopted = yield* store.loadTenantChanges(scopeA);
      const adoption = adoptionPlan.decisions.find(({ itemId }) => itemId === noteItem);
      const item = adopted.items.find(({ id }) => id === noteItem);
      if (adoption === undefined || item === undefined) {
        return;
      }
      const undoPlan = yield* attempt(
        planUndo({
          actor: ownerOf(principalA),
          assignments: [],
          authority: { _tag: 'Owner' },
          batchId: batchUndo,
          decidedAt: LATER,
          decisionIds: new Map([[noteItem, undoNoteDecision]]),
          entries: secondRelease.entries,
          membership: { legalEntities: [], members: [], suspended: [] },
          newRevisionIds: new Map([[roleA, roleARevision3]]),
          preview: previewOf([noteItem], LATER),
          revisions: adopted.revisions,
          revocations: [],
          roles: adopted.roles,
          selections: [{ adoption, item }],
          tenantId: tenantA,
        }),
      );
      yield* store.recordUndo({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: undoPlan, scope: scopeA });
      const afterUndo = yield* incarnationRows();
      expect(afterUndo).toHaveLength(1);
      expect(afterUndo.at(0)?.status).toBe('retired');
      expect((yield* revisionOfAssignment()).at(0)?.role_revision_id).toBe(roleARevision3);
    }),
  );

  suite.effect(
    'refuses a plan built against an older revision, and stores exactly one of two racing adoptions',
    Effect.fnUntraced(function* accessChangesStoreRace() {
      const schema = yield* makeAccessSchema;
      const { admin, otherStore, scopeA, store } = schema;
      yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}')`);
      yield* admin.unsafe(
        `insert into "core"."principals" (tenant_id, principal_id, kind) values ('${tenantA}', '${principalA}', 'human')`,
      );

      const firstRelease = release(snapshot1, NOW, []);
      yield* store.publishCatalog({ snapshot: firstRelease });
      const secondRelease = release(
        snapshot2,
        LATER,
        (yield* catalogOf([routineRead(noteKey), routineRead(tagKey)])).entries,
      );
      yield* store.publishCatalog({ snapshot: secondRelease });
      yield* store.recordRole({
        revision: revisionOf({
          catalogSnapshotId: snapshot1,
          cells: [],
          createdAt: NOW,
          createdBy: principalA,
          id: roleARevision1,
          revision: 1,
          roleId: roleA,
          tenantId: tenantA,
        }),
        role: roleOf(roleA, tenantA, principalA, NOW),
        scope: scopeA,
      });
      const blueprints = yield* attempt(
        blueprintChangeItems({
          drafts: yield* attempt(diffCatalogSnapshots(firstRelease, secondRelease)),
          entries: secondRelease.entries,
          roles: [],
        }),
      );
      yield* store.recordChangeItems({
        plan: yield* attempt(
          planChangeItems({
            assignments: [],
            blueprints,
            catalogSnapshotId: snapshot2,
            createdAt: LATER,
            itemIds: new Map([
              [changeItemIdentityKey('new', noteKey), noteItem],
              [changeItemIdentityKey('new', tagKey), tagItem],
            ]),
            tenantId: tenantA,
          }),
        ),
        scope: scopeA,
      });
      const beforeFirst = yield* store.loadTenantChanges(scopeA);
      const adopt = (input: {
        readonly batch: string;
        readonly decisionId: string;
        readonly entries: CatalogSnapshot['entries'];
        readonly from: AccessChangesState;
        readonly itemId: string;
        readonly revisionId: string;
      }) =>
        attempt(
          planAdoption({
            actor: ownerOf(principalA),
            assignments: [],
            authority: { _tag: 'Owner' },
            batchId: input.batch,
            decidedAt: LATER,
            decisionIds: new Map([[input.itemId, input.decisionId]]),
            entries: input.entries,
            items: input.from.items,
            membership: { legalEntities: [], members: [], suspended: [] },
            namedEffects: new Map(),
            newRevisionIds: new Map([[roleA, input.revisionId]]),
            preview: previewOf([input.itemId], LATER),
            roles: input.from.roles,
            selections: [selectionOf(input.itemId, roleA)],
            tenantId: tenantA,
          }),
        );

      // The note adoption moves the role; a plan for the tag item that was built before it is stale.
      const notePlan = yield* adopt({
        batch: batchTag,
        decisionId: adoptNoteDecision,
        entries: secondRelease.entries,
        from: beforeFirst,
        itemId: noteItem,
        revisionId: roleARevision2,
      });
      yield* store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: notePlan, scope: scopeA });
      const staleTagPlan = yield* adopt({
        batch: batchTag,
        decisionId: adoptTagDecision,
        entries: secondRelease.entries,
        from: beforeFirst,
        itemId: tagItem,
        revisionId: roleARevision3,
      });
      const staleWrite = yield* failureOf(
        store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: staleTagPlan, scope: scopeA }),
      );
      expect(staleWrite?.code).toBe('access_changes_revision_stale');

      // A plan made for somebody else never writes, and the item stays pending for its own decider.
      const current = yield* store.loadTenantChanges(scopeA);
      const currentTagPlan = yield* adopt({
        batch: batchTag,
        decisionId: adoptTagDecision,
        entries: secondRelease.entries,
        from: current,
        itemId: tagItem,
        revisionId: roleARevision3,
      });
      const foreignDecider = yield* failureOf(
        store.recordAdoption({
          catalogSnapshotId: snapshotIdOf(snapshot2),
          plan: {
            ...currentTagPlan,
            decisions: currentTagPlan.decisions.map((decision) => ({
              ...decision,
              decidedBy: principalOf(principalB),
            })),
          },
          scope: scopeA,
        }),
      );
      expect(foreignDecider?.code).toBe('access_changes_record_conflict');
      expect(itemStatus(yield* store.loadTenantChanges(scopeA), tagItem)).toBe('pending');

      // An undo that names another item's adoption is not an undo of this item.
      yield* store.recordAdoption({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: currentTagPlan, scope: scopeA });
      const adopted = yield* store.loadTenantChanges(scopeA);
      const adoptedTag = currentTagPlan.decisions.find(({ itemId }) => itemId === tagItem);
      const adoptedNote = notePlan.decisions.at(0);
      const tag = adopted.items.find(({ id }) => id === tagItem);
      expect(adoptedTag === undefined || adoptedNote === undefined || tag === undefined).toBe(false);
      if (adoptedTag === undefined || adoptedNote === undefined || tag === undefined) {
        return;
      }
      const tagUndoPlan = yield* attempt(
        planUndo({
          actor: ownerOf(principalA),
          assignments: [],
          authority: { _tag: 'Owner' },
          batchId: batchUndo,
          decidedAt: LATEST,
          decisionIds: new Map([[tagItem, undoNoteDecision]]),
          entries: secondRelease.entries,
          membership: { legalEntities: [], members: [], suspended: [] },
          newRevisionIds: new Map([[roleA, roleARevision5]]),
          preview: previewOf([tagItem], LATEST),
          revisions: adopted.revisions,
          revocations: [],
          roles: adopted.roles,
          selections: [{ adoption: adoptedTag, item: tag }],
          tenantId: tenantA,
        }),
      );
      const doctoredUndo: UndoPlan = {
        ...tagUndoPlan,
        decisions: tagUndoPlan.decisions.map((decision) => ({ ...decision, undoesDecisionId: adoptedNote.id })),
      };
      const doctored = yield* failureOf(
        store.recordUndo({ catalogSnapshotId: snapshotIdOf(snapshot2), plan: doctoredUndo, scope: scopeA }),
      );
      expect(doctored?.code).toBe('access_changes_undo_not_an_adoption');
      // The refusal rolled back: the item the undo named is still adopted.
      expect(itemStatus(yield* store.loadTenantChanges(scopeA), tagItem)).toBe('adopted');

      // Two writers, one revision: exactly one adoption is stored, and the loser stores nothing.
      const labelRelease = release(
        snapshot3,
        FINAL,
        (yield* catalogOf([routineRead(noteKey), routineRead(tagKey), routineRead(labelKey)])).entries,
      );
      yield* store.publishCatalog({ snapshot: labelRelease });
      const adoptedBeforeLabel = yield* store.loadTenantChanges(scopeA);
      yield* store.recordChangeItems({
        plan: yield* attempt(
          planChangeItems({
            assignments: [],
            blueprints: yield* attempt(
              blueprintChangeItems({
                drafts: yield* attempt(diffCatalogSnapshots(secondRelease, labelRelease)),
                entries: labelRelease.entries,
                roles: [],
              }),
            ),
            catalogSnapshotId: snapshot3,
            createdAt: FINAL,
            itemIds: new Map([[changeItemIdentityKey('new', labelKey), labelItem]]),
            tenantId: tenantA,
          }),
        ),
        scope: scopeA,
      });
      const reread = yield* store.loadTenantChanges(scopeA);
      const inexactLabelPlan = yield* adopt({
        batch: batchLabel,
        decisionId: adoptLabelDecision,
        entries: labelRelease.entries,
        from: reread,
        itemId: labelItem,
        revisionId: roleARevision5,
      });
      // A plan whose cell set is not the current revision plus its own additions writes nothing.
      const inexact = yield* failureOf(
        store.recordAdoption({
          catalogSnapshotId: snapshotIdOf(snapshot3),
          plan: {
            ...inexactLabelPlan,
            roleEdits: inexactLabelPlan.roleEdits.map((edit) => ({ ...edit, cells: [] })),
          },
          scope: scopeA,
        }),
      );
      expect(inexact?.code).toBe('access_changes_record_conflict');
      expect(itemStatus(yield* store.loadTenantChanges(scopeA), labelItem)).toBe('pending');
      // Two writers, one revision: exactly one adoption is stored and the loser stores nothing.
      // Both writers enter the store together, so their compare-and-set really races for the role's
      // current revision instead of the test hoping the pool schedules them closely enough (R4-L7).
      const bothReady = yield* Deferred.make<null>();
      const ready = yield* Ref.make(0);
      const joinRace = Ref.updateAndGet(ready, (count) => count + 1).pipe(
        Effect.flatMap((count) => (count >= 2 ? Deferred.succeed(bothReady, null) : Effect.succeed(false))),
        Effect.asVoid,
        Effect.andThen(Deferred.await(bothReady)),
      );
      const attempts = yield* Effect.forEach(
        [store, otherStore],
        (writer) =>
          joinRace.pipe(
            Effect.andThen(
              writer.recordAdoption({
                catalogSnapshotId: snapshotIdOf(snapshot3),
                plan: inexactLabelPlan,
                scope: scopeA,
              }),
            ),
            Effect.exit,
          ),
        { concurrency: 2 },
      );
      expect(attempts.filter(Exit.isSuccess)).toHaveLength(1);
      expect(attempts.filter(Exit.isFailure)).toHaveLength(1);
      const raced = yield* store.loadTenantChanges(scopeA);
      expect(itemStatus(raced, labelItem)).toBe('adopted');
      expect(currentRevisionOf(raced, roleA)?.revision).toBe(4);
      expect(cellKeys(raced, roleA).toSorted()).toEqual([labelKey, noteKey, tagKey]);
      // The failed writer stored nothing at all: no orphan decision and no second revision.
      const storedRevisions = yield* admin.unsafe<{ readonly revision: number }>(
        `select revision from "core"."access_role_revisions" where tenant_id = '${tenantA}' and role_id = '${roleA}'`,
      );
      expect(storedRevisions.map(({ revision }) => revision)).toEqual([1, 2, 3, 4]);
      const storedLabelDecisions = yield* admin.unsafe<{ readonly decision_id: string }>(
        `select decision_id from "core"."access_change_decisions" where tenant_id = '${tenantA}' and item_id = '${labelItem}'`,
      );
      expect(storedLabelDecisions.map(({ decision_id }) => decision_id)).toEqual([adoptLabelDecision]);
      expect(adoptedBeforeLabel.items.map(({ id }) => id)).toEqual([noteItem, tagItem]);

      // ---- a driver failure is retryable unavailability, never a decision about the data ------
      yield* admin.unsafe('revoke all on "core"."access_change_items" from ontos_runtime');
      const denied = yield* failureOf(store.loadTenantChanges(scopeA));
      expect(denied?.code).toBe('access_changes_store_unavailable');
      yield* admin.unsafe('grant select, insert, update, delete on "core"."access_change_items" to ontos_runtime');
      expect(itemStatus(yield* store.loadTenantChanges(scopeA), labelItem)).toBe('adopted');

      // ---- a permanent integrity refusal is a refusal, never unavailability (R4-M1) ------------
      // A renamed item carries the change it was renamed from, and the table says so in SQL. The store
      // is handed the record it is asked to store, so PostgreSQL refusing it is the answer Core gets —
      // and no retry can ever satisfy that check.
      const renamedWithoutLineage: AccessChangeItem = {
        capabilityKey: CapabilityKeySchema.make(labelKey),
        catalogSnapshotId: snapshotIdOf(snapshot3),
        createdAt: LATEST,
        id: itemIdOf(uid(93)),
        kind: 'renamed',
        lineageFrom: [],
        risk: 'routine',
        status: 'pending',
        suggestedRoleIds: [],
        tenantId: tenantOf(tenantA),
      };
      const integrityRefusal = yield* failureOf(
        store.recordChangeItems({
          plan: { items: [renamedWithoutLineage], preview: previewOf([], LATEST) },
          scope: scopeA,
        }),
      );
      expect(integrityRefusal?.code).toBe('access_changes_write_refused');
      // Nothing of the refused write survived.
      expect((yield* store.loadTenantChanges(scopeA)).items.some(({ id }) => id === uid(93))).toBe(false);

      // ---- the revision that first expresses a role is authored by the same person (R4-L8) ----
      const foreignAuthorRevision = yield* failureOf(
        store.recordRole({
          revision: revisionOf({
            catalogSnapshotId: snapshot1,
            cells: [],
            createdAt: NOW,
            createdBy: principalB,
            id: uid(94),
            revision: 1,
            roleId: uid(95),
            tenantId: tenantA,
          }),
          role: roleOf(uid(95), tenantA, principalA, NOW),
          scope: scopeA,
        }),
      );
      expect(foreignAuthorRevision?.code).toBe('access_changes_scope_mismatch');
      expect((yield* store.loadTenantChanges(scopeA)).roles.some(({ role }) => role.id === uid(95))).toBe(false);
    }),
  );
});
