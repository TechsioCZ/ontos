import { ActionPermissionDenied, ReadPermissionDenied } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Array as EffectArray, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateDefaultConfirmationRefused, TemplateRefused } from '../../shared/template-revision-errors.ts';
import type { BuiltInTemplateDefaultEntry, TemplateScope } from '../../shared/template-revision.ts';
import { confirmBuiltInTemplateDefaultAction } from '../../src/actions/confirm-built-in-template-default.action.ts';
import { builtInTemplateDefaultsRead } from '../../src/api/built-in-template-defaults.read.ts';
import { portalAuthCopyDraft } from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import {
  confirmBuiltInTemplateDefault,
  reviewBuiltInTemplateDefaults,
} from '../../src/services/built-in-template-default-domain.service.ts';
import type { ConfirmBuiltInDefaultInput } from '../../src/services/built-in-template-default-domain.service.ts';
import { templateContentDigest } from '../../src/services/template-revision-domain.service.ts';
import type { TemplateActor } from '../../src/services/template-revision-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { adminOne, adminTwo, companyA, companyScope, domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 / #1406 Option A: the approved Portal Auth default text is confirmed per Tenant, per exact message type, language
 * and scope, by that Tenant's authorised user. The review Read shows it as a marked candidate next to the Tenant's own
 * revisions; the confirm Action stores and activates it in one step, never over an own active revision of the Tenant.
 */

const VERIFY = 'commerce.customer-context.portal-auth.verify-email-message';
const tenantScope: TemplateScope = { kind: 'tenant' };

const copyOf = (messageType: string, language: 'cs' | 'en') =>
  Option.getOrThrow(
    EffectArray.findFirst(
      portalAuthCopyDraft,
      (found) => found.messageType === messageType && found.language === language,
    ),
  );
const digestOf = (messageType: string, language: 'cs' | 'en') => {
  const copy = copyOf(messageType, language);
  return templateContentDigest(copy.subject, copy.body);
};
const confirmInput = Effect.fn('test.confirmInput')(function* confirmInput(
  language: 'cs' | 'en',
  overrides: Partial<ConfirmBuiltInDefaultInput> = {},
) {
  const input: ConfirmBuiltInDefaultInput = {
    contentDigest: yield* digestOf(VERIFY, language),
    language,
    messageType: VERIFY,
    reason: 'Fictional confirmation of the approved default text',
    scope: tenantScope,
    ...overrides,
  };
  return input;
});
const entryOf = (entries: readonly BuiltInTemplateDefaultEntry[], language: 'cs' | 'en', messageType = VERIFY) =>
  entries.find((entry) => entry.identity.messageType === messageType && entry.identity.language === language);

