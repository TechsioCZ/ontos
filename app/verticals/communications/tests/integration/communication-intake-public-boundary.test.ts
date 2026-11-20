import { ActionAlreadyCommitted } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommunicationRequestScopeMismatch,
  CommunicationRequestSourceMismatch,
} from '../../shared/communication-intake-errors.ts';
import { SubmitCommunicationRequestPayloadSchema } from '../../shared/communication-intake.ts';
import { scopeKey } from '../../src/domain/recipient/original-binding.ts';
import type { ResendOriginalFacts } from '../../src/domain/recovery/resend-admission.ts';
import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import {
  fixtureType,
  nRecipientPolicyType,
  noMessageType,
  FIXTURE_APPROVER_ROLE,
} from '../unit/support/catalog-fixtures.ts';
import { privacyAllowed } from '../unit/support/privacy-fixtures.ts';
import { binding, usable } from '../unit/support/recipient-fixtures.ts';
import {
  catalogOf,
  communicationRequest,
  privacyOwnerDouble,
  recipientOwnerDouble,
  recipientLanguageDouble,
  scopeDeclarationDouble,
  sourceAuthorityDouble,
  originalRecipient,
} from '../support/intake-fixtures.ts';
import { inMemoryIntakePort } from '../support/in-memory-intake-port.ts';
import { makeInMemoryResendPort } from '../support/in-memory-resend-port.ts';
import { baseIdentity, makeInMemoryLanguagePolicyPort, seedLanguages } from '../support/language-fixtures.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';

/**
 * End to end through the PUBLIC Action boundary of the Core Action runtime (access gate for a registered source workload,
 * request hash and idempotency, payload and result validation, outbox collection), with a fake but real-boundary SOURCE
 * that issues requests the way a source owner's after-commit worker does. The store is in memory and every other owner is
 * a labelled double, so this is boundary and lifecycle evidence, NOT delivery, Privacy or provider evidence. HTTP/SpiceDB
 * native evidence needs an authorization graph that this environment does not provide (reported, not claimed).
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
// The scripted harness decides access for the protected Action; a registered-workload principal needs the verified
// gateway provenance of a live Shell issuer, which this in-process boundary does not have (reported, not claimed).
const sourceWorkload = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:fixture-source',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};
const encode = Schema.encodeSync(SubmitCommunicationRequestPayloadSchema);

/**
 * The harness scripts access, so it cannot carry the sealed gateway provenance of a registered source worker, and
 * Core's own scope installer is not reachable from it. The calling module is therefore bound as the Action's typed
 * `sourceCaller` service, exactly the seam production binds from the verified scope (`sourceCallerOf`, proved against
 * the real provenance carrier in `source-caller.test.ts` and the native intake suite).
 */
const world = Effect.fn('PublicBoundaryTest.world')(function* publicBoundaryWorld(
  types = [fixtureType()],
  callerModule = 'fixture.source',
  originals: Parameters<typeof makeInMemoryResendPort>[0] = {},
) {
  const templates = makeInMemoryTemplatePort();
  yield* seedLanguages(templates.port, ['cs', 'en'], {
    ...baseIdentity,
    messageType: types[0]?.typeId ?? 'fixture.single-message',
  }).pipe(Effect.provide(NodeCrypto.layer));
  const intake = inMemoryIntakePort();
  const policies = makeInMemoryLanguagePolicyPort();
  const resend = makeInMemoryResendPort(originals);
  const harness = yield* makeActionTestHarness({
    access: 'allowed',
    ownerRegistration: communicationsRegistration,
    services: [
      bindActionTestServices(submitCommunicationRequestAction, {
        intake: intake.port,
        policies: policies.port,
        resend: resend.port,
        sourceCaller: { isClaimedSource: (claimed: string) => claimed === callerModule },
        templates: templates.port,
      }),
    ],
  });
  const privacy = privacyOwnerDouble({
    'approver-1': privacyAllowed,
    'approver-2': privacyAllowed,
    'customer-1': privacyAllowed,
  });
  const recipients = recipientOwnerDouble({
    'contact-approver-1': usable(),
    'contact-approver-2': usable(),
    'contact-customer-1': usable(),
  });
  const ports = Layer.mergeAll(
    catalogOf(...types),
    recipientLanguageDouble().layer,
    sourceAuthorityDouble().layer,
    scopeDeclarationDouble().layer,
    recipients.layer,
    privacy.layer,
    NodeCrypto.layer,
  );
  /** The fake source: it calls the PUBLIC Action as its registered workload, with a transport key of its own. */
  const issue = (request: Parameters<typeof encode>[0], key: string) =>
    harness.runtime
      .runAction({
        payload: encode(request),
        principal: sourceWorkload,
        registration: submitCommunicationRequestAction,
        transport: { correlationId: key, idempotencyKey: key },
      })
      .pipe(Effect.provide(ports));
  return { harness, intake, issue, resend };
});

