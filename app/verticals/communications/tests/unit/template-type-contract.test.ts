import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateRefused } from '../../shared/template-revision-errors.ts';
import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { templateContractOf, TemplateContractSchema } from '../../src/domain/catalog/template-contract.ts';
import {
  activateRevision,
  approvedTemplateTypes,
  deactivateRevision,
  invalidateRevisionAsUnsafe,
  prepareRevision,
  templateContentDigest,
} from '../../src/services/template-revision-domain.service.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { adminOne, domainFor, fictionalDraft, identity } from '../support/template-fixtures.ts';

/**
 * #1398 D.3 / G / BDD "Neúplný obsah nelze aktivovat", #1399 L-08, #1406 D.5/D.6: a revision is compared with the approved
 * message type, not only with itself; the Template Actions only know approved message types (T3-14); the digest covers the
 * declared placeholders (T4-05). Revisions of the Portal Auth types use the production contract; the texts are FICTIONAL.
 */

const RESET = 'commerce.customer-context.portal-auth.reset-password-message';
const OTP = 'commerce.customer-context.portal-auth.otp-message';
const VERIFY = 'commerce.customer-context.portal-auth.verify-email-message';
const SLOT = { [OTP]: 'otp_code', [RESET]: 'reset_link', [VERIFY]: 'verification_link' } as const;

const draftOf = (messageType: keyof typeof SLOT, overrides: Parameters<typeof fictionalDraft>[0] = {}) =>
  fictionalDraft({
    ...identity({ messageType }),
    body: `[FICTIONAL TEST COPY] {{${SLOT[messageType]}}}`,
    optionalPlaceholders: [],
    requiredPlaceholders: [SLOT[messageType]],
    subject: '[FICTIONAL TEST COPY] subject',
    ...overrides,
  });

/** Prepares with the PRODUCTION catalog (the Action default) and activates with it too, as the Actions do. */
const productionActivation = (messageType: keyof typeof SLOT, overrides: Parameters<typeof fictionalDraft>[0] = {}) =>
  Effect.gen(function* attempt() {
    const memory = makeInMemoryTemplatePort();
    const { revision } = yield* prepareRevision(memory.port, draftOf(messageType, overrides), adminOne);
    return {
      activate: activateRevision(
        memory.port,
        { reason: 'Fictional approval', revisionId: revision.revisionId },
        adminOne,
      ),
      memory,
      revision,
    };
  });

