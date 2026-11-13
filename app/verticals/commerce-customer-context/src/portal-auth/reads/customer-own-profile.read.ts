import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ReadFinishContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { ownPortalScope } from '../../../api/portal-auth/own/own-portal-scope.ts';
import { readCustomerPartyProfile } from '../../../api/portal-auth/profile/party-profile.ts';
import { profileUnavailable } from '../../../api/portal-auth/profile/problems.ts';
import {
  CustomerOwnProfileSchema,
  ProfileConflictProblemSchema,
  ProfileUnavailableProblemSchema,
} from '../../../shared/portal-auth/profile-api.ts';
import {
  CustomerOwnPortalReadInputSchema,
  PORTAL_OWN_OPERATION,
  STOREFRONT_CLIENT_WORKLOAD,
  portalSessionOwnerFacts,
} from '../../../shared/portal-auth/own-session.ts';
import type { CustomerOwnPortalReadInput } from '../../../shared/portal-auth/own-session.ts';

/** A governed read of the registered storefront client (O59, O73). */
const customerProfileReadOwnEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'commerce.customer-context.api.customer-profile-read-own',
  moduleKey: 'commerce.customer-context',
  role: 'api',
});

/**
 * The storefront customer's own profile. Only the registered storefront client runs it (no person, agent or OAuth
 * connection: the carrier is the workload's alone), the owner overlay proves inside the read's transaction that the
 * session's account is bound to the Party it reads, and only then does Party Registry answer, after the commit.
 */
export const customerOwnProfileRead = defineRead(
  {
    accessKind: 'detail',
    accessOwnerFacts: (input: CustomerOwnPortalReadInput) => portalSessionOwnerFacts(input.session),
    // Pinned to the public carrier table `PORTAL_OWN_CARRIER.readProfile` by the reachability suite.
    accessWorkload: {
      reason: 'The registered storefront client reads the signed-in customer’s own profile for its own portal',
      workloads: [STOREFRONT_CLIENT_WORKLOAD],
    },
    domainErrorSchema: Schema.Union([ProfileConflictProblemSchema, ProfileUnavailableProblemSchema]),
    entrypoint: customerProfileReadOwnEntrypoint,
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'commerce.customer-context.api.customer-profile-read-own.evidence.v1',
    },
    inputSchema: CustomerOwnPortalReadInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'commerce.customer-context',
    policies: [],
    readKey: PORTAL_OWN_OPERATION.readProfile,
    resultSchema: CustomerOwnProfileSchema,
    schemaVersion: '1',
  },
  {
    finish: Effect.fn('CustomerOwnProfileRead.finish')(function* finish(
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
        profileUnavailable,
      );
      const { profile } = yield* readCustomerPartyProfile(scope);
      return { evidence: { resultCount: 1 }, result: profile };
    }),
    load: () => Effect.void,
  },
  () => Effect.succeed({}),
);
