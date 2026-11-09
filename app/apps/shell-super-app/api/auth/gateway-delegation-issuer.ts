import { admitAssertionSubject } from './gateway-assertion-evidence.ts';
import { admitRegisteredGatewayRecovery } from './gateway-recovery-evidence.ts';
import {
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
  privacyDispatchOperationContract,
  RegisteredGatewayOrganizationGovernanceReadSchema,
  organizationGovernanceReadOperationContract,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { admitRegisteredAssertionWorkload } from './gateway-registered-assertion.ts';
import { admitRegisteredGatewayWorkload } from './gateway-workload-evidence.ts';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { PrincipalResolver, TenantModuleStateService, tenantStatesAllowingAccess } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import type { GatewayActorClaim, GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GatewayActorClaimSchema,
  GatewayRegisteredAssertionSubjectSchema,
  GatewayRegisteredAdmissionSubjectSchema,
  GatewayRegisteredWorkloadSubjectSchema,
  GatewayRegisteredRecoverySubjectSchema,
  GatewayPrivacyDispatchSubjectSchema,
  GatewayOrganizationGovernanceReadSubjectSchema,
  GatewayTrustedPrincipalContextSchema,
} from '@app/shared-contracts';
import { DateTime, Effect, Match, Predicate, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import {
  GatewayIssuer,
  issuePrivacyDispatchGatewayContextAssertion,
  issueOrganizationGovernanceReadGatewayContextAssertion,
  issueOrganizationProcessingReadGatewayContextAssertion,
} from './gateway-issuer.ts';
import {
  admitOrganizationGovernanceRead,
  readAdmittedOrganizationGovernanceRead,
} from './gateway-organization-governance-evidence.ts';
import { admitPrivacyDispatch, readAdmittedPrivacyDispatch } from './gateway-privacy-dispatch-evidence.ts';
import { GatewayDelegationExchangeLedger } from './gateway-delegation-exchanges.service.ts';
import { gatewayPublishedOperationAccess, loadGatewayModuleBindings } from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { GatewayOriginatorEvidence } from './gateway-originator-evidence.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';

export type GatewayDelegationRequestPayload = Schema.Schema.Type<typeof GatewayDelegatedContextRequestSchema>;

const RegisteredSubjectSchema = Schema.Union([
  GatewayRegisteredAssertionSubjectSchema,
  GatewayRegisteredAdmissionSubjectSchema,
  GatewayRegisteredWorkloadSubjectSchema,
  GatewayRegisteredRecoverySubjectSchema,
]);
type RegisteredPayload = Omit<GatewayDelegationRequestPayload, 'subject'> & {
  readonly subject: typeof RegisteredSubjectSchema.Type;
};

/** The subject a delegated context is issued for, with the replay identity and lifetime its admission fixes. */
interface AdmittedSubject {
  readonly expiresAtEpochSeconds: number;
  /** The subject principal the new context names. */
  readonly principal: TrustedPrincipalContext;
  /** The principal the scope resolver is asked about; a live request's scope is established from its verified assertion. */
  readonly scopePrincipal: TrustedPrincipalContext;
  /** Exchange ledger key: the source token identity for `Assertion`, the invocation for `Originator`. */
  readonly sourceKey: string;
  /** The signed-in requester's own token window (kept exactly), or undefined for a fresh window. */
  readonly sourceValidity?: { readonly expiresAt: number; readonly issuedAt: number } | undefined;
}

/**
 * A tenant-scoped copy of a principal: the same identity and trust, without its Legal Entity. A trusted Storefront
 * exists only inside a Legal Entity, so it is dropped with it.
 */
const tenantScopedPrincipal = (principal: TrustedPrincipalContext): TrustedPrincipalContext => {
  const { legalEntityId: _legalEntityId, trustedStorefrontId: _trustedStorefrontId, ...tenantPrincipal } = principal;
  return preserveSystemPrincipalContextTrust(principal, tenantPrincipal);
};

/**
 * The subject as the scope resolver sees it during issuance: the module call this context is being issued for,
 * with its calling module sealed beside the subject exactly as the receiving module will seal it (D4). The gate's
 * module-call rules — a workload subject selects a company by its binding — then answer the Shell the same way
 * they answer the receiver.
 */
const moduleCallSubject = (
  principal: TrustedPrincipalContext,
  compositionRevision: string,
  actor: GatewayActorClaim,
): TrustedPrincipalContext =>
  trustVerifiedGatewayPrincipalContext(
    principal,
    readVerifiedGatewayCompositionRevision(principal) ?? compositionRevision,
    readVerifiedGatewayScopeAssertion(principal),
    { appId: actor.appId, buildMarker: actor.buildMarker, principalId: actor.principalId },
  );

const scopeFailure = (cause: unknown) =>
  new GatewayDelegationError({
    cause,
    code: Predicate.isTagged(cause, 'OperationContextUnavailable') ? 'unavailable' : 'forbidden',
  });

/**
 * Admits the requester recorded on a succeeded invocation of one of the Actions the calling module declares it may
 * act for; no live session is needed for asynchronous work. The context names the company the invocation itself
 * ran in, and nothing else for a person: a human or agent requester is never moved into another company, because a
 * calling module could then act for that person anywhere the person could select, identity carriers included.
 * Only a workload requester whose invocation ran in the tenant context — the Storefront client that started an
 * enrollment — may name the one company the work belongs to. A workload's registered binding is tenant-wide, so the
 * scope resolver below admits that company only while the workload holds an active binding in the tenant and the
 * company is an active company of it (O73).
 */
const admitOriginatorSubject = Effect.fn('GatewayDelegation.admitOriginator')(function* admitOriginatorSubject(input: {
  readonly actionInvocationId: string;
  readonly legalEntityId: string | undefined;
  readonly now: number;
  readonly originatorActions: readonly string[];
  readonly tenantId: string;
}) {
  const evidence = yield* GatewayOriginatorEvidence;
  const recorded = yield* evidence.load({
    actionInvocationId: input.actionInvocationId,
    originatorActions: input.originatorActions,
    tenantId: input.tenantId,
  });
  const recordedCompany = recorded.principal.legalEntityId;
  if (
    input.legalEntityId !== undefined &&
    (recordedCompany === undefined ? !recorded.workload : recordedCompany !== input.legalEntityId)
  ) {
    return yield* delegationForbidden();
  }
  const principal: TrustedPrincipalContext =
    input.legalEntityId === undefined
      ? recorded.principal
      : { ...recorded.principal, legalEntityId: input.legalEntityId };
  return {
    expiresAtEpochSeconds: input.now + GATEWAY_ASSERTION_TTL_SECONDS,
    principal,
    scopePrincipal: principal,
    sourceKey: input.actionInvocationId,
  };
});

const exchangeFingerprint = (input: {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly requestCorrelation: string;
}) =>
  Schema.encodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        actor: GatewayActorClaimSchema,
        audience: Schema.String,
        compositionRevision: Schema.String,
        principal: GatewayTrustedPrincipalContextSchema,
        requestCorrelation: Schema.String,
      }),
    ),
  )(input).pipe(Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json)))));

