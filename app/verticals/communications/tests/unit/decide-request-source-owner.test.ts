import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationOutcome } from '../../src/domain/catalog/decision.ts';
import { IntentStopReasonSchema, SourceUnresolvedReasonSchema } from '../../src/domain/catalog/vocabulary.ts';
import { decideRequest } from '../../src/domain/intake/decide-request.ts';
import type { DecisionPlan } from '../../src/domain/intake/plan.ts';
import { SourceOccurrenceAuthority } from '../../src/domain/intake/source-authority.ts';
import { SourceOccurrenceUnavailable } from '../../src/domain/intake/source-authority-errors.ts';
import type { RecipientLanguageContext } from '../../src/domain/language/vocabulary.ts';
import { RecipientGateVerdict } from '../../src/domain/recipient/current-gate.ts';
import {
  catalogOf,
  communicationRequest,
  originalRecipient,
  privacyOwnerDouble,
  recipientLanguageDouble,
  recipientOwnerDouble,
  scopeDeclarationDouble,
  sourceAuthorityDouble,
} from '../support/intake-fixtures.ts';
import { makeInMemoryResendPort } from '../support/in-memory-resend-port.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { baseIdentity, makeInMemoryLanguagePolicyPort, seedLanguages } from '../support/language-fixtures.ts';
import { fixtureType } from './support/catalog-fixtures.ts';
import { privacyAllowed } from './support/privacy-fixtures.ts';
import { usable } from './support/recipient-fixtures.ts';
import { feedOfDecision } from './support/required-feed.ts';

/**
 * #1401 I-07 / #1400 LC-05 (a source owner that states nothing is a durable not-sent outcome), #1399 L-02 (an owner-required
 * language is never silently replaced by Czech), #1401 (every stored reason is of the closed stop vocabulary) and T4-02 (an
 * ambiguous slot asks no Privacy owner). The REAL intake decision over in-memory stores; every owner is a labelled double.
 */

const RECIPIENT = 'customer-1';

interface Setup {
  readonly languages?: readonly ('cs' | 'en')[];
  /** The trusted recipient language of the recipient authority; none is established by default. */
  readonly recipientLanguage?: RecipientLanguageContext;
  readonly recipients?: readonly string[];
  /** Whether a producer declares the Privacy scope of each recipient; default yes. */
  readonly scopeDeclared?: boolean;
  readonly sourceAuthority?: Layer.Layer<SourceOccurrenceAuthority>;
  readonly type?: ReturnType<typeof fixtureType>;
}

const run = (setup: Setup = {}) =>
  Effect.gen(function* decideWith() {
    const type = setup.type ?? fixtureType();
    const recipients = setup.recipients ?? [RECIPIENT];
    const templates = makeInMemoryTemplatePort();
    yield* seedLanguages(templates.port, setup.languages ?? ['cs', 'en'], {
      ...baseIdentity,
      messageType: type.typeId,
    });
    const source = sourceAuthorityDouble();
    const language = recipientLanguageDouble();
    yield* Ref.set(language.ref, setup.recipientLanguage ?? { kind: 'not-established' as const });
    const owner = recipientOwnerDouble(Object.fromEntries(recipients.map((id) => [`contact-${id}`, usable()])));
    const privacy = privacyOwnerDouble(Object.fromEntries(recipients.map((id) => [id, privacyAllowed])));
    const scope = scopeDeclarationDouble();
    scope.state.declared = setup.scopeDeclared ?? true;
    const decide = decideRequest(
      communicationRequest({ bindings: recipients.map((id) => originalRecipient(id)), purpose: type.purpose }),
      {
        policies: makeInMemoryLanguagePolicyPort().port,
        resend: makeInMemoryResendPort().port,
        templates: templates.port,
      },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          catalogOf(type),
          language.layer,
          setup.sourceAuthority ?? source.layer,
          scope.layer,
          owner.layer,
          privacy.layer,
        ),
      ),
    );
    return { language, owner, plan: yield* decide, privacy, scope, source };
  }).pipe(Effect.provide(NodeCrypto.layer));

const noMessageReason = (plan: DecisionPlan) =>
  CommunicationOutcome.$match(plan.decision.outcome, {
    Candidates: () => 'CANDIDATES',
    NoMessage: ({ reason }) => reason,
  });

const languageOf = (plan: DecisionPlan) =>
  Option.getOrThrow(Option.flatten(Option.fromNullishOr(plan.intents[0]?.language)));
