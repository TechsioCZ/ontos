import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { chooseLanguage } from '../../src/domain/language/selection.ts';
import type { LanguageSelectionInput } from '../../src/domain/language/selection.ts';
import { LanguageDecisionSchema, primaryLanguageSubtag } from '../../src/domain/language/vocabulary.ts';
import type { LanguageDecision } from '../../src/domain/language/vocabulary.ts';
import { companyA, companyB, companyScope } from '../support/template-fixtures.ts';
import {
  ambiguous,
  availability,
  baseIdentity,
  missing,
  notSentOf,
  pinOf,
  platformDefaultPolicy,
  tenantPolicy,
  selectedOf,
  unreadablePolicy,
  usable,
} from '../support/language-fixtures.ts';

const trusted = (language: string) => ({ kind: 'trusted', language }) as const;
const notEstablished = { kind: 'not-established' } as const;
const decide = (overrides: Partial<LanguageSelectionInput> = {}): LanguageDecision =>
  chooseLanguage({
    availability: availability(usable('cs'), usable('en')),
    base: baseIdentity,
    ownerPermittedLanguages: ['cs', 'en'],
    policy: platformDefaultPolicy,
    recipient: notEstablished,
    ...overrides,
  });
const selected = selectedOf;
const notSent = notSentOf;

describe('Czech is the default and the only fallback (L-01, L-03)', () => {
  it('[S01 AC-02] no trusted language selects cs and pins the Czech revision', () => {
    const decision = selected(decide());
    expect(decision).toMatchObject({ basis: 'default-no-trusted-language', language: 'cs' });
    expect(decision.pin).toEqual(pinOf('cs'));
    expect(decision.requestedLanguage).toBeUndefined();
  });

  it('[S01] a malformed or inferred value is no language: nothing is guessed from an address, host or domain', () => {
    for (const value of ['de.example.com', 'user@example.cz', 'https://example.com/en', '', 'x', ' en']) {
      expect(Option.isNone(primaryLanguageSubtag(value))).toBe(true);
      expect(selected(decide({ recipient: trusted(value) }))).toMatchObject({
        basis: 'default-no-trusted-language',
        language: 'cs',
      });
    }
  });

  it('[S03 AC-02] an unsupported language such as de falls back to cs and records the original context', () => {
    const decision = selected(decide({ recipient: trusted('de') }));
    expect(decision).toMatchObject({ basis: 'fallback-unsupported-language', language: 'cs', requestedLanguage: 'de' });
    expect(decision.pin.messageType).toBe(baseIdentity.messageType);
    expect(decision.pin.scope).toEqual(baseIdentity.scope);
  });

  it('[S04 AC-02] a missing EN revision falls back to the approved Czech revision and records cs, not en', () => {
    const decision = selected(decide({ availability: availability(usable('cs'), missing), recipient: trusted('en') }));
    expect(decision).toMatchObject({ basis: 'fallback-revision-missing', language: 'cs', requestedLanguage: 'en' });
  });

  it('[S05 AC-03] no approved Czech revision stops the message with the reason, in both modes', () => {
    for (const policy of [platformDefaultPolicy, tenantPolicy('A')]) {
      for (const recipient of [notEstablished, trusted('de'), trusted('cs')]) {
        const stopped = notSent(decide({ availability: availability(missing, missing), policy, recipient }));
        expect(stopped).toMatchObject({ affectedLanguage: 'cs', reason: 'czech_revision_unavailable' });
      }
      expect(
        notSent(decide({ availability: availability(missing, missing), policy, recipient: trusted('en') })).reason,
      ).toBe('czech_revision_unavailable');
    }
  });

  it('[S05 AC-03] Czech is the default: with only an EN revision and no trusted en the message is never sent in English', () => {
    for (const policy of [platformDefaultPolicy, tenantPolicy('A')]) {
      for (const recipient of [notEstablished, trusted('de'), trusted('cs')]) {
        expect(notSent(decide({ availability: availability(missing, usable('en')), policy, recipient })).reason).toBe(
          'czech_revision_unavailable',
        );
      }
    }
  });
});

