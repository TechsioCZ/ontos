import { NativeReadTestError, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, desc, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, FileSystem, Layer, Option, Path, Redacted, Result, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import {
  consentDecisions,
  consentScopeBindings,
  privacyRelations,
  privacySubjects,
} from '../../src/database/schema.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { noticeProvisionRepositoryForScope } from '../../src/persistence/notice-provision-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { currentConsentRead } from '../../src/api/current-consent.read.ts';

type NativeConsentContext = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>;

const prepareConsentSubjectFixture = Effect.fn('PrivacyConsentSubjectFixture.prepare')(
  function* prepareConsentSubjectFixture(fixture: NativeConsentContext) {
    const crypto = yield* Crypto.Crypto;
    const nextId = () => crypto.randomUUIDv4();
    const subjectA = yield* nextId();
    const subjectB = yield* nextId();
    const mainScope = `consent:${yield* nextId()}`;
    const raceScope = `consent:${yield* nextId()}`;
    const independentScope = `consent:${yield* nextId()}`;
    const rollbackScope = `consent:${yield* nextId()}`;
    const purpose = yield* fixture.prepareOwner(
      Effect.fn('prepareConsentSubjects')(function* prepareConsentSubjects(transaction, scope) {
        const { principalId, tenantId } = scope;
        const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
        const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
        const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
        const notices = yield* noticeProvisionRepositoryForScope(transaction, scope);
        const createdPurpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
          businessCode: 'CONSENT_SUBJECT_TEST',
          effectiveFrom: '2026-01-01T00:00:00Z',
          governanceOwnerId: principalId,
          meaning: 'Optional email updates for the exact Privacy Subject',
          requiredConsentDimensions: ['COMMUNICATION_CHANNEL'],
        });
        const version = Option.getOrThrow(Option.fromUndefinedOr(createdPurpose.versions[0]));
        for (const subjectId of [subjectA, subjectB]) {
          yield* owner.createSubject(
            { legalEntityId, tenantId },
            {
              actionInvocationId: yield* nextId(),
              subject: {
                createdAt: '2026-01-01T00:00:00Z',
                subject: {
                  anonymousContext: {
                    addressability: 'SESSION',
                    contextRef: `session:${subjectId}`,
                    createdAt: '2026-01-01T00:00:00Z',
                    expiresAt: '2027-01-01T00:00:00Z',
                    kind: 'ANONYMOUS_PRIVACY_CONTEXT',
                    provenance: { method: 'SESSION', source: 'native-consent-test' },
                  },
                  kind: 'ANONYMOUS',
                },
                subjectRef: {
                  moduleId: 'privacy.core',
                  resourceId: subjectId,
                  resourceType: 'privacy.core.privacy-subject',
                  tenantId,
                },
                updatedAt: '2026-01-01T00:00:00Z',
              },
            },
          );
          for (const scopeRef of [mainScope, raceScope, independentScope, rollbackScope]) {
            const notice = yield* owner.createNoticeVersion(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                input: {
                  applicableScope: {
                    facts: [
                      { dimension: 'PRIVACY_SUBJECT', value: subjectId },
                      { dimension: 'CONTROLLER_SCOPE', value: 'controller:subject-binding' },
                      { dimension: 'PROCESSING_PURPOSE', value: createdPurpose.purposeRef.resourceId },
                      { dimension: 'PROCESSING_PURPOSE_VERSION', value: version.versionId },
                      { dimension: 'CHANNEL', value: 'EMAIL' },
                    ],
                    operation: 'CONSENT_DECISION',
                    processingScopeRef: { scopeId: scopeRef, scopeType: 'privacy.processing-scope' },
                  },
                  contentIdentity: `notice:${subjectId}:${scopeRef}`,
                  effectiveFrom: '2026-01-01T00:00:00Z',
                  evidenceArtifactRef: null,
                  language: 'en',
                  wording: 'Choose optional email updates.',
                },
                noticeId: yield* nextId(),
              },
            );
            const provisionId = `provision:${subjectId}:${scopeRef}`;
            const evidenceRef = `evidence:${subjectId}:${scopeRef}`;
            const interaction = `interaction:${subjectId}:${scopeRef}`;
            yield* notices.record(tenantId, legalEntityId, yield* nextId(), {
              actionRef: 'native-consent-subject-binding',
              anonymousContextRef: null,
              businessInteractionRef: interaction,
              channel: 'web',
              channelProof: {
                anonymousContextRef: null,
                authorityRef: 'native-owner-interaction',
                businessInteractionRef: interaction,
                channel: 'web',
                controllerRef: 'controller:subject-binding',
                evidenceRef,
                noticeVersionRef: notice.versionId,
                observedAt: '2026-01-01T00:00:01Z',
                privacySubjectRef: subjectId,
                processingPurposeRef: createdPurpose.purposeRef.resourceId,
                processingScopeRef: scopeRef,
                proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
                providedLanguage: 'en',
              },
              controllerRef: 'controller:subject-binding',
              evidenceRef,
              failureReason: null,
              noticeVersionRef: notice.versionId,
              outcome: 'PROVEN_PROVISION',
              privacySubjectRef: subjectId,
              processingPurposeRef: createdPurpose.purposeRef.resourceId,
              processingScopeRef: scopeRef,
              providedLanguage: 'en',
              provisionedAt: '2026-01-01T00:00:01Z',
              provisionId,
              recordedAt: '2026-01-01T00:00:02Z',
              supersedesProvisionRef: null,
            });
          }
        }
        return createdPurpose;
      }),
    );
    const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions[0]));
    const consent = (
      subjectId: string,
      scopeRef: string,
      kind: ConsentDecision['decision'],
      effectiveAt: string,
    ): ConsentDecision => ({
      actorEvidence: {
        actor: { principalId: fixture.principal.principalId, tenantId: fixture.principal.tenantId },
        attributedAt: effectiveAt,
        authMethod: 'session',
        impersonatedBy: null,
      },
      decision: kind,
      decisionId: `decision:${subjectId}:${scopeRef}:${effectiveAt}`,
      effectiveAt,
      flowEvidenceRefs: [],
      idempotencyKey: `key:${subjectId}:${scopeRef}:${effectiveAt}`,
      noticeEvidenceRefs: [`provision:${subjectId}:${scopeRef}`],
      provenanceRefs: ['native-owner-consent'],
      recordedAt: effectiveAt,
      scope: {
        controllerRef: 'controller:subject-binding',
        materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }],
        privacySubjectRef: {
          moduleId: 'privacy.core',
          resourceId: subjectId,
          resourceType: 'privacy.core.privacy-subject',
          tenantId: fixture.principal.tenantId,
        },
        processingPurposeRef: purpose.purposeRef,
        purposeMeaning: version.meaning,
        purposeVersionRef: version.versionId,
        scopeRef,
      },
    });
    const write = (invocation: string, decision: ConsentDecision) =>
      fixture.prepareOwner(
        Effect.fn('recordNativeConsent')(function* recordNativeConsent(transaction, scope) {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          return yield* repository.recordConsentDecision(
            scope.tenantId,
            Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
            invocation,
            decision,
          );
        }),
      );
    const read = (scopeRef: string) =>
      fixture.prepareOwner(
        Effect.fn('readNativeConsent')(function* readNativeConsent(transaction, scope) {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          return yield* repository.readCurrentConsent(
            scope.tenantId,
            Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
            scopeRef,
          );
        }),
      );
    return {
      consent,
      independentScope,
      mainScope,
      nextId,
      purpose,
      raceScope,
      read,
      rollbackScope,
      subjectA,
      subjectB,
      write,
    };
  },
);

