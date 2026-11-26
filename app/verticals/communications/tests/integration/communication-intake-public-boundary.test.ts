import { ActionAlreadyCommitted } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { communicationRequests, communicationDecisions } from '../../src/database/schema.ts';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommunicationRequestScopeMismatch,
  CommunicationRequestSourceMismatch,
} from '../../shared/communication-intake-errors.ts';
import { SubmitCommunicationRequestPayloadSchema } from '../../shared/communication-intake.ts';
import { requestIdentityKeyOf } from '../../src/domain/intake/identity.ts';
import { scopeKey } from '../../src/domain/recipient/original-binding.ts';
import type { ResendOriginalFacts } from '../../src/domain/recovery/resend-admission.ts';
import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { resendPreparationReads } from '../support/resend-preparation-reads.ts';
import { asSourceWorker } from '../support/source-worker-principal.ts';
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
// Access is scripted, while the caller carries the same sealed workload provenance Core reads in production.
const sourceWorkload = {
  authContextRef: 'job:fixture-source:run:1',
  authMethod: 'system' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};
const encode = Schema.encodeSync(SubmitCommunicationRequestPayloadSchema);
const requestLookupSql = [
  'select "action_invocation_id", "fingerprint", "identity_key", "occurrence_id", "occurrence_revision", "payload", "purpose", "received_at"::text, "request_id", "scope_key", "source_module", "tenant_id"',
  'from "communications"."communication_requests"',
  'where (("communications"."communication_requests"."tenant_id" = $1) and ("communications"."communication_requests"."identity_key" = $2))',
].join(' ');

const decisionExistsSql = new QueryBuilder()
  .select({ exists: sql<boolean>`true` })
  .from(communicationRequests)
  .innerJoin(
    communicationDecisions,
    and(
      eq(communicationDecisions.tenantId, communicationRequests.tenantId),
      eq(communicationDecisions.requestId, communicationRequests.requestId),
    ),
  )
  .where(and(eq(communicationRequests.tenantId, tenantId), eq(communicationRequests.identityKey, 'identity')))
  .limit(1)
  .toSQL().sql;

/**
 * The real preparation reads an exactly scripted existence snapshot and resend history, then gathers owner facts. The service binding
 * keeps those prepared facts and replaces only the committing stores. Workload provenance is sealed by the source
 * fixture, not cryptographically issued by a live Shell; that boundary is covered by the native HTTP suite.
 */