const issueRegisteredGatewayAssertion = Effect.fn('GatewayDelegation.issueRegistered')(
  function* issueRegistered(input: {
    readonly binding: GatewayModuleBinding;
    readonly currentDate: Date;
    readonly installed: ShellInstalledCatalog;
    readonly now: number;
    readonly payload: RegisteredPayload;
  }) {
    const { binding, currentDate, installed, now, payload } = input;
    const sourceContract = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    if (installed.composition.revision !== payload.compositionRevision) {
      return yield* delegationForbidden();
    }
    const admitted = yield* Match.value(payload.subject).pipe(
      Match.tag('RegisteredRecovery', (subject) =>
        admitRegisteredGatewayRecovery({ audience: payload.audience, binding, installed, subject }).pipe(
          Effect.map((evidence) => ({
            ...evidence,
            organizationProcessingWitness: null,
            sourceAccess: 'read' as const,
          })),
        ),
      ),
      Match.tag('RegisteredWorkload', (subject) =>
        admitRegisteredGatewayWorkload({ audience: payload.audience, binding, installed, subject }).pipe(
          Effect.map((evidence) => ({
            ...evidence,
            organizationProcessingWitness: null,
            sourceAccess: 'background' as const,
          })),
        ),
      ),
      Match.tag('RegisteredAdmission', (subject) =>
        admitRegisteredGatewayWorkload({ audience: payload.audience, binding, installed, subject }).pipe(
          Effect.map((evidence) => ({
            ...evidence,
            organizationProcessingWitness: null,
            sourceAccess: 'write' as const,
          })),
        ),
      ),
      Match.tag('RegisteredAssertion', (subject) =>
        admitAssertionSubject({
          assertion: subject.sourceAssertion,
          binding,
          currentDate,
          now,
          registeredWorkload: true,
          requestedCompositionRevision: payload.compositionRevision,
        }).pipe(
          Effect.flatMap((source) =>
            source.workload === undefined
              ? Effect.fail(delegationForbidden())
              : admitRegisteredAssertionWorkload({
                  audience: payload.audience,
                  binding,
                  installed,
                  source: source.verifiedAssertion,
                  subject,
                }),
          ),
        ),
      ),
      Match.exhaustive,
    );
    if (payload.legalEntityScope === 'tenant' && admitted.workload.legalEntityId !== undefined) {
      return yield* delegationForbidden();
    }
    const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
    if (sourceContract === undefined || destination === undefined) {
      return yield* delegationForbidden();
    }
    const states = yield* (yield* TenantModuleStateService)
      .getTenantModuleStates(admitted.principal.tenantId, [
        sourceContract.manifest.module.id,
        destination.manifest.module.id,
      ])
      .pipe(Effect.mapError(delegationUnavailable));
    const destinationAccess = gatewayPublishedOperationAccess(
      destination,
      admitted.workload.entrypointKey,
      admitted.workload.schemaVersion,
    );
    if (destinationAccess === undefined) {
      return yield* delegationForbidden();
    }
    const sourceStates = new Set(tenantStatesAllowingAccess(admitted.sourceAccess));
    const destinationStates = new Set(tenantStatesAllowingAccess(destinationAccess));
    const sourceEligible = states.some(
      (state) => state.moduleKey === sourceContract.manifest.module.id && sourceStates.has(state.state),
    );
    const destinationEligible = states.some(
      (state) => state.moduleKey === destination.manifest.module.id && destinationStates.has(state.state),
    );
    if (!sourceEligible || !destinationEligible) {
      return yield* delegationForbidden();
    }
    const fingerprintJson = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          audience: Schema.String,
          compositionRevision: Schema.String,
          principal: GatewayTrustedPrincipalContextSchema,
          workload: RegisteredGatewayWorkloadSchema,
        }),
      ),
    )({
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal: admitted.principal,
      workload: admitted.workload,
    }).pipe(Effect.mapError(delegationUnavailable));
    const fingerprint = bytesToHex(sha256(utf8ToBytes(fingerprintJson)));
    yield* (yield* GatewayDelegationExchangeLedger)
      .reserve({
        exchangeId: payload.exchangeId,
        expiresAtEpochSeconds: now + GATEWAY_ASSERTION_TTL_SECONDS,
        requestFingerprint: fingerprint,
        sourceJti: admitted.sourceKey,
      })
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'GatewayDelegationExchangeReplay')
            ? delegationForbidden(cause)
            : delegationUnavailable(cause),
        ),
      );
    if (admitted.organizationProcessingWitness !== null) {
      return yield* issueOrganizationProcessingReadGatewayContextAssertion(admitted.organizationProcessingWitness);
    }
    return yield* (yield* GatewayIssuer).issue({
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal: admitted.principal,
      workload: admitted.workload,
    });
  },
);

