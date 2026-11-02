import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq, getTableName, sql } from 'drizzle-orm';
import { Clock, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { PrivacyNoticeAcknowledgementSchema } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import type { PrivacyNoticeAcknowledgement } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import { noticeAcknowledgements } from '../../src/database/schema.ts';
import { noticeAcknowledgementRepositoryForScope } from '../../src/persistence/notice-provision-postgres-repository.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';

class AcknowledgementRollback extends Schema.TaggedError<AcknowledgementRollback>()('AcknowledgementRollback', {}) {}

/** Persistence fixtures only: these records establish neither Current authority nor a public acknowledgement. */
it.live(
  'retains one acknowledgement across concurrent invocations and enforces native rollback, RLS and immutability',
  () =>
    Effect.gen(function* nativeAcknowledgementLedger() {
      // The snapshot is required isolation-fixture configuration only; no composition authority is published.
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: yield* makeApplicationCompositionSnapshotFixture(),
        mode: 'schema-only',
        purpose: 'stabilization-1261-retained-purpose-withdrawal',
      });
      // Run the required verifier only against this owned disposable database.
      const appRoot = new URL('../../../../', import.meta.url).pathname;
      const verifier = yield* ChildProcess.make(
        'mise',
        ['exec', '--', 'pnpm', '--filter', '@app/privacy', 'db:verify'],
        {
          cwd: appRoot,
          env: {
            APP_ENV_PATH: '/dev/null',
            DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
            DATABASE_URL: isolated.connections.runtime.connectionString,
          },
          extendEnv: true,
          stderr: 'pipe',
          stdout: 'pipe',
        },
      );
      const [verificationExit] = yield* Effect.all(
        [verifier.exitCode, Stream.runDrain(verifier.stdout), Stream.runDrain(verifier.stderr)],
        { concurrency: 'unbounded' },
      );
      expect(verificationExit).toBe(0);
      yield* Effect.logInfo('Retained isolated Privacy schema verifier passed');
      const connections = {
        admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
        runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
      };
      const native = yield* makeNativeReadTestContext({
        connections,
        contextPermissions: [],
        moduleId: 'privacy.core',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const inScope = <Value, Failure, Requirements>(
        producer: (
          transaction: ScopedTransactionExecutor,
          scope: OperationalScope,
        ) => Effect.Effect<Value, Failure, Requirements>,
      ) => native.prepareOwner(producer).pipe(Effect.provide(native.layer));
      const crypto = yield* Crypto.Crypto;
      const nextId = () => crypto.randomUUIDv4();
      const servedAt = DateTime.formatIso(yield* DateTime.now);
      const subjectId = yield* nextId();
      const presentationId = yield* nextId();
      const noticeId = yield* nextId();
      const { principalId, tenantId } = native.principal;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
      const bindingId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.authBindingId));

      const fixture = yield* inScope(
        Effect.fn('NoticeAcknowledgementNative.prepare')(function* prepare(transaction, scope) {
          const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
          const operations = yield* privacyOperationRepositoryForScope(transaction, scope);
          const purpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
            businessCode: 'NOTICE_ACK_LEDGER_TEST',
            effectiveFrom: servedAt,
            governanceOwnerId: principalId,
            meaning: 'Native acknowledgement persistence fixture',
            requiredConsentDimensions: [],
          });
          const purposeVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions[0]));
          const subjectRef = {
            moduleId: 'privacy.core' as const,
            resourceId: subjectId,
            resourceType: 'privacy.core.privacy-subject' as const,
            tenantId,
          };
          yield* operations.createSubject(
            { legalEntityId, tenantId },
            {
              actionInvocationId: yield* nextId(),
              subject: {
                createdAt: servedAt,
                subject: {
                  anonymousContext: {
                    addressability: 'SESSION',
                    contextRef: `native-ack-ledger:${subjectId}`,
                    createdAt: servedAt,
                    expiresAt: DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(servedAt), '1 day')),
                    kind: 'ANONYMOUS_PRIVACY_CONTEXT',
                    provenance: { method: 'SESSION', source: 'native-ack-ledger-fixture' },
                  },
                  kind: 'ANONYMOUS',
                },
                subjectRef,
                updatedAt: servedAt,
              },
            },
          );
          const processingScopeRef = {
            scopeId: `native-ack:${presentationId}`,
            scopeType: 'privacy.processing-scope' as const,
          };
          const notice = yield* operations.createNoticeVersion(
            { legalEntityId, tenantId },
            {
              actionInvocationId: yield* nextId(),
              input: {
                applicableScope: {
                  facts: [
                    { dimension: 'PRIVACY_SUBJECT', value: subjectId },
                    { dimension: 'CONTROLLER_SCOPE', value: 'controller:native-ack-ledger' },
                    { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
                    { dimension: 'PROCESSING_PURPOSE_VERSION', value: purposeVersion.versionId },
                  ],
                  operation: 'CONSENT_DECISION',
                  processingScopeRef,
                },
                contentIdentity: `native-ack-notice:${noticeId}`,
                effectiveFrom: servedAt,
                evidenceArtifactRef: null,
                language: 'en',
                wording: 'Owner-local native persistence fixture; no public delivery or authority is claimed.',
              },
              noticeId,
            },
          );
          return { notice, processingScopeRef, purpose, purposeVersion, subjectRef };
        }),
      );

      const candidate = Effect.fn('NoticeAcknowledgementNative.candidate')(function* candidate() {
        const acknowledgedAt = DateTime.formatIso(yield* DateTime.now);
        return yield* Schema.decodeUnknownEffect(PrivacyNoticeAcknowledgementSchema)({
          acknowledgedAt,
          acknowledgementId: yield* nextId(),
          actionInvocationId: yield* nextId(),
          actorPrincipalId: principalId,
          applicableScopeDigest: 'a'.repeat(64),
          authBindingId: bindingId,
          authenticationNamespaceId: native.principal.authenticationNamespaceId,
          authorityEvidenceRefs: ['native:persistence-fixture-not-current-authority'],
          businessInteractionRef: `native-ack:${presentationId}`,
          contentIdentity: fixture.notice.contentIdentity,
          controllerRef: 'controller:native-ack-ledger',
          language: fixture.notice.language,
          legalEntityId,
          noticeVersionId: fixture.notice.versionId,
          presentationId,
          privacySubjectRef: fixture.subjectRef,
          processingPurposeRef: fixture.purpose.purposeRef.resourceId,
          processingScopeRef: fixture.processingScopeRef,
          purposeVersionId: fixture.purposeVersion.versionId,
          recordedAt: acknowledgedAt,
          retailProfileId: `native:persistence-profile:${subjectId}`,
          servedAt,
          sessionContextDigest: 'b'.repeat(64),
          tenantId,
          wordingDigest: 'c'.repeat(64),
        });
      });
      const record = (acknowledgement: PrivacyNoticeAcknowledgement) =>
        inScope(
          Effect.fn('NoticeAcknowledgementNative.record')(function* recordAcknowledgement(transaction, scope) {
            const repository = yield* noticeAcknowledgementRepositoryForScope(transaction, scope);
            return yield* repository.record(acknowledgement);
          }),
        );
      const read = (id: string) =>
        inScope(
          Effect.fn('NoticeAcknowledgementNative.read')(function* readAcknowledgement(transaction, scope) {
            const repository = yield* noticeAcknowledgementRepositoryForScope(transaction, scope);
            return yield* repository.findByPresentation(id);
          }),
        );

      const first = yield* candidate();
      const second = yield* candidate();
      expect(first.actionInvocationId).not.toBe(second.actionInvocationId);
      const results = yield* Effect.all([record(first), record(second)], { concurrency: 2 });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(results[1]);
      const retained = Option.getOrThrow(Option.fromUndefinedOr(results[0]));
      expect([first.acknowledgementId, second.acknowledgementId]).toContain(retained.acknowledgementId);
      // Each call constructs a new owner repository in a new committed transaction. This is durable readback, not process restart.
      expect(Option.getOrThrow(yield* read(presentationId))).toEqual(retained);
      expect(yield* record(yield* candidate())).toEqual(retained);
      const persisted = yield* inScope((transaction) =>
        transaction
          .select()
          .from(noticeAcknowledgements)
          .where(eq(noticeAcknowledgements.presentationId, presentationId)),
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.acknowledgementRecord).toEqual(retained);
      expect(persisted[0]?.acknowledgedAt.toISOString()).toBe(retained.acknowledgedAt);
      const row = Option.getOrThrow(Option.fromUndefinedOr(persisted[0]));
      const duplicateInvocation = {
        ...retained,
        acknowledgementId: yield* nextId(),
        presentationId: yield* nextId(),
      };
      const duplicateInvocationFailure = yield* inScope((transaction) =>
        transaction.insert(noticeAcknowledgements).values({
          ...row,
          acknowledgementId: duplicateInvocation.acknowledgementId,
          acknowledgementRecord: duplicateInvocation,
          presentationId: duplicateInvocation.presentationId,
        }),
      ).pipe(Effect.flip);
      expect(Option.getOrThrow(findPostgresFailure(duplicateInvocationFailure))).toMatchObject({
        code: '23505',
        constraint: 'privacy_notice_ack_invocation_uk',
      });
      expect(Option.isNone(yield* read(duplicateInvocation.presentationId))).toBe(true);

      const conflict = yield* Effect.flip(record({ ...(yield* candidate()), wordingDigest: 'd'.repeat(64) }));
      expect(conflict).toMatchObject({ code: 'privacy_notice_acknowledgement_conflict' });
      expect(Option.getOrThrow(yield* read(presentationId))).toEqual(retained);

      const rollback = { ...(yield* candidate()), presentationId: yield* nextId() };
      const rolledBack = yield* inScope(
        Effect.fn('NoticeAcknowledgementNative.rollback')(function* rollbackWrite(transaction, scope) {
          const repository = yield* noticeAcknowledgementRepositoryForScope(transaction, scope);
          yield* repository.record(rollback);
          return yield* new AcknowledgementRollback();
        }),
      ).pipe(Effect.flip);
      expect(Schema.is(AcknowledgementRollback)(rolledBack)).toBe(true);
      expect(Option.isNone(yield* read(rollback.presentationId))).toBe(true);

      for (const mutation of [
        inScope((transaction) =>
          transaction
            .update(noticeAcknowledgements)
            .set({ retailProfileId: 'changed' })
            .where(eq(noticeAcknowledgements.acknowledgementId, retained.acknowledgementId)),
        ),
        inScope((transaction) =>
          transaction
            .delete(noticeAcknowledgements)
            .where(eq(noticeAcknowledgements.acknowledgementId, retained.acknowledgementId)),
        ),
      ]) {
        const failure = yield* Effect.flip(mutation);
        expect(Option.getOrThrow(findPostgresFailure(failure))).toMatchObject({ code: '42501' });
      }
      expect(Option.getOrThrow(yield* read(presentationId))).toEqual(retained);

      // Deliberately bypass repository scope predicates with owner-local typed SQL to prove the actual runtime role's RLS.
      const foreign = yield* makeNativeReadTestContext({
        connections,
        contextPermissions: [],
        moduleId: 'privacy.core',
        ownerFixtureRetention: 'retain-complete-context',
      });
      const foreignRows = yield* foreign
        .prepareOwner((transaction) =>
          transaction
            .select()
            .from(noticeAcknowledgements)
            .where(eq(noticeAcknowledgements.acknowledgementId, retained.acknowledgementId)),
        )
        .pipe(Effect.provide(foreign.layer));
      expect(foreignRows).toEqual([]);
      for (const dimension of ['tenant', 'legal-entity'] as const) {
        const substituted = yield* nextId();
        const insert = yield* inScope((transaction) =>
          transaction.insert(noticeAcknowledgements).values({
            ...row,
            acknowledgementId: substituted,
            acknowledgementRecord: {
              ...retained,
              acknowledgementId: substituted,
              legalEntityId: dimension === 'legal-entity' ? substituted : legalEntityId,
              privacySubjectRef: {
                ...retained.privacySubjectRef,
                tenantId: dimension === 'tenant' ? substituted : tenantId,
              },
              tenantId: dimension === 'tenant' ? substituted : tenantId,
            },
            legalEntityId: dimension === 'legal-entity' ? substituted : legalEntityId,
            tenantId: dimension === 'tenant' ? substituted : tenantId,
          }),
        ).pipe(Effect.flip);
        expect(Option.getOrThrow(findPostgresFailure(insert))).toMatchObject({ code: '42501' });
      }

      // System catalogs cannot be expressed by owner Drizzle tables; this fixed read verifies the migrated physical protections.
      const protection = yield* inScope((transaction) =>
        transaction.select({
          forced: sql<boolean>`c.relforcerowsecurity`,
          rls: sql<boolean>`c.relrowsecurity`,
          triggerName: sql<string>`t.tgname`,
        }).from(sql`pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          join pg_catalog.pg_trigger t on t.tgrelid = c.oid`)
          .where(sql`n.nspname = 'privacy' and c.relname = ${getTableName(noticeAcknowledgements)}
            and t.tgname = 'privacy_notice_acknowledgements_immutable' and t.tgenabled = 'O'`),
      );
      expect(protection).toEqual([
        { forced: true, rls: true, triggerName: 'privacy_notice_acknowledgements_immutable' },
      ]);
      expect(Option.getOrThrow(yield* read(presentationId))).toEqual(retained);
    }).pipe(
      Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          NodeServices.layer,
          NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);
