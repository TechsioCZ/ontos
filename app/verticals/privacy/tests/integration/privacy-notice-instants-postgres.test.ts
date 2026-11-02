import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { createHash } from 'node:crypto';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  canonicalizeApplicationComposition,
  makeContextPermissionRelationshipMutationLive,
  OntosModuleDeploymentContractSchema,
  ReadRuntime,
  runAction,
  TrustedPrincipalContextSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Crypto, Effect, Layer, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CreatePrivacyNoticeVersionInput } from '../../shared/domain/privacy-notice-version.ts';
import type { NoticeVersionsRequestSchema } from '../../shared/privacy-queries.ts';
import { createNoticeVersionAction } from '../../src/actions/create-notice-version.action.ts';
import { noticeVersionsRead } from '../../src/api/notice-versions.read.ts';
import { noticeVersions } from '../../src/database/schema.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const baseInput: CreatePrivacyNoticeVersionInput = {
  applicableScope: {
    facts: [{ dimension: 'CONTROLLER_SCOPE', value: 'notice-instant-controller' }],
    operation: 'NOTICE_CATALOG',
    processingScopeRef: { scopeId: 'notice-instant-scope', scopeType: 'privacy.processing-scope' },
  },
  contentIdentity: 'notice-instant-content-v1',
  evidenceArtifactRef: null,
  language: 'en',
  wording: 'Retained original Notice wording.',
};

const makeNoticeIsolation = Effect.fn('NoticeInstants.makeIsolation')(function* makeNoticeIsolation() {
  const base = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('NoticeInstants.moduleContract')(function* moduleContract(module) {
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        module.contractDocument,
      );
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))({
        ...contract,
        manifest: { ...contract.manifest, module: { ...contract.manifest.module, id: 'privacy.core' } },
      });
      const sha256 = digest(document);
      return {
        ...module,
        contract: { ...module.contract, sha256 },
        contractDocument: document,
        moduleId: 'privacy.core',
        publicContract: { ...module.publicContract, id: 'privacy.core', sha256 },
      };
    }),
    { concurrency: 1 },
  );
  const composition = { ...base.composition, modules };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1275-notice-instants',
  });
  expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
  return { isolated, snapshot };
});

type NoticeIsolation = Effect.Success<ReturnType<typeof makeNoticeIsolation>>;
const makeNoticeContext = Effect.fn('NoticeInstants.makeContext')(function* makeNoticeContext(
  isolation: NoticeIsolation,
  provisionExecution: boolean,
) {
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: provisionExecution ? [createNoticeVersionAction.descriptor.actionKey] : [],
      adminConnectionString: Redacted.make(isolation.isolated.connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: isolation.snapshot.composition.revision,
      moduleKeys: ['privacy.core'],
      runtimeConnectionString: Redacted.make(isolation.isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const coreEvidenceServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolation.isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
  const context = yield* Layer.build(fixture.layer);
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    ...fixture.manager,
    legalEntityId: fixture.legalEntityId,
  });
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const target = { moduleId: 'privacy.core', permission: 'privacy.notice.read' };
  const setReadPermission = (operation: 'grant' | 'revoke') =>
    permissions.mutate({
      legalEntityId: fixture.legalEntityId,
      operation,
      principal,
      target,
      tenantId: fixture.tenantId,
    });
  yield* Effect.addFinalizer(() => setReadPermission('revoke').pipe(Effect.orDie));
  const create = Effect.fn('NoticeInstants.create')(function* createNotice(
    input: CreatePrivacyNoticeVersionInput,
    noticeId?: string,
  ) {
    return yield* runAction({
      payload: { input, noticeId: noticeId ?? (yield* nextId) },
      principal,
      registration: createNoticeVersionAction,
      transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'privacy.core' },
    }).pipe(Effect.provideContext(context));
  });
  const runtime = yield* ReadRuntime.pipe(Effect.provideContext(context));
  const read = Effect.fn('NoticeInstants.read')(function* readNotice(
    input: typeof NoticeVersionsRequestSchema.Type,
    actor: TrustedPrincipalContext = principal,
  ) {
    return yield* runtime
      .runRead({
        input,
        principal: actor,
        registration: noticeVersionsRead,
        transport: { correlationId: yield* nextId },
      })
      .pipe(Effect.provideContext(context));
  });
  const raw = Effect.fn('NoticeInstants.raw')(function* rawNotice(noticeId: string) {
    return yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction
            .select({ record: noticeVersions.noticeRecord })
            .from(noticeVersions)
            .where(eq(noticeVersions.noticeId, noticeId)),
        'required',
      )
      .pipe(Effect.provideContext(context));
  });
  const enableRead = Effect.fn('NoticeInstants.enableRead')(function* enableRead(resource: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  }) {
    yield* fixture.grantResourceAccess(resource, principal.principalId, 'reader');
    yield* setReadPermission('grant');
  });
  return { context, coreEvidenceExecutor, create, enableRead, fixture, principal, raw, read, setReadPermission };
});

