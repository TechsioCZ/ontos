import { NodeCrypto } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Layer, Schema, Struct } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyProcessingInterventionSchema } from '../../shared/domain/privacy-processing-eligibility.ts';
import { preVerificationBindings, processingInterventions } from '../../src/database/schema.ts';
import {
  makePreVerificationPrivacyNative,
  preVerificationPrivacyDatabaseLive,
} from '../support/pre-verification-binding-native.ts';
import type { PreVerificationCall } from '../support/pre-verification-binding-native.ts';
import { freshPrivacyLedgerScope, inPrivacyLedger } from '../support/privacy-ledger-scope.ts';

/**
 * #1406 D.8 — the Privacy pre-verification binding contract against its REAL table in PostgreSQL, as the runtime role
 * with row-level security, through the exact bodies the Actions and the governed Read run after authorization. The
 * access gate (SpiceDB) and HTTP are a different seam. Every policy value is FICTIONAL: no product value is asserted.
 */
const layer = Layer.mergeAll(NodeCrypto.layer, preVerificationPrivacyDatabaseLive);
const SOURCE_TYPE = 'fictional.portal-account';
const PURPOSE = 'fictional.source.verify';
const OPERATION = 'FICTIONAL_SEND';

const tenantPolicy = (tenantId: string) =>
  ({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    legalBasisRef: 'fictional-legal-basis:contract',
    policyRef: 'fictional-policy:tenant',
    revision: 'fictional-r1',
    scope: {
      controllerRef: 'fictional-controller',
      dataCategoryRefs: ['fictional:contact'],
      operation: OPERATION,
      processingScopeRef: { scopeId: 'fictional-scope', scopeType: 'privacy.processing-scope' },
      purposeRef: 'fictional-purpose',
      purposeVersionId: 'fictional-purpose-v1',
      recipientRefs: ['fictional.communications'],
    },
    sourceModuleId: 'commerce.customer-context',
    sourcePurposeRef: PURPOSE,
    sourceResourceType: SOURCE_TYPE,
    tenantId,
    validUntil: '2099-01-01T00:00:00.000Z',
  }) as const;
const entityPolicy = (tenantId: string, legalEntityId: string) => ({
  ...tenantPolicy(tenantId),
  legalEntityId,
  policyRef: `fictional-policy:${legalEntityId}`,
});

const world = Effect.fn('PrivacyTests.preVerificationWorld')(function* makeWorld() {
  const crypto = yield* Crypto.Crypto;
  const ledger = yield* freshPrivacyLedgerScope();
  const { legalEntityId, principalId, tenantId } = ledger;
  if (legalEntityId === undefined) {
    return yield* Effect.die('the ledger scope names a Legal Entity');
  }
  const privacy = yield* makePreVerificationPrivacyNative([
    tenantPolicy(tenantId),
    entityPolicy(tenantId, legalEntityId),
  ]);
  const tenantWide = (callerAppId: string): PreVerificationCall => ({ callerAppId, principalId, tenantId });
  const inEntity = (callerAppId: string): PreVerificationCall => ({
    callerAppId,
    legalEntityId,
    principalId,
    tenantId,
  });
  const account = `fictional-provider-subject-${yield* crypto.randomUUIDv4()}`;
  const bindPayload = (validUntil = '2099-01-01T00:00:00.000Z', resourceId = account) =>
    ({
      occurrence: { occurrenceId: `fictional-issuance-${resourceId}`, validUntil },
      source: { moduleId: 'commerce.customer-context', resourceId, resourceType: SOURCE_TYPE },
      sourcePurposeRef: PURPOSE,
    }) as const;
  const ask = (bindingRef: string, call = tenantWide('communications')) =>
    privacy.eligibility(call, {
      bindingRef,
      consumerModuleId: 'communications.core',
      operation: OPERATION,
      sourcePurposeRef: PURPOSE,
    });
  return { account, ask, bindPayload, inEntity, ledger, privacy, tenantId, tenantWide };
});