const reasonOf = (plan: DecisionPlan) =>
  Option.getOrThrow(Option.flatten(Option.fromNullishOr(plan.intents[0]?.reason)));

const unresolvedSource = (reason: SourceOccurrenceUnavailable['reason']) =>
  Layer.succeed(SourceOccurrenceAuthority, { read: () => Effect.fail(new SourceOccurrenceUnavailable({ reason })) });

describe('A source owner that states nothing is a durable not-sent outcome (#1401 I-07, #1400 LC-05)', () => {
  it.effect(
    'an owner that answers nothing about the occurrence decides it as NO_MESSAGE SOURCE_OCCURRENCE_UNKNOWN and asks no recipient or Privacy owner',
    () =>
      Effect.gen(function* unresolved() {
        const { owner, plan, privacy, scope } = yield* run({ sourceAuthority: unresolvedSource('OCCURRENCE_UNKNOWN') });
        // the request IS decided: a plan to persist, never a failure with nothing stored
        expect(noMessageReason(plan)).toBe('SOURCE_OCCURRENCE_UNKNOWN');
        expect(Schema.is(SourceUnresolvedReasonSchema)('SOURCE_OCCURRENCE_UNKNOWN')).toBe(true);
        expect(plan.intents).toEqual([]);
        // no recipient is addressed and no owner is asked on a source nobody could state
        expect(owner.queries).toHaveLength(0);
        expect(privacy.queries).toHaveLength(0);
        expect(scope.state.declared).toBe(true);
      }),
  );

  it.effect(
    'an owner that cannot be asked at all is a retryable failure and decides nothing: an outage never loses a message',
    () =>
      Effect.gen(function* outage() {
        const failure = yield* Effect.flip(run({ sourceAuthority: unresolvedSource('OWNER_UNAVAILABLE') }));
        expect(failure).toMatchObject({ code: 'communication_decision_unavailable' });
      }),
  );

  it.effect('a required type reports the source stop to its workflow as a failed outcome, never as prepared', () =>
    Effect.gen(function* required() {
      const { plan } = yield* run({
        sourceAuthority: unresolvedSource('OCCURRENCE_UNKNOWN'),
        type: fixtureType({ requiredness: 'REQUIRED' }),
      });
      expect(feedOfDecision(plan.decision)).toMatchObject({
        noMessageReason: 'SOURCE_OCCURRENCE_UNKNOWN',
        requiredOutcome: 'FAILED',
        sourceImpact: 'SOURCE_OWNER_DECIDES',
      });
    }),
  );

  it.effect('an owner that does state the occurrence still decides it normally', () =>
    Effect.gen(function* stated() {
      const { plan } = yield* run();
      expect(noMessageReason(plan)).toBe('CANDIDATES');
      expect(plan.intents.map(({ status }) => status)).toEqual(['PENDING_HANDOFF']);
    }),
  );
});

describe('An owner-required language is never silently replaced by Czech (#1399 L-02)', () => {
  it.effect('with no declaration both languages are permitted and the default stays Czech', () =>
    Effect.gen(function* none() {
      const { plan } = yield* run();
      expect(languageOf(plan)).toMatchObject({ language: 'cs', outcome: 'selected' });
    }),
  );

  it.effect('an owner that requires English sends English even when the recipient context would ask for Czech', () =>
    Effect.gen(function* requiresEnglish() {
      const { plan } = yield* run({
        recipientLanguage: { kind: 'trusted', language: 'cs' },
        type: fixtureType({ ownerRequiredLanguage: 'en' }),
      });
      expect(languageOf(plan)).toMatchObject({ basis: 'owner-required-language', language: 'en', outcome: 'selected' });
    }),
  );

  it.effect(
    'an owner that requires English with no usable English revision stops the message and never falls back to Czech',
    () =>
      Effect.gen(function* noEnglish() {
        const { plan } = yield* run({
          languages: ['cs'],
          recipientLanguage: { kind: 'trusted', language: 'cs' },
          type: fixtureType({ ownerRequiredLanguage: 'en' }),
        });
        expect(languageOf(plan)).toMatchObject({ outcome: 'not-sent', reason: 'owner_required_language_unavailable' });
        expect(plan.intents[0]).toMatchObject({
          reason: Option.some('OWNER_REQUIRED_LANGUAGE_UNAVAILABLE'),
          status: 'NOT_SENT',
        });
      }),
  );

  it.effect('an owner that requires Czech is never sent English because the recipient asks for it', () =>
    Effect.gen(function* requiresCzech() {
      const { plan } = yield* run({
        recipientLanguage: { kind: 'trusted', language: 'en' },
        type: fixtureType({ ownerRequiredLanguage: 'cs' }),
      });
      expect(languageOf(plan)).toMatchObject({ basis: 'owner-required-language', language: 'cs', outcome: 'selected' });
    }),
  );
});