describe('A trusted en selects the approved EN revision (L-02)', () => {
  it('[S02 AC-02] en with usable EN and CS revisions selects en in both modes and pins the EN revision', () => {
    for (const policy of [platformDefaultPolicy, tenantPolicy('A')]) {
      const decision = selected(decide({ policy, recipient: trusted('en') }));
      expect(decision).toMatchObject({ basis: 'trusted-context', language: 'en', requestedLanguage: 'en' });
      expect(decision.pin.language).toBe('en');
    }
  });

  it('[S02] a regional tag of a supported language counts as that language', () => {
    expect(selected(decide({ recipient: trusted('EN-gb') })).language).toBe('en');
    expect(selected(decide({ recipient: trusted('cs_CZ') })).language).toBe('cs');
  });

  it('[S01] a trusted cs selects cs', () => {
    expect(selected(decide({ recipient: trusted('cs') }))).toMatchObject({ basis: 'trusted-context', language: 'cs' });
  });
});

describe('Tenant mode B requires Czech, mode A allows English without it (L-02, L-13)', () => {
  const englishOnly = availability(missing, usable('en'));

  it('[S07 AC-03] the default mode B stops a trusted en even though an approved EN revision exists', () => {
    const decision = notSent(
      decide({ availability: englishOnly, policy: platformDefaultPolicy, recipient: trusted('en') }),
    );
    expect(decision).toMatchObject({
      affectedLanguage: 'cs',
      mode: 'B',
      policy: { platformDefaultVersion: 1, source: 'platform-default' },
      reason: 'czech_revision_required_by_mode_b',
    });
  });

  it('[S08 AC-03] mode A selects the EN revision without a Czech one and pins mode A and its policy version', () => {
    const policy = tenantPolicy('A');
    const decision = selected(decide({ availability: englishOnly, policy, recipient: trusted('en') }));
    expect(decision).toMatchObject({ basis: 'trusted-context', language: 'en', mode: 'A' });
    expect(decision.policy).toEqual(policy.kind === 'effective' ? policy.policy : undefined);
  });

  it('[AC-03] mode A allows no English without a trusted en: the Czech default is still needed and missing', () => {
    expect(
      notSent(decide({ availability: englishOnly, policy: tenantPolicy('A'), recipient: notEstablished })).reason,
    ).toBe('czech_revision_unavailable');
  });

  it('[AC-03] mode A with a missing EN revision falls back to Czech, and needs it', () => {
    expect(
      notSent(
        decide({ availability: availability(missing, missing), policy: tenantPolicy('A'), recipient: trusted('en') }),
      ).reason,
    ).toBe('czech_revision_unavailable');
  });

  it('[AC-03] mode B records which type and scope lacked Czech and does not use another scope', () => {
    const decision = notSent(
      decide({
        // a Czech revision of another company is offered, but the decision is about the Tenant-wide scope
        availability: availability(usable('cs', { scope: companyScope(companyB) }), usable('en')),
        policy: platformDefaultPolicy,
        recipient: trusted('en'),
      }),
    );
    expect(decision.reason).toBe('czech_revision_required_by_mode_b');
  });
});

describe('Another company or scope is never used (L-03, S06)', () => {
  it('[S06 AC-03] a Czech revision of another scope, brand or type is not usable, so the message stops', () => {
    const foreign = [
      usable('cs', { scope: companyScope(companyA) }),
      usable('cs', { messageType: 'fixture.other-notice' }),
      usable('cs', { channel: 'email', language: 'en' }),
    ];
    for (const offered of foreign) {
      expect(notSent(decide({ availability: availability(offered, missing) })).reason).toBe(
        'czech_revision_unavailable',
      );
    }
  });

  it('[S06] a pin of the exact legal entity scope is usable only for that scope', () => {
    const base = { ...baseIdentity, scope: companyScope(companyA) };
    expect(
      selected(decide({ availability: availability(usable('cs', { scope: companyScope(companyA) }), missing), base }))
        .language,
    ).toBe('cs');
    expect(
      notSent(decide({ availability: availability(usable('cs', { scope: companyScope(companyB) }), missing), base }))
        .reason,
    ).toBe('czech_revision_unavailable');
  });
});

