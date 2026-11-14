import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ReadFinishContext } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { readDemoNewsletterChoice } from '../../../api/portal-auth/consent/choice-persistence.ts';
import { consentUnavailable } from '../../../api/portal-auth/consent/problems.ts';
import { ownPortalScope } from '../../../api/portal-auth/own/own-portal-scope.ts';
import { readDirectCustomerParty } from '../../../api/portal-auth/profile/party-profile.ts';
import { ConsentAuthorityUnavailableProblemSchema } from '@app/consent-authority-contracts/api';

import { CustomerOwnConsentSchema, DEMO_NEWSLETTER_NOTICE } from '../../../shared/portal-auth/consent-api.ts';
import {
  CustomerOwnPortalReadInputSchema,
  PORTAL_OWN_OPERATION,
  STOREFRONT_CLIENT_WORKLOAD,
  portalSessionOwnerFacts,
} from '../../../shared/portal-auth/own-session.ts';
import type { CustomerOwnPortalReadInput } from '../../../shared/portal-auth/own-session.ts';

/** A governed read of the registered storefront client (O59, O73). */
const customerConsentReadOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'commerce.customer-context.api.customer-consent-read-own',
  moduleKey: 'commerce.customer-context',
  role: 'api',
});

/**
 * The storefront customer's own newsletter consent. The registered storefront client alone runs it; the owner overlay
 * proves the session's account is bound to the Party it reads, then the Party is checked to be direct (an archived,
 * merged or aliased Party needs owner reconciliation, never a guessed successor) and its choice is projected.
 */
export const customerOwnConsentRead = defineRead(
  {
    accessKind: 'detail',
    accessOwnerFacts: (input: CustomerOwnPortalReadInput) => portalSessionOwnerFacts(input.session),
    // Pinned to the public carrier table `PORTAL_OWN_CARRIER.readConsent` by the reachability suite.
    accessWorkload: {
      reason: 'The registered storefront client reads the signed-in customer’s own consent for its own portal',
      workloads: [STOREFRONT_CLIENT_WORKLOAD],
    },
    domainErrorSchema: ConsentAuthorityUnavailableProblemSchema,
    entrypoint: customerConsentReadOwnEntrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'commerce.customer-context.api.customer-consent-read-own.evidence.v1',
    },
    inputSchema: CustomerOwnPortalReadInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.customer-context',
    policies: [],
    readKey: PORTAL_OWN_OPERATION.readConsent,
    resultSchema: CustomerOwnConsentSchema,
    schemaVersion: '1',
  },
  {
    finish: Effect.fn('CustomerOwnConsentRead.finish')(function* finish(
      input: CustomerOwnPortalReadInput,
      context: ReadFinishContext<undefined, void>,
    ) {
      const scope = yield* ownPortalScope(
        {
          compositionRevision: context.compositionRevision,
          legalEntityId: context.scope.legalEntityId,
          partyId: input.session.partyId,
          tenantId: context.scope.tenantId,
        },
        consentUnavailable,
      );
      yield* readDirectCustomerParty(scope).pipe(Effect.mapError(consentUnavailable));
      const choice = yield* readDemoNewsletterChoice(scope);
      const projected = yield* Schema.decodeEffect(CustomerOwnConsentSchema)(
        Option.match(choice, {
          onNone: () => ({ decision: 'ABSENT' as const, notice: DEMO_NEWSLETTER_NOTICE, revision: 0 }),
          onSome: (stored) => ({
            decision: stored.decision,
            notice: DEMO_NEWSLETTER_NOTICE,
            revision: stored.revision,
          }),
        }),
      ).pipe(Effect.mapError(consentUnavailable));
      return { evidence: { resultCount: 1 }, result: projected };
    }),
    load: () => Effect.void,
  },
  () => Effect.succeed({}),
);
