import { DateTime, Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  messageIntents,
} from '../../src/database/schema.ts';
import {
  fixtureType,
  noMessageType,
  nRecipientPolicyType,
  FIXTURE_APPROVER_ROLE,
} from '../unit/support/catalog-fixtures.ts';
import { binding, unavailable, unusable, usable } from '../unit/support/recipient-fixtures.ts';
import { privacyIndeterminate, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { intakeRunnerOver } from '../support/intake-runner.ts';
import { baseIdentity, seedLanguages } from '../support/language-fixtures.ts';
import { decided, intakeWorld, requestFor } from '../support/intake-world.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import {
  CommunicationRequestScopeMismatch,
  CommunicationRequestSourceMismatch,
} from '../../shared/communication-intake-errors.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';

/**
 * Integration of the Communication Request intake on native PostgreSQL as the runtime role under forced Row Level
 * Security, through the real intake handler and the real intake store. The owner edges (source facts, recipient
 * authority, Privacy, the Privacy scope declaration) are the labelled test doubles of `intake-fixtures.ts`: they prove
 * how Communications reacts, never what another owner answers.
 */

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

describe('Communication Request intake: one stored decision per source identity (#1401)', () => {
  it.live(
    '[AC-01 S01] one request becomes one individual Message Intent with a stable identity, pinned and queued',
    () =>
      Effect.gen(function* oneMessage() {
        const t = yield* setup();
        const run = yield* t.runner.submit(t.tenantId, requestFor(t.tenantId));
        const result = decided(run);
        expect(result.replayed).toBe(false);
        expect(result.requiredness).toBe('OPTIONAL');
        expect(result.decision.kind).toBe('MESSAGE_INTENTS');
        const [intent] = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
        expect(intent).toMatchObject({ slotKey: 'primary', status: 'PENDING_HANDOFF' });
        expect(intent?.recipientRef.resourceId).toBe('customer-1');
        // exactly one self-outbox message, for exactly this intent, carrying identities only
        expect(run.outbox).toEqual([
          {
            payloadJson: { intentId: intent?.intentId, requestId: result.requestId },
            topic: 'communications.core.message-intent-prepared.v1',
          },
        ]);
        const [stored] = yield* t.read((tx) => tx.select().from(messageIntents));
        // the pins: original recipient + endpoint reference (never the address), language, template revision, mode
        expect(stored).toMatchObject({
          language: 'cs',
          status: 'PENDING_HANDOFF',
          templateRevisionNumber: 1,
          tenantMode: 'B',
          typeId: 'fixture.single-message',
          typeRevision: 1,
        });
        expect(stored?.endpointPin).toMatchObject({ channel: 'email', mask: 'p***@example.test' });
        expect(JSON.stringify(stored)).not.toContain('example.test@');
        expect(JSON.stringify(stored)).not.toContain('puvodni@example.test');
        expect(stored?.originalBinding).toMatchObject({ role: 'original-recipient' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-01 S01] one request becomes N intents, each with its own identity and slot, one outbox message each',
    () =>
      Effect.gen(function* nMessages() {
        const t = yield* setup({
          recipients: ['approver-1', 'approver-2', 'approver-3'],
          types: [nRecipientPolicyType],
        });
        yield* t.database.withPorts(t.tenantId, (templates) =>
          seedLanguages(templates, ['cs'], { ...baseIdentity, messageType: nRecipientPolicyType.typeId }),
        );
        const request = communicationRequest({
          bindings: ['approver-1', 'approver-2', 'approver-3'].map((id) => binding(FIXTURE_APPROVER_ROLE, id)),
          purpose: nRecipientPolicyType.purpose,
          tenantId: t.tenantId,
        });
        const run = yield* t.runner.submit(t.tenantId, request);
        const result = decided(run);
        const intents = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
        expect(intents).toHaveLength(3);
        expect(new Set(intents.map((intent) => intent.intentId)).size).toBe(3);
        expect(intents.every((intent) => intent.status === 'PENDING_HANDOFF')).toBe(true);
        expect(run.outbox).toHaveLength(3);
        // all three reference the same one source request
        const rows = yield* t.read((tx) => tx.select().from(messageIntents));
        expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-01 S03] an approved no-message rule and an unknown purpose decide zero intents and queue nothing', () =>
    Effect.gen(function* zeroMessages() {
      const t = yield* setup({ types: [fixtureType(), noMessageType] });
      const quiet = decided(
        yield* t.runner.submit(
          t.tenantId,
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            purpose: noMessageType.purpose,
            tenantId: t.tenantId,
          }),
        ),
      );
      expect(quiet.decision).toMatchObject({
        kind: 'NO_MESSAGE',
        reason: 'APPROVED_NO_MESSAGE',
        ruleKey: 'fixture.rule.quiet',
      });
      const unknown = yield* t.runner.submit(
        t.tenantId,
        communicationRequest({
          bindings: [originalRecipient('customer-1')],
          occurrenceId: 'fixture-occurrence-9',
          purpose: 'fixture.never-approved',
          tenantId: t.tenantId,
        }),
      );
      expect(decided(unknown).decision).toMatchObject({ kind: 'NO_MESSAGE', reason: 'UNKNOWN_PURPOSE' });
      expect(unknown.outbox).toEqual([]);
      expect(yield* t.read((tx) => tx.select().from(messageIntents))).toEqual([]);
      // an unknown purpose never asked any owner about the recipient
      expect(t.recipientAuthority.queries).toEqual([]);
      expect(t.privacy.queries).toEqual([]);
      expect(yield* t.read((tx) => tx.select().from(communicationDecisions))).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 S04] the identical request again returns exactly the stored original and adds no intent and no outbox',
    () =>
      Effect.gen(function* identical() {
        const t = yield* setup();
        const request = requestFor(t.tenantId);
        const first = yield* t.runner.submit(t.tenantId, request, '00000000-0000-4000-8000-0000000000a1');
        const again = yield* t.runner.submit(t.tenantId, request, '00000000-0000-4000-8000-0000000000a2');
        expect(decided(again)).toEqual({ ...decided(first), replayed: true });
        expect(again.outbox).toEqual([]);
        expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
        expect(yield* t.read((tx) => tx.select().from(communicationRequests))).toHaveLength(1);
        // the request row keeps the FIRST invocation: a transport id is attribution, never the dedupe key
        const [row] = yield* t.read((tx) => tx.select().from(communicationRequests));
        expect(row?.actionInvocationId).toBe('00000000-0000-4000-8000-0000000000a1');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-02 S10] two parallel intakes of one occurrence leave exactly one logical set of intents', () =>
    Effect.gen(function* parallel() {
      const t = yield* setup({ recipients: ['approver-1', 'approver-2'], types: [nRecipientPolicyType] });
      yield* t.database.withPorts(t.tenantId, (templates) =>
        seedLanguages(templates, ['cs'], { ...baseIdentity, messageType: nRecipientPolicyType.typeId }),
      );
      const request = communicationRequest({
        bindings: ['approver-1', 'approver-2'].map((id) => binding(FIXTURE_APPROVER_ROLE, id)),
        purpose: nRecipientPolicyType.purpose,
        tenantId: t.tenantId,
      });
      const runs = yield* Effect.all(
        [
          t.runner.submit(t.tenantId, request, '00000000-0000-4000-8000-0000000000a1'),
          t.runner.submit(t.tenantId, request, '00000000-0000-4000-8000-0000000000a2'),
        ],
        { concurrency: 2 },
      );
      const [one, other] = runs.map(decided);
      expect(one?.decisionId).toBe(other?.decisionId);
      expect(one?.decision).toEqual(other?.decision);
      expect(
        [one?.replayed, other?.replayed].toSorted((left, right) => String(left).localeCompare(String(right))),
      ).toEqual([false, true]);
      expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(2);
      expect(runs.reduce((count, run) => count + run.outbox.length, 0)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-03 S05] the same identity with another recipient is a recorded conflict: nothing changes, nothing is sent',
    () =>
      Effect.gen(function* conflict() {
        const t = yield* setup({ recipients: ['customer-1', 'customer-2'] });
        const first = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-1'])));
        const other = yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-2']));
        expect(other.result).toMatchObject({
          originalDecisionId: first.decisionId,
          outcome: 'CONFLICT',
          requestId: first.requestId,
        });
        expect(other.outbox).toEqual([]);
        const repeated = yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-2']));
        expect(repeated.result).toMatchObject({ outcome: 'CONFLICT' });
        const intents = yield* t.read((tx) => tx.select().from(messageIntents));
        expect(intents).toHaveLength(1);
        expect(intents[0]?.recipientId).toBe('customer-1');
        // the conflict is recorded once per conflicting meaning, never as a new request
        expect(yield* t.read((tx) => tx.select().from(communicationRequestConflicts))).toHaveLength(1);
        expect(yield* t.read((tx) => tx.select().from(communicationRequests))).toHaveLength(1);
        // and the original request still replays as the original
        expect(decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-1']))).replayed).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-04 S07] a later legitimate occurrence on the same order is a new request, not a duplicate', () =>
    Effect.gen(function* laterOccurrence() {
      const t = yield* setup();
      const first = decided(
        yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-1'], 'fixture-order-1-accepted')),
      );
      const second = decided(
        yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-1'], 'fixture-order-1-dispatched')),
      );
      expect(second.replayed).toBe(false);
      expect(second.decisionId).not.toBe(first.decisionId);
      expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(2);
      // a new revision of the same occurrence is a new identity as well
      const revised = decided(
        yield* t.runner.submit(
          t.tenantId,
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            occurrenceId: 'fixture-order-1-accepted',
            revision: 2,
            tenantId: t.tenantId,
          }),
        ),
      );
      expect(revised.replayed).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 S11] a source that could not be asked leaves nothing stored; the retry after recovery stores exactly one set',
    () =>
      Effect.gen(function* restart() {
        const t = yield* setup();
        t.source.state.available = false;
        const failed = yield* Effect.exit(t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* t.read((tx) => tx.select().from(communicationRequests))).toEqual([]);
        t.source.state.available = true;
        const retried = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        const again = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        expect(retried.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-05 S06/S08] pins survive a later catalog revision, a new template revision, a new tenant mode and a new contact',
    () =>
      Effect.gen(function* pinsSurvive() {
        const t = yield* setup();
        const first = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        const [before] = yield* t.read((tx) => tx.select().from(messageIntents));
        // the world moves on: another approved catalog revision, a Tenant mode A, a corrected contact, a new template revision
        yield* t.database.withPorts(t.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'A', {
            ...actorWith('00000000-0000-4000-8000-0000000000a3'),
            principalId: actorWith('x').principalId,
          }),
        );
        t.recipientAuthority.answers.set('contact-customer-1', usable('nova@example.test'));
        const laterCatalog = intakeRunnerOver(t.database, t.portsFor([fixtureType({ revision: 2 })]));
        const replay = decided(yield* laterCatalog.submit(t.tenantId, requestFor(t.tenantId)));
        expect(replay).toEqual({ ...first, replayed: true });
        const [after] = yield* t.read((tx) => tx.select().from(messageIntents));
        expect(after).toEqual(before);
        expect(after).toMatchObject({ templateRevisionNumber: 1, tenantMode: 'B', typeRevision: 1 });
        // changing the mode never replays a request or creates an intent (AC-10)
        expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
        // a NEW occurrence uses today's rules, with its own pins
        const next = yield* laterCatalog.submit(
          t.tenantId,
          requestFor(t.tenantId, ['customer-1'], 'fixture-occurrence-2'),
        );
        expect(decided(next).replayed).toBe(false);
        const rows = yield* t.read((tx) => tx.select().from(messageIntents));
        expect(
          rows
            .map((row) => [row.typeRevision, row.tenantMode])
            .toSorted((left, right) => String(left).localeCompare(String(right))),
        ).toEqual([
          [1, 'B'],
          [2, 'A'],
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-06 S05] suppressed, not-sent and no-message are distinct stored outcomes with their own reason', () =>
    Effect.gen(function* distinctOutcomes() {
      const t = yield* setup({ recipients: ['p-denied', 'p-unsure', 'p-gone', 'p-owner-down', 'p-unproven'] });
      t.privacy.answers.set('p-denied', privacyNotAllowed());
      t.privacy.answers.set('p-unsure', privacyIndeterminate);
      t.recipientAuthority.answers.set('contact-p-gone', unusable('ORIGINAL_ENDPOINT_UNUSABLE'));
      t.recipientAuthority.answers.set('contact-p-owner-down', unavailable());
      const statusOf = (recipient: string, occurrence: string, contact: string | null = `contact-${recipient}`) =>
        t.runner
          .submit(
            t.tenantId,
            communicationRequest({
              bindings: [binding('original-recipient', recipient, contact)],
              occurrenceId: occurrence,
              tenantId: t.tenantId,
            }),
          )
          .pipe(
            Effect.map((run) => {
              const result = decided(run);
              return result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents[0] : undefined;
            }),
          );
      expect(yield* statusOf('p-denied', 'o-1')).toMatchObject({ reason: 'PRIVACY_NOT_ALLOWED', status: 'SUPPRESSED' });
      expect(yield* statusOf('p-unsure', 'o-2')).toMatchObject({
        reason: 'PRIVACY_INDETERMINATE',
        status: 'SUPPRESSED',
      });
      expect(yield* statusOf('p-gone', 'o-3')).toMatchObject({
        reason: 'RECIPIENT_NOT_ELIGIBLE',
        status: 'SUPPRESSED',
      });
      expect(yield* statusOf('p-owner-down', 'o-4')).toMatchObject({
        reason: 'RECIPIENT_AUTHORITY_UNAVAILABLE',
        status: 'SUPPRESSED',
      });
      // I-07: no historical contact is a truthful stop, never a guess from a Current profile
      expect(yield* statusOf('p-unproven', 'o-5', null)).toMatchObject({
        reason: 'RECIPIENT_BASIS_MISSING',
        status: 'SUPPRESSED',
      });
      // a suppressed message is not queued for a handoff
      const queued = yield* t.read((tx) => tx.select().from(messageIntents));
      expect(queued.every((row) => row.status === 'SUPPRESSED')).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[I-07] a recipient without an approved template stays not-sent, and a missing Privacy scope is an unresolved context',
    () =>
      Effect.gen(function* notSent() {
        const t = yield* setup({ withTemplates: false });
        const noTemplate = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        expect(noTemplate.decision).toMatchObject({
          intents: [{ reason: 'CZECH_REVISION_UNAVAILABLE', status: 'NOT_SENT' }],
          kind: 'MESSAGE_INTENTS',
        });
        const askedBefore = t.privacy.queries.length;
        t.scope.state.declared = false;
        const undeclared = decided(
          yield* t.runner.submit(t.tenantId, requestFor(t.tenantId, ['customer-1'], 'o-undeclared')),
        );
        expect(undeclared.decision).toMatchObject({
          intents: [{ reason: 'PRIVACY_INDETERMINATE', status: 'SUPPRESSED' }],
        });
        // Privacy was never asked about a scope nobody declared
        expect(t.privacy.queries).toHaveLength(askedBefore);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[trusted scope] a payload that claims another Tenant is refused whole and stores nothing', () =>
    Effect.gen(function* scopeClaim() {
      const t = yield* setup();
      const foreign = requestFor('22222222-2222-4222-8222-222222222222');
      const failure = yield* Effect.flip(t.runner.submit(t.tenantId, foreign));
      expect(Schema.is(CommunicationRequestScopeMismatch)(failure)).toBe(true);
      expect(yield* t.read((tx) => tx.select().from(communicationRequests))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[F1 I-02] one occurrence under two scopes of one Tenant is two independent decisions; the same scope again replays its own',
    () =>
      Effect.gen(function* twoScopes() {
        const t = yield* setup();
        const inScope = (profileId: string) =>
          communicationRequest({ bindings: [originalRecipient('customer-1')], profileId, tenantId: t.tenantId });
        const first = decided(yield* t.runner.submit(t.tenantId, inScope('profile-a')));
        // the same source, occurrence, revision, purpose and recipient, but another scope: NOT a collision and NOT a 503
        const other = yield* t.runner.submit(t.tenantId, inScope('profile-b'));
        const second = decided(other);
        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(false);
        expect(second.requestId).not.toBe(first.requestId);
        expect(second.decisionId).not.toBe(first.decisionId);
        const intentIds = [first, second].flatMap((result) =>
          result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents.map(({ intentId }) => intentId) : [],
        );
        expect(new Set(intentIds).size).toBe(2);
        // each scope queued its own pre-handoff message
        expect(other.outbox).toHaveLength(1);
        const rows = yield* t.read((tx) => tx.select().from(messageIntents));
        expect(new Set(rows.map((row) => row.intentKey)).size).toBe(2);
        expect(yield* t.read((tx) => tx.select().from(communicationRequests))).toHaveLength(2);
        // the same scope again returns ITS original decision, and neither scope's decision is touched
        const replay = yield* t.runner.submit(t.tenantId, inScope('profile-a'));
        expect(decided(replay)).toEqual({ ...first, replayed: true });
        expect(replay.outbox).toEqual([]);
        expect(decided(yield* t.runner.submit(t.tenantId, inScope('profile-b')))).toEqual({
          ...second,
          replayed: true,
        });
        expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[F2] a request whose claimed source module is not the verified caller is refused, typed, with nothing stored or queued',
    () =>
      Effect.gen(function* impersonation() {
        const t = yield* setup();
        const request = requestFor(t.tenantId);
        // the request names `fixture.source`; the module Core verified as the caller is another one
        const failure = yield* Effect.flip(
          t.runner.submit(t.tenantId, request, '00000000-0000-4000-8000-0000000000a5', 'fixture.other-source'),
        );
        expect(Schema.is(CommunicationRequestSourceMismatch)(failure)).toBe(true);
        for (const table of [
          communicationRequests,
          communicationDecisions,
          messageIntents,
          communicationRequestConflicts,
        ]) {
          expect(yield* t.read((tx) => tx.select().from(table))).toEqual([]);
        }
        // no owner was asked about anyone on behalf of an impersonated source
        expect(t.recipientAuthority.queries).toEqual([]);
        expect(t.privacy.queries).toEqual([]);
        // the genuine source module, calling in its own name, is decided as usual
        expect(decided(yield* t.runner.submit(t.tenantId, request)).replayed).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[tenant isolation] another Tenant sees none of the requests, decisions, intents, attempts or stops', () =>
    Effect.gen(function* isolation() {
      const t = yield* setup();
      yield* t.runner.submit(t.tenantId, requestFor(t.tenantId));
      const stranger = yield* nextId;
      for (const table of [
        communicationRequests,
        communicationDecisions,
        messageIntents,
        deliveryAttempts,
        intentHandoffStops,
      ]) {
        expect(yield* t.database.inTenant(stranger, (tx) => tx.select().from(table))).toEqual([]);
      }
      // the same business identity in another Tenant is another request
      const other = yield* setup();
      const otherTenant = decided(yield* other.runner.submit(other.tenantId, requestFor(other.tenantId)));
      expect(otherTenant.replayed).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[append-only] the runtime role can neither rewrite nor remove a stored decision, and cannot write attempts',
    () =>
      Effect.gen(function* appendOnly() {
        const t = yield* setup();
        const first = decided(yield* t.runner.submit(t.tenantId, requestFor(t.tenantId)));
        const update = yield* Effect.exit(
          t.database.inTenant(t.tenantId, (tx) => tx.update(messageIntents).set({ status: 'SUPPRESSED' })),
        );
        expect(Exit.isFailure(update)).toBe(true);
        const removal = yield* Effect.exit(t.database.inTenant(t.tenantId, (tx) => tx.delete(communicationDecisions)));
        expect(Exit.isFailure(removal)).toBe(true);
        const preparedAt = DateTime.toDateUtc(yield* DateTime.now);
        const forged = yield* Effect.exit(
          t.database.inTenant(t.tenantId, (tx) =>
            tx.insert(deliveryAttempts).values({
              attemptId: '00000000-0000-4000-8000-0000000000e1',
              attemptNumber: 1,
              intentId: first.decision.kind === 'MESSAGE_INTENTS' ? (first.decision.intents[0]?.intentId ?? '') : '',
              preparedAt,
              state: 'ACCEPTED',
              tenantId: t.tenantId,
            }),
          ),
        );
        expect(Exit.isFailure(forged)).toBe(true);
        expect(yield* t.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