describe('Every stored reason is of the closed stop vocabulary (#1401)', () => {
  it.effect('a channel other than e-mail stops as CHANNEL_NOT_SUPPORTED', () =>
    Effect.gen(function* otherChannel() {
      const templates = makeInMemoryTemplatePort();
      const type = fixtureType();
      yield* seedLanguages(templates.port, ['cs', 'en'], { ...baseIdentity, messageType: type.typeId });
      const owner = recipientOwnerDouble({
        [`contact-${RECIPIENT}`]: (query) =>
          Effect.succeed(
            RecipientGateVerdict.Usable({
              endpoint: {
                channel: 'sms',
                contactRef: query.contact.contactRef,
                contactRevision: 1,
                mask: 'p***',
                value: Redacted.make('+420000000000'),
              },
            }),
          ),
      });
      const plan = yield* decideRequest(communicationRequest({ bindings: [originalRecipient(RECIPIENT)] }), {
        policies: makeInMemoryLanguagePolicyPort().port,
        resend: makeInMemoryResendPort().port,
        templates: templates.port,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            catalogOf(type),
            recipientLanguageDouble().layer,
            sourceAuthorityDouble().layer,
            scopeDeclarationDouble().layer,
            owner.layer,
            privacyOwnerDouble({ [RECIPIENT]: privacyAllowed }).layer,
          ),
        ),
      );
      expect(reasonOf(plan)).toBe('CHANNEL_NOT_SUPPORTED');
      expect(plan.intents[0]?.status).toBe('SUPPRESSED');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('a language stop is its own closed reason, not a case change of free text', () =>
    Effect.gen(function* noCzech() {
      const { plan } = yield* run({ languages: ['en'] });
      expect(reasonOf(plan)).toBe('CZECH_REVISION_UNAVAILABLE');
      expect(plan.intents[0]?.status).toBe('NOT_SENT');
    }),
  );

  it.effect('a recipient whose Privacy scope no producer declared stops as an unresolved Privacy context', () =>
    Effect.gen(function* undeclared() {
      const { plan } = yield* run({ scopeDeclared: false });
      expect(reasonOf(plan)).toBe('PRIVACY_CONTEXT_AMBIGUOUS');
      expect(Schema.is(IntentStopReasonSchema)(reasonOf(plan))).toBe(true);
    }),
  );

  it('the vocabulary is closed: a free-form or case-changed text is not a reason', () => {
    for (const reason of ['RECIPIENT_BASIS_MISSING', 'CHANNEL_NOT_SUPPORTED', 'LANGUAGE_POLICY_UNREADABLE']) {
      expect(Schema.is(IntentStopReasonSchema)(reason)).toBe(true);
    }
    for (const reason of ['czech_revision_unavailable', 'SOMETHING_ELSE', '']) {
      expect(Schema.is(IntentStopReasonSchema)(reason)).toBe(false);
    }
  });
});

describe('An ambiguous slot asks no Privacy owner (T4-02)', () => {
  it.effect(
    'two recipients of an EXACTLY_ONE slot are discarded without a scope declaration or a Privacy question',
    () =>
      Effect.gen(function* ambiguous() {
        const { plan, privacy } = yield* run({ recipients: ['customer-1', 'customer-2'] });
        expect(plan.intents).toEqual([]);
        expect(
          CommunicationOutcome.$match(plan.decision.outcome, {
            Candidates: () => [],
            NoMessage: ({ unresolvedSlots }) => unresolvedSlots.map(({ reason }) => reason),
          }),
        ).toEqual(['RECIPIENT_AMBIGUOUS']);
        expect(privacy.queries).toHaveLength(0);
      }),
  );

  it.effect('one recipient of the same slot is asked as before', () =>
    Effect.gen(function* single() {
      const { privacy } = yield* run();
      expect(privacy.queries).toHaveLength(1);
    }),
  );
});
