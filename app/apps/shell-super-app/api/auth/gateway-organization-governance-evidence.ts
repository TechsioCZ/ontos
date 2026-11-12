import { AccessDeclarationSchema, recoverSqlTransactionError } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayOrganizationGovernanceReadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayOrganizationGovernanceRead } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import type { GatewayOrganizationGovernanceReadSubjectSchema } from '@app/shared-contracts';
import {
  decodeGatewayContextProtectedHeader,
  decodeSupportedGatewayContextClaims,
  organizationGovernanceReadOperationContract,
} from '@app/shared-contracts';
import { symmySourceOrganizationFactsAccessDeclaration } from '@app/symmy-integration/api/symmy-source-organization-facts';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Predicate, Redacted, Schema } from 'effect';
import { jwtVerify } from 'jose';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { validateDelegationAuthentication } from './gateway-delegation-authentication.service.ts';
import { delegationForbidden, delegationUnavailable, GatewayDelegationError } from './gateway-delegation-errors.ts';
import { bindingAttestsSource, resolvePublishedFiniteGatewayTarget } from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { GatewayDelegationVerification } from './gateway-delegation-verification.ts';

type Subject = typeof GatewayOrganizationGovernanceReadSubjectSchema.Type;
type InstalledContract = ShellInstalledCatalog['contracts'][number];
type GovernanceTarget = ReturnType<typeof organizationGovernanceReadOperationContract>;
interface Evidence {
  readonly organizationGovernanceRead: RegisteredGatewayOrganizationGovernanceRead;
  readonly principal: TrustedPrincipalContext;
  readonly sourceAccess: 'read';
  readonly sourceKey: string;
  readonly sourceValidity: { readonly expiresAt: number; readonly issuedAt: number };
}
const privacyApp = 'privacy';
const privacyModule = 'privacy.core';
const governanceSourceRequirements = [
  {
    consumer: 'privacy.core.api.organization-business-applicability',
    key: 'privacy.core.requirement.organization-business-source-facts',
  },
  {
    consumer: 'privacy.core.record-privacy-applicability',
    key: 'privacy.core.requirement.record-organization-business-source-facts',
  },
];
const sourcePinsGovernanceVersion = (source: InstalledContract, target: GovernanceTarget): boolean =>
  governanceSourceRequirements.every(({ consumer, key }) => {
    const matches = source.manifest.requirements?.operations.filter((requirement) => requirement.key === key) ?? [];
    const [requirement] = matches;
    return (
      matches.length === 1 &&
      requirement !== undefined &&
      requirement.entrypointKey === consumer &&
      requirement.provider.moduleId === target.moduleId &&
      requirement.provider.entrypointKey === target.entrypointKey &&
      requirement.provider.schemaVersion === target.schemaVersion
    );
  });
const mintKey = Object.freeze({ kind: 'organization_governance_read' });
class AdmittedOrganizationGovernanceReadValue {
  readonly #evidence: Evidence | undefined;
  constructor(key: typeof mintKey, evidence: Evidence) {
    this.#evidence = key === mintKey ? Object.freeze(evidence) : undefined;
    Object.freeze(this);
  }
  static read(witness: AdmittedOrganizationGovernanceReadValue): Evidence | undefined {
    return #evidence in witness ? witness.#evidence : undefined;
  }
}
export type AdmittedOrganizationGovernanceRead = AdmittedOrganizationGovernanceReadValue;
const witnessSchema = Schema.instanceOf(AdmittedOrganizationGovernanceReadValue);
/** The private signer accepts only evidence minted after this module's complete current-human proof. */
export const readAdmittedOrganizationGovernanceRead = (
  witness: AdmittedOrganizationGovernanceRead,
): Evidence | undefined =>
  Schema.is(witnessSchema)(witness) ? AdmittedOrganizationGovernanceReadValue.read(witness) : undefined;