it.live(
  'creates retained mixed-precision Notice JSON and reads inclusive starts and exclusive ends through real governed operations',
  () =>
    Effect.gen(function* nativeNoticeBoundaries() {
      const isolation = yield* makeNoticeIsolation();
      const owner = yield* makeNoticeContext(isolation, true);
      const started = yield* owner.create({
        ...baseInput,
        effectiveFrom: '2026-10-17T10:00:00Z',
        effectiveTo: '2026-10-17T11:00:00Z',
      });
      yield* owner.enableRead(started.noticeRef);
      const ended = yield* owner.create({
        ...baseInput,
        effectiveFrom: '2026-10-17T09:00:00Z',
        effectiveTo: '2026-10-17T10:00:00Z',
      });
      const open = yield* owner.create({ ...baseInput, effectiveFrom: '2026-10-17T10:00:00Z', language: 'cs' });
      const precise = yield* owner.create({
        ...baseInput,
        effectiveFrom: '2026-10-17T10:00:00.123456Z',
        effectiveTo: '2026-10-17T10:00:00.123457Z',
      });
      const ultraPrecise = yield* owner.create({
        ...baseInput,
        effectiveFrom: '2026-10-17T10:00:00.123456789012345Z',
        effectiveTo: '2026-10-17T10:00:00.123456789012346Z',
      });
      const original = yield* owner.raw(started.noticeRef.resourceId);
      expect(original).toEqual([{ record: started }]);
      expect(yield* owner.raw(precise.noticeRef.resourceId)).toEqual([{ record: precise }]);
      expect(yield* owner.raw(ultraPrecise.noticeRef.resourceId)).toEqual([{ record: ultraPrecise }]);
      for (const asOf of ['2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.500Z']) {
        const current = yield* owner.read({ asOf, languages: [], noticeRefs: [] });
        expect(current.items).toHaveLength(2);
        expect(current.items).toEqual(expect.arrayContaining([started, open]));
        expect(current.items.some((item) => item.versionId === ended.versionId)).toBe(false);
      }
      for (const [asOf, expected] of [
        ['2026-10-17T10:00:00.123455Z', false],
        ['2026-10-17T10:00:00.123456000Z', true],
        ['2026-10-17T10:00:00.1234565Z', true],
        ['2026-10-17T10:00:00.123457000Z', false],
      ] as const) {
        const current = yield* owner.read({ asOf, languages: ['en'], noticeRefs: [precise.noticeRef.resourceId] });
        expect(current.items).toEqual(expected ? [precise] : []);
      }
      for (const [asOf, expected] of [
        ['2026-10-17T10:00:00.123456789012344Z', false],
        ['2026-10-17T10:00:00.123456789012345000Z', true],
        ['2026-10-17T10:00:00.123456789012346Z', false],
      ] as const) {
        const current = yield* owner.read({ asOf, languages: [], noticeRefs: [ultraPrecise.noticeRef.resourceId] });
        expect(current.items).toEqual(expected ? [ultraPrecise] : []);
      }
      for (const [asOf, languages, noticeRefs] of [
        ['2026-10-17T09:59:59.999Z', [], [started.noticeRef.resourceId]],
        ['2026-10-17T10:30:00Z', ['cs'], [started.noticeRef.resourceId]],
        ['2026-10-17T10:30:00Z', [], [yield* nextId]],
      ] as const) {
        expect((yield* owner.read({ asOf, languages, noticeRefs })).items).toEqual([]);
      }
      expect(
        (yield* owner.read({ asOf: '2027-01-01T00:00:00Z', languages: [], noticeRefs: [open.noticeRef.resourceId] }))
          .items,
      ).toEqual([open]);
      const defaultNotice = yield* owner.create(baseInput);
      expect(defaultNotice.effectiveFrom).toBe(defaultNotice.recordedAt);
      expect(yield* owner.raw(defaultNotice.noticeRef.resourceId)).toEqual([{ record: defaultNotice }]);
      expect(
        (yield* owner.read({
          asOf: defaultNotice.recordedAt,
          languages: [],
          noticeRefs: [defaultNotice.noticeRef.resourceId],
        })).items,
      ).toEqual([defaultNotice]);
      expect(yield* owner.raw(started.noticeRef.resourceId)).toEqual(original);
    }).pipe(Effect.provide(nativeServices)),
);