const ORIGINAL_INTENT_ID = '33333333-3333-4333-8333-333333333333';

describe('Explicit Resend over the public Action boundary (#1403)', () => {
  const resendOf = { originalIntentId: ORIGINAL_INTENT_ID, reason: 'RECIPIENT_NOT_RECEIVED' };
  const request = (key: string, legalEntityId?: string) =>
    communicationRequest({
      bindings: [originalRecipient('customer-1')],
      legalEntityId,
      occurrenceId: key,
      resendOf,
      tenantId,
    });
  /** What the original's store says when it was requested in the SAME scope as `request(...)` and is final. */
  const originalOf = (typeId: ResendOriginalFacts['typeId'], legalEntityId?: string): ResendOriginalFacts => ({
    effectBlock: Option.none(),
    pendingWithoutOutcome: false,
    scopeKey: scopeKey(request('scope-probe', legalEntityId).scope),
    sourceModule: 'fixture.source',
    typeId,
  });

  it.effect(
    "[S08 AC-04] a type without the source owner's resend approval is refused with a closed reason, and the original is never even read",
    () =>
      Effect.gen(function* unapproved() {
        const t = yield* world([fixtureType()], 'fixture.source', {
          [ORIGINAL_INTENT_ID]: originalOf(fixtureType().typeId),
        });
        const result = yield* t.issue(request('o-resend-1'), 'k-resend-1');
        expect(result).toMatchObject({
          decision: { kind: 'NO_MESSAGE', reason: 'RESEND_NOT_APPROVED' },
          outcome: 'DECIDED',
        });
        expect(t.resend.reads).toEqual([]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[S07 R-02] an approved type with an original of the same source owner and type is decided like any request',
    () =>
      Effect.gen(function* approved() {
        const type = fixtureType({ resend: 'SOURCE_APPROVED' });
        const t = yield* world([type], 'fixture.source', {
          [ORIGINAL_INTENT_ID]: originalOf(type.typeId),
        });
        const result = yield* t.issue(request('o-resend-2'), 'k-resend-2');
        expect(result).toMatchObject({ decision: { kind: 'MESSAGE_INTENTS' }, outcome: 'DECIDED' });
        expect(t.resend.reads).toEqual([ORIGINAL_INTENT_ID]);
        // an original that is not there is refused, and no message is created
        const missing = yield* world([type]);
        expect(yield* missing.issue(request('o-resend-3'), 'k-resend-3')).toMatchObject({
          decision: { kind: 'NO_MESSAGE', reason: 'RESEND_ORIGINAL_NOT_FOUND' },
        });
        // an original that exists but was requested in ANOTHER Legal Entity answers exactly like one that is not there
        const otherEntity = '55555555-5555-4555-8555-555555555555';
        const crossEntity = yield* world([type], 'fixture.source', {
          [ORIGINAL_INTENT_ID]: originalOf(type.typeId, otherEntity),
        });
        const refused = yield* crossEntity.issue(request('o-resend-4'), 'k-resend-4');
        expect(refused).toMatchObject({ decision: { kind: 'NO_MESSAGE', reason: 'RESEND_ORIGINAL_NOT_FOUND' } });
        const notThere = yield* missing.issue(request('o-resend-4'), 'k-resend-4');
        expect(refused.outcome === 'DECIDED' && refused.decision).toEqual(
          notThere.outcome === 'DECIDED' && notThere.decision,
        );
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('Communication Request intake over the public Action boundary (#1401, AC-01)', () => {
  it.effect(
    '[AC-01 S01 S03] a source request yields 0, 1 and N messages with stable identities; an event alone creates nothing',
    () =>
      Effect.gen(function* zeroOneN() {
        const t = yield* world([fixtureType(), noMessageType, nRecipientPolicyType]);
        expect(t.intake.stored.size).toBe(0);
        const zero = yield* t.issue(
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            purpose: noMessageType.purpose,
            tenantId,
          }),
          'k-0',
        );
        expect(zero).toMatchObject({ decision: { kind: 'NO_MESSAGE' }, outcome: 'DECIDED' });
        const one = yield* t.issue(
          communicationRequest({ bindings: [originalRecipient('customer-1')], occurrenceId: 'o-1', tenantId }),
          'k-1',
        );
        const many = yield* t.issue(
          communicationRequest({
            bindings: ['approver-1', 'approver-2'].map((id) => binding(FIXTURE_APPROVER_ROLE, id)),
            occurrenceId: 'o-n',
            purpose: nRecipientPolicyType.purpose,
            tenantId,
          }),
          'k-n',
        );
        const count = (result: typeof one) =>
          result.outcome === 'DECIDED' && result.decision.kind === 'MESSAGE_INTENTS'
            ? result.decision.intents.length
            : 0;
        expect([count(one), count(many)]).toEqual([1, 2]);
        // the identities are stable: the very same requests again give the very same intents, not new ones
        const oneAgain = yield* t.issue(
          communicationRequest({ bindings: [originalRecipient('customer-1')], occurrenceId: 'o-1', tenantId }),
          'k-1-transport-2',
        );
        expect(oneAgain).toEqual({ ...one, replayed: true });
        // only the three submitted requests exist; a Domain Event without a request created nothing
        expect(t.intake.stored.size).toBe(3);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[AC-02 AC-03] Core refuses a replayed transport key as already committed; a new key returns the stored decision; another meaning is a conflict',
    () =>
      Effect.gen(function* replayAndConflict() {
        const t = yield* world();
        const request = communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId });
        const first = yield* t.issue(request, 'k-1');
        // the transport key is Core's own replay guard: it is never the business identity
        expect(Schema.is(ActionAlreadyCommitted)(yield* Effect.flip(t.issue(request, 'k-1')))).toBe(true);
        expect(yield* t.issue(request, 'k-1-retry')).toEqual({ ...first, replayed: true });
        const otherRecipient = communicationRequest({
          bindings: [originalRecipient('customer-2', 'contact-customer-2')],
          tenantId,
        });
        const conflict = yield* t.issue(otherRecipient, 'k-2');
        expect(conflict).toMatchObject({
          originalDecisionId: first.outcome === 'DECIDED' ? first.decisionId : '',
          outcome: 'CONFLICT',
        });
        expect(t.intake.conflicts).toHaveLength(1);
        expect(t.intake.stored.size).toBe(1);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[trusted scope] a payload claiming another Tenant is refused by the Action and stores nothing', () =>
    Effect.gen(function* foreignClaim() {
      const t = yield* world();
      const failure = yield* Effect.flip(
        t.issue(
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            tenantId: '22222222-2222-4222-8222-222222222222',
          }),
          'k-foreign',
        ),
      );
      expect(Schema.is(CommunicationRequestScopeMismatch)(failure)).toBe(true);
      expect(t.intake.stored.size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[caller binding] a caller that is not the claimed source module is refused, typed, with nothing stored or queued',
    () =>
      Effect.gen(function* impersonation() {
        const t = yield* world([fixtureType()], 'fixture.other-source');
        const failure = yield* Effect.flip(
          t.issue(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }), 'k-impersonated'),
        );
        expect(Schema.is(CommunicationRequestSourceMismatch)(failure)).toBe(true);
        expect(t.intake.stored.size).toBe(0);
        expect(t.intake.conflicts).toEqual([]);
        // the real source, calling in its own name, is decided as usual by the same Action
        const own = yield* world([fixtureType()], 'fixture.source');
        expect(
          yield* own.issue(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }), 'k-own'),
        ).toMatchObject({ outcome: 'DECIDED' });
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('[AC-02] the public payload is the published contract: an extra field, an address or a language is refused', () => {
    const encoded = encode(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }));
    const strict = Schema.decodeUnknownSync(SubmitCommunicationRequestPayloadSchema, { onExcessProperty: 'error' });
    for (const extra of [{ recipientAddress: 'someone@example.test' }, { language: 'en' }, { templateId: 'x' }]) {
      expect(() => strict({ ...encoded, ...extra })).toThrow();
    }
    expect(Object.keys(encoded)).not.toContain('recipientAddress');
  });

  it('[AC-09 ADR-0013] the owner consumes only its own pre-handoff topic and Privacy measure dispatch: no source event is ever a request, no backfill code exists', () => {
    const subscriptions = outboxWorkers.map(({ descriptor }) => [descriptor.producerModuleKey, descriptor.topic]);
    expect(subscriptions).toEqual([
      ['communications.core', 'communications.core.message-intent-prepared.v1'],
      ['privacy.core', 'privacy.measure.dispatched'],
    ]);
    // The pre-handoff worker's consumer is Communications itself, for its own self-outbox only, and the one other worker
    // consumes the Privacy measure dispatch to record the handoff of a measure: it subscribes to no business producer's
    // event, so a source event can never be turned into a send, and `matched_at` of the first-match rule only ever concerns
    // messages observed after a consumer exists. The activation order (worker registered before the first producer) is
    // documented on the worker; Core's own runtime tests (`outbox:test`) prove that a later consumer receives no earlier message.
    const [worker, privacyWorker] = outboxWorkers;
    expect(worker?.descriptor.consumerModuleKey).toBe('communications.core');
    expect(worker?.descriptor.consumerModuleKey).toBe(worker?.descriptor.producerModuleKey);
    expect(worker?.descriptor.workerKey).toBe('communications.core.prepare-message-handoff');
    expect(privacyWorker?.descriptor.workerKey).toBe('communications.core.receive-privacy-measure');
    // No replay, redrive or backfill entry point exists in the owner: its worker list is exactly these two workers.
    expect(outboxWorkers).toHaveLength(2);
  });
});
