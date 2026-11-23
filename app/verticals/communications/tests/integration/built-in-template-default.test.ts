import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateResolutionFailed } from '../../shared/template-revision-errors.ts';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import { portalAuthCopyDraft } from '../../src/domain/catalog/portal-auth-copy-draft.ts';
import {
  confirmBuiltInTemplateDefault,
  reviewBuiltInTemplateDefaults,
} from '../../src/services/built-in-template-default-domain.service.ts';
import { resolveTemplatePin, templateContentDigest } from '../../src/services/template-revision-domain.service.ts';
import type { TemplateActor } from '../../src/services/template-revision-domain.service.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 / #1406 Option A on native PostgreSQL as the runtime role: confirming a built-in default is one transaction of
 * the acting user, serialized on the Type lock, rolled back as a whole when refused, and isolated per Tenant.
 */

const OTP = 'commerce.customer-context.portal-auth.otp-message';
const tenantScope = { kind: 'tenant' } as const;
const identityOf = (language: 'cs' | 'en'): TemplateIdentity => ({
  channel: 'email',
  language,
  messageType: OTP,
  scope: tenantScope,
});
const inputOf = Effect.fn('test.inputOf')(function* inputOf(language: 'cs' | 'en') {
  const copy = portalAuthCopyDraft.find((found) => found.messageType === OTP && found.language === language);
  return {
    contentDigest: yield* templateContentDigest(copy?.subject ?? '', copy?.body ?? ''),
    language,
    messageType: OTP,
    reason: 'Fictional confirmation of the approved default text',
    scope: tenantScope,
  };
});
const principalOf = (actor: TemplateActor, principalId: string): TemplateActor => ({ ...actor, principalId });

describe('Confirming a built-in template default on native PostgreSQL as the runtime role', () => {
  it.live('fails closed until confirmed, then stores and activates it as the acting user in one transaction', () =>
    Effect.gen(function* confirm() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const otherTenant = yield* nextId;
      // nothing is active: a Portal Auth message of this Tenant resolves no template and stops with the typed reason
      const before = yield* database.withPort(tenant, (port) =>
        Effect.flip(resolveTemplatePin(port, identityOf('cs'))),
      );
      expect(Schema.is(TemplateResolutionFailed)(before)).toBe(true);
      expect(before).toMatchObject({ code: 'template_no_active_revision' });
      const confirmer = principalOf(actorWith(yield* nextId), yield* nextId);
      const czechInput = yield* inputOf('cs');
      const confirmed = yield* database.withPort(tenant, (port) =>
        confirmBuiltInTemplateDefault(port, czechInput, confirmer),
      );
      expect(confirmed.alreadyConfirmed).toBe(false);
      expect(confirmed.revision.createdByPrincipalId).toBe(confirmer.principalId);
      expect(confirmed.activation.activatedByPrincipalId).toBe(confirmer.principalId);
      expect(confirmed.activation.activationReason).toBe('Fictional confirmation of the approved default text');
      const after = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* afterConfirm() {
          const pin = yield* resolveTemplatePin(port, identityOf('cs'));
          const review = yield* reviewBuiltInTemplateDefaults(port, tenantScope);
          return { pin, review };
        }),
      );
      expect(after.pin.revisionId).toBe(confirmed.revision.revisionId);
      const czech = after.review.find(
        (entry) => entry.identity.messageType === OTP && entry.identity.language === 'cs',
      );
      expect(czech?.builtInDefault.state).toBe('BUILT_IN_DEFAULT_CONFIRMED');
      expect(czech?.revisions).toMatchObject([{ isBuiltInDefaultText: true, lifecycleState: 'active' }]);
      // another Tenant sees none of it and still fails closed
      const foreign = yield* database.withPort(otherTenant, (port) =>
        Effect.gen(function* foreignTenant() {
          const review = yield* reviewBuiltInTemplateDefaults(port, tenantScope);
          const failure = yield* Effect.flip(resolveTemplatePin(port, identityOf('cs')));
          return { failure, review };
        }),
      );
      expect(foreign.review.every((entry) => entry.builtInDefault.state === 'BUILT_IN_DEFAULT_NOT_CONFIRMED')).toBe(
        true,
      );
      expect(foreign.review.every((entry) => entry.revisions.length === 0)).toBe(true);
      expect(foreign.failure).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('serializes concurrent confirmations: one revision, one activation, the second one changes nothing', () =>
    Effect.gen(function* concurrent() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const confirmOnce = Effect.fn('test.confirmOnce')(function* confirmOnce() {
        const actor = principalOf(actorWith(yield* nextId), yield* nextId);
        const input = yield* inputOf('cs');
        return yield* database.withPort(tenant, (port) => confirmBuiltInTemplateDefault(port, input, actor));
      });
      const results = yield* Effect.all([confirmOnce(), confirmOnce()], { concurrency: 2 });
      expect(
        results
          .map(({ alreadyConfirmed }) => String(alreadyConfirmed))
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(['false', 'true']);
      expect(new Set(results.map(({ revision }) => revision.revisionId)).size).toBe(1);
      expect(new Set(results.map(({ activation }) => activation.activationId)).size).toBe(1);
      const stored = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* storedRows() {
          const type = yield* port.findType(identityOf('cs'));
          const typeId = Option.getOrThrow(type).templateTypeId;
          return { open: yield* port.openActivations(typeId), revisions: yield* port.revisionsOfType(typeId) };
        }),
      );
      expect(stored.revisions).toHaveLength(1);
      expect(stored.open).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live("rolls a refusal back as a whole and never replaces the Tenant's own active revision", () =>
    Effect.gen(function* refusals() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      // English before Czech is refused, and the Type it would have created is not left behind
      const early = yield* Effect.flip(
        database.withPort(tenant, (port) =>
          Effect.gen(function* english() {
            return yield* confirmBuiltInTemplateDefault(port, yield* inputOf('en'), actorWith(yield* nextId));
          }),
        ),
      );
      expect(early).toMatchObject({ code: 'template_built_in_default_requires_czech' });
      expect(Option.isNone(yield* database.withPort(tenant, (port) => port.findType(identityOf('en'))))).toBe(true);
      // the Tenant's own active Czech revision stays the active one
      const own = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* ownRevision() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const prepared = yield* t.prepare(
            fictionalDraft({
              body: '[FICTIONAL TEST COPY] {{otp_code}}',
              messageType: OTP,
              optionalPlaceholders: [],
              requiredPlaceholders: ['otp_code'],
              subject: '[FICTIONAL TEST COPY] Code',
            }),
            actor,
          );
          yield* t.approve(prepared.revision.revisionId, actor);
          return prepared.revision;
        }),
      );
      const blocked = yield* Effect.flip(
        database.withPort(tenant, (port) =>
          Effect.gen(function* czech() {
            return yield* confirmBuiltInTemplateDefault(port, yield* inputOf('cs'), actorWith(yield* nextId));
          }),
        ),
      );
      expect(blocked).toMatchObject({ code: 'template_tenant_revision_active' });
      const pin = yield* database.withPort(tenant, (port) => resolveTemplatePin(port, identityOf('cs')));
      expect(pin.revisionId).toBe(own.revisionId);
      // with an own active Czech revision the English default is confirmable
      const english = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* englishAfterCzech() {
          return yield* confirmBuiltInTemplateDefault(port, yield* inputOf('en'), actorWith(yield* nextId));
        }),
      );
      expect(english.alreadyConfirmed).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
