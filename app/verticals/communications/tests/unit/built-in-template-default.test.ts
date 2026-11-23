import { ReadPermissionDenied } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Array as EffectArray, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplatePinBlocked, TemplateResolutionFailed } from '../../shared/template-revision-errors.ts';
import type { BuiltInTemplateDefaultEntry, TemplateIdentity, TemplateScope } from '../../shared/template-revision.ts';
import { builtInTemplateDefaultsRead } from '../../src/api/built-in-template-defaults.read.ts';
import { builtInTemplateDefaultOf } from '../../src/domain/catalog/built-in-template-defaults.ts';
import { portalAuthDefaultCopy } from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import { reviewBuiltInTemplateDefaults } from '../../src/services/built-in-template-default-domain.service.ts';
import { decideMessageLanguage } from '../../src/services/language-selection.service.ts';
import { pinnedTemplateText, templateContentDigest } from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { makeInMemoryLanguagePolicyPort } from '../support/language-fixtures.ts';
import { adminOne, adminTwo, companyA, companyScope, domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 / #1406 (product owner, 2026-11-23): the six approved Portal Auth texts are ACTIVE BY DEFAULT. Resolution falls
 * back to the built-in text, as its last step, only for an identity the Tenant never took over; the Tenant's own active
 * revision always wins, and once the Tenant activated an own revision it owns the identity: a deactivated or invalidated
 * own revision fails closed and never silently re-enables the built-in text. Every pin records its source.
 */

const VERIFY = 'commerce.customer-context.portal-auth.verify-email-message';
const tenantScope: TemplateScope = { kind: 'tenant' };
const identityOf = (language: 'cs' | 'en', overrides: Partial<TemplateIdentity> = {}): TemplateIdentity => ({
  channel: 'email',
  language,
  messageType: VERIFY,
  scope: tenantScope,
  ...overrides,
});
const copyOf = (messageType: string, language: 'cs' | 'en') =>
  Option.getOrThrow(
    EffectArray.findFirst(
      portalAuthDefaultCopy,
      (found) => found.messageType === messageType && found.language === language,
    ),
  );
const entryOf = (entries: readonly BuiltInTemplateDefaultEntry[], language: 'cs' | 'en', messageType = VERIFY) =>
  entries.find((entry) => entry.identity.messageType === messageType && entry.identity.language === language);
/** A FICTIONAL own revision of the verification type, declaring its secret slot. */
const ownDraft = (language: 'cs' | 'en', scope: TemplateScope = tenantScope) =>
  fictionalDraft({
    body: `[FICTIONAL TEST COPY] ${language} {{verification_link}}`,
    language,
    messageType: VERIFY,
    optionalPlaceholders: [],
    requiredPlaceholders: ['verification_link'],
    scope,
    subject: `[FICTIONAL TEST COPY] ${language} verify`,
  });
const UUID_V8 = /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

describe('Template resolution falls back to the built-in default as its last step (#1398, #1406)', () => {
  it.effect(
    'pins the built-in text, with its source, version and digest, for an identity the Tenant never took over',
    () =>
      Effect.gen(function* builtIn() {
        const memory = makeInMemoryTemplatePort();
        const t = domainFor(memory.port);
        const copy = copyOf(VERIFY, 'cs');
        const pin = yield* t.resolve(identityOf('cs'));
        expect(pin).toMatchObject({
          contentDigest: yield* templateContentDigest(copy.subject, copy.body),
          language: 'cs',
          messageType: VERIFY,
          revisionNumber: 1,
          scope: tenantScope,
          source: 'BUILT_IN_DEFAULT',
        });
        // the same text always pins the same reference, and nothing is stored to do so
        expect((yield* t.resolve(identityOf('cs'))).revisionId).toBe(pin.revisionId);
        expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
        // the handoff gate passes it and the adapter gets exactly the approved text
        expect((yield* t.verify(pin)).revisionId).toBe(pin.revisionId);
        expect(Option.getOrThrow(yield* pinnedTemplateText(memory.port, pin))).toMatchObject({
          body: copy.body,
          requiredPlaceholders: ['verification_link'],
          subject: copy.subject,
        });
        // the audit names the built-in source and no principal: nobody activated it
        expect(yield* t.describe(pin)).toMatchObject({
          activations: [],
          lifecycleState: 'active',
          source: 'BUILT_IN_DEFAULT',
        });
        // a prepared, never activated own draft does not take the identity over
        yield* t.prepare(ownDraft('cs'));
        expect((yield* t.resolve(identityOf('cs'))).source).toBe('BUILT_IN_DEFAULT');
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("lets the Tenant's own active revision win, attributed to the real person who activated it", () =>
    Effect.gen(function* own() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const prepared = yield* t.prepare(ownDraft('cs'), adminTwo);
      yield* t.approve(prepared.revision.revisionId, adminTwo);
      const pin = yield* t.resolve(identityOf('cs'));
      expect(pin).toMatchObject({
        contentDigest: prepared.revision.contentDigest,
        revisionId: prepared.revision.revisionId,
        source: 'TENANT_REVISION',
      });
      expect(memory.state.activations[0]?.activatedByPrincipalId).toBe(adminTwo.principalId);
      expect(memory.state.revisions[0]?.createdByPrincipalId).toBe(adminTwo.principalId);
      // English, never taken over, still uses its built-in text next to the own Czech one
      expect((yield* t.resolve(identityOf('en'))).source).toBe('BUILT_IN_DEFAULT');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'never falls back once the Tenant took the identity over: a deactivated or invalidated own text fails closed',
    () =>
      Effect.gen(function* takenOver() {
        const memory = makeInMemoryTemplatePort();
        const t = domainFor(memory.port);
        const czech = yield* t.prepare(ownDraft('cs'));
        yield* t.approve(czech.revision.revisionId);
        yield* t.deactivate(czech.revision.revisionId);
        const deactivated = yield* Effect.flip(t.resolve(identityOf('cs')));
        expect(Schema.is(TemplateResolutionFailed)(deactivated)).toBe(true);
        expect(deactivated).toMatchObject({ code: 'template_no_active_revision' });
        const english = yield* t.prepare(ownDraft('en'));
        yield* t.approve(english.revision.revisionId);
        yield* t.invalidate(english.revision.revisionId);
        expect(yield* Effect.flip(t.resolve(identityOf('en')))).toMatchObject({ code: 'template_no_active_revision' });
        // a message type without a built-in default fails closed as before
        expect(
          yield* Effect.flip(t.resolve(identityOf('cs', { messageType: 'fixture.transactional-notice' }))),
        ).toMatchObject({ code: 'template_no_active_revision' });
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps scopes exact: an own Legal Entity text replaces the default only in that Legal Entity', () =>
    Effect.gen(function* scopes() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const company = { ...adminOne, legalEntityId: companyA };
      const prepared = yield* t.prepare(ownDraft('cs', companyScope(companyA)), company);
      yield* t.approve(prepared.revision.revisionId, company);
      expect((yield* t.resolve(identityOf('cs', { scope: companyScope(companyA) }))).source).toBe('TENANT_REVISION');
      expect((yield* t.resolve(identityOf('cs'))).source).toBe('BUILT_IN_DEFAULT');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('blocks a built-in pin whose text the catalog no longer holds: nothing is upgraded silently', () =>
    Effect.gen(function* withdrawn() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const pin = yield* t.resolve(identityOf('cs'));
      const blocked = yield* Effect.flip(t.verify({ ...pin, revisionNumber: pin.revisionNumber + 1 }));
      expect(Schema.is(TemplatePinBlocked)(blocked)).toBe(true);
      expect(blocked).toMatchObject({ code: 'pinned_template_revision_unavailable' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps the language rule: Czech by default, English for a trusted English recipient only with Czech', () =>
    Effect.gen(function* languages() {
      const memory = makeInMemoryTemplatePort();
      const policies = makeInMemoryLanguagePolicyPort();
      const decide = (recipient: Parameters<typeof decideMessageLanguage>[2]['recipient']) =>
        decideMessageLanguage(memory.port, policies.port, {
          base: { channel: 'email', messageType: VERIFY, scope: tenantScope },
          ownerPermittedLanguages: ['cs', 'en'],
          recipient,
        });
      expect(yield* decide({ kind: 'not-established' })).toMatchObject({
        language: 'cs',
        outcome: 'selected',
        pin: { source: 'BUILT_IN_DEFAULT' },
      });
      expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({
        language: 'en',
        outcome: 'selected',
        pin: { source: 'BUILT_IN_DEFAULT' },
      });
      // the Tenant took Czech over and stopped it: mode B sends no English without Czech
      const t = domainFor(memory.port);
      const czech = yield* t.prepare(ownDraft('cs'));
      yield* t.approve(czech.revision.revisionId);
      yield* t.deactivate(czech.revision.revisionId);
      expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({ outcome: 'not-sent' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('derives a stable, valid reference for each of the six built-in texts', () => {
    const references = portalAuthDefaultCopy.map((copy) =>
      Option.getOrThrow(
        builtInTemplateDefaultOf({ channel: 'email', language: copy.language, messageType: copy.messageType }),
      ),
    );
    expect(new Set(references.map(({ revisionId }) => revisionId)).size).toBe(6);
    for (const reference of references) {
      expect(reference.revisionId).toMatch(UUID_V8);
      expect(reference.templateTypeId).toMatch(UUID_V8);
    }
  });
});

describe('The built-in template default review (#1398, #1406)', () => {
  it.effect('lists every Portal Auth type and language with the built-in text in force and its exact text', () =>
    Effect.gen(function* review() {
      const memory = makeInMemoryTemplatePort();
      const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
      expect(entries.map(({ identity }) => `${identity.messageType}/${identity.language}`)).toEqual(
        portalAuthDefaultCopy.map((copy) => `${copy.messageType}/${copy.language}`),
      );
      for (const entry of entries) {
        const copy = copyOf(entry.identity.messageType, entry.identity.language);
        expect(entry.builtInDefault).toEqual({
          approval: 'APPROVED-DEFAULT-TEXT',
          approvedOn: '2026-11-23',
          body: copy.body,
          contentDigest: yield* templateContentDigest(copy.subject, copy.body),
          optionalPlaceholders: [],
          requiredPlaceholders: [copy.ownerRenderedSlot],
          state: 'BUILT_IN_DEFAULT_IN_USE',
          subject: copy.subject,
          version: 1,
        });
        expect(entry.inForce).toEqual({ contentDigest: copy.contentDigest, source: 'BUILT_IN_DEFAULT', version: 1 });
        expect(entry.revisions).toEqual([]);
      }
      expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('shows a replacement as the text in force and a stopped own text as nothing in force', () =>
    Effect.gen(function* replaced() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const czech = yield* t.prepare(ownDraft('cs'));
      yield* t.approve(czech.revision.revisionId);
      const english = yield* t.prepare(ownDraft('en'));
      yield* t.approve(english.revision.revisionId);
      yield* t.deactivate(english.revision.revisionId);
      // a revision of another scope is not a revision of this identity
      yield* t.prepare(ownDraft('cs', companyScope(companyA)), { ...adminOne, legalEntityId: companyA });
      const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
      expect(entryOf(entries, 'cs')).toMatchObject({
        builtInDefault: { state: 'BUILT_IN_DEFAULT_REPLACED' },
        inForce: { revisionId: czech.revision.revisionId, source: 'TENANT_REVISION' },
        revisions: [{ isBuiltInDefaultText: false, lifecycleState: 'active', revisionId: czech.revision.revisionId }],
      });
      expect(entryOf(entries, 'en')).toMatchObject({
        builtInDefault: { state: 'BUILT_IN_DEFAULT_REPLACED' },
        inForce: { reason: 'template_no_active_revision', source: 'NONE' },
        revisions: [{ lifecycleState: 'retired' }],
      });
      // the review agrees with resolution
      expect((yield* t.resolve(identityOf('cs'))).revisionId).toBe(czech.revision.revisionId);
      expect(yield* Effect.flip(t.resolve(identityOf('en')))).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const principal = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:communications-built-in-defaults',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};

const readHarness = (access: 'allowed' | 'denied') =>
  makeReadTestHarness({
    access,
    executeOwnerQuery: (query) =>
      Effect.sync(() => {
        // only the principal's own Tenant is ever asked for, and no other owner's table
        expect(query.sql).toContain('"communications"."template_types"');
        expect(query.params).toContain(tenantId);
        expect(query.params).not.toContain(otherTenantId);
        return [];
      }),
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-23T12:00:00Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: communicationsRegistration,
    scope: { ...principal, correlationId: 'built-in-defaults-read' },
  });

describe('The review Read through the Core Read runtime (#1398, #1406)', () => {
  it('declares ONE proposed template-revision permission, scope-wide, for a human caller only', () => {
    expect(builtInTemplateDefaultsRead.descriptor.accessDeclaration).toMatchObject({
      key: 'communications.core.template-revision.list',
      kind: 'read',
      modes: ['run'],
      selectors: [],
    });
    expect(builtInTemplateDefaultsRead.descriptor.accessWorkload).toBeUndefined();
    expect(builtInTemplateDefaultsRead.descriptor.legalEntityScope).toBe('optional');
  });

  it.effect('answers the six texts in force for the trusted Tenant; a denied caller reads nothing', () =>
    Effect.scoped(
      Effect.gen(function* throughRead() {
        const allowed = yield* readHarness('allowed');
        const result = yield* allowed.runtime.runRead({
          input: {},
          principal,
          registration: builtInTemplateDefaultsRead,
          transport: { correlationId: 'built-in-defaults-read' },
        });
        expect(result.scope).toEqual(tenantScope);
        expect(result.entries).toHaveLength(6);
        expect(result.entries.every((entry) => entry.inForce.source === 'BUILT_IN_DEFAULT')).toBe(true);
        const denied = yield* readHarness('denied');
        const failure = yield* Effect.flip(
          denied.runtime.runRead({
            input: {},
            principal,
            registration: builtInTemplateDefaultsRead,
            transport: { correlationId: 'built-in-defaults-read-denied' },
          }),
        );
        expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
        expect(denied.snapshot().ownerQueries).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
