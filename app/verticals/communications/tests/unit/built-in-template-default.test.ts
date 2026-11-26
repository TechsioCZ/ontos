import { ReadPermissionDenied } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Array as EffectArray, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateResolutionFailed } from '../../shared/template-revision-errors.ts';
import type { BuiltInTemplateDefaultEntry, TemplateIdentity, TemplateScope } from '../../shared/template-revision.ts';
import { builtInTemplateDefaultsRead } from '../../src/api/built-in-template-defaults.read.ts';
import { portalAuthDefaultCopy } from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import { reviewBuiltInTemplateDefaults } from '../../src/services/built-in-template-default-domain.service.ts';
import { decideMessageLanguage } from '../../src/services/language-selection.service.ts';
import { templateContentDigest } from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { makeInMemoryLanguagePolicyPort } from '../support/language-fixtures.ts';
import { adminOne, adminTwo, companyA, companyScope, domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 (PO decision 1A), #1397 TPL-05, R-D1: only a revision an authorised administrator prepared AND activated is ever
 * used. The six Portal Auth texts are seed content: an untouched Tenant has NO text for those types, so tenant mode B and
 * "no Czech text, do not send" apply, and nothing resolves to a shared or built-in text.
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

describe('Template resolution never falls back to a built-in text (#1398, R-D1)', () => {
  it.effect('fails with no active revision for every identity an administrator never activated', () =>
    Effect.gen(function* untouched() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      for (const copy of portalAuthDefaultCopy) {
        const failure = yield* Effect.flip(t.resolve(identityOf(copy.language, { messageType: copy.messageType })));
        expect(Schema.is(TemplateResolutionFailed)(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'template_no_active_revision' });
      }
      // nothing was stored to answer, and a prepared but never activated own draft does not change the answer
      expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
      yield* t.prepare(ownDraft('cs'));
      expect(yield* Effect.flip(t.resolve(identityOf('cs')))).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "uses the Tenant's own active revision, attributed to the real person who activated it, and nothing else",
    () =>
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
        // English was never taken over: it has no text, there is no built-in to stand in for it
        expect(yield* Effect.flip(t.resolve(identityOf('en')))).toMatchObject({ code: 'template_no_active_revision' });
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('fails closed once the Tenant took the identity over and stopped it', () =>
    Effect.gen(function* takenOver() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const czech = yield* t.prepare(ownDraft('cs'));
      yield* t.approve(czech.revision.revisionId);
      yield* t.deactivate(czech.revision.revisionId);
      expect(yield* Effect.flip(t.resolve(identityOf('cs')))).toMatchObject({ code: 'template_no_active_revision' });
      const english = yield* t.prepare(ownDraft('en'));
      yield* t.approve(english.revision.revisionId);
      yield* t.invalidate(english.revision.revisionId);
      expect(yield* Effect.flip(t.resolve(identityOf('en')))).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps scopes exact: a Legal Entity text is not a Tenant-wide text', () =>
    Effect.gen(function* scopes() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const company = { ...adminOne, legalEntityId: companyA };
      const prepared = yield* t.prepare(ownDraft('cs', companyScope(companyA)), company);
      yield* t.approve(prepared.revision.revisionId, company);
      expect((yield* t.resolve(identityOf('cs', { scope: companyScope(companyA) }))).source).toBe('TENANT_REVISION');
      expect(yield* Effect.flip(t.resolve(identityOf('cs')))).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('stops an untouched Tenant at "no Czech text, do not send" (TPL-05), whatever the recipient asks for', () =>
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
        outcome: 'not-sent',
        reason: 'czech_revision_unavailable',
      });
      expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({
        outcome: 'not-sent',
        reason: 'czech_revision_unavailable',
      });
      // with an own active Czech text, Czech is selected and English still needs its own text
      const t = domainFor(memory.port);
      const czech = yield* t.prepare(ownDraft('cs'));
      yield* t.approve(czech.revision.revisionId);
      expect(yield* decide({ kind: 'trusted', language: 'en' })).toMatchObject({
        language: 'cs',
        outcome: 'selected',
        pin: { source: 'TENANT_REVISION' },
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('The seed text review shows content, never a text in force (#1398, R-D1, E-09)', () => {
  it.effect('lists every Portal Auth type and language as pending the approver with nothing in force', () =>
    Effect.gen(function* review() {
      const memory = makeInMemoryTemplatePort();
      const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
      expect(entries.map(({ identity }) => `${identity.messageType}/${identity.language}`)).toEqual(
        portalAuthDefaultCopy.map((copy) => `${copy.messageType}/${copy.language}`),
      );
      for (const entry of entries) {
        const copy = copyOf(entry.identity.messageType, entry.identity.language);
        expect(entry.builtInDefault).toEqual({
          approval: 'PENDING-APPROVER',
          body: copy.body,
          contentDigest: yield* templateContentDigest({
            body: copy.body,
            optionalPlaceholders: [],
            requiredPlaceholders: [copy.ownerRenderedSlot],
            subject: copy.subject,
          }),
          optionalPlaceholders: [],
          requiredPlaceholders: [copy.ownerRenderedSlot],
          subject: copy.subject,
          version: 1,
        });
        expect(entry.inForce).toEqual({ reason: 'template_no_active_revision', source: 'NONE' });
        expect(entry.revisions).toEqual([]);
      }
      expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('shows an administrator-activated revision as the text in force and agrees with resolution', () =>
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
        inForce: { revisionId: czech.revision.revisionId, source: 'TENANT_REVISION' },
        revisions: [{ isBuiltInDefaultText: false, lifecycleState: 'active', revisionId: czech.revision.revisionId }],
      });
      expect(entryOf(entries, 'en')).toMatchObject({
        inForce: { reason: 'template_no_active_revision', source: 'NONE' },
        revisions: [{ lifecycleState: 'retired' }],
      });
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

  it.effect(
    'answers the six seed texts with nothing in force for the trusted Tenant; a denied caller reads nothing',
    () =>
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
          expect(result.entries.every((entry) => entry.inForce.source === 'NONE')).toBe(true);
          expect(result.entries.every((entry) => entry.builtInDefault.approval === 'PENDING-APPROVER')).toBe(true);
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
