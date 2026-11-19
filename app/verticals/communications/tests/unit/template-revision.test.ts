import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { activateTemplateRevisionAction } from '../../src/actions/activate-template-revision.action.ts';
import { deactivateTemplateRevisionAction } from '../../src/actions/deactivate-template-revision.action.ts';
import { invalidateTemplateRevisionAction } from '../../src/actions/invalidate-template-revision.action.ts';
import { prepareTemplateRevisionAction } from '../../src/actions/prepare-template-revision.action.ts';
import { TemplatePinSchema, TemplateUseAuditSchema } from '../../shared/template-revision.ts';
import { extractPlaceholders } from '../../src/services/template-revision-domain.service.ts';
import {
  actorFor,
  adminOne,
  adminTwo,
  companyA,
  companyB,
  companyScope,
  domainFor,
  failureOf,
  fictionalDraft,
  identity,
  withCrypto,
} from '../support/template-fixtures.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';

describe('Template revisions: identity, activation, single administrator (#1398)', () => {
  it.effect('[S01 AC-01] an authorized administrator activates a complete prepared revision with a full trace', () => {
    const { advance, port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* activates() {
        yield* t.prepare(fictionalDraft());
        const second = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] v2 {{purpose}}' }))).revision;
        advance(5);
        const { activation } = yield* t.approve(second.revisionId);
        expect(second.revisionNumber).toBe(2);
        expect(activation.activatedByPrincipalId).toBe(adminOne.principalId);
        expect(activation.activationReason).toBe('Fictional approval for tests');
        expect(activation.scopeKey).toBe('tenant');
        expect(DateTime.formatIso(activation.activatedAt)).toBe('2026-11-19T10:05:00.000Z');
        expect((yield* t.resolve(identity())).revisionNumber).toBe(2);
        expect(state.activations).toHaveLength(1);
      }),
    );
  });

  it.effect(
    '[S02 AC-01] one administrator suffices: prepare and activate by the same single actor, no second approval',
    () => {
      const { port, state } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* single() {
          const { revision } = yield* t.prepare(fictionalDraft());
          const { activation } = yield* t.approve(revision.revisionId);
          expect(activation.activatedByPrincipalId).toBe(revision.createdByPrincipalId);
          expect(state.activations.map((found) => found.activatedByPrincipalId)).toEqual([adminOne.principalId]);
          expect((yield* t.resolve(identity())).revisionId).toBe(revision.revisionId);
        }),
      );
    },
  );

  it.effect('[S03 AC-01] an operation outside the exact scope changes nothing and keeps the current revision', () => {
    const { port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    const scoped = identity({ scope: companyScope(companyA) });
    return withCrypto(
      Effect.gen(function* outsideScope() {
        const { revision } = yield* t.prepare(fictionalDraft({ scope: scoped.scope }), actorFor(companyA));
        yield* t.approve(revision.revisionId, actorFor(companyA));
        const replacement = (yield* t.prepare(fictionalDraft({ scope: scoped.scope }), actorFor(companyA))).revision;
        const before = state.activations.map((found) => found.activationId);
        const wrongCompany = yield* failureOf(t.approve(replacement.revisionId, actorFor(companyB)));
        const noCompany = yield* failureOf(t.approve(replacement.revisionId, adminOne));
        expect(wrongCompany).toMatchObject({ code: 'template_scope_mismatch' });
        expect(noCompany).toMatchObject({ code: 'template_scope_mismatch' });
        expect(state.activations.map((found) => found.activationId)).toEqual(before);
        expect((yield* t.resolve(scoped)).revisionId).toBe(revision.revisionId);
      }),
    );
  });

  it('[S03 AC-01] every template Action is protected by its own concrete permission and no workload bypass', () => {
    const actions = [
      ['prepare', prepareTemplateRevisionAction],
      ['activate', activateTemplateRevisionAction],
      ['deactivate', deactivateTemplateRevisionAction],
      ['invalidate', invalidateTemplateRevisionAction],
    ] as const;
    for (const [verb, action] of actions) {
      const { descriptor } = action;
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(descriptor.accessDeclaration?.key).toBe(`communications.core.template-revision.${verb}`);
      expect(descriptor.accessDeclaration?.kind).toBe('action');
      expect(descriptor.accessDeclaration?.risk).not.toBe('routine');
      expect(descriptor.accessWorkload).toBeUndefined();
      expect(descriptor.idempotency).toBe('required');
    }
  });

  it.effect('[S04] an incomplete revision is refused with the missing placeholder and nothing is activated', () => {
    const { port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* incomplete() {
        const { revision } = yield* t.prepare(
          fictionalDraft({ body: '[FICTIONAL TEST COPY] no purpose here', subject: '[FICTIONAL TEST COPY] fixed' }),
        );
        expect(yield* failureOf(t.approve(revision.revisionId))).toMatchObject({
          code: 'template_placeholder_missing',
          placeholders: ['purpose'],
        });
        expect(state.activations).toHaveLength(0);
        expect(yield* failureOf(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
      }),
    );
  });

  it.effect('[S04 AC-04] an undeclared placeholder and a malformed brace are not activatable or storable', () => {
    const { port } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* incompatible() {
        const { revision } = yield* t.prepare(fictionalDraft({ body: '{{purpose}} and {{surprise_value}}' }));
        expect(yield* failureOf(t.approve(revision.revisionId))).toMatchObject({
          code: 'template_placeholder_undeclared',
          placeholders: ['surprise_value'],
        });
        expect(yield* failureOf(t.prepare(fictionalDraft({ body: '{{purpose} broken' })))).toMatchObject({
          code: 'template_content_malformed',
        });
        expect(
          yield* failureOf(
            t.prepare(fictionalDraft({ optionalPlaceholders: ['purpose'], requiredPlaceholders: ['purpose'] })),
          ),
        ).toMatchObject({ code: 'template_content_malformed' });
      }),
    );
  });

  it.effect('[S05 AC-04] two open activations of one identity are an explicit failure, never a pick', () => {
    const { port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* conflict() {
        const { revision } = yield* t.prepare(fictionalDraft());
        yield* t.approve(revision.revisionId);
        const [only] = state.activations;
        if (only !== undefined) {
          // A corrupted store: the PostgreSQL form makes this impossible, the rule still must not guess.
          state.activations.push({ ...only, activationId: '00000000-0000-4000-8000-0000000000f1' });
        }
        expect(yield* failureOf(t.resolve(identity()))).toMatchObject({ code: 'template_active_revision_ambiguous' });
      }),
    );
  });

  it.effect(
    '[S06 AC-02] a new message pins the one active revision with identity, language, scope and decision time',
    () => {
      const { advance, port } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* pins() {
          const { revision } = yield* t.prepare(fictionalDraft());
          advance(1);
          yield* t.approve(revision.revisionId);
          advance(1);
          const pin = yield* t.resolve(identity());
          expect(DateTime.formatIso(pin.decisionTime)).toBe('2026-11-19T10:02:00.000Z');
          expect(pin).toMatchObject({
            channel: 'email',
            language: 'cs',
            messageType: 'fixture.transactional-notice',
            revisionId: revision.revisionId,
            revisionNumber: 1,
            scope: { kind: 'tenant' },
            templateTypeId: revision.templateTypeId,
          });
          expect(Schema.is(TemplatePinSchema)(pin)).toBe(true);
        }),
      );
    },
  );

  it.effect(
    '[S07 S08 AC-02 AC-03] a retry keeps the pinned revision; a new request uses the new one; history stays explainable',
    () => {
      const { advance, port } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* retryAndNewRequest() {
          const second = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] second {{purpose}}' })))
            .revision;
          yield* t.approve(second.revisionId);
          advance(10);
          const pin = yield* t.resolve(identity());
          advance(10);
          const third = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] third {{purpose}}' })))
            .revision;
          yield* t.approve(third.revisionId);
          // retry of the same intent: verify the stored pin, never resolve again
          const retried = yield* t.verify(pin);
          expect(retried).toEqual(pin);
          expect(retried.revisionId).toBe(second.revisionId);
          // a different business request resolves the then-active revision
          const fresh = yield* t.resolve(identity());
          expect(fresh.revisionId).toBe(third.revisionId);
          expect(fresh.revisionNumber).toBe(2);
          // the earlier use is still answerable: revision 1 was active at the decision time and then replaced
          const audit = yield* t.describe(pin);
          expect(audit.activeAtDecisionTime).toBe(true);
          expect(audit.lifecycleState).toBe('retired');
          expect(audit.activations[0]?.endedKind).toBe('replaced');
        }),
      );
    },
  );

  it.effect(
    '[S09 AC-05] an unsafe-invalidated pinned revision blocks handoff and is never switched to a newer one',
    () => {
      const { advance, port, state } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* unsafe() {
          const first = (yield* t.prepare(fictionalDraft())).revision;
          yield* t.approve(first.revisionId);
          advance(1);
          const pin = yield* t.resolve(identity());
          const newer = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] newer {{purpose}}' })))
            .revision;
          advance(1);
          yield* t.approve(newer.revisionId);
          advance(1);
          yield* t.invalidate(first.revisionId);
          const blocked = yield* failureOf(t.verify(pin));
          expect(blocked).toMatchObject({
            code: 'pinned_template_revision_invalidated_unsafe',
            revisionId: first.revisionId,
          });
          // the original decision is not rewritten and no replacement is offered
          expect(pin.revisionId).toBe(first.revisionId);
          expect(Object.keys(blocked)).not.toContain('replacementRevisionId');
          // a NEW request resolves independently of the blocked one
          expect((yield* t.resolve(identity())).revisionId).toBe(newer.revisionId);
          expect(state.invalidations).toHaveLength(1);
          const audit = yield* t.describe(pin);
          expect(audit.lifecycleState).toBe('invalidated-unsafe');
          expect(audit.invalidation?.reason).toBe('Fictional unsafe wording');
          expect(yield* failureOf(t.invalidate(first.revisionId, 'Again'))).toMatchObject({
            code: 'template_revision_already_invalidated',
          });
          expect(yield* failureOf(t.approve(first.revisionId))).toMatchObject({
            code: 'template_revision_invalidated',
          });
        }),
      );
    },
  );

  it.effect(
    '[S09] invalidating the only active revision leaves an explicit no-active failure, not a silent fallback',
    () => {
      const { port } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* onlyActive() {
          const only = (yield* t.prepare(fictionalDraft())).revision;
          yield* t.approve(only.revisionId);
          yield* t.invalidate(only.revisionId);
          expect(yield* failureOf(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
        }),
      );
    },
  );

  it.effect('[S10 T-07 AC-07] the audit answers revision, language and scope without text or secrets', () => {
    const { port } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    const english = identity({ language: 'en' });
    return withCrypto(
      Effect.gen(function* audit() {
        const { revision } = yield* t.prepare(
          fictionalDraft({
            ...english,
            body: '[FICTIONAL TEST COPY] code {{one_time_code}}',
            optionalPlaceholders: [],
            requiredPlaceholders: ['one_time_code'],
            subject: '[FICTIONAL TEST COPY] notice',
          }),
        );
        yield* t.approve(revision.revisionId, adminTwo);
        const pin = yield* t.resolve(english);
        const view = yield* t.describe(pin);
        expect(view.identity).toEqual(english);
        expect(view.revisionNumber).toBe(1);
        expect(view.lifecycleState).toBe('active');
        expect(view.activations[0]).toMatchObject({ activatedByPrincipalId: adminTwo.principalId, scopeKey: 'tenant' });
        expect(view.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
        const serialized = JSON.stringify(Schema.encodeSync(TemplateUseAuditSchema)(view));
        expect(serialized).not.toContain('FICTIONAL TEST COPY');
        expect(serialized).not.toContain('one_time_code');
        expect(Object.keys(pin).toSorted((left, right) => left.localeCompare(right))).toEqual([
          'channel',
          'decisionTime',
          'language',
          'messageType',
          'revisionId',
          'revisionNumber',
          'scope',
          'templateTypeId',
        ]);
      }),
    );
  });

  it.effect('[S11 AC-04] another scope or another language never substitutes for a missing revision', () => {
    const { port } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* noSubstitution() {
        const other = (yield* t.prepare(fictionalDraft({ scope: companyScope(companyB) }), actorFor(companyB)))
          .revision;
        yield* t.approve(other.revisionId, actorFor(companyB));
        const english = (yield* t.prepare(fictionalDraft({ language: 'en' }))).revision;
        yield* t.approve(english.revisionId);
        // company A has no revision; only company B and the tenant-wide English one exist
        expect(yield* failureOf(t.resolve(identity({ scope: companyScope(companyA) })))).toMatchObject({
          code: 'template_no_active_revision',
        });
        expect(yield* failureOf(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
      }),
    );
  });

  it.effect('[AC-06] approved CS and EN revisions of one message type are separately identifiable', () => {
    const { port } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* bothLanguages() {
        const cs = (yield* t.prepare(fictionalDraft())).revision;
        const en = (yield* t.prepare(fictionalDraft({ language: 'en' }))).revision;
        yield* t.approve(cs.revisionId);
        yield* t.approve(en.revisionId);
        const pinCs = yield* t.resolve(identity());
        const pinEn = yield* t.resolve(identity({ language: 'en' }));
        expect([pinCs.language, pinEn.language]).toEqual(['cs', 'en']);
        expect(pinCs.templateTypeId).not.toBe(pinEn.templateTypeId);
      }),
    );
  });

  it.effect('[T-02 AC-02] every text is a new immutable revision; a Type keeps one declaration', () => {
    const { port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* immutable() {
        const first = (yield* t.prepare(fictionalDraft())).revision;
        const snapshot = structuredClone(state.revisions[0]);
        const changed = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] changed {{purpose}}' })))
          .revision;
        expect([first.revisionNumber, changed.revisionNumber]).toEqual([1, 2]);
        expect(changed.contentDigest).not.toBe(first.contentDigest);
        expect(state.revisions[0]).toEqual(snapshot);
        expect(state.types).toHaveLength(1);
        expect(
          yield* failureOf(
            t.prepare(fictionalDraft({ optionalPlaceholders: [], requiredPlaceholders: ['purpose', 'reference'] })),
          ),
        ).toMatchObject({ code: 'template_type_declaration_conflict' });
      }),
    );
  });

  it.effect(
    '[T-04] deactivation ends the active period and later resolution fails explicitly; re-activation is traced',
    () => {
      const { advance, port, state } = makeInMemoryTemplatePort();
      const t = domainFor(port);
      return withCrypto(
        Effect.gen(function* deactivates() {
          const { revision } = yield* t.prepare(fictionalDraft());
          yield* t.approve(revision.revisionId);
          advance(5);
          expect(yield* failureOf(t.deactivate('00000000-0000-4000-8000-0000000000e1'))).toMatchObject({
            code: 'template_revision_not_found',
          });
          yield* t.deactivate(revision.revisionId);
          expect(yield* failureOf(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
          expect(yield* failureOf(t.deactivate(revision.revisionId, 'Again'))).toMatchObject({
            code: 'template_revision_not_active',
          });
          advance(5);
          yield* t.approve(revision.revisionId);
          expect(yield* failureOf(t.approve(revision.revisionId))).toMatchObject({
            code: 'template_revision_already_active',
          });
          expect(state.activations.map((found) => Option.isSome(found.ending))).toEqual([true, false]);
        }),
      );
    },
  );

  it.effect('[T-09] a pinned revision that no longer exists is an explicit failure, never an upgrade', () => {
    const { port, state } = makeInMemoryTemplatePort();
    const t = domainFor(port);
    return withCrypto(
      Effect.gen(function* vanished() {
        const { revision } = yield* t.prepare(fictionalDraft());
        yield* t.approve(revision.revisionId);
        const pin = yield* t.resolve(identity());
        state.revisions.length = 0;
        expect(yield* failureOf(t.verify(pin))).toMatchObject({ code: 'pinned_template_revision_unavailable' });
      }),
    );
  });

  it('extracts well-formed placeholders and flags stray braces', () => {
    expect(extractPlaceholders('a {{one}} b {{ two_2 }}')).toEqual({ malformed: false, names: ['one', 'two_2'] });
    expect(extractPlaceholders('{{Bad}}').malformed).toBe(true);
    expect(extractPlaceholders('{{ok}} }}').malformed).toBe(true);
    expect(extractPlaceholders('plain')).toEqual({ malformed: false, names: [] });
  });
});