it.live(
  'validates Notice periods and previous-version ordering against retained fractional instants without rewriting history',
  () =>
    Effect.gen(function* nativeNoticeWriterGuards() {
      const owner = yield* makeNoticeContext(yield* makeNoticeIsolation(), true);
      for (const [effectiveFrom, effectiveTo] of [
        ['2026-10-17T10:00:00Z', '2026-10-17T10:00:00.000Z'],
        ['2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00Z'],
        ['2026-10-17T10:00:00.123457Z', '2026-10-17T10:00:00.123456Z'],
      ] as const) {
        const noticeId = yield* nextId;
        const rejected = yield* owner
          .create({ ...baseInput, effectiveFrom, effectiveTo }, noticeId)
          .pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(Schema.is(PrivacyOperationPersistenceError)(rejected.failure)).toBe(true);
          expect(rejected.failure).toMatchObject({
            code: 'privacy_operation_conflict',
            reason: 'Notice Version effective period is invalid',
          });
        }
        expect(yield* owner.raw(noticeId)).toEqual([]);
      }
      const first = yield* owner.create({ ...baseInput, effectiveFrom: '2026-10-17T10:00:00.123456Z' });
      const original = yield* owner.raw(first.noticeRef.resourceId);
      for (const effectiveFrom of ['2026-10-17T10:00:00.1234560Z', '2026-10-17T10:00:00.123455Z']) {
        const rejected = yield* owner
          .create({ ...baseInput, effectiveFrom }, first.noticeRef.resourceId)
          .pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(Schema.is(PrivacyOperationPersistenceError)(rejected.failure)).toBe(true);
          expect(rejected.failure).toMatchObject({
            code: 'privacy_operation_conflict',
            reason: 'Notice Version effective time must follow the latest retained version',
          });
        }
        expect(yield* owner.raw(first.noticeRef.resourceId)).toEqual(original);
      }
      const second = yield* owner.create(
        {
          ...baseInput,
          contentIdentity: 'notice-instant-content-v2',
          effectiveFrom: '2026-10-17T10:00:00.123457Z',
        },
        first.noticeRef.resourceId,
      );
      expect(second.versionNumber).toBe(2);
      const retained = yield* owner.raw(first.noticeRef.resourceId);
      expect(retained).toHaveLength(2);
      expect(retained).toContainEqual(original[0]);
      expect(retained).toContainEqual({ record: second });
      const before = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
      for (const effectiveFrom of [
        'not-a-timestamp',
        '2026-02-30T10:00:00Z',
        '2026-02-29T10:00:00Z',
        '2026-04-31T10:00:00Z',
        '2026-10-17T24:00:00Z',
      ]) {
        const malformedId = yield* nextId;
        const malformed = yield* owner.create({ ...baseInput, effectiveFrom }, malformedId).pipe(Effect.result);
        expect(Result.isFailure(malformed)).toBe(true);
        if (Result.isFailure(malformed)) {
          expect(malformed.failure).toMatchObject({ code: 'action_payload_invalid' });
        }
        expect(yield* owner.raw(malformedId)).toEqual([]);
        const ownerRejected = yield* owner.fixture
          .prepareOwner(
            Effect.fn('NoticeInstants.invalidOpenOwnerStart')(function* invalidOpenOwnerStart(transaction, scope) {
              const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
              return yield* repository.createNoticeVersion(
                { legalEntityId: owner.fixture.legalEntityId, tenantId: scope.tenantId },
                { actionInvocationId: yield* nextId, input: { ...baseInput, effectiveFrom }, noticeId: malformedId },
              );
            }),
            'required',
          )
          .pipe(Effect.provideContext(owner.context), Effect.result);
        expect(Result.isFailure(ownerRejected)).toBe(true);
        if (Result.isFailure(ownerRejected)) {
          expect(ownerRejected.failure).toMatchObject({ code: 'privacy_operation_conflict' });
        }
        expect(yield* owner.raw(malformedId)).toEqual([]);
      }
      const after = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
      expect(after.invocations).toHaveLength(before.invocations.length);
      expect(after.audits).toHaveLength(before.audits.length);
    }).pipe(Effect.provide(nativeServices)),
);

