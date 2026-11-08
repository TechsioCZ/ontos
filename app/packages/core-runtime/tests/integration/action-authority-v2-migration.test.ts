import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, FileSystem, Option, Result, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { decodeActionAuthorityProofV2 } from '../../src/access/approvals/action-authority-v2.ts';
import type { ActionAuthorityProofV2 } from '../../src/access/approvals/action-authority-v2.ts';
import {
  actionCommandQuestionsV2,
  freezeActionCommandV2,
  makeActionCommandV2,
} from '../../src/access/approvals/action-command-v2.ts';
import { freezeCommand } from '../../src/access/approvals/command.ts';
import { CapabilityKeySchema, RecordKeySchema } from '../../src/access/ids.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { actionFor, ownerKey, principal } from '../support/action-command-v2.ts';
import { insertTenantStatement, replacedDatabase, scenarioMigrations } from '../support/access-scenarios/database.ts';
import { makeTestPgClient } from '../support/database.ts';

/*
 * Structural storage proof, not execution admission. Commands come from an original registered
 * Action; proof DTOs refer to real fixture assignment/grant rows. No engine answer, prepared
 * execution lease, production activation or full-target owner execution is claimed by these tests.
 */
const uid = (value: number) => `10000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const scopeId = uid(10);
const roleId = uid(11);
const roleRevisionId = uid(12);
const catalogId = uid(13);
const approverId = uid(14);
const requesterAssignment = uid(15);
const approverAssignment = uid(16);
const proposalId = uid(17);
const mandateId = uid(18);
const historicalProposalId = uid(19);
const historicalMandateId = uid(20);
const writeKey = `${ownerKey}.record.change`;
const writeFieldKey = `${ownerKey}.record.write-salary`;
const readKey = `${ownerKey}.record.read`;
const readFieldKey = `${ownerKey}.record.read-salary`;
const grants = [
  { id: uid(30), key: writeKey, mode: 'propose' },
  { id: uid(31), key: writeFieldKey, mode: 'propose' },
  { id: uid(32), key: writeKey, mode: 'approve' },
  { id: uid(33), key: writeFieldKey, mode: 'approve' },
  { id: uid(34), key: readKey, mode: 'run' },
  { id: uid(35), key: readFieldKey, mode: 'run' },
  { id: uid(36), key: writeKey, mode: 'run' },
] as const;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const preparedMigration = new URL(
  '../../drizzle/20261107052150_prepared-action-authority/migration.sql',
  import.meta.url,
);
const runStatements = (admin: PgClient.PgClient, statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => admin.unsafe(statement), { concurrency: 1, discard: true });

const seedIntent = Effect.fn('AuthorityMigration.seedIntent')(function* seedIntent(admin: PgClient.PgClient) {
  yield* admin.unsafe(insertTenantStatement(principal.tenantId));
  yield* admin.unsafe(
    `insert into core.legal_entities
       (tenant_id, legal_entity_id, legal_name, registration_country, registration_number, status)
     values ($1, $2, 'Authority migration company', 'CZ', 'authority-migration', 'active')`,
    [principal.tenantId, principal.legalEntityId],
  );
  for (const person of [principal.principalId, approverId]) {
    yield* admin.unsafe(
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status)
       values ($1, $2, 'human', 'Authority migration human', 'active')`,
      [principal.tenantId, person],
    );
  }
  yield* admin.unsafe(
    `insert into core.principal_auth_bindings
       (tenant_id, principal_auth_binding_id, principal_id, authentication_namespace_id, provider,
        subject_type, provider_subject_id, status)
     values ($1, $2, $3, 'test.authority-migration.v1', 'fixture', 'user', $4, 'active')`,
    [principal.tenantId, principal.authBindingId, principal.principalId, principal.principalId],
  );
  yield* admin.unsafe(`insert into core.access_scopes (scope_id, tenant_id, legal_entity_id) values ($1, $2, $3)`, [
    scopeId,
    principal.tenantId,
    principal.legalEntityId,
  ]);
  yield* admin.unsafe(
    `insert into core.access_catalog_snapshots (catalog_snapshot_id, digest, published_at)
     values ($1, $2, '2099-01-01T00:00:00Z')`,
    [catalogId, 'a'.repeat(64)],
  );
  for (const key of [writeKey, writeFieldKey, readKey, readFieldKey]) {
    yield* admin.unsafe(
      `insert into core.access_catalog_entries (catalog_snapshot_id, capability_key, entry_json)
       values ($1, $2, $3::jsonb)`,
      [catalogId, key, encodeJson({ key })],
    );
  }
  yield* admin.unsafe(
    `insert into core.access_roles (role_id, tenant_id, created_by, name) values ($1, $2, $3, 'Migration role')`,
    [roleId, principal.tenantId, principal.principalId],
  );
  yield* admin.unsafe(
    `insert into core.access_role_revisions
       (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
     values ($1, $2, $3, 1, $4, $5::jsonb, $6, 'manual')`,
    [
      roleRevisionId,
      principal.tenantId,
      roleId,
      catalogId,
      encodeJson(grants.map((grant) => ({ capabilityKey: grant.key, mode: grant.mode, selector: { _tag: 'all' } }))),
      principal.principalId,
    ],
  );
  for (const [assignmentId, person] of [
    [requesterAssignment, principal.principalId],
    [approverAssignment, approverId],
  ]) {
    yield* admin.unsafe(
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
       values ($1, $2, $3, $4, $5, $6, $6, 'active', '2000-01-01T00:00:00Z')`,
      [assignmentId, principal.tenantId, scopeId, roleId, roleRevisionId, person],
    );
  }
  for (const grant of grants) {
    yield* admin.unsafe(
      `insert into core.access_grant_incarnations
         (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
       values ($1, $2, $3, $4, $5, $6, 'all', $7::jsonb, 'active')`,
      [
        grant.id,
        principal.tenantId,
        scopeId,
        roleId,
        grant.key,
        grant.mode,
        encodeJson({ capabilityKey: grant.key, mode: grant.mode, selector: { _tag: 'all' } }),
      ],
    );
  }
});

const databaseBeforeForward = Effect.gen(function* databaseBeforeForward() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const crypto = yield* Crypto.Crypto;
  const name = `authority_migration_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const control = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* control.unsafe(`create database "${name}"`);
  yield* Effect.addFinalizer(() => control.unsafe(`drop database if exists "${name}" with (force)`).pipe(Effect.orDie));
  const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, name), {
    maxConnections: 1,
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const prepared = yield* fileSystem.readFileString(preparedMigration.pathname);
  const [firstPreparedStatement] = prepared.split('--> statement-breakpoint');
  const migrations = yield* scenarioMigrations;
  const boundary = firstPreparedStatement === undefined ? -1 : migrations.indexOf(firstPreparedStatement);
  expect(boundary).toBeGreaterThan(0);
  // Use the existing immutable-identity selector unchanged. No migration text is rebuilt or edited.
  yield* runStatements(admin, migrations.slice(0, boundary));
  yield* seedIntent(admin);
  return { admin, migrateForward: runStatements(admin, migrations.slice(boundary)) };
});

const grantFor = (key: string, mode: (typeof grants)[number]['mode']) =>
  grants.find((candidate) => candidate.key === key && candidate.mode === mode);

const documents = Effect.gen(function* migrationDocuments() {
  const command = yield* makeActionCommandV2({
    payload: { ids: [RecordKeySchema.make('record-2'), RecordKeySchema.make('record-1')], salary: 25 },
    registration: actionFor(),
    scope: { ...principal, correlationId: 'authority-migration-structural-proof' },
  });
  const commandDigest = Result.getOrThrow(freezeActionCommandV2(command));
  const proofFor = (phase: ActionAuthorityProofV2['phase']) =>
    decodeActionAuthorityProofV2({
      commandDigest,
      format: 'core.action-authority/2',
      phase,
      principalId: phase === 'requester' ? principal.principalId : approverId,
      questions: actionCommandQuestionsV2(command)
        .filter((question) => phase === 'approver' || question.role === 'write')
        .map((question) => {
          const writeMode = phase === 'requester' ? 'propose' : 'approve';
          const writePurpose = phase === 'requester' ? 'request_write' : 'approve_write';
          const mode = question.role === 'governing_read' ? 'run' : writeMode;
          const keys = [question.declaration.key, ...(question.parent === undefined ? [] : [question.parent.key])];
          return {
            capabilityKey: question.declaration.key,
            mode,
            purpose: question.role === 'governing_read' ? 'governing_read' : writePurpose,
            questionHash: question.questionHash,
            target: question.target,
            witnesses: keys.map((key) => {
              const grant = grantFor(key, mode);
              if (grant === undefined) {
                throw new Error('Every structural fixture question has its exact persisted grant');
              }
              return {
                assignmentIncarnationId: phase === 'requester' ? requesterAssignment : approverAssignment,
                capabilityKey: key,
                grantIncarnationId: grant.id,
              };
            }),
          };
        }),
      scopeId,
      targetSetHash: command.targetSetHash,
    });
  return { approver: yield* proofFor('approver'), command, commandDigest, requester: yield* proofFor('requester') };
});
type Documents = Effect.Success<typeof documents>;

const insertProposal = (admin: PgClient.PgClient, document: Documents, proof: Schema.Json) =>
  admin.unsafe(
    `insert into core.access_proposals
       (proposal_id, tenant_id, scope_id, capability_key, command_digest, requester_json,
        requester_principal_id, requester_authority_json, requester_action_authority_json, status, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, '[]'::jsonb, $8::jsonb, 'pending',
             '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`,
    [
      proposalId,
      principal.tenantId,
      scopeId,
      writeKey,
      document.commandDigest,
      encodeJson({ _tag: 'Principal', principalId: principal.principalId }),
      principal.principalId,
      encodeJson(proof),
    ],
  );
const insertFrozen = (admin: PgClient.PgClient, document: Documents) =>
  admin.unsafe(
    `insert into core.access_frozen_commands
       (tenant_id, proposal_id, scope_id, capability_key, command_digest, command_json, action_key)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      principal.tenantId,
      proposalId,
      scopeId,
      writeKey,
      document.commandDigest,
      encodeJson({ capabilityKey: writeKey, payload: document.command }),
      document.command.actionKey,
    ],
  );
const insertMandate = (admin: PgClient.PgClient, document: Documents, proof: Schema.Json) =>
  admin.unsafe(
    `insert into core.access_mandates
       (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest,
        approver_id, approved_at, approval_expires_at, action_authority_json)
     values ($1, $2, $3, $4, $5, $6, $7, '2099-01-01T00:05:00Z', '2099-01-01T01:00:00Z', $8::jsonb)`,
    [
      mandateId,
      proposalId,
      principal.tenantId,
      scopeId,
      writeKey,
      document.commandDigest,
      approverId,
      encodeJson(proof),
    ],
  );
const approve = (admin: PgClient.PgClient) =>
  admin.unsafe(`update core.access_proposals set status = 'approved' where proposal_id = $1`, [proposalId]);
const insertForward = (admin: PgClient.PgClient, document: Documents) =>
  admin.withTransaction(
    Effect.all(
      [
        insertProposal(admin, document, document.requester),
        insertFrozen(admin, document),
        insertMandate(admin, document, document.approver),
        approve(admin),
      ],
      { concurrency: 1, discard: true },
    ),
  );

const expectRefusal = Effect.fn('AuthorityMigration.expectRefusal')(function* expectRefusal<A, R>(
  operation: Effect.Effect<A, SqlError, R>,
  code: '23514' | '55000',
) {
  const failure = yield* Effect.flip(operation);
  expect(Option.getOrThrow(findPostgresFailure(failure)).code).toBe(code);
});

const historicalSnapshot = (admin: PgClient.PgClient) =>
  admin.unsafe<{ readonly document: string }>(
    `select jsonb_build_object(
       'proposals', (select jsonb_agg(to_jsonb(p) - 'requester_action_authority_json')
         from core.access_proposals p where proposal_id = $1),
       'mandates', (select jsonb_agg(to_jsonb(m) - 'action_authority_json')
         from core.access_mandates m where proposal_id = $1),
       'commands', (select jsonb_agg(to_jsonb(f))
         from core.access_frozen_commands f where proposal_id = $1),
       'witnesses', (select jsonb_agg(to_jsonb(g) order by purpose)
         from core.access_mandate_grants g where mandate_id = $2)
     )::text as document`,
    [historicalProposalId, historicalMandateId],
  );

it.layer(NodeServices.layer, { excludeTestServices: true })('native Action authority forward migrations', (suite) => {
  suite.effect(
    'preserves historical scalar commands, RUN witnesses and executed receipts across the actual chain',
    () =>
      Effect.gen(function* preserveHistoricalRecords() {
        const { admin, migrateForward } = yield* databaseBeforeForward;
        const command = {
          capabilityKey: CapabilityKeySchema.make(writeKey),
          payload: { historical: true },
          target: RecordKeySchema.make('historical-record'),
        };
        const digest = Result.getOrThrow(freezeCommand(command));
        const requesterWitness = {
          assignmentIncarnationId: requesterAssignment,
          capabilityKey: writeKey,
          grantIncarnationId: uid(30),
          holderId: { _tag: 'Principal', principalId: principal.principalId },
          mode: 'propose',
          purpose: 'requester',
          scopeId,
        };
        yield* admin.withTransaction(
          Effect.gen(function* seedHistoricalApproval() {
            yield* admin.unsafe(
              `insert into core.access_proposals
             (proposal_id, tenant_id, scope_id, capability_key, command_digest, requester_json,
              requester_principal_id, requester_authority_json, target, status, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, 'approved',
                   '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`,
              [
                historicalProposalId,
                principal.tenantId,
                scopeId,
                writeKey,
                digest,
                encodeJson({ _tag: 'Principal', principalId: principal.principalId }),
                principal.principalId,
                encodeJson([requesterWitness]),
                command.target,
              ],
            );
            yield* admin.unsafe(
              `insert into core.access_frozen_commands
             (tenant_id, proposal_id, scope_id, capability_key, command_digest, command_json, action_key)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
              [
                principal.tenantId,
                historicalProposalId,
                scopeId,
                writeKey,
                digest,
                encodeJson(command),
                `${ownerKey}.change`,
              ],
            );
            yield* admin.unsafe(
              `insert into core.access_mandates
             (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest, approver_id,
              approver_assignment_incarnation_id, execution_assignment_incarnation_id, approved_at, approval_expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8, '2099-01-01T00:05:00Z', '2099-01-01T01:00:00Z')`,
              [
                historicalMandateId,
                historicalProposalId,
                principal.tenantId,
                scopeId,
                writeKey,
                digest,
                approverId,
                approverAssignment,
              ],
            );
            for (const [purpose, mode, grantId] of [
              ['approval', 'approve', uid(32)],
              ['execution', 'run', uid(36)],
            ]) {
              yield* admin.unsafe(
                `insert into core.access_mandate_grants
               (tenant_id, mandate_id, scope_id, capability_key, grant_incarnation_id, assignment_incarnation_id, purpose, mode)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  principal.tenantId,
                  historicalMandateId,
                  scopeId,
                  writeKey,
                  grantId,
                  approverAssignment,
                  purpose,
                  mode,
                ],
              );
            }
            yield* admin.unsafe(
              `update core.access_proposals set status = 'executed', executed_at = '2099-01-01T00:30:00Z',
             execution_operation_id = $1 where proposal_id = $2`,
              [uid(99), historicalProposalId],
            );
          }),
        );
        const before = yield* historicalSnapshot(admin);
        yield* migrateForward;
        expect(yield* historicalSnapshot(admin)).toEqual(before);
        const [formats] = yield* admin.unsafe<{ readonly historical: boolean }>(
          `select p.requester_action_authority_json is null and m.action_authority_json is null as historical
         from core.access_proposals p join core.access_mandates m using (tenant_id, proposal_id)`,
        );
        expect(formats?.historical).toBe(true);
        const document = yield* documents;
        yield* expectRefusal(
          admin.unsafe(`update core.access_proposals set requester_action_authority_json = $1::jsonb`, [
            encodeJson(document.requester),
          ]),
          '55000',
        );
        yield* expectRefusal(
          admin.unsafe(`update core.access_mandates set action_authority_json = $1::jsonb`, [
            encodeJson(document.approver),
          ]),
          '55000',
        );
        expect(yield* historicalSnapshot(admin)).toEqual(before);
      }),
  );

  suite.effect('commits exact complete requester/approver proofs without scalar RUN assignments', () =>
    Effect.gen(function* completeProofStorage() {
      const { admin, migrateForward } = yield* databaseBeforeForward;
      yield* migrateForward;
      const document = yield* documents;
      expect(document.requester.questions).toHaveLength(4);
      expect(document.approver.questions).toHaveLength(8);
      yield* insertForward(admin, document);
      const [stored] = yield* admin.unsafe<{
        readonly action_authority_json: ActionAuthorityProofV2;
        readonly approver_assignment_incarnation_id: string | null;
        readonly execution_assignment_incarnation_id: string | null;
        readonly requester_action_authority_json: ActionAuthorityProofV2;
      }>(
        `select m.action_authority_json, m.approver_assignment_incarnation_id, m.execution_assignment_incarnation_id,
                p.requester_action_authority_json
         from core.access_mandates m join core.access_proposals p using (tenant_id, proposal_id)`,
      );
      expect(stored).toEqual({
        action_authority_json: document.approver,
        approver_assignment_incarnation_id: null,
        execution_assignment_incarnation_id: null,
        requester_action_authority_json: document.requester,
      });
    }),
  );

  suite.effect('rejects incomplete, duplicate, foreign, wrong-mode and parentless requester questions at commit', () =>
    Effect.gen(function* rejectMalformedRequesterProofs() {
      const { admin, migrateForward } = yield* databaseBeforeForward;
      yield* migrateForward;
      const document = yield* documents;
      const [first] = document.requester.questions;
      if (first === undefined) {
        expect.unreachable('The registered Action has requester questions');
      }
      for (const questions of [
        document.requester.questions.slice(1),
        [first, ...document.requester.questions.slice(0, -1)],
        document.requester.questions.map((question) => ({ ...question, mode: 'run' })),
        document.requester.questions.map((question) => ({
          ...question,
          target: { moduleKey: ownerKey, recordKey: 'foreign-record' },
        })),
        document.requester.questions.map((question) => ({ ...question, witnesses: question.witnesses.slice(0, 1) })),
        document.requester.questions.map((question) => ({
          ...question,
          witnesses: question.witnesses.map((witness) => ({ ...witness, assignmentIncarnationId: approverAssignment })),
        })),
      ]) {
        yield* expectRefusal(
          admin.withTransaction(
            Effect.all(
              [insertProposal(admin, document, { ...document.requester, questions }), insertFrozen(admin, document)],
              { concurrency: 1, discard: true },
            ),
          ),
          '23514',
        );
      }
      for (const proof of [
        { ...document.requester, scopeId: uid(98) },
        { ...document.requester, principalId: approverId },
        { ...document.requester, commandDigest: '0'.repeat(64) },
        { ...document.requester, targetSetHash: '0'.repeat(64) },
        { ...document.requester, admissionDeadline: 0 },
      ]) {
        yield* expectRefusal(
          admin.withTransaction(
            Effect.all([insertProposal(admin, document, proof), insertFrozen(admin, document)], {
              concurrency: 1,
              discard: true,
            }),
          ),
          '23514',
        );
      }
      yield* expectRefusal(admin.withTransaction(insertProposal(admin, document, document.requester)), '23514');
      const rows = yield* admin.unsafe(`select proposal_id from core.access_proposals`);
      expect(rows).toHaveLength(0);
    }),
  );

  suite.effect('requires every independent Read question and exact approval mode in an atomic approved pair', () =>
    Effect.gen(function* rejectMalformedApproverProofs() {
      const { admin, migrateForward } = yield* databaseBeforeForward;
      yield* migrateForward;
      const document = yield* documents;
      for (const questions of [
        document.approver.questions.filter((question) => question.purpose !== 'governing_read'),
        document.approver.questions.map((question) => ({ ...question, mode: 'run' })),
        document.approver.questions.map((question) => ({
          ...question,
          witnesses: question.witnesses.map((witness) => ({
            ...witness,
            assignmentIncarnationId: requesterAssignment,
          })),
        })),
      ]) {
        yield* expectRefusal(
          admin.withTransaction(
            Effect.all(
              [
                insertProposal(admin, document, document.requester),
                insertFrozen(admin, document),
                insertMandate(admin, document, { ...document.approver, questions }),
                approve(admin),
              ],
              { concurrency: 1, discard: true },
            ),
          ),
          '23514',
        );
      }
      yield* expectRefusal(
        admin.withTransaction(
          Effect.all(
            [insertProposal(admin, document, document.requester), insertFrozen(admin, document), approve(admin)],
            { concurrency: 1, discard: true },
          ),
        ),
        '23514',
      );
      const rows = yield* admin.unsafe(`select mandate_id from core.access_mandates`);
      expect(rows).toHaveLength(0);
    }),
  );

  suite.effect('refuses retired, revoked and expired forward witnesses without leaving a partial proposal', () =>
    Effect.gen(function* currentWitnessConstraints() {
      const { admin, migrateForward } = yield* databaseBeforeForward;
      yield* migrateForward;
      const document = yield* documents;
      for (const mutation of [
        admin.unsafe(`update core.access_grant_incarnations set status = 'retired' where grant_incarnation_id = $1`, [
          uid(30),
        ]),
        admin.unsafe(`update core.access_assignments set status = 'revoked' where incarnation_id = $1`, [
          requesterAssignment,
        ]),
      ]) {
        yield* expectRefusal(
          admin.withTransaction(
            Effect.all([mutation, insertProposal(admin, document, document.requester), insertFrozen(admin, document)], {
              concurrency: 1,
              discard: true,
            }),
          ),
          '23514',
        );
      }
      const expiredProof = {
        ...document.requester,
        questions: document.requester.questions.map((question) => ({
          ...question,
          witnesses: question.witnesses.map((witness) => ({ ...witness, assignmentIncarnationId: uid(70) })),
        })),
      };
      yield* expectRefusal(
        admin.withTransaction(
          Effect.all(
            [
              admin.unsafe(
                `insert into core.access_assignments
                   (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id,
                    assigned_by, status, valid_from, valid_until)
                 values ($1, $2, $3, $4, $5, $6, $6, 'active', '2000-01-01T00:00:00Z', '2098-12-31T00:00:00Z')`,
                [uid(70), principal.tenantId, scopeId, roleId, roleRevisionId, principal.principalId],
              ),
              insertProposal(admin, document, expiredProof),
              insertFrozen(admin, document),
            ],
            { concurrency: 1, discard: true },
          ),
        ),
        '23514',
      );
      const proposals = yield* admin.unsafe(`select proposal_id from core.access_proposals`);
      const expired = yield* admin.unsafe(
        `select incarnation_id from core.access_assignments where incarnation_id = $1`,
        [uid(70)],
      );
      const [grant] = yield* admin.unsafe<{ readonly status: string }>(
        `select status from core.access_grant_incarnations where grant_incarnation_id = $1`,
        [uid(30)],
      );
      const [assignment] = yield* admin.unsafe<{ readonly status: string }>(
        `select status from core.access_assignments where incarnation_id = $1`,
        [requesterAssignment],
      );
      expect(proposals).toHaveLength(0);
      expect(expired).toHaveLength(0);
      expect(grant?.status).toBe('active');
      expect(assignment?.status).toBe('active');
    }),
  );

  suite.effect('keeps complete forward proofs and frozen commands immutable and refuses scalar witness mixing', () =>
    Effect.gen(function* immutableForwardStorage() {
      const { admin, migrateForward } = yield* databaseBeforeForward;
      yield* migrateForward;
      const document = yield* documents;
      yield* insertForward(admin, document);
      for (const statement of [
        `update core.access_proposals set requester_action_authority_json = null`,
        `update core.access_mandates set action_authority_json = null`,
        `update core.access_frozen_commands set command_json = '{}'::jsonb`,
        `delete from core.access_mandates`,
      ]) {
        yield* expectRefusal(admin.unsafe(statement), '55000');
      }
      yield* expectRefusal(
        admin.unsafe(
          `insert into core.access_mandate_grants
             (tenant_id, mandate_id, scope_id, capability_key, grant_incarnation_id, assignment_incarnation_id, purpose, mode)
           values ($1, $2, $3, $4, $5, $6, 'execution', 'run')`,
          [principal.tenantId, mandateId, scopeId, writeKey, uid(36), approverAssignment],
        ),
        '23514',
      );
      const [stored] = yield* admin.unsafe<{ readonly proof: ActionAuthorityProofV2 }>(
        `select requester_action_authority_json as proof from core.access_proposals`,
      );
      expect(stored?.proof).toEqual(document.requester);
    }),
  );
});