const verifySource = Effect.fn('OrganizationGovernanceEvidence.verifySource')(function* verify(input: {
  readonly assertion: Redacted.Redacted;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
}) {
  const configuration = yield* (yield* GatewayDelegationVerification).load;
  const now = yield* DateTime.now;
  const verified = yield* Effect.tryPromise({
    catch: (cause) => delegationForbidden(cause),
    try: jwtVerify.bind(undefined, Redacted.value(input.assertion), configuration.keys, {
      algorithms: ['EdDSA'],
      audience: privacyApp,
      clockTolerance: 0,
      currentDate: DateTime.toDateUtc(now),
      issuer: configuration.issuer,
    }),
  }).pipe(Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(delegationUnavailable()) }));
  yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(Effect.mapError(delegationForbidden));
  const claims = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(
    Effect.mapError(delegationForbidden),
  );
  const nowSeconds = Math.floor(DateTime.toEpochMillis(now) / 1000);
  if (
    (claims.ver !== 2 && claims.ver !== 3) ||
    claims.iat > nowSeconds ||
    claims.exp <= nowSeconds ||
    !bindingAttestsSource(input.binding, claims, input.installed.composition.revision)
  ) {
    return yield* delegationForbidden();
  }
  const { principal } = claims;
  if (
    (principal.authMethod !== 'session' && principal.authMethod !== 'api_key') ||
    principal.impersonatedByPrincipalId !== undefined ||
    principal.legalEntityId === undefined ||
    principal.authBindingId === undefined ||
    principal.authenticationNamespaceId === undefined
  ) {
    return yield* delegationForbidden();
  }
  yield* validateDelegationAuthentication(principal, nowSeconds);
  return claims;
});

/** This fresh native identity question neither carries a previous relay actor nor invents a namespace. */
const validateCurrentHuman = Effect.fn('OrganizationGovernanceEvidence.currentHuman')(function* human(
  principal: TrustedPrincipalContext,
) {
  const database = yield* CoreDatabase;
  yield* database.executor
    .transaction(
      Effect.fn('OrganizationGovernanceEvidence.nativeHuman')(function* native(transaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id',${principal.tenantId},true),set_config('ontos.legal_entity_id',${principal.legalEntityId ?? ''},true)`,
          'objects',
        );
        const namespace =
          principal.authenticationNamespaceId === undefined
            ? sql`true`
            : sql`b.authentication_namespace_id=${principal.authenticationNamespaceId}`;
        const rows = yield* transaction.execute(
          sql`
      select p.principal_id
      from core.principals p
      join core.tenants t on t.tenant_id=p.tenant_id and t.status='active'
      join core.principal_auth_bindings b on b.tenant_id=p.tenant_id and b.principal_id=p.principal_id
        and b.principal_auth_binding_id=${principal.authBindingId}::uuid and b.status='active' and b.revoked_at is null
      join core.legal_entities l on l.tenant_id=p.tenant_id and l.legal_entity_id=${principal.legalEntityId}::uuid and l.status='active'
      where p.tenant_id=${principal.tenantId}::uuid and p.principal_id=${principal.principalId}::uuid
        and p.kind='human' and p.status='active' and ${namespace}
        and b.subject_type=${principal.authMethod === 'session' ? 'user' : 'api_key'}
      limit 2`,
          'objects',
        );
        if (rows.length !== 1) {
          return yield* delegationForbidden();
        }
        return yield* Effect.void;
      }),
    )
    .pipe(
      recoverSqlTransactionError,
      Effect.mapError((cause) => (Schema.is(GatewayDelegationError)(cause) ? cause : delegationUnavailable(cause))),
    );
});
const requireReadRights = Effect.fn('OrganizationGovernanceEvidence.readRights')(function* rights(
  principal: TrustedPrincipalContext,
  sourceKey: string,
  target: GovernanceTarget,
) {
  const scope = yield* (yield* OperationalScopeResolver)
    .resolve({
      audience: privacyApp,
      correlationId: sourceKey,
      legalEntityScope: 'required',
      principal,
    })
    .pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'OperationContextUnavailable')
          ? delegationUnavailable(cause)
          : delegationForbidden(cause),
      ),
    );
  if (
    scope.principalId !== principal.principalId ||
    scope.tenantId !== principal.tenantId ||
    scope.legalEntityId !== principal.legalEntityId
  ) {
    return yield* delegationForbidden();
  }
  const declaration = yield* Schema.decodeUnknownEffect(AccessDeclarationSchema)(
    symmySourceOrganizationFactsAccessDeclaration,
  ).pipe(Effect.mapError(delegationUnavailable));
  const decision = yield* (yield* AccessDecisionGate).decide({
    // Ask about the human's rights directly; a previous module's identity-only actor carrier supplies no grant.
    carrier: {
      accessDeclaration: declaration,
      entrypoint: { entrypointKey: target.entrypointKey },
      schemaVersion: target.schemaVersion,
    },
    legalEntityScope: 'required',
    now: DateTime.toDateUtc(yield* DateTime.now),
    scope,
  });
  if (decision.outcome === 'UNAVAILABLE') {
    return yield* delegationUnavailable();
  }
  if (decision.outcome !== 'ALLOWED') {
    return yield* delegationForbidden();
  }
  return yield* Effect.void;
});

