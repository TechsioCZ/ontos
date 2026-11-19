import {
  ActionAlreadyCommitted,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionTransactionError,
  ModuleStateDeniedError,
  ReadRuntime,
  runAction,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/owner-evidence';
import { DateTime, Effect, Layer, Option, Redacted, Result, Schema, Struct } from 'effect';
import { describe, expect, it, rs } from 'effect-rstest';
import { readVouchersRead } from '../../src/api/read-vouchers.read.ts';
import { provisionVoucherAction } from '../../src/actions/provision-voucher.action.ts';
import { disableVoucherAction } from '../../src/actions/disable-voucher.action.ts';
import { setBasisPolicyAction } from '../../src/actions/set-basis-policy.action.ts';
import { readPromotionsRead } from '../../src/api/read-promotions.read.ts';
import { createPromotionDraftAction } from '../../src/actions/create-promotion-draft.action.ts';
import { createPromotionSuccessorAction } from '../../src/actions/create-promotion-successor.action.ts';
import { disablePromotionAction } from '../../src/actions/disable-promotion.action.ts';
import { editPromotionDraftAction } from '../../src/actions/edit-promotion-draft.action.ts';
import { endPromotionAction } from '../../src/actions/end-promotion.action.ts';
import { publishPromotionAction } from '../../src/actions/publish-promotion.action.ts';
import { retirePromotionAction } from '../../src/actions/retire-promotion.action.ts';
import { setCartRankingAction } from '../../src/actions/set-cart-ranking.action.ts';
import { PromotionLifecycleConflict, publishPromotion } from '../../src/services/lifecycle.service.ts';
import { promotionPersistenceFactory, PromotionStateConflict } from '../../src/services/persistence.service.ts';
import { promotionRegistration } from '../../vertical.registration.ts';
import { createNativeManagementFixture, loadPromotionTestComposition } from '../support/management.fixture.ts';
import { nativeServices, nextId } from '../support/persistence.fixture.ts';

const reason = 'Native management acceptance';
const meaningFor = (sellingLegalEntityId: string | undefined, from: string, percentage = '10') => ({
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage },
  displayName: 'Native management cart offer',
  effectivePeriod: { from },
  eligibility: { commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId }] },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
});

const lifecycleActions = [
  createPromotionDraftAction,
  editPromotionDraftAction,
  publishPromotionAction,
  createPromotionSuccessorAction,
  disablePromotionAction,
  endPromotionAction,
  retirePromotionAction,
  setCartRankingAction,
] as const;

