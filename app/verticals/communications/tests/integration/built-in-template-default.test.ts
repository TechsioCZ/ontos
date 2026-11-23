import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateResolutionFailed } from '../../shared/template-revision-errors.ts';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import { reviewBuiltInTemplateDefaults } from '../../src/services/built-in-template-default-domain.service.ts';
import { pinnedTemplateText } from '../../src/services/template-revision-domain.service.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 / #1406 (product owner, 2026-11-23) on native PostgreSQL as the runtime role: the built-in Portal Auth text is in
 * force for every Tenant until that Tenant replaces it through prepare + activate; the replacement is stored, attributed
 * to the person who made it and isolated per Tenant; a Tenant that stops its own text fails closed.
 */

const OTP = 'commerce.customer-context.portal-auth.otp-message';
const tenantScope = { kind: 'tenant' } as const;
const identityOf = (language: 'cs' | 'en'): TemplateIdentity => ({
  channel: 'email',
  language,
  messageType: OTP,
  scope: tenantScope,
});
/** A FICTIONAL own replacement of the OTP text, declaring its secret slot. */
const replacement = fictionalDraft({
  body: '[FICTIONAL TEST COPY] {{otp_code}}',
  messageType: OTP,
  optionalPlaceholders: [],
  requiredPlaceholders: ['otp_code'],
  subject: '[FICTIONAL TEST COPY] Code',
});

describe('Built-in template defaults on native PostgreSQL as the runtime role', () => {
  it.live('are in force from day one, are replaced per Tenant by an attributed own revision, and stay isolated', () =>
    Effect.gen(function* replace() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const otherTenant = yield* nextId;
      // day one: nothing is stored, and the built-in text is what a message uses
      const dayOne = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* builtIn() {
          const pin = yield* domainFor(port).resolve(identityOf('cs'));
          return { pin, text: yield* pinnedTemplateText(port, pin) };
        }),
      );
      expect(dayOne.pin.source).toBe('BUILT_IN_DEFAULT');
      expect(dayOne.text._tag).toBe('Some');
      // the Tenant's authorised user replaces the Czech text with an own revision
      const replacer = { ...actorWith(yield* nextId), principalId: yield* nextId };
      const replaced = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* replaceText() {
          const t = domainFor(port);
          const prepared = yield* t.prepare(replacement, replacer);
          const activated = yield* t.approve(prepared.revision.revisionId, replacer);
          return { activated, prepared };
        }),
      );
      expect(replaced.prepared.revision.createdByPrincipalId).toBe(replacer.principalId);
      expect(replaced.activated.activation.activatedByPrincipalId).toBe(replacer.principalId);
      const after = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* afterReplace() {
          const pin = yield* domainFor(port).resolve(identityOf('cs'));
          return { pin, review: yield* reviewBuiltInTemplateDefaults(port, tenantScope) };
        }),
      );
      expect(after.pin).toMatchObject({
        contentDigest: replaced.prepared.revision.contentDigest,
        revisionId: replaced.prepared.revision.revisionId,
        source: 'TENANT_REVISION',
      });
      const czech = after.review.find(
        (entry) => entry.identity.messageType === OTP && entry.identity.language === 'cs',
      );
      expect(czech).toMatchObject({
        builtInDefault: { state: 'BUILT_IN_DEFAULT_REPLACED' },
        inForce: { revisionId: replaced.prepared.revision.revisionId, source: 'TENANT_REVISION' },
      });
      // another Tenant still uses the built-in text and sees none of the replacement
      const foreign = yield* database.withPort(otherTenant, (port) =>
        Effect.gen(function* foreignTenant() {
          const pin = yield* domainFor(port).resolve(identityOf('cs'));
          return { pin, review: yield* reviewBuiltInTemplateDefaults(port, tenantScope) };
        }),
      );
      expect(foreign.pin.source).toBe('BUILT_IN_DEFAULT');
      expect(foreign.review.every((entry) => entry.inForce.source === 'BUILT_IN_DEFAULT')).toBe(true);
      expect(foreign.review.every((entry) => entry.revisions.length === 0)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('fails closed with the typed reason once the Tenant stopped its own text: no silent fallback', () =>
    Effect.gen(function* stopped() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const failure = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* stopOwn() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const prepared = yield* t.prepare(replacement, actor);
          yield* t.approve(prepared.revision.revisionId, actor);
          yield* t.deactivate(prepared.revision.revisionId, 'Fictional retirement', actor);
          return yield* Effect.flip(t.resolve(identityOf('cs')));
        }),
      );
      expect(Schema.is(TemplateResolutionFailed)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'template_no_active_revision' });
      // English, never taken over, is unaffected
      const english = yield* database.withPort(tenant, (port) => domainFor(port).resolve(identityOf('en')));
      expect(english.source).toBe('BUILT_IN_DEFAULT');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