const issueFinitePrivacyDispatch = Effect.fn('GatewayDelegation.issueFinitePrivacyDispatch')(
  function* issueFinitePrivacyDispatch(input: {
    readonly actor: GatewayActorClaim;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly now: number;
    readonly payload: GatewayDelegationRequestPayload & {
      readonly subject: typeof GatewayPrivacyDispatchSubjectSchema.Type;
    };
  }) {
    const { actor, binding, installed, now, payload } = input;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const target = privacyDispatchOperationContract(payload.subject.operation._tag);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
    if (
      payload.legalEntityScope !== 'subject' ||
      payload.audience !== target.appId ||
      installed.composition.revision !== payload.compositionRevision ||
      binding.compositionRevision !== installed.composition.revision ||
      source?.deployment.buildMarker !== binding.sourceBuildMarker ||
      destination?.manifest.module.id !== target.moduleId
    ) {
      return yield* delegationForbidden();
    }
    const witness = yield* admitPrivacyDispatch({
      audience: payload.audience,
      binding,
      installed,
      subject: payload.subject,
    });
    const admitted = readAdmittedPrivacyDispatch(witness);
    if (
      admitted === undefined ||
      gatewayPublishedOperationAccess(destination, target.entrypointKey, target.schemaVersion) !== target.access
    ) {
      return yield* delegationForbidden();
    }
    const moduleKeys = [source.manifest.module.id, destination.manifest.module.id];
    const states = yield* (yield* TenantModuleStateService)
      .getTenantModuleStates(admitted.principal.tenantId, moduleKeys)
      .pipe(Effect.mapError(delegationUnavailable));
    const sourceStates = new Set(tenantStatesAllowingAccess(admitted.sourceAccess));
    const targetStates = new Set(tenantStatesAllowingAccess(target.access));
    if (
      !states.some((state) => state.moduleKey === source.manifest.module.id && sourceStates.has(state.state)) ||
      !states.some((state) => state.moduleKey === destination.manifest.module.id && targetStates.has(state.state))
    ) {
      return yield* delegationForbidden();
    }
    const fingerprint = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          actor: GatewayActorClaimSchema,
          audience: Schema.String,
          compositionRevision: Schema.String,
          principal: GatewayTrustedPrincipalContextSchema,
          privacyDispatch: RegisteredGatewayPrivacyDispatchSchema,
        }),
      ),
    )({
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal: admitted.principal,
      privacyDispatch: admitted.privacyDispatch,
    }).pipe(
      Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json)))),
      Effect.mapError(delegationUnavailable),
    );
    yield* (yield* GatewayDelegationExchangeLedger)
      .reserve({
        exchangeId: payload.exchangeId,
        expiresAtEpochSeconds: now + GATEWAY_ASSERTION_TTL_SECONDS,
        requestFingerprint: fingerprint,
        sourceJti: admitted.sourceKey,
      })
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'GatewayDelegationExchangeReplay')
            ? delegationForbidden(cause)
            : delegationUnavailable(cause),
        ),
      );
    return yield* issuePrivacyDispatchGatewayContextAssertion(witness, {
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
    });
  },
);