it.live('binds native Consent history to one exact Subject across valid competing writes, replay and races', () =>
  Effect.scoped(
    Effect.gen(function* nativeConsentSubjectBinding() {
      const fixture = yield* makeNativeReadTestContext({
        contextPermissions: ['privacy.consent.read'],
        moduleId: 'privacy.core',
        ownerFixtureRetention: 'retain-complete-context',
      });
      yield* Effect.gen(function* consentSubjectAssertions() {
        const {
          consent,
          independentScope,
          mainScope,
          nextId,
          raceScope,
          read,
          rollbackScope,
          subjectA,
          subjectB,
          write,
        } = yield* prepareConsentSubjectFixture(fixture);
        const withdrawal = consent(subjectA, mainScope, 'WITHDRAWN', '2026-02-01T00:00:00Z');
        const invocation = yield* nextId();
        yield* write(invocation, withdrawal);
        expect(yield* write(invocation, withdrawal)).toEqual(withdrawal);
        const laterB = consent(subjectB, mainScope, 'GRANTED', '2026-03-01T00:00:00Z');
        expect(yield* Effect.flip(write(yield* nextId(), laterB))).toMatchObject({
          code: 'privacy_operation_conflict',
        });
        expect(yield* read(mainScope)).toEqual({ decision: withdrawal, outcome: 'CURRENT' });
        const evidenceBefore = yield* fixture.evidenceCount();
        const governed = yield* fixture.runtime.runRead({
          input: { scopeRefs: [mainScope] },
          principal: fixture.principal,
          registration: currentConsentRead,
          transport: { correlationId: 'privacy-native-consent-subject-binding' },
        });
        expect(governed.items[0]?.resolution).toEqual({ decision: withdrawal, outcome: 'CURRENT' });
        expect(yield* fixture.evidenceCount()).toBe(evidenceBefore + 1);
        expect(yield* Effect.flip(write(invocation, laterB))).toMatchObject({ code: 'privacy_operation_conflict' });
        expect(
          yield* Effect.flip(write(yield* nextId(), consent(subjectB, mainScope, 'GRANTED', withdrawal.effectiveAt))),
        ).toMatchObject({ code: 'privacy_operation_conflict' });
        const nativeMismatch = yield* Effect.flip(
          fixture.prepareOwner(
            Effect.fn('rejectNativeSubjectSubstitution')(function* rejectNativeSubjectSubstitution(transaction, scope) {
              return yield* transaction.insert(consentDecisions).values({
                actionInvocationId: yield* nextId(),
                decision: laterB.decision,
                decisionId: 'decision:native-substitution',
                decisionRecord: Schema.encodeSync(ConsentDecisionSchema)(laterB),
                effectiveAt: new Date(laterB.effectiveAt),
                idempotencyKey: 'key:native-substitution',
                legalEntityId: Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
                recordedAt: new Date(laterB.recordedAt),
                scopeRef: mainScope,
                tenantId: scope.tenantId,
              });
            }),
          ),
        );
        expect(Option.getOrThrow(findPostgresFailure(nativeMismatch))).toMatchObject({
          code: '23514',
          constraint: 'privacy_consent_subject_binding_ck',
        });
        for (const mutate of [
          fixture.prepareOwner(
            Effect.fn('cannotChangeConsentBinding')(function* cannotChangeConsentBinding(transaction) {
              return yield* transaction
                .update(consentScopeBindings)
                .set({ privacySubjectId: subjectB })
                .where(eq(consentScopeBindings.scopeRef, mainScope));
            }),
          ),
          fixture.prepareOwner(
            Effect.fn('cannotDeleteConsentBinding')(function* cannotDeleteConsentBinding(transaction) {
              return yield* transaction
                .delete(consentScopeBindings)
                .where(eq(consentScopeBindings.scopeRef, mainScope));
            }),
          ),
        ]) {
          expect(Option.getOrThrow(findPostgresFailure(yield* Effect.flip(mutate)))).toMatchObject({ code: '42501' });
        }
        const foreignId = yield* nextId();
        for (const dimension of ['tenant', 'legal-entity'] as const) {
          const foreignInsert = yield* Effect.flip(
            fixture.prepareOwner(
              Effect.fn('rejectForeignConsentBinding')(function* rejectForeignConsentBinding(transaction, scope) {
                return yield* transaction.insert(consentScopeBindings).values({
                  legalEntityId:
                    dimension === 'legal-entity'
                      ? foreignId
                      : Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
                  privacySubjectId: subjectA,
                  scopeRef: `foreign:${dimension}`,
                  tenantId: dimension === 'tenant' ? foreignId : scope.tenantId,
                });
              }),
            ),
          );
          expect(Option.getOrThrow(findPostgresFailure(foreignInsert))).toMatchObject({ code: '42501' });
        }
        const rollbackDecision = consent(subjectB, rollbackScope, 'GRANTED', '2026-03-01T00:00:00Z');
        yield* fixture
          .prepareOwner(
            Effect.fn('rollbackConsentAndBinding')(function* rollbackConsentAndBinding(transaction, scope) {
              const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
              yield* repository.recordConsentDecision(
                scope.tenantId,
                Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
                yield* nextId(),
                rollbackDecision,
              );
              return yield* Effect.fail(
                new PrivacyOperationPersistenceError({
                  code: 'privacy_operation_conflict',
                  reason: 'Intentional test transaction rollback',
                }),
              );
            }),
          )
          .pipe(Effect.flip);
        expect(yield* read(rollbackScope)).toEqual({ outcome: 'ABSENT' });
        const afterRollback = consent(subjectA, rollbackScope, 'GRANTED', '2026-03-01T00:00:00Z');
        expect(yield* write(yield* nextId(), afterRollback)).toEqual(afterRollback);
        const regrant = consent(subjectA, mainScope, 'GRANTED', '2026-04-01T00:00:00Z');
        expect(yield* write(yield* nextId(), regrant)).toEqual(regrant);
        expect(yield* read(mainScope)).toEqual({ decision: regrant, outcome: 'CURRENT' });
        const ownB = consent(subjectB, independentScope, 'GRANTED', '2026-03-01T00:00:00Z');
        expect(yield* write(yield* nextId(), ownB)).toEqual(ownB);
        const raceA = consent(subjectA, raceScope, 'GRANTED', '2026-02-01T00:00:00Z');
        const raceB = consent(subjectB, raceScope, 'GRANTED', '2026-03-01T00:00:00Z');
        const invocations = yield* Effect.all([nextId(), nextId()]);
        const races = yield* Effect.all(
          [Effect.result(write(invocations[0], raceA)), Effect.result(write(invocations[1], raceB))],
          { concurrency: 2 },
        );
        expect(races.filter(Result.isSuccess)).toHaveLength(1);
        expect(races.filter(Result.isFailure)).toHaveLength(1);
        for (const result of races) {
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ code: 'privacy_operation_conflict' });
          }
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

const recordBaselineConsentDecision = Effect.fn('PrivacyConsentLegacyFixture.recordBaselineDecision')(
  function* recordBaselineConsentDecision(fixture: NativeConsentContext, decision: ConsentDecision) {
    const crypto = yield* Crypto.Crypto;
    return yield* fixture.prepareOwner(
      Effect.fn('recordBaselineConsentDecisionRows')(function* recordBaselineConsentDecisionRows(transaction, scope) {
        const decoded = yield* Schema.decodeUnknownEffect(ConsentDecisionSchema)(decision);
        return yield* transaction.insert(consentDecisions).values({
          actionInvocationId: yield* crypto.randomUUIDv4(),
          decision: decoded.decision,
          decisionId: decoded.decisionId,
          decisionRecord: Schema.encodeSync(ConsentDecisionSchema)(decoded),
          effectiveAt: new Date(decoded.effectiveAt),
          idempotencyKey: decoded.idempotencyKey ?? null,
          legalEntityId: Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
          recordedAt: new Date(decoded.recordedAt),
          scopeRef: decoded.scope.scopeRef,
          tenantId: scope.tenantId,
        });
      }),
    );
  },
);

const readNativeConsentHistory = Effect.fn('PrivacyConsentLegacyFixture.history')(function* readNativeConsentHistory(
  fixture: NativeConsentContext,
  scopeRef: string,
) {
  return yield* fixture.prepareOwner(
    Effect.fn('readBaselineConsentRows')(function* readBaselineConsentRows(transaction, scope) {
      const rows = yield* transaction
        .select({ record: consentDecisions.decisionRecord })
        .from(consentDecisions)
        .where(
          and(
            eq(consentDecisions.tenantId, scope.tenantId),
            eq(consentDecisions.legalEntityId, Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId))),
            eq(consentDecisions.scopeRef, scopeRef),
          ),
        )
        .orderBy(desc(consentDecisions.effectiveAt));
      return yield* Schema.decodeUnknownEffect(Schema.Array(ConsentDecisionSchema))(rows.map(({ record }) => record));
    }),
  );
});

const legacyNativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live(
  'preserves ambiguous legacy Consent history across the actual forward migration without assigning a Subject winner',
  () =>
    Effect.scoped(
      Effect.gen(function* legacyConsentSubjectMigration() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1260-privacy-legacy',
        });
        const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        expect(isolated.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
        expect(isolated.connections.admin.database).not.toBe(source.admin.database);
        expect(isolated.connections.runtime.database).toBe(isolated.connections.admin.database);
        expect(isolated.connections.admin.user).not.toBe(isolated.connections.runtime.user);
        yield* isolated.migrateCoreSchema();
        const filesystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ownerHistory = new URL('../../drizzle/', import.meta.url).pathname;
        const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-privacy-legacy-' });
        const baseline = path.join(temporary, 'migrations');
        yield* filesystem.makeDirectory(baseline);
        const forwardMigration = '20261019115713_consent_scope_subject_binding';
        const folders = (yield* filesystem.readDirectory(ownerHistory)).filter(
          (folder) => /^\d{14}_/u.test(folder) && folder < forwardMigration,
        );
        expect(folders.length).toBeGreaterThan(0);
        for (const folder of folders) {
          yield* filesystem.copy(path.join(ownerHistory, folder), path.join(baseline, folder));
        }
        const client = PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        );
        const clientServices = yield* Layer.build(client);
        const ownerAdmin = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
          Effect.provide(clientServices),
        );
        const configurationPath = path.join(temporary, 'drizzle.config.mjs');
        yield* filesystem.writeFileString(
          configurationPath,
          `export default {
          dialect: 'postgresql',
          out: process.env.ONTOS_PRIVACY_LEGACY_MIGRATIONS,
          schema: process.env.ONTOS_PRIVACY_LEGACY_SCHEMA,
          dbCredentials: { url: process.env.DATABASE_ADMIN_URL },
          migrations: { schema: 'drizzle', table: '__drizzle_migrations_privacy' }
        };`,
        );
        const migrateHistory = Effect.fn('PrivacyConsentLegacyFixture.migrateHistory')(function* migrateHistory(
          folder: string,
          phase: string,
        ) {
          const migration = yield* ChildProcess.make(
            'mise',
            [
              'exec',
              '--',
              'pnpm',
              '--filter',
              '@app/privacy',
              'exec',
              'drizzle-kit',
              'migrate',
              '--config',
              configurationPath,
            ],
            {
              cwd: new URL('../../../../', import.meta.url).pathname,
              env: {
                DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
                DATABASE_URL: isolated.connections.runtime.connectionString,
                ONTOS_PRIVACY_LEGACY_MIGRATIONS: folder,
                ONTOS_PRIVACY_LEGACY_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
              },
              extendEnv: true,
              stderr: 'pipe',
              stdout: 'pipe',
            },
          );
          const result = yield* Effect.all(
            {
              exitCode: migration.exitCode,
              stderr: migration.stderr.pipe(Stream.decodeText, Stream.runCollect),
              stdout: migration.stdout.pipe(Stream.decodeText, Stream.runCollect),
            },
            { concurrency: 3 },
          );
          if (result.exitCode !== 0) {
            let output = [...result.stdout, ...result.stderr]
              .join('')
              .replaceAll(/postgres(?:ql)?:\/\/[^\s"']+/gu, '[redacted database URL]');
            for (const configuration of [isolated.connections.admin, isolated.connections.runtime]) {
              const { password } = new URL(configuration.connectionString);
              for (const secret of [password, decodeURIComponent(password)]) {
                if (secret.length > 0) {
                  output = output.replaceAll(secret, '[redacted]');
                }
              }
            }
            yield* Effect.logError('Isolated Privacy migration CLI failed', {
              exitCode: result.exitCode,
              output,
              phase,
            });
            return yield* new NativeReadTestError({
              code: 'native_read_test_failed',
              reason: 'Isolated Privacy migration CLI failed',
            });
          }
          return yield* Effect.void;
        });
        yield* migrateHistory(baseline, 'baseline').pipe(
          Effect.mapError(
            (cause) =>
              new NativeReadTestError({
                cause: Redacted.make(cause),
                code: 'native_read_test_failed',
                reason: 'Isolated Privacy baseline migration failed',
              }),
          ),
        );
        const identity = yield* ownerAdmin.execute<{ readonly binding_absent: boolean; readonly database: string }>(
          sql`select current_database()::text as database, to_regclass('privacy.consent_scope_bindings') is null as binding_absent`,
          'objects',
        );
        expect(identity).toEqual([{ binding_absent: true, database: isolated.connections.admin.database }]);
        expect(yield* ownerAdmin.select().from(privacySubjects)).toEqual([]);
        expect(yield* ownerAdmin.select().from(consentDecisions)).toEqual([]);
        // Minimal ordinary owner privileges needed by the historical supported producers.
        // Immutable triggers and runtime RLS remain enabled throughout both migration phases.
        const runtimeRole = sql.identifier(isolated.connections.runtime.user);
        yield* ownerAdmin.execute(sql`grant usage on schema privacy to ${runtimeRole}`, 'objects');
        yield* ownerAdmin.execute(
          sql`grant select,insert on all tables in schema privacy to ${runtimeRole}`,
          'objects',
        );
        const fixture = yield* makeNativeReadTestContext({
          connections: {
            admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
            runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
          },
          contextPermissions: ['privacy.consent.read'],
          moduleId: 'privacy.core',
          ownerFixtureRetention: 'retain-complete-context',
        });
        yield* Effect.gen(function* legacyConsentAssertions() {
          const {
            consent,
            independentScope,
            mainScope,
            nextId,
            raceScope,
            read,
            rollbackScope,
            subjectA,
            subjectB,
            write,
          } = yield* prepareConsentSubjectFixture(fixture);
          // The immutable baseline writer at 0325cbf9 (recordConsentDecision .insert values)
          // admitted these individually valid decisions. Execute that small SQL ABI only on
          // the baseline schema, using actual Subject/Purpose/exact Notice producers above.
          const withdrawnA = consent(subjectA, mainScope, 'WITHDRAWN', '2026-02-01T00:00:00Z');
          const grantedB = consent(subjectB, mainScope, 'GRANTED', '2026-03-01T00:00:00Z');
          const sameTimeA = consent(subjectA, raceScope, 'WITHDRAWN', '2026-02-01T00:00:00Z');
          const sameTimeB = consent(subjectB, raceScope, 'GRANTED', '2026-02-01T00:00:00Z');
          const unambiguous = consent(subjectA, independentScope, 'GRANTED', '2026-02-01T00:00:00Z');
          const onlyB = consent(subjectB, rollbackScope, 'GRANTED', '2026-02-01T00:00:00Z');
          for (const decision of [withdrawnA, grantedB, sameTimeA, sameTimeB, unambiguous, onlyB]) {
            yield* recordBaselineConsentDecision(fixture, decision);
          }
          const before = yield* readNativeConsentHistory(fixture, mainScope);
          expect(before).toEqual([grantedB, withdrawnA]);
          yield* migrateHistory(ownerHistory, 'forward').pipe(
            Effect.mapError(
              (cause) =>
                new NativeReadTestError({
                  cause: Redacted.make(cause),
                  code: 'native_read_test_failed',
                  reason: 'Isolated Privacy forward migration failed',
                }),
            ),
          );
          expect(yield* readNativeConsentHistory(fixture, mainScope)).toEqual(before);
          expect(yield* read(mainScope)).toMatchObject({ outcome: 'CONFLICT', reason: 'SUBJECT_BINDING_CONFLICT' });
          expect(yield* read(raceScope)).toMatchObject({ outcome: 'CONFLICT', reason: 'SUBJECT_BINDING_CONFLICT' });
          expect(yield* read(independentScope)).toEqual({ decision: unambiguous, outcome: 'CURRENT' });
          for (const subjectId of [subjectA, subjectB]) {
            expect(
              yield* Effect.flip(
                write(yield* nextId(), consent(subjectId, mainScope, 'GRANTED', '2026-04-01T00:00:00Z')),
              ),
            ).toMatchObject({ code: 'privacy_operation_conflict' });
          }
          expect(
            yield* Effect.flip(
              write(yield* nextId(), consent(subjectA, rollbackScope, 'GRANTED', '2026-04-01T00:00:00Z')),
            ),
          ).toMatchObject({ code: 'privacy_operation_conflict' });
          const bindingsBeforeClaim = yield* fixture.prepareOwner(
            Effect.fn('readUnassignedLegacyBindings')(function* readUnassignedLegacyBindings(transaction) {
              return yield* transaction.select().from(consentScopeBindings);
            }),
          );
          expect(bindingsBeforeClaim).toEqual([]);
          const validRegrant = consent(subjectA, independentScope, 'GRANTED', '2026-04-01T00:00:00Z');
          expect(yield* write(yield* nextId(), validRegrant)).toEqual(validRegrant);
          expect(yield* read(independentScope)).toEqual({ decision: validRegrant, outcome: 'CURRENT' });
          expect(yield* readNativeConsentHistory(fixture, mainScope)).toEqual(before);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ).pipe(Effect.provide(legacyNativeServices)),
);