describe('#1406 D.8 Privacy binds an unverified Portal Auth account and answers for it (native PostgreSQL)', () => {
  it.live('binds Tenant-wide without a Legal Entity, then answers ALLOWED for exactly the policy scope', () =>
    Effect.gen(function* allowed() {
      const w = yield* world();
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      expect(bound).toMatchObject({ policy: { policyRef: 'fictional-policy:tenant' }, status: 'ACTIVE' });
      const answer = yield* w.ask(bound.bindingRef);
      expect(answer).toMatchObject({ evidence: { outcome: 'ALLOWED' }, outcome: 'ALLOWED' });
      // the evidence echoes Privacy's own scope and subject, the same the bind returned
      expect(answer.outcome === 'ALLOWED' && answer.evidence.evaluatedScope).toEqual(bound.scope);
    }).pipe(Effect.provide(layer)),
  );

  it.live('keeps one subject per account: a later occurrence extends the same binding', () =>
    Effect.gen(function* rebound() {
      const w = yield* world();
      const first = yield* w.privacy.bind(
        w.tenantWide('commerce-customer-context'),
        w.bindPayload('2098-01-01T00:00:00.000Z'),
      );
      const again = yield* w.privacy.bind(
        w.tenantWide('commerce-customer-context'),
        w.bindPayload('2099-01-01T00:00:00.000Z'),
      );
      expect(again.bindingRef).toBe(first.bindingRef);
      expect(again.validUntil).toBe('2099-01-01T00:00:00.000Z');
    }).pipe(Effect.provide(layer)),
  );

  it.live('turns a Privacy withdrawal into a proven NOT_ALLOWED that a new bind cannot reopen', () =>
    Effect.gen(function* withdrawn() {
      const w = yield* world();
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      const record = yield* w.privacy.withdraw(w.tenantWide('privacy'), {
        bindingRef: bound.bindingRef,
        evidenceRef: 'fictional-dsr-case',
      });
      expect(record).toMatchObject({ status: 'WITHDRAWN', withdrawal: { evidenceRef: 'fictional-dsr-case' } });
      const answer = yield* w.ask(bound.bindingRef);
      expect(answer).toMatchObject({
        eligibility: { evidence: { reasonCodes: ['pre_verification_binding_withdrawn'] }, outcome: 'NOT_ALLOWED' },
        outcome: 'DENIED',
        reason: 'PROCESSING_NOT_ALLOWED',
      });
      const rebound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      expect(rebound).toMatchObject({ bindingRef: bound.bindingRef, status: 'WITHDRAWN' });
    }).pipe(Effect.provide(layer)),
  );

  it.live('says INDETERMINATE, never ALLOWED, once the occurrence the source stated has passed', () =>
    Effect.gen(function* expired() {
      const w = yield* world();
      // the occurrence is still usable for the bind, and over by the time Communications asks
      const soon = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 2 }));
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload(soon));
      yield* Effect.sleep('3 seconds');
      expect(yield* w.ask(bound.bindingRef)).toMatchObject({
        eligibility: { evidence: { reasonCodes: ['pre_verification_binding_expired'] }, outcome: 'INDETERMINATE' },
        outcome: 'DENIED',
      });
    }).pipe(Effect.provide(layer)),
  );

  it.live('never crosses the Tenant-wide and the Legal Entity scope, in either direction', () =>
    Effect.gen(function* scoped() {
      const w = yield* world();
      const tenantBound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      // the same account in a Legal Entity of the Tenant is a conflict, not a second subject
      const conflict = yield* Effect.flip(w.privacy.bind(w.inEntity('commerce-customer-context'), w.bindPayload()));
      expect(conflict).toMatchObject({ reason: 'SCOPE_CONFLICT' });
      expect(yield* w.ask(tenantBound.bindingRef, w.inEntity('communications'))).toMatchObject({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' },
      });
      const entityBound = yield* w.privacy.bind(
        w.inEntity('commerce-customer-context'),
        w.bindPayload('2099-01-01T00:00:00.000Z', `${w.account}-le`),
      );
      expect(entityBound.policy.policyRef).toBe(`fictional-policy:${w.ledger.legalEntityId}`);
      expect(yield* w.ask(entityBound.bindingRef)).toMatchObject({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' },
      });
      expect(yield* w.ask(entityBound.bindingRef, w.inEntity('communications'))).toMatchObject({ outcome: 'ALLOWED' });
    }).pipe(Effect.provide(layer)),
  );

  it.live('P1: a restriction Privacy recorded for the bound subject in the policy scope is a proven NOT_ALLOWED', () =>
    Effect.gen(function* restricted() {
      const w = yield* world();
      const crypto = yield* Crypto.Crypto;
      const bound = yield* w.privacy.bind(
        w.inEntity('commerce-customer-context'),
        w.bindPayload('2099-01-01T00:00:00.000Z', `${w.account}-restricted`),
      );
      expect(yield* w.ask(bound.bindingRef, w.inEntity('communications'))).toMatchObject({ outcome: 'ALLOWED' });
      // a FICTIONAL restriction of exactly this subject and scope, stored the way Privacy records an intervention
      const intervention = Schema.decodeUnknownSync(PrivacyProcessingInterventionSchema)({
        currentness: {
          authoritative: true,
          observedAt: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { seconds: 1 })),
          revision: 'fictional-restriction-r1',
          sourceRef: 'privacy.core.processing-interventions',
        },
        interventionRef: `fictional-restriction-${bound.bindingRef}`,
        kind: 'RESTRICTION',
        scope: bound.scope,
        status: 'ACTIVE',
      });
      const actionInvocationId = yield* crypto.randomUUIDv4();
      yield* inPrivacyLedger(w.ledger, (transaction) =>
        transaction.insert(processingInterventions).values({
          actionInvocationId,
          interventionKind: intervention.kind,
          interventionRecord: Schema.encodeSync(PrivacyProcessingInterventionSchema)(intervention),
          interventionRef: intervention.interventionRef,
          legalEntityId: w.ledger.legalEntityId ?? '',
          observedAt: DateTime.toDateUtc(DateTime.makeUnsafe(intervention.currentness.observedAt)),
          processingScopeRef: intervention.scope.processingScopeRef.scopeId,
          status: intervention.status,
          tenantId: w.tenantId,
        }),
      );
      expect(yield* w.ask(bound.bindingRef, w.inEntity('communications'))).toMatchObject({
        eligibility: { evidence: { reasonCodes: ['processing_restriction_active'] }, outcome: 'NOT_ALLOWED' },
        outcome: 'DENIED',
        reason: 'PROCESSING_NOT_ALLOWED',
      });
    }).pipe(Effect.provide(layer)),
  );

  it.live('P2: a Privacy operator locates the binding of a source account in its exact scope and withdraws it', () =>
    Effect.gen(function* located() {
      const w = yield* world();
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      const { source } = w.bindPayload();
      expect(yield* w.privacy.locate(w.tenantWide('privacy'), { source })).toEqual({
        bindings: [
          { bindingRef: bound.bindingRef, boundAt: expect.any(String), status: 'ACTIVE', validUntil: bound.validUntil },
        ],
      });
      // another Legal Entity of the Tenant, another account and another Tenant see nothing
      expect(yield* w.privacy.locate(w.inEntity('privacy'), { source })).toEqual({ bindings: [] });
      expect(
        yield* w.privacy.locate(w.tenantWide('privacy'), { source: { ...source, resourceId: `${w.account}-other` } }),
      ).toEqual({ bindings: [] });
      const stranger = yield* freshPrivacyLedgerScope();
      expect(
        yield* w.privacy.locate(
          { callerAppId: 'privacy', principalId: stranger.principalId, tenantId: stranger.tenantId },
          { source },
        ),
      ).toEqual({ bindings: [] });
      const [current] = (yield* w.privacy.locate(w.tenantWide('privacy'), { source })).bindings;
      yield* w.privacy.withdraw(w.tenantWide('privacy'), {
        bindingRef: current?.bindingRef ?? '',
        evidenceRef: 'fictional-erasure-request',
      });
      expect(yield* w.privacy.locate(w.tenantWide('privacy'), { source })).toMatchObject({
        bindings: [{ bindingRef: bound.bindingRef, status: 'WITHDRAWN', withdrawnAt: expect.any(String) }],
      });
    }).pipe(Effect.provide(layer)),
  );

  it.live('P3: the database refuses to reopen a withdrawn binding, whoever writes the row', () =>
    Effect.gen(function* noReopen() {
      const w = yield* world();
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      yield* w.privacy.withdraw(w.tenantWide('privacy'), {
        bindingRef: bound.bindingRef,
        evidenceRef: 'fictional-objection',
      });
      const tenantWide = Struct.omit(w.ledger, ['legalEntityId']);
      const reopened = yield* Effect.exit(
        inPrivacyLedger(tenantWide, (transaction) =>
          transaction
            .update(preVerificationBindings)
            .set({ status: 'ACTIVE' })
            .where(eq(preVerificationBindings.bindingId, bound.bindingRef)),
        ),
      );
      expect(Exit.isFailure(reopened)).toBe(true);
      expect(JSON.stringify(reopened)).toContain('privacy_pre_verification_bindings_no_reopen_ck');
      // any other update of a withdrawn row keeps it withdrawn and is allowed
      const touchedAt = DateTime.toDateUtc(yield* DateTime.now);
      yield* inPrivacyLedger(tenantWide, (transaction) =>
        transaction
          .update(preVerificationBindings)
          .set({ updatedAt: touchedAt })
          .where(eq(preVerificationBindings.bindingId, bound.bindingRef)),
      );
      const rows = yield* inPrivacyLedger(tenantWide, (transaction) =>
        transaction
          .select({ status: preVerificationBindings.status })
          .from(preVerificationBindings)
          .where(eq(preVerificationBindings.bindingId, bound.bindingRef)),
      );
      expect(rows).toEqual([{ status: 'WITHDRAWN' }]);
    }).pipe(Effect.provide(layer)),
  );

  it.live('binds nothing for another caller or without a policy, and stores no address or secret', () =>
    Effect.gen(function* refused() {
      const w = yield* world();
      const impostor = yield* Effect.flip(w.privacy.bind(w.tenantWide('communications'), w.bindPayload()));
      expect(impostor).toMatchObject({ reason: 'CALLER_NOT_SOURCE' });
      const other = yield* freshPrivacyLedgerScope();
      const unconfigured = yield* Effect.flip(
        w.privacy.bind(
          { callerAppId: 'commerce-customer-context', principalId: other.principalId, tenantId: other.tenantId },
          w.bindPayload(),
        ),
      );
      expect(unconfigured).toMatchObject({ reason: 'NO_CURRENT_POLICY' });
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      const rows = yield* inPrivacyLedger(Struct.omit(w.ledger, ['legalEntityId']), (transaction) =>
        transaction.select({ record: preVerificationBindings.bindingRecord }).from(preVerificationBindings),
      );
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows);
      expect(stored).toContain(bound.bindingRef);
      expect(stored).not.toMatch(/@|token|otp|password/iu);
    }).pipe(Effect.provide(layer)),
  );

  it.live('answers an unknown binding or another operation without evaluating anything', () =>
    Effect.gen(function* notEvaluated() {
      const w = yield* world();
      const crypto = yield* Crypto.Crypto;
      expect(yield* w.ask(yield* crypto.randomUUIDv4())).toMatchObject({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' },
      });
      const bound = yield* w.privacy.bind(w.tenantWide('commerce-customer-context'), w.bindPayload());
      expect(
        yield* w.privacy.eligibility(w.tenantWide('communications'), {
          bindingRef: bound.bindingRef,
          consumerModuleId: 'communications.core',
          operation: 'ANOTHER_OPERATION',
          sourcePurposeRef: PURPOSE,
        }),
      ).toMatchObject({ eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'NO_CONTEXT' } });
      // row-level security hides every binding of the Tenant from a session of another Tenant
      const stranger = yield* freshPrivacyLedgerScope();
      const visible = yield* inPrivacyLedger(Struct.omit(stranger, ['legalEntityId']), (transaction) =>
        transaction.select({ bindingId: preVerificationBindings.bindingId }).from(preVerificationBindings),
      );
      expect(visible).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