/**
 * Module-to-module capability issuance. The calling module is the actor: its module credential's bound
 * service principal goes in `act`, and only this binding can set the app and build of `act`. The subject
 * is the requester of a live request (`Assertion`) or of the invocation asynchronous work runs for (`Originator`).
 */
const issueFiniteOrganizationGovernanceRead = Effect.fn('GatewayDelegation.issueOrganizationGovernanceRead')(
  function* issueFiniteOrganizationGovernanceRead(input: {
    readonly actor: GatewayActorClaim;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly payload: GatewayDelegationRequestPayload & {
      readonly subject: typeof GatewayOrganizationGovernanceReadSubjectSchema.Type;
    };
  }) {
    const { actor, binding, installed, payload } = input;
    const target = organizationGovernanceReadOperationContract();
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
    if (
      payload.legalEntityScope !== 'subject' ||
      actor.appId !== 'privacy' ||
      payload.audience !== target.appId ||
      installed.composition.revision !== payload.compositionRevision ||
      binding.compositionRevision !== installed.composition.revision ||
      source?.deployment.buildMarker !== binding.sourceBuildMarker ||
      destination?.manifest.module.id !== target.moduleId
    ) {
      return yield* delegationForbidden();
    }
    const witness = yield* admitOrganizationGovernanceRead({
      audience: payload.audience,
      binding,
      installed,
      subject: payload.subject,
    });
    const admitted = readAdmittedOrganizationGovernanceRead(witness);
    if (admitted === undefined) {
      return yield* delegationForbidden();
    }
    const states = yield* (yield* TenantModuleStateService)
      .getTenantModuleStates(admitted.principal.tenantId, [source.manifest.module.id, destination.manifest.module.id])
      .pipe(Effect.mapError(delegationUnavailable));
    const readable = new Set(tenantStatesAllowingAccess('read'));
    if (
      ![source.manifest.module.id, destination.manifest.module.id].every((moduleKey) =>
        states.some((state) => state.moduleKey === moduleKey && readable.has(state.state)),
      )
    ) {
      return yield* delegationForbidden();
    }
    const fingerprint = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          actor: GatewayActorClaimSchema,
          audience: Schema.String,
          compositionRevision: Schema.String,
          organizationGovernanceRead: RegisteredGatewayOrganizationGovernanceReadSchema,
          principal: GatewayTrustedPrincipalContextSchema,
        }),
      ),
    )({
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      organizationGovernanceRead: admitted.organizationGovernanceRead,
      principal: admitted.principal,
    }).pipe(
      Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json)))),
      Effect.mapError(delegationUnavailable),
    );
    yield* (yield* GatewayDelegationExchangeLedger)
      .reserve({
        exchangeId: payload.exchangeId,
        expiresAtEpochSeconds: admitted.sourceValidity.expiresAt,
        requestFingerprint: fingerprint,
        sourceJti: admitted.sourceKey,
      })
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'GatewayDelegationExchangeReplay')
            ? delegationForbidden(cause)
            : delegationUnavailable(cause),
        ),
      );
    return yield* issueOrganizationGovernanceReadGatewayContextAssertion(witness, {
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
    });
  },
);

