import { NodeCrypto } from '@effect/platform-node';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TemplatePinBlocked } from '../../shared/template-revision-errors.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import { decideMessageLanguage, verifyLanguageForHandoff } from '../../src/services/language-selection.service.ts';
import type { DecideLanguageInput } from '../../src/services/language-selection.service.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import {
  baseIdentity,
  makeInMemoryLanguagePolicyPort,
  seedLanguages,
  selectedOf,
} from '../support/language-fixtures.ts';
import { companyA, companyB, companyScope, domainFor, fictionalDraft, identity } from '../support/template-fixtures.ts';

const principalId = '00000000-0000-4000-8000-0000000000b1';
const actor = { actionInvocationId: '00000000-0000-4000-8000-0000000000a1', principalId };
const english = { kind: 'trusted', language: 'en' } as const;
const input = (overrides: Partial<DecideLanguageInput> = {}): DecideLanguageInput => ({
  base: baseIdentity,
  ownerPermittedLanguages: ['cs', 'en'],
  recipient: english,
  ...overrides,
});
const selected = selectedOf;
const withTenant = () => ({ policies: makeInMemoryLanguagePolicyPort(), templates: makeInMemoryTemplatePort() });

describe('A decision resolves the exact type and scope through the template pin contract', () => {
  it.effect('[S01 S02 AC-02 AC-04] the pinned revision is the approved active one of the chosen language', () =>
    Effect.gen(function* pinned() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
      const czech = selected(
        yield* decideMessageLanguage(
          tenant.templates.port,
          tenant.policies.port,
          input({ recipient: { kind: 'not-established' } }),
        ),
      );
      const englishDecision = selected(
        yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()),
      );
      expect([czech.language, englishDecision.language]).toEqual(['cs', 'en']);
      const audit = yield* domainFor(tenant.templates.port).describe(englishDecision.pin);
      expect(audit.identity.language).toBe('en');
      expect(audit.revisionId).toBe(englishDecision.pin.revisionId);
      expect(englishDecision.policy).toEqual({ platformDefaultVersion: 1, source: 'platform-default' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S06 AC-03] a Czech revision of another company or Tenant is never used', () =>
    Effect.gen(function* foreign() {
      const ownTenant = withTenant();
      const otherTenant = withTenant();
      yield* seedLanguages(ownTenant.templates.port, ['en']);
      yield* seedLanguages(otherTenant.templates.port, ['cs', 'en']);
      // another company of the same Tenant has Czech, the exact scope has none
      yield* seedLanguages(ownTenant.templates.port, ['cs'], { ...baseIdentity, scope: companyScope(companyB) });
      const stopped = yield* decideMessageLanguage(
        ownTenant.templates.port,
        ownTenant.policies.port,
        input({ base: { ...baseIdentity, scope: companyScope(companyA) }, recipient: { kind: 'not-established' } }),
      );
      expect(stopped).toMatchObject({ outcome: 'not-sent', reason: 'czech_revision_unavailable' });
      // the Tenant-wide scope has English only: mode B stops the trusted en, the other Tenant's Czech is invisible
      const own = yield* decideMessageLanguage(ownTenant.templates.port, ownTenant.policies.port, input());
      expect(own).toMatchObject({ outcome: 'not-sent', reason: 'czech_revision_required_by_mode_b' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-03] a deactivated or unsafe-invalidated Czech revision is not usable, so it counts as missing', () =>
    Effect.gen(function* retired() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['en']);
      const t = domainFor(tenant.templates.port);
      const czech = (yield* t.prepare(fictionalDraft({ ...identity({ language: 'cs' }) }))).revision;
      yield* t.approve(czech.revisionId);
      expect(
        selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input())).language,
      ).toBe('en');
      yield* t.invalidate(czech.revisionId);
      expect(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input())).toMatchObject({
        outcome: 'not-sent',
        reason: 'czech_revision_required_by_mode_b',
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('Retry reuses the pinned decision (L-04, S10)', () => {
  it.effect('[S10 AC-04 AC-11] a newer revision and a changed recipient language never reach the pinned message', () =>
    Effect.gen(function* retry() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
      const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      expect([pinned.language, pinned.pin.revisionNumber]).toEqual(['en', 1]);
      const t = domainFor(tenant.templates.port);
      const next = (yield* t.prepare(
        fictionalDraft({ ...identity({ language: 'en' }), body: '[FICTIONAL TEST COPY] new {{purpose}}' }),
      )).revision;
      yield* t.approve(next.revisionId);
      // the recipient now prefers cs; the gate takes only the stored decision, so it cannot see that
      const retried = yield* verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned);
      expect(retried).toEqual({ decision: pinned, outcome: 'proceed' });
      // only a new business request resolves again and gets revision 2 and the new language
      const fresh = selected(
        yield* decideMessageLanguage(
          tenant.templates.port,
          tenant.policies.port,
          input({ recipient: { kind: 'trusted', language: 'cs' } }),
        ),
      );
      expect([fresh.language, fresh.pin.revisionNumber]).toEqual(['cs', 1]);
      const freshEnglish = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      expect(freshEnglish.pin.revisionNumber).toBe(2);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[S10 AC-04] an unsafe-invalidated pinned revision blocks the handoff and offers no replacement', () =>
    Effect.gen(function* unsafe() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
      const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      yield* domainFor(tenant.templates.port).invalidate(pinned.pin.revisionId);
      const blocked = yield* Effect.flip(verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned));
      expect(blocked).toBeInstanceOf(TemplatePinBlocked);
      expect(blocked).toMatchObject({
        code: 'pinned_template_revision_invalidated_unsafe',
        revisionId: pinned.pin.revisionId,
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('Tenant mode A and B through the decision (L-13, AC-11)', () => {
  it.effect('[S07 S08 S09 AC-03 AC-11] B by default, B to A to B, per Tenant, earlier results untouched', () =>
    Effect.gen(function* switching() {
      const one = withTenant();
      const two = withTenant();
      yield* seedLanguages(one.templates.port, ['en']);
      yield* seedLanguages(two.templates.port, ['en']);
      const decideOne = decideMessageLanguage(one.templates.port, one.policies.port, input());
      const decideTwo = decideMessageLanguage(two.templates.port, two.policies.port, input());

      const earlier = yield* decideOne;
      expect(earlier).toMatchObject({ mode: 'B', outcome: 'not-sent', reason: 'czech_revision_required_by_mode_b' });
      const earlierSnapshot = structuredClone(earlier);

      yield* setLanguageMode(one.policies.port, 'A', actor);
      // switching to A never revives the earlier not-sent decision: it is a stored value nothing rewrites
      expect(earlier).toEqual(earlierSnapshot);
      const underA = selected(yield* decideOne);
      expect(underA).toMatchObject({ language: 'en', mode: 'A', policy: { source: 'tenant', versionNumber: 1 } });
      // the other Tenant keeps B
      expect(yield* decideTwo).toMatchObject({ mode: 'B', outcome: 'not-sent' });

      yield* setLanguageMode(one.policies.port, 'B', actor);
      expect(yield* decideOne).toMatchObject({
        mode: 'B',
        outcome: 'not-sent',
        policy: { source: 'tenant', versionNumber: 2 },
        reason: 'czech_revision_required_by_mode_b',
      });
      // the English intent decided under A is stopped before its last stoppable handoff, and rewritten by nothing
      const underASnapshot = structuredClone(underA);
      const gate = yield* verifyLanguageForHandoff(one.templates.port, one.policies.port, underA);
      expect(gate).toEqual({ currentMode: 'B', outcome: 'stop', reason: 'czech_revision_required_by_mode_b' });
      expect(underA).toEqual(underASnapshot);
      expect(underA).toMatchObject({ language: 'en', mode: 'A', policy: { versionNumber: 1 } });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] with a usable Czech revision the pinned English intent passes under B and under A', () =>
    Effect.gen(function* bothModes() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
      const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      for (const mode of ['B', 'A'] as const) {
        yield* setLanguageMode(tenant.policies.port, mode, actor);
        expect(yield* verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned)).toEqual({
          decision: pinned,
          outcome: 'proceed',
        });
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] a pinned Czech intent is not stopped by a mode change in either direction', () =>
    Effect.gen(function* czechPin() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs']);
      const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      expect(pinned.language).toBe('cs');
      for (const mode of ['A', 'B'] as const) {
        yield* setLanguageMode(tenant.policies.port, mode, actor);
        expect((yield* verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned)).outcome).toBe(
          'proceed',
        );
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('[AC-11] an English intent pinned under B is stopped when its Czech revision becomes unusable', () =>
    Effect.gen(function* czechGone() {
      const tenant = withTenant();
      yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
      const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
      const t = domainFor(tenant.templates.port);
      // the Czech revision was seeded first
      const [czech] = tenant.templates.state.revisions;
      yield* t.deactivate(czech?.revisionId ?? '');
      const gate = yield* verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned);
      expect(gate.outcome === 'stop' ? gate.reason : undefined).toBe('czech_revision_required_by_mode_b');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[AC-11] an unreadable setting blocks the new decision and the last handoff, and is never the default',
    () =>
      Effect.gen(function* unreadable() {
        const tenant = withTenant();
        yield* seedLanguages(tenant.templates.port, ['cs', 'en']);
        const pinned = selected(yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input()));
        tenant.policies.state.unreadable = true;
        const decision = yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input());
        expect(decision).toMatchObject({ outcome: 'not-sent', reason: 'language_policy_unreadable' });
        expect(decision).not.toHaveProperty('mode');
        expect(yield* verifyLanguageForHandoff(tenant.templates.port, tenant.policies.port, pinned)).toEqual({
          outcome: 'stop',
          reason: 'language_policy_unreadable',
        });
        tenant.policies.state.unreadable = false;
        expect((yield* decideMessageLanguage(tenant.templates.port, tenant.policies.port, input())).outcome).toBe(
          'selected',
        );
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