describe('Activation compares a revision with its approved message type (T2-04)', () => {
  it('declares exactly one required owner-rendered slot per Portal Auth type', () => {
    expect(approvedMessageTypes.map(({ typeId }) => typeId).toSorted()).toEqual(Object.keys(SLOT).toSorted());
    for (const [typeId, name] of Object.entries(SLOT)) {
      const type = approvedMessageTypes.find((candidate) => candidate.typeId === typeId);
      expect(type === undefined ? undefined : templateContractOf(type).placeholders).toEqual([
        { kind: 'owner-rendered', name, required: true },
      ]);
    }
  });

  it.effect.each([RESET, OTP, VERIFY] as const)(
    'activates a revision of %s that carries its secret slot and pins it',
    (messageType) =>
      Effect.gen(function* complete() {
        const { activate, memory } = yield* productionActivation(messageType);
        yield* activate;
        expect(memory.state.activations).toHaveLength(1);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect.each([RESET, OTP] as const)(
    'refuses to activate a revision of %s that declares no placeholder and leaves its slot out',
    (messageType) =>
      Effect.gen(function* lacking() {
        const { activate, memory } = yield* productionActivation(messageType, {
          body: '[FICTIONAL TEST COPY] no secret at all',
          requiredPlaceholders: [],
        });
        const failure = yield* Effect.flip(activate);
        expect(Schema.is(TemplateRefused)(failure)).toBe(true);
        expect(failure).toMatchObject({
          code: 'template_required_placeholder_omitted',
          placeholders: [SLOT[messageType]],
        });
        expect(memory.state.activations).toEqual([]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a revision that declares the secret slot only as optional', () =>
    Effect.gen(function* optional() {
      const { activate } = yield* productionActivation(RESET, {
        optionalPlaceholders: ['reset_link'],
        requiredPlaceholders: [],
      });
      expect(yield* Effect.flip(activate)).toMatchObject({
        code: 'template_required_placeholder_omitted',
        placeholders: ['reset_link'],
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a revision that uses or declares a placeholder its type does not allow', () =>
    Effect.gen(function* foreign() {
      const { activate } = yield* productionActivation(OTP, {
        body: '[FICTIONAL TEST COPY] {{otp_code}} {{invoice_number}}',
        requiredPlaceholders: ['otp_code', 'invoice_number'],
      });
      expect(yield* Effect.flip(activate)).toMatchObject({
        code: 'template_placeholder_undeclared',
        placeholders: ['invoice_number'],
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a secret-bearing slot in the subject, which no owner step ever completes', () =>
    Effect.gen(function* subject() {
      const { activate } = yield* productionActivation(RESET, { subject: '[FICTIONAL TEST COPY] {{reset_link}}' });
      expect(yield* Effect.flip(activate)).toMatchObject({
        code: 'template_content_malformed',
        placeholders: ['reset_link'],
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('keeps a type without a declared contract at no placeholder at all', () => {
    expect(templateContractOf({})).toEqual({ placeholders: [] });
    const decoded = Schema.decodeUnknownResult(TemplateContractSchema);
    // names are unique, and only an optional non-secret placeholder may be omitted
    expect(
      decoded({
        placeholders: [
          { kind: 'text', name: 'a', required: false },
          { kind: 'text', name: 'a', required: false },
        ],
      })._tag,
    ).toBe('Failure');
    expect(
      decoded({ placeholders: [{ kind: 'owner-rendered', name: 'a', omission: 'omit-paragraph', required: false }] })
        ._tag,
    ).toBe('Failure');
  });
});

describe('The Template Actions only know approved message types (T3-14)', () => {
  const UNAPPROVED = 'fixture.never-approved';

  it.effect('prepare refuses a well-formed key that is not in the approved catalog and stores nothing', () =>
    Effect.gen(function* prepare() {
      const memory = makeInMemoryTemplatePort();
      const failure = yield* Effect.flip(
        prepareRevision(memory.port, fictionalDraft({ ...identity({ messageType: UNAPPROVED }) }), adminOne),
      );
      expect(Schema.is(TemplateRefused)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'template_content_malformed' });
      expect([memory.state.types, memory.state.revisions]).toEqual([[], []]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('activate, deactivate and invalidate refuse a revision whose key is not in the approved catalog', () =>
    Effect.gen(function* lifecycle() {
      const memory = makeInMemoryTemplatePort();
      // a revision of an unapproved type exists only if something wrote around the Action: seed it with the fixture catalog
      const seeded = domainFor(memory.port);
      const { revision } = yield* seeded.prepare(fictionalDraft({ ...identity({ messageType: UNAPPROVED }) }));
      yield* seeded.approve(revision.revisionId);
      const input = { reason: 'Fictional attempt', revisionId: revision.revisionId };
      expect(yield* Effect.flip(activateRevision(memory.port, input, adminOne))).toMatchObject({
        code: 'template_content_malformed',
      });
      expect(yield* Effect.flip(deactivateRevision(memory.port, input, adminOne))).toMatchObject({
        code: 'template_content_malformed',
      });
      expect(yield* Effect.flip(invalidateRevisionAsUnsafe(memory.port, input, adminOne))).toMatchObject({
        code: 'template_content_malformed',
      });
      // nothing changed: still the one open activation, no invalidation
      expect(memory.state.activations).toHaveLength(1);
      expect(memory.state.invalidations).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('knows exactly the approved types of the production catalog', () => {
    for (const type of approvedMessageTypes) {
      expect(approvedTemplateTypes.contractOf(type.typeId)._tag).toBe('Some');
    }
    expect(approvedTemplateTypes.contractOf(UNAPPROVED)._tag).toBe('None');
  });
});

describe('The content digest covers the declared placeholders (T4-05)', () => {
  const content = {
    body: '[FICTIONAL TEST COPY] {{purpose}}',
    optionalPlaceholders: ['reference'],
    requiredPlaceholders: ['purpose'],
    subject: '[FICTIONAL TEST COPY]',
  };

  it.effect('differs when only a declaration differs and ignores the order of the declared names', () =>
    Effect.gen(function* digests() {
      const base = yield* templateContentDigest(content);
      expect(base).toMatch(/^[0-9a-f]{64}$/u);
      expect(yield* templateContentDigest({ ...content, optionalPlaceholders: [] })).not.toBe(base);
      expect(
        yield* templateContentDigest({
          ...content,
          optionalPlaceholders: [],
          requiredPlaceholders: ['purpose', 'reference'],
        }),
      ).not.toBe(base);
      expect(
        yield* templateContentDigest({ ...content, optionalPlaceholders: [], requiredPlaceholders: ['a', 'b'] }),
      ).toBe(yield* templateContentDigest({ ...content, optionalPlaceholders: [], requiredPlaceholders: ['b', 'a'] }));
      // a name moved between the two lists is another message, and no boundary between fields can be forged
      expect(yield* templateContentDigest({ ...content, body: 'bc', subject: 'a' })).not.toBe(
        yield* templateContentDigest({ ...content, body: 'c', subject: 'ab' }),
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('is the digest the prepare path stores', () =>
    Effect.gen(function* stored() {
      const memory = makeInMemoryTemplatePort();
      const { revision } = yield* domainFor(memory.port).prepare(fictionalDraft());
      expect(revision.contentDigest).toBe(
        yield* templateContentDigest({
          body: revision.body,
          optionalPlaceholders: revision.optionalPlaceholders,
          requiredPlaceholders: revision.requiredPlaceholders,
          subject: revision.subject,
        }),
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