it.live('retains Notice scope, explicit execution and read permission boundaries with native persistence', () =>
  Effect.gen(function* nativeNoticeScopeAndPermissions() {
    const isolation = yield* makeNoticeIsolation();
    const owner = yield* makeNoticeContext(isolation, true);
    const foreign = yield* makeNoticeContext(isolation, true);
    const notice = yield* owner.create({ ...baseInput, effectiveFrom: '2026-10-17T10:00:00Z' });
    const other = yield* foreign.create({ ...baseInput, effectiveFrom: '2026-10-17T10:00:00Z' });
    const query = { asOf: '2026-10-17T10:00:00Z', languages: [], noticeRefs: [] };
    yield* owner.setReadPermission('grant');
    const noModule = yield* owner.read(query).pipe(Effect.result);
    expect(Result.isFailure(noModule)).toBe(true);
    if (Result.isFailure(noModule)) {
      expect(noModule.failure).toMatchObject({ code: 'read_permission_denied' });
    }
    yield* owner.enableRead(notice.noticeRef);
    yield* foreign.enableRead(other.noticeRef);
    expect((yield* owner.read(query)).items).toEqual([notice]);
    expect((yield* foreign.read(query)).items).toEqual([other]);
    expect((yield* owner.read({ ...query, noticeRefs: [other.noticeRef.resourceId] })).items).toEqual([]);
    yield* owner.setReadPermission('revoke');
    const noContext = yield* owner.read(query).pipe(Effect.result);
    expect(Result.isFailure(noContext)).toBe(true);
    if (Result.isFailure(noContext)) {
      expect(noContext.failure).toMatchObject({ code: 'read_permission_denied' });
    }
    yield* owner.setReadPermission('grant');
    const { legalEntityId: _selectedLegalEntity, ...withoutLegalEntity } = owner.principal;
    for (const actor of [
      withoutLegalEntity,
      { ...owner.principal, legalEntityId: foreign.fixture.legalEntityId },
      { ...owner.principal, tenantId: foreign.fixture.tenantId },
    ]) {
      expect(Result.isFailure(yield* owner.read(query, actor).pipe(Effect.result))).toBe(true);
    }
    for (const asOf of [
      'not-a-timestamp',
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '2026-10-17T24:00:00Z',
    ]) {
      const invalid = yield* owner.read({ ...query, asOf }).pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(invalid.failure).toMatchObject({ code: 'read_input_invalid' });
      }
    }
    const unconfigured = yield* makeNoticeContext(isolation, false);
    const before = yield* unconfigured.fixture.evidence(unconfigured.coreEvidenceExecutor);
    const deniedId = yield* nextId;
    const rejected = yield* unconfigured.create(baseInput, deniedId).pipe(Effect.result);
    expect(Result.isFailure(rejected)).toBe(true);
    if (Result.isFailure(rejected)) {
      expect(rejected.failure).toMatchObject({ code: 'action_permission_denied' });
    }
    expect(yield* unconfigured.raw(deniedId)).toEqual([]);
    const after = yield* unconfigured.fixture.evidence(unconfigured.coreEvidenceExecutor);
    expect(after.invocations.filter((invocation) => invocation.status === 'succeeded')).toHaveLength(
      before.invocations.filter((invocation) => invocation.status === 'succeeded').length,
    );
    expect(after.events).toHaveLength(before.events.length);
    expect(after.outbox).toHaveLength(before.outbox.length);
  }).pipe(Effect.provide(nativeServices)),
);