export const issueDelegatedGatewayContextAssertion = Effect.fn('GatewayDelegation.issue')(
  function* issueDelegatedGatewayContext(input: {
    readonly payload: GatewayDelegationRequestPayload;
    readonly requestCorrelation: string;
    readonly verifiedProviderKeyId: string;
  }) {
    const { payload } = input;
    const bindings = yield* loadGatewayModuleBindings.pipe(Effect.mapError(delegationUnavailable));
    const binding = bindings.find((candidate) => candidate.providerKeyId === input.verifiedProviderKeyId);
    if (binding === undefined) {
      return yield* delegationForbidden();
    }
    const principalResolver = yield* PrincipalResolver;
    const caller = yield* principalResolver
      .resolveBetterAuthApiKey(input.verifiedProviderKeyId)
      .pipe(Effect.mapError(delegationForbidden));
    if (caller.principalKind !== 'service') {
      return yield* delegationForbidden();
    }
    const actor = yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
      appId: binding.sourceAppId,
      buildMarker: binding.sourceBuildMarker,
      principalId: caller.principalId,
    }).pipe(Effect.mapError(delegationUnavailable));

    const currentDate = DateTime.toDateUtc(yield* DateTime.now);
    const now = Math.floor(currentDate.getTime() / 1000);
    const catalog = yield* ShellInstalledModuleCatalog;
    const installed = yield* catalog.load.pipe(Effect.mapError(delegationUnavailable));
    const sourceContract = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    if (Schema.is(GatewayOrganizationGovernanceReadSubjectSchema)(payload.subject)) {
      return yield* issueFiniteOrganizationGovernanceRead({
        actor,
        binding,
        installed,
        payload: { ...payload, subject: payload.subject },
      });
    }
    if (Schema.is(GatewayPrivacyDispatchSubjectSchema)(payload.subject)) {
      return yield* issueFinitePrivacyDispatch({
        actor,
        binding,
        installed,
        now,
        payload: { ...payload, subject: payload.subject },
      });
    }
    if (Schema.is(RegisteredSubjectSchema)(payload.subject)) {
      return yield* issueRegisteredGatewayAssertion({
        binding,
        currentDate,
        installed,
        now,
        payload: { ...payload, subject: payload.subject },
      });
    }
    const subject: AdmittedSubject = yield* Match.value(payload.subject).pipe(
      Match.tag('Assertion', (assertion) =>
        admitAssertionSubject({
          assertion: assertion.sourceAssertion,
          binding,
          currentDate,
          now,
          requestedCompositionRevision: payload.compositionRevision,
        }),
      ),
      Match.tag('Originator', (originator) =>
        // A tenant-only context names no company, so it never accepts one either.
        payload.legalEntityScope === 'tenant' && originator.legalEntityId !== undefined
          ? Effect.fail(delegationForbidden())
          : admitOriginatorSubject({
              actionInvocationId: originator.actionInvocationId,
              legalEntityId: originator.legalEntityId,
              now,
              originatorActions: sourceContract?.manifest.originatorActions ?? [],
              tenantId: originator.tenantId,
            }),
      ),
      Match.exhaustive,
    );

    if (installed.composition.revision !== payload.compositionRevision) {
      return yield* new GatewayDelegationError({ code: 'reload_required' });
    }
    const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
    if (
      sourceContract?.deployment.buildMarker !== binding.sourceBuildMarker ||
      binding.compositionRevision !== installed.composition.revision ||
      destination === undefined
    ) {
      return yield* delegationForbidden();
    }
    // `tenant` names no Legal Entity, so the context and its scope are issued for the tenant alone.
    const tenantOnly = payload.legalEntityScope === 'tenant';
    const principal = tenantOnly ? tenantScopedPrincipal(subject.principal) : subject.principal;
    const scopePrincipal = tenantOnly ? tenantScopedPrincipal(subject.scopePrincipal) : subject.scopePrincipal;
    if (
      // A delegated context names two parties, and the subject's authentication namespace must be explicit.
      principal.principalId === caller.principalId ||
      principal.authenticationNamespaceId === undefined
    ) {
      return yield* delegationForbidden();
    }

    const resolver = yield* OperationalScopeResolver;
    yield* resolver
      .resolve({
        audience: binding.sourceAppId,
        correlationId: input.requestCorrelation,
        legalEntityScope: principal.legalEntityId === undefined ? 'forbidden' : 'required',
        principal: moduleCallSubject(scopePrincipal, payload.compositionRevision, actor),
      })
      .pipe(Effect.mapError(scopeFailure));

    const moduleStates = yield* TenantModuleStateService;
    const moduleKeys = [sourceContract.manifest.module.id, destination.manifest.module.id];
    const states = yield* moduleStates
      .getTenantModuleStates(principal.tenantId, moduleKeys)
      .pipe(Effect.mapError(delegationUnavailable));
    const readableStates = new Set(tenantStatesAllowingAccess('read'));
    if (moduleKeys.some((key) => !states.some((state) => state.moduleKey === key && readableStates.has(state.state)))) {
      return yield* delegationForbidden();
    }

    const ledger = yield* GatewayDelegationExchangeLedger;
    const requestFingerprint = yield* exchangeFingerprint({
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal,
      requestCorrelation: input.requestCorrelation,
    }).pipe(Effect.mapError(delegationUnavailable));
    yield* ledger
      .reserve({
        exchangeId: payload.exchangeId,
        expiresAtEpochSeconds: subject.expiresAtEpochSeconds,
        requestFingerprint,
        sourceJti: subject.sourceKey,
      })
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'GatewayDelegationExchangeReplay')
            ? delegationForbidden(cause)
            : delegationUnavailable(cause),
        ),
      );

    const issuer = yield* GatewayIssuer;
    return yield* issuer.issue({
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal,
      sourceValidity: subject.sourceValidity,
    });
  },
);
