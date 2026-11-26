import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TemplateResolutionFailed } from '../../shared/template-revision-errors.ts';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import { reviewBuiltInTemplateDefaults } from '../../src/services/built-in-template-default-domain.service.ts';
import { pinnedTemplateText } from '../../src/services/template-revision-domain.service.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 / R-D1 on native PostgreSQL as the runtime role: an untouched Tenant has NO text for a Portal Auth type; the text
 * a message uses is a revision an authorised user prepared AND activated, attributed to that person and isolated per Tenant;
 * a Tenant that stops its own text fails closed.
 */

const OTP = 'commerce.customer-context.portal-auth.otp-message';
const tenantScope = { kind: 'tenant' } as const;
const identityOf = (language: 'cs' | 'en'): TemplateIdentity => ({
  channel: 'email',
  language,
  messageType: OTP,
  scope: tenantScope,
});
/** A FICTIONAL own text of the OTP message, declaring its secret slot. */
const ownText = fictionalDraft({
  body: '[FICTIONAL TEST COPY] {{otp_code}}',
  messageType: OTP,
  optionalPlaceholders: [],
  requiredPlaceholders: ['otp_code'],
  subject: '[FICTIONAL TEST COPY] Code',
});

describe('Template resolution on native PostgreSQL as the runtime role (R-D1)', () => {
  it.live(
    'has no text from day one, uses an attributed own revision once activated, and stays isolated per Tenant',
    () =>
      Effect.gen(function* own() {
        const database = yield* makeRuntimeDatabase();
        const tenant = yield* nextId;
        const otherTenant = yield* nextId;
        // day one: nothing is stored and nothing resolves, so no message of the type can leave
        const dayOne = yield* database.withPort(tenant, (port) =>
          Effect.flip(domainFor(port).resolve(identityOf('cs'))),
        );
        expect(Schema.is(TemplateResolutionFailed)(dayOne)).toBe(true);
        expect(dayOne).toMatchObject({ code: 'template_no_active_revision' });
        const author = { ...actorWith(yield* nextId), principalId: yield* nextId };
        const prepared = yield* database.withPort(tenant, (port) =>
          Effect.gen(function* prepareText() {
            const t = domainFor(port);
            const draft = yield* t.prepare(ownText, author);
            // a prepared, never activated draft is not a text in force
            const stillNone = yield* Effect.flip(t.resolve(identityOf('cs')));
            expect(stillNone).toMatchObject({ code: 'template_no_active_revision' });
            return draft;
          }),
        );
        const activated = yield* database.withPort(tenant, (port) =>
          domainFor(port).approve(prepared.revision.revisionId, author),
        );
        expect(prepared.revision.createdByPrincipalId).toBe(author.principalId);
        expect(activated.activation.activatedByPrincipalId).toBe(author.principalId);
        const after = yield* database.withPort(tenant, (port) =>
          Effect.gen(function* afterActivation() {
            const pin = yield* domainFor(port).resolve(identityOf('cs'));
            return {
              pin,
              review: yield* reviewBuiltInTemplateDefaults(port, tenantScope),
              text: yield* pinnedTemplateText(port, pin),
            };
          }),
        );
        expect(after.pin).toMatchObject({
          contentDigest: prepared.revision.contentDigest,
          revisionId: prepared.revision.revisionId,
          source: 'TENANT_REVISION',
        });
        expect(Option.isSome(after.text)).toBe(true);
        const czech = after.review.find(
          (entry) => entry.identity.messageType === OTP && entry.identity.language === 'cs',
        );
        expect(czech).toMatchObject({
          builtInDefault: { approval: 'PENDING-APPROVER' },
          inForce: { revisionId: prepared.revision.revisionId, source: 'TENANT_REVISION' },
        });
        // another Tenant still has no text and sees none of the revision
        const foreign = yield* database.withPort(otherTenant, (port) =>
          Effect.gen(function* foreignTenant() {
            return {
              failure: yield* Effect.flip(domainFor(port).resolve(identityOf('cs'))),
              review: yield* reviewBuiltInTemplateDefaults(port, tenantScope),
            };
          }),
        );
        expect(foreign.failure).toMatchObject({ code: 'template_no_active_revision' });
        expect(foreign.review.every((entry) => entry.inForce.source === 'NONE')).toBe(true);
        expect(foreign.review.every((entry) => entry.revisions.length === 0)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('fails closed with the typed reason once the Tenant stopped its own text', () =>
    Effect.gen(function* stopped() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const failure = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* stopOwn() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const prepared = yield* t.prepare(ownText, actor);
          yield* t.approve(prepared.revision.revisionId, actor);
          yield* t.deactivate(prepared.revision.revisionId, 'Fictional retirement', actor);
          return yield* Effect.flip(t.resolve(identityOf('cs')));
        }),
      );
      expect(Schema.is(TemplateResolutionFailed)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'template_no_active_revision' });
      // English, never taken over, has no text either
      const english = yield* database.withPort(tenant, (port) =>
        Effect.flip(domainFor(port).resolve(identityOf('en'))),
      );
      expect(english).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
