import type { ModuleEntrypointDescriptor, TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import type { HttpServerRequest } from 'effect/http';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import {
  CustomerOwnConsentSchema,
  CustomerOwnConsentSchemaError,
  DEMO_NEWSLETTER_NOTICE,
} from '../../../shared/portal-auth/consent-api.ts';
import type { CustomerOwnConsent, UpdateCustomerOwnConsent } from '../../../shared/portal-auth/consent-api.ts';
import {
  customerConsentReadOwnEntrypoint,
  customerConsentUpdateOwnEntrypoint,
} from '../../../shared/portal-auth/consent-entrypoints.ts';
import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import { noStoreHeaders, requireTrustedOrigin } from '../http-transport.ts';
import { authorizeCustomerProfile } from '../profile/http.ts';
import { readCustomerPartyProfile } from '../profile/party-profile.ts';
import { admitCustomerAccount } from '../session/http.ts';
import { readDemoNewsletterChoice, writeDemoNewsletterChoice } from './choice-persistence.ts';
import {
  consentAuthentication,
  consentConflict,
  consentForbidden,
  consentInvalid,
  consentUnavailable,
} from './problems.ts';

const authorize = (principal: Readonly<TrustedPrincipalContext>, entrypoint: ModuleEntrypointDescriptor) =>
  authorizeCustomerProfile(principal, entrypoint).pipe(
    Effect.mapError((p) => (p.status === 403 ? consentForbidden() : consentUnavailable())),
  );
const activeRevision = Effect.gen(function* composition() {
  const compositions = yield* ActiveApplicationCompositionService;
  return (yield* compositions.load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(consentUnavailable),
  )).composition.revision;
});
const admitted = Effect.fn('CustomerConsent.admit')(function* admit(
  request: HttpServerRequest.HttpServerRequest,
  entrypoint: ModuleEntrypointDescriptor,
) {
  yield* noStoreHeaders;
  const current = yield* admitCustomerAccount(request, 'retail.consent.manage').pipe(
    Effect.mapError((problem) => {
      if (problem.status === 401) {
        return consentAuthentication();
      }
      if (problem.status === 403) {
        return consentForbidden();
      }
      return consentUnavailable();
    }),
  );
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(consentAuthentication());
  }
  yield* authorize(current.workloadPrincipal, entrypoint);
  if (current.workloadPrincipal.legalEntityId === undefined) {
    return yield* Effect.fail(consentForbidden());
  }
  const crypto = yield* Crypto.Crypto;
  const scope = {
    compositionRevision: yield* activeRevision,
    legalEntityId: current.workloadPrincipal.legalEntityId,
    partyId: current.account.partyId,
    requestCorrelation: yield* crypto.randomUUIDv4().pipe(Effect.mapError(consentUnavailable)),
    tenantId: current.workloadPrincipal.tenantId,
  };
  // Archived/merged/aliased Parties require real owner reconciliation, not a guessed successor.
  yield* readCustomerPartyProfile(scope).pipe(Effect.mapError(consentUnavailable));
  return { current, scope };
});
const projectChoice = (decision: CustomerOwnConsent['decision'], revision: number) =>
  Schema.decodeEffect(CustomerOwnConsentSchema)({ decision, notice: DEMO_NEWSLETTER_NOTICE, revision }).pipe(
    Effect.mapError(consentUnavailable),
  );

const read = Effect.fn('CustomerConsent.read')(function* readConsent(request: HttpServerRequest.HttpServerRequest) {
  const { scope } = yield* admitted(request, customerConsentReadOwnEntrypoint);
  const choice = yield* readDemoNewsletterChoice(scope);
  return yield* Option.isNone(choice)
    ? projectChoice('ABSENT', 0)
    : projectChoice(choice.value.decision, choice.value.revision);
});

const update = Effect.fn('CustomerConsent.update')(function* updateConsent(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerOwnConsent,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, consentForbidden);
  const { current, scope } = yield* admitted(request, customerConsentUpdateOwnEntrypoint);
  if (input.noticeVersionId !== DEMO_NEWSLETTER_NOTICE.noticeVersionId) {
    return yield* Effect.fail(consentConflict());
  }
  const audit = yield* CommercePortalAuthAudit;
  const crypto = yield* Crypto.Crypto;
  const correlationDigest = yield* crypto
    .digest('SHA-256', new TextEncoder().encode(input.requestId))
    .pipe(Effect.map(Hex.encode), Effect.mapError(consentUnavailable));
  const event = {
    correlationDigest,
    operation: 'customer-newsletter-consent',
    providerSubjectId: current.session.providerSubjectId,
    sessionRef: current.session.sessionRef,
  };
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.consent-requested.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'requested',
    })
    .pipe(Effect.mapError(consentUnavailable));
  const saved = yield* writeDemoNewsletterChoice(scope, input).pipe(
    Effect.tapError(() =>
      DateTime.nowAsDate.pipe(
        Effect.flatMap((occurredAt) =>
          audit.record({
            ...event,
            eventType: 'commerce.portal-auth.consent-failed.v1',
            occurredAt,
            outcome: 'unavailable',
          }),
        ),
        Effect.mapError(consentUnavailable),
      ),
    ),
  );
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.consent-recorded.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'success',
    })
    .pipe(Effect.mapError(consentUnavailable));
  // The owner routine returned only after its scoped transaction committed.
  return yield* projectChoice(saved.decision, saved.revision);
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnConsentSchemaError, () =>
  Effect.fail(consentInvalid()),
);
export const customerOwnConsentReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentRead',
  (handlers) => handlers.handle('execute', ({ request }) => read(request)),
).pipe(Layer.provide(schemaErrorLive));
export const customerOwnConsentUpdateApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnConsentUpdate',
  (handlers) => handlers.handle('execute', ({ payload, request }) => update(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