const world = Effect.fn('PublicBoundaryTest.world')(function* publicBoundaryWorld(
  types = [fixtureType()],
  callerModule = 'fixture.source',
  originals: Parameters<typeof makeInMemoryResendPort>[0] = {},
  sourceExecutionAdmitted = true,
  revokeBeforeLookup = false,
) {
  const templates = makeInMemoryTemplatePort();
  yield* seedLanguages(templates.port, ['cs', 'en'], {
    ...baseIdentity,
    messageType: types[0]?.typeId ?? 'fixture.single-message',
  }).pipe(Effect.provide(NodeCrypto.layer));
  const intake = inMemoryIntakePort();
  const policies = makeInMemoryLanguagePolicyPort();
  const resend = makeInMemoryResendPort(originals);
  const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: communicationsRegistration });
  const source = sourceAuthorityDouble();
  const sourceExecutionInvocations =
    sourceExecutionAdmitted === true ? [{ invocationId: '60000000-0000-4000-8000-000000000002', tenantId }] : [];
  const fenceChecks: boolean[] = [];
  const lookup = { after: () => {} };
  const harness = yield* makeActionTestHarness({
    ...owner,
    access: 'allowed',
    ownerRegistration: communicationsRegistration,
    preparationReads: [
      ...resendPreparationReads(tenantId, originals),
      {
        execute: () =>
          Effect.sync(() => {
            lookup.after();
            return [];
          }),
        sql: requestLookupSql,
      },
      {
        execute: ({ params }) =>
          Effect.sync(() => {
            const exists = intake.stored.has(String(params[1]));
            lookup.after();
            return exists ? [{ exists: true }] : [];
          }),
        sql: decisionExistsSql,
      },
    ],
    services: [
      bindActionTestServices(submitCommunicationRequestAction, (prepared) => ({
        ...prepared,
        intake: intake.port,
        policies: policies.port,
        resend: resend.port,
        sourceCaller: { isClaimedSource: (claimed: string) => claimed === callerModule },
        templates: templates.port,
      })),
    ],
    get sourceExecutionInvocations() {
      const admitted = revokeBeforeLookup === false || fenceChecks.length === 0;
      fenceChecks.push(admitted && sourceExecutionInvocations.length > 0);
      return admitted ? sourceExecutionInvocations : [];
    },
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
    source.layer,
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
        principal: asSourceWorker(sourceWorkload, callerModule, owner.snapshot.composition.revision),
        registration: submitCommunicationRequestAction,
        transport: { correlationId: key, idempotencyKey: key },
      })
      .pipe(Effect.provide(ports));
  /** The same public call with a body that is NOT a Communication Request: whatever a source published instead of one. */
  const issueRaw = (payload: Schema.Json, key: string) =>
    harness.runtime
      .runAction({
        payload,
        principal: asSourceWorker(sourceWorkload, callerModule, owner.snapshot.composition.revision),
        registration: submitCommunicationRequestAction,
        transport: { correlationId: key, idempotencyKey: key },
      })
      .pipe(Effect.provide(ports));
  return { fenceChecks, harness, intake, issue, issueRaw, lookup, privacy, recipients, resend, source };
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
        expect(t.recipients.queries).toEqual([]);
        expect(t.privacy.queries).toEqual([]);
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
        expect(missing.recipients.queries).toEqual([]);
        expect(missing.privacy.queries).toEqual([]);
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
  it.effect('a concurrent winner is replayed even when source preparation fails after the empty lookup', () =>
    Effect.gen(function* concurrentWinner() {
      const t = yield* world();
      const request = communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId });
      const first = yield* t.issue(request, 'winner');
      const identity = requestIdentityKeyOf(request);
      const winner = Option.getOrThrow(Option.fromNullishOr(t.intake.stored.get(identity)));
      t.intake.stored.delete(identity);
      t.lookup.after = () => {
        t.intake.stored.set(identity, winner);
        t.source.state.available = false;
      };
      expect(yield* t.issue(request, 'contender')).toEqual({ ...first, replayed: true });
      expect(t.source.state.reads).toBe(2);
      expect(t.intake.decisions).toHaveLength(1);
      expect(t.harness.snapshot().committed.at(-1)?.evidence.outboxMessages).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('source preparation failure with no concurrent decision stays retryable and stores nothing', () =>
    Effect.gen(function* noWinner() {
      const t = yield* world();
      t.source.state.available = false;
      expect(
        yield* Effect.flip(
          t.issue(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }), 'no-winner'),
        ),
      ).toMatchObject({ code: 'communication_decision_unavailable' });
      expect(t.intake.stored.size).toBe(0);
      expect(t.harness.snapshot().committed).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect('revocation after admission but before the preparation lookup reads no Communications data', () =>
    Effect.gen(function* revokeAfterAdmission() {
      const request = communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId });
      const admitted = yield* world();
      yield* admitted.issue(request, 'seed-stored-decision');
      const t = yield* world([fixtureType()], 'fixture.source', {}, true, true);
      for (const [identity, decision] of admitted.intake.stored) {
        t.intake.stored.set(identity, decision);
      }
      yield* Effect.flip(t.issue(request, 'revoked-between-admission-and-lookup'));
      expect(t.harness.snapshot().stages).toContain('invocation_prepared');
      expect(t.fenceChecks.slice(0, 2)).toEqual([true, false]);
      expect(t.harness.snapshot().preparationQueries).toEqual([]);
      expect(t.source.state.reads).toBe(0);
      expect(t.harness.snapshot().committed).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect('a revoked source execution cannot prepare a decision or queue an intent', () =>
    Effect.gen(function* revokedSourceExecution() {
      const t = yield* world([fixtureType()], 'fixture.source', {}, false);
      yield* Effect.flip(
        t.issue(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }), 'revoked-source'),
      );
      expect(t.intake.stored.size).toBe(0);
      expect(t.harness.snapshot().preparationQueries).toEqual([]);
      expect(t.harness.snapshot().committed).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
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
    '[E05 BDD] a source domain event that is not a Communication Request creates no message: the public Action refuses it and nothing is stored',
    () =>
      Effect.gen(function* eventWithoutRequest() {
        const t = yield* world();
        // what a source's own business event looks like on the wire: it names what happened, never a purpose, issuer or Tenant
        const events = [
          { eventType: 'fixture.order.confirmed', orderId: 'order-fixture-1' },
          { occurrence: { occurrenceId: 'fixture-occurrence-1', revision: 1 }, scope: { tenantId } },
          Object.fromEntries(
            Object.entries(
              encode(communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId })),
            ).filter(([field]) => field !== 'purpose'),
          ),
        ];
        for (const [index, event] of events.entries()) {
          const failure = yield* Effect.flip(t.issueRaw(event, `k-event-${index}`));
          expect(Schema.is(ActionAlreadyCommitted)(failure), `event ${index}`).toBe(false);
          expect(JSON.stringify(failure)).toContain('payload');
        }
        // nothing was decided, stored or queued for any of them
        expect(t.intake.stored.size).toBe(0);
        expect(t.intake.conflicts).toHaveLength(0);
        // the same source's real request is still decided exactly once afterwards
        const real = yield* t.issue(
          communicationRequest({ bindings: [originalRecipient('customer-1')], tenantId }),
          'k-real',
        );
        expect(real).toMatchObject({ decision: { kind: 'MESSAGE_INTENTS' }, outcome: 'DECIDED' });
        expect(t.intake.stored.size).toBe(1);
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
        t.source.state.available = false;
        const lookups = t.harness.snapshot().preparationQueries.length;
        const { reads } = t.source.state;
        expect(yield* t.issue(request, 'k-1-retry')).toEqual({ ...first, replayed: true });
        expect(t.source.state.reads).toBe(reads);
        expect(t.harness.snapshot().preparationQueries.slice(lookups)).toMatchObject([
          { params: [tenantId, requestIdentityKeyOf(request), 1], sql: decisionExistsSql },
        ]);
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

  it('[AC-09 ADR-0013] INVENTORY (not a behaviour proof): the owner declares no replay, redrive or backfill worker and no source-event subscription', () => {
    // This is an inventory of what the owner registers. That a source event is never turned into a send, and that a consumer
    // installed after the events exist receives none of them, is BEHAVIOUR proven on the real Core outbox in
    // `no-automatic-backfill.test.ts`; Core's own `matches a complete empty authority once without backfilling a later
    // installed consumer` proves the first-match rule itself.
    const subscriptions = outboxWorkers.map(({ descriptor }) => [descriptor.producerModuleKey, descriptor.topic]);
    expect(subscriptions).toEqual([
      ['communications.core', 'communications.core.message-intent-prepared.v1'],
      ['privacy.core', 'privacy.measure.dispatched'],
      ['communications.core', 'communications.core.provider-observation-recorded.v1'],
      ['communications.core', 'communications.core.owner-execution-evidence-recorded.v1'],
    ]);
    expect(outboxWorkers.map(({ descriptor }) => descriptor.workerKey)).toEqual([
      'communications.core.prepare-message-handoff',
      'communications.core.receive-privacy-measure',
      'communications.core.reconcile-provider-evidence',
      'communications.core.report-privacy-owner-outcome',
    ]);
  });
});