describe('A binding owner language is never overridden (L-03, S11)', () => {
  it('[S11 AC-03] an owner that permits only en stops when EN is missing, never falling back to cs', () => {
    for (const policy of [platformDefaultPolicy, tenantPolicy('A')]) {
      const decision = notSent(
        decide({ availability: availability(usable('cs'), missing), ownerPermittedLanguages: ['en'], policy }),
      );
      expect(decision).toMatchObject({ affectedLanguage: 'en', reason: 'owner_required_language_unavailable' });
    }
  });

  it('[S11] an owner that permits only en uses en whatever the recipient context says', () => {
    const decision = selected(
      decide({ ownerPermittedLanguages: ['en'], policy: tenantPolicy('A'), recipient: trusted('cs') }),
    );
    expect(decision).toMatchObject({ basis: 'owner-required-language', language: 'en' });
  });

  it('[S11] an owner that permits only cs ignores a trusted en and stops when Czech is missing', () => {
    expect(selected(decide({ ownerPermittedLanguages: ['cs'], recipient: trusted('en') })).language).toBe('cs');
    expect(
      notSent(
        decide({
          availability: availability(missing, usable('en')),
          ownerPermittedLanguages: ['cs'],
          recipient: trusted('en'),
        }),
      ).reason,
    ).toBe('owner_required_language_unavailable');
  });

  it('[S11] a repeated owner entry is still one binding language', () => {
    expect(selected(decide({ ownerPermittedLanguages: ['cs', 'cs'], recipient: trusted('en') }))).toMatchObject({
      basis: 'owner-required-language',
      language: 'cs',
    });
  });

  it('[S11] an owner-required en still needs Czech under mode B, as every English message does', () => {
    expect(
      notSent(decide({ availability: availability(missing, usable('en')), ownerPermittedLanguages: ['en'] })).reason,
    ).toBe('czech_revision_required_by_mode_b');
  });
});

describe('An ambiguous revision is never chosen at random (G: two EN revisions with the same activation)', () => {
  it('[AC-02] an ambiguous EN revision stops the message instead of falling back or picking one', () => {
    expect(
      notSent(decide({ availability: availability(usable('cs'), ambiguous), recipient: trusted('en') })),
    ).toMatchObject({ affectedLanguage: 'en', reason: 'template_revision_ambiguous' });
  });

  it('[AC-02] an ambiguous Czech revision stops the message in the default path and in mode B for an EN recipient', () => {
    expect(notSent(decide({ availability: availability(ambiguous, usable('en')) })).reason).toBe(
      'template_revision_ambiguous',
    );
    expect(
      notSent(decide({ availability: availability(ambiguous, usable('en')), recipient: trusted('en') })).reason,
    ).toBe('template_revision_ambiguous');
  });
});

describe('An unreadable Tenant mode fails closed (L-13)', () => {
  it('[AC-11] stops with the unreadable reason and pins neither a mode nor a revision', () => {
    for (const recipient of [notEstablished, trusted('en'), trusted('cs')]) {
      const decision = notSent(decide({ policy: unreadablePolicy, recipient }));
      expect(decision.reason).toBe('language_policy_unreadable');
      expect(decision.mode).toBeUndefined();
      expect(decision.policy).toBeUndefined();
    }
  });
});

describe('The decision is the pin (L-04) and says nothing about recipient, Market, currency or legal basis (L-05)', () => {
  it('[AC-04] a selected decision carries exactly language, revision identity, mode and policy version evidence', () => {
    const decision = selected(decide({ policy: tenantPolicy('A'), recipient: trusted('en') }));
    expect(Object.keys(decision).toSorted()).toEqual(
      ['basis', 'language', 'mode', 'outcome', 'pin', 'policy', 'requestedLanguage'].toSorted(),
    );
    expect(Object.keys(decision.pin).toSorted()).toEqual(
      [
        'channel',
        'decisionTime',
        'language',
        'messageType',
        'revisionId',
        'revisionNumber',
        'scope',
        'templateTypeId',
      ].toSorted(),
    );
  });

  it('[AC-09] the language never changes anything but the revision: the same type and scope for every outcome', () => {
    const outcomes = [notEstablished, trusted('en'), trusted('de'), trusted('cs')].map((recipient) =>
      selected(decide({ recipient })),
    );
    for (const outcome of outcomes) {
      expect(outcome.pin.messageType).toBe(baseIdentity.messageType);
      expect(outcome.pin.channel).toBe(baseIdentity.channel);
      expect(outcome.pin.scope).toEqual(baseIdentity.scope);
    }
  });

  it('[AC-04] a decision survives storage unchanged: it round-trips through its schema', () => {
    for (const decision of [
      decide({ policy: tenantPolicy('A'), recipient: trusted('en') }),
      decide({ availability: availability(missing, missing) }),
      decide({ policy: unreadablePolicy }),
    ]) {
      const stored = Schema.encodeSync(LanguageDecisionSchema)(decision);
      expect(Schema.decodeUnknownSync(LanguageDecisionSchema)(structuredClone(stored))).toEqual(decision);
    }
  });
});