describe('The built-in template default review (#1398, #1406)', () => {
  it.effect('lists every Portal Auth type and language as a NOT CONFIRMED candidate with its exact text', () =>
    Effect.gen(function* review() {
      const memory = makeInMemoryTemplatePort();
      const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
      expect(entries.map(({ identity }) => `${identity.messageType}/${identity.language}`)).toEqual(
        portalAuthCopyDraft.map((copy) => `${copy.messageType}/${copy.language}`),
      );
      for (const entry of entries) {
        const copy = copyOf(entry.identity.messageType, entry.identity.language);
        expect(entry.builtInDefault).toEqual({
          approval: 'APPROVED-DEFAULT-TEXT',
          body: copy.body,
          contentDigest: yield* templateContentDigest(copy.subject, copy.body),
          optionalPlaceholders: [],
          requiredPlaceholders: [copy.ownerRenderedSlot],
          state: 'BUILT_IN_DEFAULT_NOT_CONFIRMED',
          subject: copy.subject,
          version: 1,
        });
        expect(entry.identity).toEqual({
          channel: 'email',
          language: copy.language,
          messageType: copy.messageType,
          scope: tenantScope,
        });
        expect(entry.revisions).toEqual([]);
        // Czech is confirmable at once; English waits for Czech
        expect(entry.confirmationBlockedBy).toBe(
          copy.language === 'en' ? 'template_built_in_default_requires_czech' : undefined,
        );
      }
      // reviewing stores nothing
      expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "shows the Tenant's own revisions of exactly that identity and blocks the default under an own active one",
    () =>
      Effect.gen(function* ownRevision() {
        const memory = makeInMemoryTemplatePort();
        const t = domainFor(memory.port);
        const own = yield* t.prepare(
          fictionalDraft({
            body: '[FICTIONAL TEST COPY] {{verification_link}}',
            messageType: VERIFY,
            optionalPlaceholders: [],
            requiredPlaceholders: ['verification_link'],
            subject: '[FICTIONAL TEST COPY] Verify',
          }),
        );
        yield* t.approve(own.revision.revisionId);
        // a revision of another scope is not a revision of this identity
        yield* t.prepare(fictionalDraft({ messageType: VERIFY, scope: companyScope(companyA) }), {
          ...adminOne,
          legalEntityId: companyA,
        });
        const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
        const czech = entryOf(entries, 'cs');
        expect(czech?.revisions).toMatchObject([
          { isBuiltInDefaultText: false, lifecycleState: 'active', revisionId: own.revision.revisionId },
        ]);
        expect(czech?.builtInDefault.state).toBe('BUILT_IN_DEFAULT_NOT_CONFIRMED');
        expect(czech?.confirmationBlockedBy).toBe('template_tenant_revision_active');
        // an own active Czech revision makes the English default confirmable
        expect(entryOf(entries, 'en')?.confirmationBlockedBy).toBeUndefined();
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('Confirming a built-in template default (#1398, #1406)', () => {
  it.effect('stores and activates the default in one step, as the acting user and with their reason', () =>
    Effect.gen(function* confirm() {
      const memory = makeInMemoryTemplatePort();
      const result = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminTwo);
      expect(result.alreadyConfirmed).toBe(false);
      expect(memory.state.revisions).toHaveLength(1);
      expect(memory.state.revisions[0]).toMatchObject({
        body: copyOf(VERIFY, 'cs').body,
        contentDigest: yield* digestOf(VERIFY, 'cs'),
        createdByPrincipalId: adminTwo.principalId,
        optionalPlaceholders: [],
        reason: 'Fictional confirmation of the approved default text',
        requiredPlaceholders: ['verification_link'],
      });
      expect(memory.state.activations).toHaveLength(1);
      expect(memory.state.activations[0]).toMatchObject({
        activatedByPrincipalId: adminTwo.principalId,
        activationReason: 'Fictional confirmation of the approved default text',
        revisionId: result.revision.revisionId,
      });
      // the confirmed default is what Communications now resolves for exactly this identity
      const pin = yield* domainFor(memory.port).resolve({
        channel: 'email',
        language: 'cs',
        messageType: VERIFY,
        scope: tenantScope,
      });
      expect(pin.revisionId).toBe(result.revision.revisionId);
      const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
      expect(entryOf(entries, 'cs')?.builtInDefault.state).toBe('BUILT_IN_DEFAULT_CONFIRMED');
      expect(entryOf(entries, 'cs')?.revisions).toMatchObject([
        { isBuiltInDefaultText: true, lifecycleState: 'active' },
      ]);
      expect(entryOf(entries, 'cs')?.confirmationBlockedBy).toBeUndefined();
      expect(entryOf(entries, 'en')?.confirmationBlockedBy).toBeUndefined();
      // every other identity is untouched
      expect(entries.filter((entry) => entry.builtInDefault.state === 'BUILT_IN_DEFAULT_CONFIRMED')).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('is idempotent: confirming the active default again stores, activates and replaces nothing', () =>
    Effect.gen(function* twice() {
      const memory = makeInMemoryTemplatePort();
      const first = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne);
      const second = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminTwo);
      expect(second.alreadyConfirmed).toBe(true);
      expect(second.revision.revisionId).toBe(first.revision.revisionId);
      expect(second.activation.activationId).toBe(first.activation.activationId);
      expect(memory.state.revisions).toHaveLength(1);
      expect(memory.state.activations).toHaveLength(1);
      expect(memory.state.activations[0]?.activatedByPrincipalId).toBe(adminOne.principalId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("never replaces the Tenant's own active revision", () =>
    Effect.gen(function* ownActive() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const own = yield* t.prepare(
        fictionalDraft({
          body: '[FICTIONAL TEST COPY] {{verification_link}}',
          messageType: VERIFY,
          optionalPlaceholders: [],
          requiredPlaceholders: ['verification_link'],
          subject: '[FICTIONAL TEST COPY] Verify',
        }),
      );
      yield* t.approve(own.revision.revisionId);
      const failure = yield* Effect.flip(
        confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne),
      );
      expect(Schema.is(TemplateDefaultConfirmationRefused)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'template_tenant_revision_active' });
      expect(memory.state.revisions).toHaveLength(1);
      expect(memory.state.activations).toHaveLength(1);
      expect(memory.state.activations[0]?.revisionId).toBe(own.revision.revisionId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('confirms English only while Czech is active in the same scope', () =>
    Effect.gen(function* englishAfterCzech() {
      const memory = makeInMemoryTemplatePort();
      const early = yield* Effect.flip(confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('en'), adminOne));
      expect(early).toMatchObject({ code: 'template_built_in_default_requires_czech' });
      expect([memory.state.revisions, memory.state.activations]).toEqual([[], []]);
      yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne);
      const english = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('en'), adminOne);
      expect(english.alreadyConfirmed).toBe(false);
      expect(memory.state.activations).toHaveLength(2);
      // Czech of ANOTHER scope does not count
      const company = { ...adminOne, legalEntityId: companyA };
      const companyEnglish = yield* Effect.flip(
        confirmBuiltInTemplateDefault(
          memory.port,
          yield* confirmInput('en', { scope: companyScope(companyA) }),
          company,
        ),
      );
      expect(companyEnglish).toMatchObject({ code: 'template_built_in_default_requires_czech' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a digest the user did not review, an unknown default and a scope other than the operation', () =>
    Effect.gen(function* refusals() {
      const memory = makeInMemoryTemplatePort();
      const english = yield* digestOf(VERIFY, 'en');
      const mismatch = yield* Effect.flip(
        confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs', { contentDigest: english }), adminOne),
      );
      expect(Schema.is(TemplateDefaultConfirmationRefused)(mismatch)).toBe(true);
      expect(mismatch).toMatchObject({ code: 'template_built_in_default_digest_mismatch' });
      const unknown = yield* Effect.flip(
        confirmBuiltInTemplateDefault(
          memory.port,
          yield* confirmInput('cs', { messageType: 'fixture.transactional-notice' }),
          adminOne,
        ),
      );
      expect(unknown).toMatchObject({ code: 'template_built_in_default_unknown' });
      const companyActor: TemplateActor = { ...adminOne, legalEntityId: companyA };
      const scopeMismatch = yield* Effect.flip(
        confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), companyActor),
      );
      expect(Schema.is(TemplateRefused)(scopeMismatch)).toBe(true);
      expect(scopeMismatch).toMatchObject({ code: 'template_scope_mismatch' });
      expect([memory.state.types, memory.state.revisions, memory.state.activations]).toEqual([[], [], []]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'never confirms a default text the Tenant invalidated as unsafe; a retired default may be confirmed again',
    () =>
      Effect.gen(function* invalidated() {
        const memory = makeInMemoryTemplatePort();
        const t = domainFor(memory.port);
        const first = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne);
        yield* t.deactivate(first.revision.revisionId);
        const again = yield* confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne);
        expect(again.alreadyConfirmed).toBe(false);
        expect(again.revision.revisionNumber).toBe(2);
        yield* t.invalidate(again.revision.revisionId);
        const refused = yield* Effect.flip(
          confirmBuiltInTemplateDefault(memory.port, yield* confirmInput('cs'), adminOne),
        );
        expect(refused).toMatchObject({ code: 'template_built_in_default_invalidated' });
        const entries = yield* reviewBuiltInTemplateDefaults(memory.port, tenantScope);
        expect(entryOf(entries, 'cs')?.confirmationBlockedBy).toBe('template_built_in_default_invalidated');
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

describe('The confirm Action and the review Read through the Core runtime (#1398, #1406)', () => {
  it.effect('a permitted user confirms under their own principal; a denied one changes nothing', () =>
    Effect.gen(function* throughAction() {
      const allowedMemory = makeInMemoryTemplatePort();
      const allowed = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: communicationsRegistration,
        services: [bindActionTestServices(confirmBuiltInTemplateDefaultAction, allowedMemory.port)],
      });
      const payload = {
        contentDigest: yield* digestOf(VERIFY, 'cs'),
        language: 'cs' as const,
        messageType: VERIFY,
        reason: 'Fictional confirmation of the approved default text',
        scope: tenantScope,
      };
      const confirmed = yield* allowed.runtime.runAction({
        payload,
        principal,
        registration: confirmBuiltInTemplateDefaultAction,
        transport: { correlationId: 'confirm-1', idempotencyKey: 'confirm-1' },
      });
      expect(confirmed.alreadyConfirmed).toBe(false);
      expect(allowedMemory.state.activations[0]?.activatedByPrincipalId).toBe(principal.principalId);
      expect(allowedMemory.state.revisions[0]?.createdByPrincipalId).toBe(principal.principalId);

      const deniedMemory = makeInMemoryTemplatePort();
      const denied = yield* makeActionTestHarness({
        access: 'denied',
        ownerRegistration: communicationsRegistration,
        services: [bindActionTestServices(confirmBuiltInTemplateDefaultAction, deniedMemory.port)],
      });
      const failure = yield* Effect.flip(
        denied.runtime.runAction({
          payload,
          principal,
          registration: confirmBuiltInTemplateDefaultAction,
          transport: { correlationId: 'confirm-denied', idempotencyKey: 'confirm-denied' },
        }),
      );
      expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
      expect([deniedMemory.state.types, deniedMemory.state.revisions, deniedMemory.state.activations]).toEqual([
        [],
        [],
        [],
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('declares ONE proposed template-revision permission each, scope-wide, and a human caller only', () => {
    expect(confirmBuiltInTemplateDefaultAction.descriptor.accessDeclaration).toMatchObject({
      key: 'communications.core.template-revision.confirm-built-in-default',
      kind: 'action',
      risk: 'sensitive',
      selectors: [],
    });
    expect(confirmBuiltInTemplateDefaultAction.descriptor.accessWorkload).toBeUndefined();
    expect(confirmBuiltInTemplateDefaultAction.descriptor.idempotency).toBe('required');
    expect(confirmBuiltInTemplateDefaultAction.descriptor.legalEntityScope).toBe('optional');
    expect(builtInTemplateDefaultsRead.descriptor.accessDeclaration).toMatchObject({
      key: 'communications.core.template-revision.list',
      kind: 'read',
      modes: ['run'],
      selectors: [],
    });
    expect(builtInTemplateDefaultsRead.descriptor.accessWorkload).toBeUndefined();
    expect(builtInTemplateDefaultsRead.descriptor.legalEntityScope).toBe('optional');
  });

  it.effect('the Read answers the six candidates of the trusted Tenant; a denied caller reads nothing', () =>
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
        expect(result.entries.every((entry) => entry.builtInDefault.state === 'BUILT_IN_DEFAULT_NOT_CONFIRMED')).toBe(
          true,
        );
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
