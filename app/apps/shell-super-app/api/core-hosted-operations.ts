import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { SHELL_HOST_APP_ID } from '@app/core-runtime/sdk/core';
import {
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  bindGatewayPrincipalVerifier,
} from '@app/gateway-principal-verifier/server';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect } from 'effect';
import type { Redacted } from 'effect';

import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import {
  CoreHostedOperationAuthenticationProblemSchema,
  CoreHostedOperationForbiddenProblemSchema,
  CoreHostedOperationInternalProblemSchema,
  CoreHostedOperationInvalidProblemSchema,
  CoreHostedOperationNotFoundProblemSchema,
  CoreHostedOperationPolicyConflictProblemSchema,
  CoreHostedOperationPolicyProblemSchema,
  CoreHostedOperationUnavailableProblemSchema,
} from '../shared/core-hosted-operations.ts';
import { ShellInstalledModuleCatalog } from './modules/installed-module-catalog.ts';

/*
 * The receiving side of the Core operations the Shell host serves to modules (#1443 P2). Everything a vertical's
 * receiver proves, this proves for the Shell deployment, and one thing more: the assertion must have been issued to a
 * MODULE on behalf of a requester, and that module's own installed release must declare exactly the operation the
 * route serves (its provider identity: module, entrypoint key and schema version), not any Shell-hosted operation.
 *
 * - signature, issuer, exact audience (the Shell app id), approved release, expiry and the calling module's approved
 *   release are verified by the shared verifier bound to this deployment;
 * - the `(issuer, audience, jti)` identity is consumed once, durably, before anything runs;
 * - a direct assertion of a person (no calling module) is refused here: a person reaches Core Media through the
 *   session routes, never through this one;
 * - the read then runs as the REQUESTER: Core re-resolves the principal's binding, tenant and namespace and the
 *   read's own SpiceDB decision answers, so the calling module's service credential adds no permission.
 */

const principalVerifier = bindGatewayPrincipalVerifier(SHELL_HOST_APP_ID, ultramodernDeliveryUnit);

const unauthorized = () =>
  Effect.fail(
    ActionPrincipalScopeErrorSchema.make({ reason: 'The Bearer assertion was not issued for this operation' }),
  );

/** The provider identity of the registration a Shell route actually serves, as a requirement names its provider. */
interface ServedHostedOperation {
  readonly entrypointKey: string;
  readonly moduleId: string;
  readonly schemaVersion: string;
}

interface ServedReadRegistration {
  readonly descriptor: { readonly owningModuleKey: string; readonly readKey: string; readonly schemaVersion: string };
}

/** The operation a read registration serves, taken from the registration itself and never from the request. */
const servedHostedOperationOf = (registration: ServedReadRegistration): ServedHostedOperation => ({
  entrypointKey: registration.descriptor.readKey,
  moduleId: registration.descriptor.owningModuleKey,
  schemaVersion: registration.descriptor.schemaVersion,
});

/**
 * The calling module of a verified assertion and what its own installed release declares: a requirement that relays
 * the requester for exactly the operation this route serves. A module that declares another hosted operation (or this
 * one at another schema version) is not authorized to call this endpoint: a confused deputy once a second operation
 * is hosted.
 */
const callingModuleDeclaresHostedOperation = Effect.fn('CoreHostedOperation.authorizeCaller')(
  function* callingModuleDeclaresHostedOperation(
    actor: { readonly appId: string; readonly buildMarker: string },
    served: ServedHostedOperation,
  ) {
    const catalog = yield* ShellInstalledModuleCatalog;
    const installed = yield* catalog.load.pipe(
      Effect.catchTag('InstalledModuleCatalogUnavailableError', () =>
        Effect.fail(ActionPrincipalUnavailableErrorSchema.make({ reason: 'The installed catalog is unavailable' })),
      ),
    );
    const contract = installed.contracts.find(
      ({ deployment }) => deployment.appId === actor.appId && deployment.buildMarker === actor.buildMarker,
    );
    const declares =
      contract?.manifest.requirements?.operations.some(
        (requirement) =>
          requirement.callers?.some((caller) => caller.kind === 'person') === true &&
          requirement.provider.moduleId === served.moduleId &&
          requirement.provider.entrypointKey === served.entrypointKey &&
          requirement.provider.schemaVersion === served.schemaVersion,
      ) === true;
    return yield* declares ? Effect.void : unauthorized();
  },
);

/** The audience-bound verifier of this endpoint: verified, redeemed once, and issued to a module for its requester. */
export const authenticateHostedOperationPrincipal = Effect.fn('CoreHostedOperation.authenticate')(
  function* authenticateHostedOperationPrincipal(
    authorization: Redacted.Redacted<string | undefined>,
    served: ServedHostedOperation,
  ) {
    const redemption = yield* GatewayAssertionRedemptionService;
    const principal = yield* principalVerifier.verifyAndRedeem(authorization, { redemption });
    const actor = readVerifiedGatewayActor(principal);
    if (actor === undefined) {
      return yield* unauthorized();
    }
    yield* callingModuleDeclaresHostedOperation(actor, served);
    return principal;
  },
);

/** The sanitized governed-read problems of the hosted endpoint. */
export const hostedOperationProblems = makeGovernedReadProblems({
  authentication: CoreHostedOperationAuthenticationProblemSchema,
  forbidden: CoreHostedOperationForbiddenProblemSchema,
  internal: CoreHostedOperationInternalProblemSchema,
  invalid: CoreHostedOperationInvalidProblemSchema,
  notFound: CoreHostedOperationNotFoundProblemSchema,
  policyConflict: CoreHostedOperationPolicyConflictProblemSchema,
  policyIneligible: CoreHostedOperationPolicyProblemSchema,
  unavailable: CoreHostedOperationUnavailableProblemSchema,
});

/**
 * The authenticator of the route that serves `registration`: it maps the verifier's refusals onto the endpoint's two
 * authentication problems (401 and a retryable 503) and admits only a module that declares that operation.
 */
export const authenticateHostedOperation =
  (registration: ServedReadRegistration) =>
  (
    authorization: Redacted.Redacted<string | undefined>,
    authenticationProblems: {
      readonly authentication: () => ReturnType<typeof hostedOperationProblems.authentication>;
      readonly unavailable: () => ReturnType<typeof hostedOperationProblems.unavailable>;
    },
  ) =>
    authenticateHostedOperationPrincipal(authorization, servedHostedOperationOf(registration)).pipe(
      Effect.catchTags({
        ActionPrincipalConfigurationError: () => Effect.fail(authenticationProblems.unavailable()),
        ActionPrincipalExpiredError: () => Effect.fail(authenticationProblems.authentication()),
        ActionPrincipalInvalidError: () => Effect.fail(authenticationProblems.authentication()),
        ActionPrincipalMissingError: () => Effect.fail(authenticationProblems.authentication()),
        ActionPrincipalScopeError: () => Effect.fail(authenticationProblems.authentication()),
        ActionPrincipalUnavailableError: () => Effect.fail(authenticationProblems.unavailable()),
      }),
    );