/** One fixed human governance Read, bounded by its exact input hash and the original source assertion's interval. */
export const admitOrganizationGovernanceRead = Effect.fn('GatewayDelegation.admitOrganizationGovernanceRead')(
  function* admit(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly subject: Subject;
  }) {
    const { binding, installed, subject } = input;
    const approvedTarget = organizationGovernanceReadOperationContract();
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    if (
      source === undefined ||
      destination === undefined ||
      binding.sourceAppId !== privacyApp ||
      source.manifest.module.id !== privacyModule ||
      binding.sourceBuildMarker !== source.deployment.buildMarker ||
      binding.compositionRevision !== installed.composition.revision ||
      input.audience !== approvedTarget.appId ||
      destination.manifest.module.id !== approvedTarget.moduleId ||
      destination.manifest.publicSurface.actions.some(
        (action) => action.entrypoint.entrypointKey === approvedTarget.entrypointKey,
      )
    ) {
      return yield* delegationForbidden();
    }
    const resolved = resolvePublishedFiniteGatewayTarget(destination, approvedTarget);
    if (Option.isNone(resolved)) {
      return yield* delegationForbidden();
    }
    const target = resolved.value;
    if (target.schemaVersion !== approvedTarget.schemaVersion && !sourcePinsGovernanceVersion(source, target)) {
      return yield* delegationForbidden();
    }
    const sourceProof = yield* verifySource({ assertion: subject.sourceAssertion, binding, installed });
    yield* validateCurrentHuman(sourceProof.principal);
    yield* requireReadRights(sourceProof.principal, sourceProof.jti, target);
    const metadata = {
      governanceLegalEntityId: sourceProof.principal.legalEntityId,
      principalId: sourceProof.principal.principalId,
      requestHash: subject.requestHash,
      tenantId: sourceProof.principal.tenantId,
    };
    if (target.schemaVersion !== approvedTarget.schemaVersion) {
      Object.assign(metadata, { target });
    }
    const organizationGovernanceRead = yield* Schema.decodeUnknownEffect(
      RegisteredGatewayOrganizationGovernanceReadSchema,
    )(metadata).pipe(Effect.mapError(delegationForbidden));
    if (organizationGovernanceRead.target !== undefined) {
      Object.freeze(organizationGovernanceRead.target);
    }
    return new AdmittedOrganizationGovernanceReadValue(mintKey, {
      organizationGovernanceRead: Object.freeze(organizationGovernanceRead),
      principal: Object.freeze({ ...sourceProof.principal }),
      sourceAccess: 'read',
      sourceKey: sourceProof.jti,
      sourceValidity: Object.freeze({ expiresAt: sourceProof.exp, issuedAt: sourceProof.iat }),
    });
  },
);