describe('Promotion native Core Action management', () => {
  it.live(
    'executes every lifecycle intent, preconfigured draft ranking, immutable publication and committed idempotency',
    () =>
      Effect.gen(function* nativeLifecycleManagement() {
        const test = yield* createNativeManagementFixture();
        const { fixture } = test;
        const fixtureContext = fixture.context;
        const firstId = yield* nextId;
        const successorId = yield* nextId;
        const from = DateTime.formatIso(yield* DateTime.now);
        const firstMeaning = meaningFor(fixture.principal.legalEntityId, from);
        const { principal } = fixture;
        const tenantPrincipal = Struct.omit(principal, ['legalEntityId']);
        const createTransport = { correlationId: yield* nextId, idempotencyKey: yield* nextId };
        yield* Effect.forEach(lifecycleActions, (registration) => fixture.grantActionExecution(registration), {
          concurrency: 1,
        });
        yield* Effect.gen(function* lifecycleRuntime() {
          const created = yield* runAction({
            audience: 'promotion',
            payload: { meaning: firstMeaning, promotionId: firstId, reason },
            principal,
            registration: createPromotionDraftAction,
            transport: createTransport,
          });
          expect(created.technicalVersion).toBe(1);
          expect(created.promotionRef.tenantId).toBe(principal.tenantId);
          const edited = yield* runAction({
            audience: 'promotion',
            payload: {
              expectedVersion: 1,
              meaning: meaningFor(principal.legalEntityId, from, '15'),
              promotionId: firstId,
              reason,
            },
            principal,
            registration: editPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(edited.technicalVersion).toBe(2);
          const missingRanking = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { expectedVersion: 2, promotionId: firstId, reason },
              principal,
              registration: publishPromotionAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(missingRanking)).toBe(true);
          if (Schema.is(PromotionStateConflict)(missingRanking)) {
            expect(missingRanking.code).toBe('INVALID_POLICY');
          }
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [firstId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const published = yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 2, promotionId: firstId, reason },
            principal,
            registration: publishPromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(published.technicalVersion).toBe(3);
          const beforeRefusal = yield* fixture.evidenceCount();
          const immutable = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: {
                expectedVersion: 3,
                meaning: meaningFor(principal.legalEntityId, from, '20'),
                promotionId: firstId,
                reason,
              },
              principal,
              registration: editPromotionDraftAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionLifecycleConflict)(immutable)).toBe(true);
          if (Schema.is(PromotionLifecycleConflict)(immutable)) {
            expect(immutable.code).toBe('IMMUTABLE_MEANING');
          }
          expect(yield* fixture.evidenceCount()).toBe(beforeRefusal);
          const successor = yield* runAction({
            audience: 'promotion',
            payload: {
              expectedVersion: 3,
              meaning: meaningFor(principal.legalEntityId, from, '20'),
              predecessorPromotionId: firstId,
              promotionId: successorId,
              reason,
            },
            principal,
            registration: createPromotionSuccessorAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(successor.promotionRef.resourceId).toBe(successorId);
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, orderedPromotionIds: [successorId, firstId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, promotionId: successorId, reason },
            principal,
            registration: publishPromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 3, promotionId: firstId, reason },
            principal,
            registration: disablePromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const effectiveAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 1 }));
          yield* runAction({
            audience: 'promotion',
            payload: { effectiveAt, expectedVersion: 2, promotionId: successorId, reason },
            principal,
            registration: endPromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 3, promotionId: successorId, reason },
            principal,
            registration: retirePromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const original = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(
              Effect.andThen((service) => service.loadPromotion(firstId)),
            ),
          );
          expect(original.meaning.benefit).toEqual({ kind: 'PERCENTAGE', percentage: '15' });
          expect(original.technicalVersion).toBe(4);
          expect(original.disabledAt).toBeDefined();
          const stateBeforeReplay = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
          );
          const evidenceBeforeReplay = yield* fixture.evidenceCount();
          const replay = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { meaning: firstMeaning, promotionId: firstId, reason },
              principal,
              registration: createPromotionDraftAction,
              transport: createTransport,
            }),
          );
          expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
          expect(yield* fixture.evidenceCount()).toBe(evidenceBeforeReplay);
          expect(
            yield* fixture.prepareOwner((transaction, scope) =>
              promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
            ),
          ).toBe(stateBeforeReplay);
        }).pipe(Effect.provide(fixtureContext));
      }).pipe(Effect.provide(nativeServices)),
  );

  it.live('fails denied or unavailable Current permission and absent owner composition before owner writes', () =>
    Effect.gen(function* currentPermissionAndComposition() {
      const test = yield* createNativeManagementFixture();
      const { fixture } = test;
      const fixtureContext = fixture.context;
      const promotionId = yield* nextId;
      const payload = {
        meaning: meaningFor(fixture.principal.legalEntityId, DateTime.formatIso(yield* DateTime.now)),
        promotionId,
        reason,
      };
      yield* Effect.gen(function* negativeRuntime() {
        test.access.defaultAnswer.outcome = 'DENIED';
        const denied = yield* Effect.flip(
          runAction({
            audience: 'promotion',
            payload,
            principal: fixture.principal,
            registration: createPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        test.access.defaultAnswer.outcome = 'UNAVAILABLE';
        const unavailable = yield* Effect.flip(
          runAction({
            audience: 'promotion',
            payload,
            principal: fixture.principal,
            registration: createPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          }),
        );
        expect(Schema.is(ActionPermissionCheckError)(unavailable)).toBe(true);
        test.access.defaultAnswer.outcome = 'ALLOWED';
        const installed = test.authority.snapshot;
        test.authority.snapshot = yield* makeApplicationCompositionSnapshotFixture([]);
        const absent = yield* runAction({
          audience: 'promotion',
          payload,
          principal: fixture.principal,
          registration: createPromotionDraftAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        }).pipe(Effect.result);
        expect(Result.isFailure(absent)).toBe(true);
        test.authority.snapshot = installed;
        const stored = yield* fixture.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadPromotions())),
        );
        expect(stored).toEqual([]);
        expect(yield* fixture.evidenceCount()).toBe(0);
      }).pipe(Effect.provide(fixtureContext));
    }).pipe(Effect.provide(nativeServices)),
  );

  it.live('serializes competing stale edits and commits only one new meaning', () =>
    Effect.gen(function* staleConcurrentManagement() {
      const test = yield* createNativeManagementFixture();
      const { fixture } = test;
      const fixtureContext = fixture.context;
      const promotionId = yield* nextId;
      const from = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.gen(function* concurrentRuntime() {
        yield* runAction({
          audience: 'promotion',
          payload: { meaning: meaningFor(fixture.principal.legalEntityId, from), promotionId, reason },
          principal: fixture.principal,
          registration: createPromotionDraftAction,
          transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
        });
        const firstTransport = { correlationId: yield* nextId, idempotencyKey: yield* nextId };
        const secondTransport = { correlationId: yield* nextId, idempotencyKey: yield* nextId };
        const attempts = yield* Effect.all(
          [
            runAction({
              audience: 'promotion',
              payload: {
                expectedVersion: 1,
                meaning: meaningFor(fixture.principal.legalEntityId, from, '15'),
                promotionId,
                reason,
              },
              principal: fixture.principal,
              registration: editPromotionDraftAction,
              transport: firstTransport,
            }).pipe(Effect.result),
            runAction({
              audience: 'promotion',
              payload: {
                expectedVersion: 1,
                meaning: meaningFor(fixture.principal.legalEntityId, from, '20'),
                promotionId,
                reason,
              },
              principal: fixture.principal,
              registration: editPromotionDraftAction,
              transport: secondTransport,
            }).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
        expect(attempts.filter(Result.isFailure)).toHaveLength(1);
        for (const attempt of attempts) {
          if (Result.isFailure(attempt)) {
            expect(Schema.is(PromotionLifecycleConflict)(attempt.failure)).toBe(true);
            if (Schema.is(PromotionLifecycleConflict)(attempt.failure)) {
              expect(attempt.failure.code).toBe('STALE_VERSION');
            }
          }
        }
        const loaded = yield* fixture.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(
            Effect.andThen((service) => service.loadPromotion(promotionId)),
          ),
        );
        expect(loaded.technicalVersion).toBe(2);
        expect(
          yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
          ),
        ).toBe(3);
      }).pipe(Effect.provide(fixtureContext));
    }).pipe(Effect.provide(nativeServices)),
  );

  it.live('rolls owner writes and success evidence back together and blocks read-only mutations', () =>
    Effect.gen(function* faultRollbackAndReadOnly() {
      const composition = yield* loadPromotionTestComposition();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          rs.stubEnv('SPICEDB_ENDPOINT', composition.spiceEnvironment.SPICEDB_ENDPOINT);
          rs.stubEnv('SPICEDB_PRESHARED_KEY', Redacted.value(composition.spiceEnvironment.SPICEDB_PRESHARED_KEY));
          rs.stubEnv('SPICEDB_CA_CERT', composition.spiceEnvironment.SPICEDB_CA_CERT);
          rs.stubEnv(
            'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
            composition.spiceEnvironment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT,
          );
        }),
        () => Effect.sync(() => rs.unstubAllEnvs()),
      );
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionExecutor: 'manager-only',
          actionKeys: [...lifecycleActions, disableVoucherAction].map((action) => action.descriptor.actionKey),
          additionalLegalEntity: 'same-tenant',
          adminConnectionString: Redacted.make(composition.connections.admin.connectionString),
          allowedAudiences: ['promotion'],
          applicationComposition: { load: Effect.succeed(composition.snapshot) },
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.snapshot.composition.revision,
          expectedDeployment: composition.contract.deployment,
          moduleAccess: 'configured-modules',
          moduleKeys: ['commerce.promotion'],
          ownerRegistration: promotionRegistration,
          runtimeConnectionString: Redacted.make(composition.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const fixtureContext = yield* Layer.build(fixture.layer);
      const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      const promotionId = yield* nextId;
      const payload = {
        meaning: {
          ...meaningFor(fixture.legalEntityId, DateTime.formatIso(yield* DateTime.now)),
          activation: 'VOUCHER',
          family: 'CART_VOUCHER',
        },
        promotionId,
        reason,
      };
      const transport = { correlationId: yield* nextId, idempotencyKey: yield* nextId };
      yield* Effect.gen(function* faultRuntime() {
        fixture.faultNextTransaction('rollback');
        const rolledBack = yield* Effect.flip(
          runAction({ audience: 'promotion', payload, principal, registration: createPromotionDraftAction, transport }),
        );
        expect(Schema.is(ActionTransactionError)(rolledBack)).toBe(true);
        const afterRollback = yield* fixture.evidence(composition.admin);
        expect(afterRollback.invocations).toHaveLength(1);
        expect(afterRollback.invocations[0]?.status).toBe('received');
        expect(afterRollback.audits).toEqual([]);
        expect(afterRollback.accesses).toEqual([]);
        expect(afterRollback.events).toEqual([]);
        expect(
          yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadPromotions())),
          ),
        ).toEqual([]);
        yield* runAction({
          audience: 'promotion',
          payload,
          principal,
          registration: createPromotionDraftAction,
          transport,
        });
        const committed = yield* fixture.evidence(composition.admin);
        expect(committed.invocations[0]?.status).toBe('succeeded');
        expect(committed.audits.length).toBeGreaterThan(0);
        expect(committed.accesses.length).toBeGreaterThan(0);
        const successfulAudit = committed.audits.find((audit) => audit.eventType === 'action.executed');
        expect(successfulAudit?.principalId).toBe(principal.principalId);
        expect(successfulAudit?.tenantId).toBe(principal.tenantId);
        expect(successfulAudit?.legalEntityId).toBe(principal.legalEntityId);
        expect(successfulAudit?.evidenceJson).toMatchObject({
          actionKey: 'commerce.promotion.create-promotion-draft',
          afterMeaningHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          afterVersion: 1,
          beforeVersion: 0,
          operation: 'CREATE_DRAFT',
          reason,
          resourceId: promotionId,
          resultHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        const reads = yield* ReadRuntime;
        const primaryRead = yield* reads.runRead({
          audience: 'promotion',
          input: {},
          principal,
          registration: readPromotionsRead,
          transport: { correlationId: yield* nextId },
        });
        expect(primaryRead.promotions.map((promotion) => promotion.promotionId)).toEqual([promotionId]);
        const secondEntity = yield* Effect.fromOption(Option.fromUndefinedOr(fixture.secondaryLegalEntity));
        const isolatedRead = yield* reads.runRead({
          audience: 'promotion',
          input: {},
          principal: secondEntity.manager,
          registration: readPromotionsRead,
          transport: { correlationId: yield* nextId },
        });
        expect(isolatedRead.promotions).toEqual([]);
        yield* fixture.setConfiguredModuleState('commerce.promotion', 'read_only');
        const readOnly = yield* Effect.flip(
          runAction({
            audience: 'promotion',
            payload: {
              expectedVersion: 1,
              meaning: meaningFor(fixture.legalEntityId, payload.meaning.effectivePeriod.from, '20'),
              promotionId,
              reason,
            },
            principal,
            registration: editPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          }),
        );
        expect(Schema.is(ModuleStateDeniedError)(readOnly)).toBe(true);
        expect((yield* fixture.evidence(composition.admin)).invocations).toHaveLength(1);
        yield* fixture.setConfiguredModuleState('commerce.promotion', 'active');
        const voucherId = yield* nextId;
        const actionInvocationId = yield* nextId;
        yield* fixture.prepareOwner((transaction, scope) =>
          Effect.gen(function* prepareForeignEntityVoucher() {
            const service = yield* promotionPersistenceFactory(transaction, scope);
            const generation = yield* service.lockForWrite;
            const at = yield* service.operationAt;
            const draft = yield* service.loadPromotion(promotionId);
            const published = yield* publishPromotion(draft, { expectedVersion: 1, operationAt: at });
            const attribution = { actionInvocationId, reason };
            yield* service.savePublication(published, attribution);
            yield* service.provisionVoucher(
              { ...attribution, normalizedCode: 'entity-isolation', promotionId, voucherId },
              at,
            );
            yield* service.bump(generation);
          }),
        );
        const beforeProbes = yield* fixture.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
        );
        for (const expectedDisabled of [false, true]) {
          const hiddenVoucher = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { expectedDisabled, reason, voucherId },
              principal: secondEntity.manager,
              registration: disableVoucherAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(hiddenVoucher)).toBe(true);
          if (Schema.is(PromotionStateConflict)(hiddenVoucher)) {
            expect(hiddenVoucher.code).toBe('NOT_FOUND');
          }
        }
        const absentPromotionId = yield* nextId;
        for (const targetId of [promotionId, absentPromotionId]) {
          const hiddenPromotion = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { expectedVersion: 2, promotionId: targetId, reason },
              principal: secondEntity.manager,
              registration: disablePromotionAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(hiddenPromotion)).toBe(true);
          if (Schema.is(PromotionStateConflict)(hiddenPromotion)) {
            expect(hiddenPromotion.code).toBe('NOT_FOUND');
          }
        }
        expect(
          yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
          ),
        ).toBe(beforeProbes);
      }).pipe(Effect.provide(fixtureContext));
    }).pipe(Effect.provide(nativeServices)),
  );
  it.live(
    'manages persisted Vouchers and basis policy through Core Actions without exposing codes or rebinding history',
    () =>
      Effect.gen(function* nativeVoucherAndPolicyManagement() {
        const test = yield* createNativeManagementFixture();
        const { fixture } = test;
        const { principal } = fixture;
        const tenantPrincipal = Struct.omit(principal, ['legalEntityId']);
        const originalId = yield* nextId;
        const successorId = yield* nextId;
        const voucherId = yield* nextId;
        const from = DateTime.formatIso(
          yield* fixture
            .prepareOwner((transaction, scope) =>
              promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.operationAt)),
            )
            .pipe(Effect.provide(fixture.context)),
        );
        const meaning = { ...meaningFor(principal.legalEntityId, from), activation: 'VOUCHER', family: 'CART_VOUCHER' };
        yield* Effect.gen(function* voucherPolicyRuntime() {
          const basis = yield* runAction({
            audience: 'promotion',
            payload: {
              expectedVersion: 0,
              reason,
              rules: [
                {
                  buyerVatStatus: 'REGISTERED',
                  effectivePeriod: { from },
                  mode: 'NET_TAX_EXCLUSIVE',
                  revision: '1',
                  ruleId: 'registered-b2b',
                  sellerVatStatus: 'REGISTERED',
                },
              ],
            },
            principal: tenantPrincipal,
            registration: setBasisPolicyAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(basis.version).toBe(1);
          yield* runAction({
            audience: 'promotion',
            payload: { meaning, promotionId: originalId, reason },
            principal,
            registration: createPromotionDraftAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 0, orderedPromotionIds: [originalId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, promotionId: originalId, reason },
            principal,
            registration: publishPromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const provisioned = yield* runAction({
            audience: 'promotion',
            payload: { code: ' VIP-Native ', promotionId: originalId, reason, voucherId },
            principal,
            registration: provisionVoucherAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(provisioned.voucherRef.resourceId).toBe(voucherId);
          const reads = yield* ReadRuntime;
          const safeRead = yield* reads.runRead({
            audience: 'promotion',
            input: {},
            principal,
            registration: readVouchersRead,
            transport: { correlationId: yield* nextId },
          });
          expect(safeRead.vouchers).toEqual([{ disabled: false, promotionId: originalId, voucherId }]);
          for (const voucher of safeRead.vouchers) {
            expect(voucher).not.toHaveProperty('normalizedCode');
            expect(voucher).not.toHaveProperty('code');
          }
          yield* runAction({
            audience: 'promotion',
            payload: {
              expectedVersion: 2,
              meaning: { ...meaning, benefit: { kind: 'PERCENTAGE', percentage: '15' } },
              predecessorPromotionId: originalId,
              promotionId: successorId,
              reason,
            },
            principal,
            registration: createPromotionSuccessorAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, orderedPromotionIds: [successorId, originalId], reason },
            principal: tenantPrincipal,
            registration: setCartRankingAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          yield* runAction({
            audience: 'promotion',
            payload: { expectedVersion: 1, promotionId: successorId, reason },
            principal,
            registration: publishPromotionAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          const omission = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { expectedVersion: 2, orderedPromotionIds: [], reason },
              principal: tenantPrincipal,
              registration: setCartRankingAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(omission)).toBe(true);
          if (Schema.is(PromotionStateConflict)(omission)) {
            expect(omission.code).toBe('INVALID_POLICY');
          }
          const disabled = yield* runAction({
            audience: 'promotion',
            payload: { expectedDisabled: false, reason, voucherId },
            principal,
            registration: disableVoucherAction,
            transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
          });
          expect(disabled.disabled).toBe(true);
          const generation = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
          );
          const stale = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { expectedDisabled: false, reason, voucherId },
              principal,
              registration: disableVoucherAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(stale)).toBe(true);
          if (Schema.is(PromotionStateConflict)(stale)) {
            expect(stale.code).toBe('STALE_VERSION');
          }
          expect(
            yield* fixture.prepareOwner((transaction, scope) =>
              promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.generation())),
            ),
          ).toBe(generation);
          const conflictingId = yield* nextId;
          const rebind = yield* Effect.flip(
            runAction({
              audience: 'promotion',
              payload: { code: 'vip-native', promotionId: successorId, reason, voucherId: conflictingId },
              principal,
              registration: provisionVoucherAction,
              transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId },
            }),
          );
          expect(Schema.is(PromotionStateConflict)(rebind)).toBe(true);
          if (Schema.is(PromotionStateConflict)(rebind)) {
            expect(rebind.code).toBe('CODE_ALREADY_BOUND');
          }
          const stored = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadVouchers())),
          );
          expect(stored).toEqual([
            { disabled: true, normalizedCode: 'vip-native', promotionId: originalId, voucherId },
          ]);
          const safeHistory = yield* reads.runRead({
            audience: 'promotion',
            input: {},
            principal,
            registration: readVouchersRead,
            transport: { correlationId: yield* nextId },
          });
          expect(safeHistory.vouchers).toEqual([{ disabled: true, promotionId: originalId, voucherId }]);
          const policies = yield* fixture.prepareOwner((transaction, scope) =>
            promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadPolicies)),
          );
          expect(policies.basis?.version).toBe(1);
          expect(policies.ranking.find((policy) => policy.kind === 'CART')?.orderedPromotionIds).toEqual([
            successorId,
            originalId,
          ]);
        }).pipe(Effect.provide(fixture.context));
      }).pipe(Effect.provide(nativeServices)),
  );
});
