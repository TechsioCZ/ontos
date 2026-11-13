import { admitAssertionSubject } from './gateway-assertion-evidence.ts';
import { admitRegisteredGatewayRecovery } from './gateway-recovery-evidence.ts';
import {
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
  RegisteredGatewayOrganizationGovernanceReadSchema,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { admitRegisteredAssertionWorkload } from './gateway-registered-assertion.ts';
import { admitRegisteredGatewayWorkload } from './gateway-workload-evidence.ts';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { PrincipalResolver, TenantModuleStateService, tenantStatesAllowingAccess } from '@app/core-runtime';
import type { TenantModuleState } from '@app/core-runtime';
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
  organizationGovernanceReadOperationContract,
  privacyDispatchOperationContract,
} from '@app/shared-contracts';
import { DateTime, Effect, Match, Predicate, Ref, Schema } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import type { InstalledModuleCatalogError, ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import {
  GatewayIssuer,
  gatewayIssuerFailureClass,
  gatewayIssuerRefusalReason,
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
import {
  GatewayDelegationPolicyUnavailable,
  gatewayPublishedOperationAccess,
  loadGatewayModuleBindings,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { GatewayOriginatorEvidence } from './gateway-originator-evidence.ts';
import {
  GatewayDelegationError,
  delegationForbidden,
  delegationUnavailable,
  logDelegationRefusal,
  refusalTenant,
} from './gateway-delegation-errors.ts';
import type { RefusalContext } from './gateway-delegation-errors.ts';

export type GatewayDelegationRequestPayload = Schema.Schema.Type<typeof GatewayDelegatedContextRequestSchema>;

/** One delegated issuance request: the payload, the request's correlation and the verified key's provider id. */
interface GatewayDelegationIssueInput {
  readonly payload: GatewayDelegationRequestPayload;
  readonly requestCorrelation: string;
  readonly verifiedProviderKeyId: string;
}

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
 * Lasting, deliberate states of an installed module that its callers read as "not installed": switched off for the
 * tenant (`inactive`) or retired with it (`archived`). `suspended` and `quarantined` are temporary: an outage.
 */
const NOT_INSTALLED_STATES: ReadonlySet<TenantModuleState> = new Set<TenantModuleState>(['archived', 'inactive']);

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

/** The bindings could not be derived: the enrolment or the installed release could not be read. */
export const bindingsUnavailable = (cause: GatewayDelegationPolicyUnavailable | InstalledModuleCatalogError) =>
  Schema.is(GatewayDelegationPolicyUnavailable)(cause)
    ? delegationUnavailable('module_enrolment_unavailable')(cause)
    : delegationUnavailable('installed_release_unavailable')(cause);

const scopeFailure = (cause: unknown) =>
  Predicate.isTagged(cause, 'OperationContextUnavailable')
    ? delegationUnavailable('scope_unavailable')(cause)
    : delegationForbidden('scope_refused')(cause);

/** The one-use exchange is reserved for this exact request; a second use of the exchange is a replay. */
const reserveExchange = (reservation: {
  readonly exchangeId: string;
  readonly expiresAtEpochSeconds: number;
  readonly requestFingerprint: string;
  readonly sourceJti: string;
}) =>
  GatewayDelegationExchangeLedger.pipe(
    Effect.flatMap((ledger) => ledger.reserve(reservation)),
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, 'GatewayDelegationExchangeReplay')
        ? delegationForbidden('exchange_replayed')(cause)
        : delegationUnavailable('exchange_ledger_unavailable')(cause),
    ),
  );

/** The fingerprint the exchange ledger binds: the canonical JSON of what was admitted, hashed. */
const fingerprintOf = <Fields extends Schema.Struct.Fields>(fields: Fields, value: Schema.Struct<Fields>['Type']) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Struct(fields)))(value).pipe(
    Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json)))),
    Effect.mapError(delegationUnavailable('exchange_ledger_unavailable')),
  );

type ModuleAccess = Parameters<typeof tenantStatesAllowingAccess>[0];

/** The tenant's current states of the source and destination modules. */
const loadModuleStates = (tenantId: string, moduleKeys: readonly string[]) =>
  TenantModuleStateService.pipe(
    Effect.flatMap((moduleStates) => moduleStates.getTenantModuleStates(tenantId, [...moduleKeys])),
    Effect.mapError(delegationUnavailable('module_states_unavailable')),
  );

/** The source and destination modules must both hold a state that admits the access each side performs. */
const requireModuleStates = (
  states: readonly { readonly moduleKey: string; readonly state: string }[],
  sides: readonly { readonly access: ModuleAccess; readonly moduleKey: string }[],
) =>
  sides.every((side) => {
    const allowed: ReadonlySet<string> = new Set(tenantStatesAllowingAccess(side.access));
    return states.some((state) => state.moduleKey === side.moduleKey && allowed.has(state.state));
  })
    ? Effect.void
    : Effect.fail(delegationForbidden('module_not_active')());

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
    return yield* delegationForbidden('originator_not_admitted')();
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

/** The steps after the subject is admitted: scope, module states, replay ledger and issuance. */
const issueForSubject = Effect.fn('GatewayDelegation.issueForSubject')(function* issueForSubject(
  input: {
    readonly payload: GatewayDelegationRequestPayload;
    readonly requestCorrelation: string;
  },
  admitted: {
    readonly actor: GatewayActorClaim;
    readonly caller: { readonly principalId: string };
    readonly destination: { readonly manifest: { readonly module: { readonly id: string } } };
    readonly sourceContract: { readonly manifest: { readonly module: { readonly id: string } } };
    readonly subject: AdmittedSubject;
  },
) {
  const { payload } = input;
  const { actor, caller, destination, sourceContract, subject } = admitted;
  // `tenant` names no Legal Entity, so the context and its scope are issued for the tenant alone.
  const tenantOnly = payload.legalEntityScope === 'tenant';
  const principal = tenantOnly ? tenantScopedPrincipal(subject.principal) : subject.principal;
  const scopePrincipal = tenantOnly ? tenantScopedPrincipal(subject.scopePrincipal) : subject.scopePrincipal;
  if (
    // A delegated context names two parties, and the subject's authentication namespace must be explicit.
    principal.principalId === caller.principalId ||
    principal.authenticationNamespaceId === undefined
  ) {
    return yield* delegationForbidden('subject_not_delegable')();
  }

  const resolver = yield* OperationalScopeResolver;
  yield* resolver
    .resolve({
      audience: actor.appId,
      correlationId: input.requestCorrelation,
      legalEntityScope: principal.legalEntityId === undefined ? 'forbidden' : 'required',
      principal: moduleCallSubject(scopePrincipal, payload.compositionRevision, actor),
    })
    .pipe(Effect.mapError(scopeFailure));

  const moduleKeys = [sourceContract.manifest.module.id, destination.manifest.module.id];
  const states = yield* loadModuleStates(principal.tenantId, moduleKeys);
  yield* requireModuleStates(states, [{ access: 'read', moduleKey: sourceContract.manifest.module.id }]);
  // A calling module may read the refusal as "not installed" when the module it calls is absent for the tenant, or in a
  // lasting, deliberate state: switched off (`inactive`) or retired with its tenant (`archived`). One that is only
  // stopped for now (`suspended`, `quarantined`) is a plain refusal: an outage to the caller, never an answer.
  const readableStates: ReadonlySet<string> = new Set(tenantStatesAllowingAccess('read'));
  const destinationState = states.find((state) => state.moduleKey === destination.manifest.module.id)?.state;
  if (destinationState === undefined || !readableStates.has(destinationState)) {
    return yield* destinationState === undefined || NOT_INSTALLED_STATES.has(destinationState)
      ? new GatewayDelegationError({ code: 'module_not_installed', reason: 'audience_module_not_installed' })
      : delegationForbidden('audience_module_not_active')();
  }

  const requestFingerprint = yield* fingerprintOf(
    {
      actor: GatewayActorClaimSchema,
      audience: Schema.String,
      compositionRevision: Schema.String,
      principal: GatewayTrustedPrincipalContextSchema,
      requestCorrelation: Schema.String,
    },
    {
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal,
      requestCorrelation: input.requestCorrelation,
    },
  );
  yield* reserveExchange({
    exchangeId: payload.exchangeId,
    expiresAtEpochSeconds: subject.expiresAtEpochSeconds,
    requestFingerprint,
    sourceJti: subject.sourceKey,
  });

  const issuer = yield* GatewayIssuer;
  return yield* issuer.issue({
    actor,
    audience: payload.audience,
    compositionRevision: payload.compositionRevision,
    principal,
    sourceValidity: subject.sourceValidity,
  });
});

/**
 * A registered workload subject: a durable worker delivery, an admission invocation, a recovery of either, or a
 * verified workload assertion. Its system principal, workload and lifetime come from the Shell's own evidence.
 */
const issueRegisteredGatewayAssertion = Effect.fn('GatewayDelegation.issueRegistered')(function* issueRegistered(
  input: {
    readonly binding: GatewayModuleBinding;
    readonly currentDate: Date;
    readonly installed: ShellInstalledCatalog;
    readonly now: number;
    readonly payload: RegisteredPayload;
  },
  learned: Ref.Ref<RefusalContext>,
) {
  const { binding, currentDate, installed, now, payload } = input;
  const sourceContract = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
  if (installed.composition.revision !== payload.compositionRevision) {
    return yield* delegationForbidden('release_changed')();
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
            ? Effect.fail(delegationForbidden('subject_assertion_kind_mismatch')())
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
  yield* Ref.update(learned, (context) => ({ ...context, ...refusalTenant(admitted.principal.tenantId) }));
  if (payload.legalEntityScope === 'tenant' && admitted.workload.legalEntityId !== undefined) {
    return yield* delegationForbidden('legal_entity_scope_mismatch')();
  }
  const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
  if (sourceContract === undefined) {
    return yield* delegationForbidden('caller_build_not_installed')();
  }
  if (destination === undefined) {
    return yield* delegationForbidden('audience_not_installed')();
  }
  const states = yield* loadModuleStates(admitted.principal.tenantId, [
    sourceContract.manifest.module.id,
    destination.manifest.module.id,
  ]);
  const destinationAccess = gatewayPublishedOperationAccess(
    destination,
    admitted.workload.entrypointKey,
    admitted.workload.schemaVersion,
  );
  if (destinationAccess === undefined) {
    return yield* delegationForbidden('registered_operation_refused')();
  }
  yield* requireModuleStates(states, [
    { access: admitted.sourceAccess, moduleKey: sourceContract.manifest.module.id },
    { access: destinationAccess, moduleKey: destination.manifest.module.id },
  ]);
  const requestFingerprint = yield* fingerprintOf(
    {
      audience: Schema.String,
      compositionRevision: Schema.String,
      principal: GatewayTrustedPrincipalContextSchema,
      workload: RegisteredGatewayWorkloadSchema,
    },
    {
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
      principal: admitted.principal,
      workload: admitted.workload,
    },
  );
  yield* reserveExchange({
    exchangeId: payload.exchangeId,
    expiresAtEpochSeconds: now + GATEWAY_ASSERTION_TTL_SECONDS,
    requestFingerprint,
    sourceJti: admitted.sourceKey,
  });
  if (admitted.organizationProcessingWitness !== null) {
    return yield* issueOrganizationProcessingReadGatewayContextAssertion(admitted.organizationProcessingWitness);
  }
  return yield* (yield* GatewayIssuer).issue({
    audience: payload.audience,
    compositionRevision: payload.compositionRevision,
    principal: admitted.principal,
    workload: admitted.workload,
  });
});

/** The fixed finite target a Privacy dispatch or governance Read names, in the release the calling module runs. */
const requireFiniteTarget = Effect.fn('GatewayDelegation.requireFiniteTarget')(function* requireFiniteTarget(input: {
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
  readonly payload: GatewayDelegationRequestPayload;
  readonly targetAppId: string;
  readonly targetModuleId: string;
  readonly targetSource?: string;
}) {
  const { binding, installed, payload } = input;
  const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
  const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
  if (installed.composition.revision !== payload.compositionRevision) {
    return yield* delegationForbidden('release_changed')();
  }
  if (
    source === undefined ||
    binding.compositionRevision !== installed.composition.revision ||
    source.deployment.buildMarker !== binding.sourceBuildMarker
  ) {
    return yield* delegationForbidden('caller_build_not_installed')();
  }
  if (
    payload.legalEntityScope !== 'subject' ||
    (input.targetSource !== undefined && binding.sourceAppId !== input.targetSource) ||
    payload.audience !== input.targetAppId ||
    destination?.manifest.module.id !== input.targetModuleId
  ) {
    return yield* delegationForbidden('finite_target_mismatch')();
  }
  return { destination, source };
});

/** The fixed Privacy→Symmy dispatch graph, admitted only from the Shell's durable native evidence. */
const issueFinitePrivacyDispatch = Effect.fn('GatewayDelegation.issueFinitePrivacyDispatch')(
  function* issueFinitePrivacyDispatch(
    input: {
      readonly actor: GatewayActorClaim;
      readonly binding: GatewayModuleBinding;
      readonly installed: ShellInstalledCatalog;
      readonly now: number;
      readonly payload: GatewayDelegationRequestPayload & {
        readonly subject: typeof GatewayPrivacyDispatchSubjectSchema.Type;
      };
    },
    learned: Ref.Ref<RefusalContext>,
  ) {
    const { actor, binding, installed, now, payload } = input;
    const approvedTarget = privacyDispatchOperationContract(payload.subject.operation._tag);
    const { destination, source } = yield* requireFiniteTarget({
      binding,
      installed,
      payload,
      targetAppId: approvedTarget.appId,
      targetModuleId: approvedTarget.moduleId,
    });
    const witness = yield* admitPrivacyDispatch({
      audience: payload.audience,
      binding,
      installed,
      subject: payload.subject,
    });
    const admitted = readAdmittedPrivacyDispatch(witness);
    if (admitted === undefined) {
      return yield* delegationForbidden('privacy_dispatch_not_admitted')();
    }
    yield* Ref.update(learned, (context) => ({ ...context, ...refusalTenant(admitted.principal.tenantId) }));
    const target = privacyDispatchOperationContract(
      admitted.privacyDispatch.operation,
      admitted.privacyDispatch.target,
    );
    if (gatewayPublishedOperationAccess(destination, target.entrypointKey, target.schemaVersion) !== target.access) {
      return yield* delegationForbidden('finite_target_mismatch')();
    }
    const states = yield* loadModuleStates(admitted.principal.tenantId, [
      source.manifest.module.id,
      destination.manifest.module.id,
    ]);
    yield* requireModuleStates(states, [
      { access: admitted.sourceAccess, moduleKey: source.manifest.module.id },
      { access: target.access, moduleKey: destination.manifest.module.id },
    ]);
    const requestFingerprint = yield* fingerprintOf(
      {
        actor: GatewayActorClaimSchema,
        audience: Schema.String,
        compositionRevision: Schema.String,
        principal: GatewayTrustedPrincipalContextSchema,
        privacyDispatch: RegisteredGatewayPrivacyDispatchSchema,
      },
      {
        actor,
        audience: payload.audience,
        compositionRevision: payload.compositionRevision,
        principal: admitted.principal,
        privacyDispatch: admitted.privacyDispatch,
      },
    );
    yield* reserveExchange({
      exchangeId: payload.exchangeId,
      expiresAtEpochSeconds: now + GATEWAY_ASSERTION_TTL_SECONDS,
      requestFingerprint,
      sourceJti: admitted.sourceKey,
    });
    return yield* issuePrivacyDispatchGatewayContextAssertion(witness, {
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
    });
  },
);

/** One fixed Organization governance Read for Privacy, bounded by the original human source assertion. */
const issueFiniteOrganizationGovernanceRead = Effect.fn('GatewayDelegation.issueOrganizationGovernanceRead')(
  function* issueFiniteOrganizationGovernanceRead(
    input: {
      readonly actor: GatewayActorClaim;
      readonly binding: GatewayModuleBinding;
      readonly installed: ShellInstalledCatalog;
      readonly payload: GatewayDelegationRequestPayload & {
        readonly subject: typeof GatewayOrganizationGovernanceReadSubjectSchema.Type;
      };
    },
    learned: Ref.Ref<RefusalContext>,
  ) {
    const { actor, binding, installed, payload } = input;
    const target = organizationGovernanceReadOperationContract();
    const { destination, source } = yield* requireFiniteTarget({
      binding,
      installed,
      payload,
      targetAppId: target.appId,
      targetModuleId: target.moduleId,
      targetSource: 'privacy',
    });
    const witness = yield* admitOrganizationGovernanceRead({
      audience: payload.audience,
      binding,
      installed,
      subject: payload.subject,
    });
    const admitted = readAdmittedOrganizationGovernanceRead(witness);
    if (admitted === undefined) {
      return yield* delegationForbidden('organization_governance_not_admitted')();
    }
    yield* Ref.update(learned, (context) => ({ ...context, ...refusalTenant(admitted.principal.tenantId) }));
    const states = yield* loadModuleStates(admitted.principal.tenantId, [
      source.manifest.module.id,
      destination.manifest.module.id,
    ]);
    yield* requireModuleStates(states, [
      { access: 'read', moduleKey: source.manifest.module.id },
      { access: 'read', moduleKey: destination.manifest.module.id },
    ]);
    const requestFingerprint = yield* fingerprintOf(
      {
        actor: GatewayActorClaimSchema,
        audience: Schema.String,
        compositionRevision: Schema.String,
        organizationGovernanceRead: RegisteredGatewayOrganizationGovernanceReadSchema,
        principal: GatewayTrustedPrincipalContextSchema,
      },
      {
        actor,
        audience: payload.audience,
        compositionRevision: payload.compositionRevision,
        organizationGovernanceRead: admitted.organizationGovernanceRead,
        principal: admitted.principal,
      },
    );
    yield* reserveExchange({
      exchangeId: payload.exchangeId,
      expiresAtEpochSeconds: admitted.sourceValidity.expiresAt,
      requestFingerprint,
      sourceJti: admitted.sourceKey,
    });
    return yield* issueOrganizationGovernanceReadGatewayContextAssertion(witness, {
      actor,
      audience: payload.audience,
      compositionRevision: payload.compositionRevision,
    });
  },
);

/** The steps after the calling module's binding is known; every refusal they make names that module. */
const issueForBinding = Effect.fn('GatewayDelegation.issueForBinding')(function* issueForBinding(
  input: GatewayDelegationIssueInput,
  binding: GatewayModuleBinding,
  learned: Ref.Ref<RefusalContext>,
) {
  const { payload } = input;
  const principalResolver = yield* PrincipalResolver;
  const caller = yield* principalResolver
    .resolveBetterAuthApiKey(input.verifiedProviderKeyId)
    .pipe(Effect.mapError(delegationForbidden('caller_principal_unresolved')));
  if (caller.principalKind !== 'service') {
    return yield* delegationForbidden('caller_not_service')();
  }
  const actor = yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
    appId: binding.sourceAppId,
    buildMarker: binding.sourceBuildMarker,
    principalId: caller.principalId,
  }).pipe(Effect.mapError(delegationUnavailable('caller_principal_unavailable')));

  const currentDate = DateTime.toDateUtc(yield* DateTime.now);
  const now = Math.floor(currentDate.getTime() / 1000);
  const catalog = yield* ShellInstalledModuleCatalog;
  const installed = yield* catalog.load.pipe(Effect.mapError(delegationUnavailable('installed_release_unavailable')));
  const sourceContract = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
  if (Schema.is(GatewayOrganizationGovernanceReadSubjectSchema)(payload.subject)) {
    return yield* issueFiniteOrganizationGovernanceRead(
      { actor, binding, installed, payload: { ...payload, subject: payload.subject } },
      learned,
    );
  }
  if (Schema.is(GatewayPrivacyDispatchSubjectSchema)(payload.subject)) {
    return yield* issueFinitePrivacyDispatch(
      { actor, binding, installed, now, payload: { ...payload, subject: payload.subject } },
      learned,
    );
  }
  if (Schema.is(RegisteredSubjectSchema)(payload.subject)) {
    return yield* issueRegisteredGatewayAssertion(
      { binding, currentDate, installed, now, payload: { ...payload, subject: payload.subject } },
      learned,
    );
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
        ? Effect.fail(delegationForbidden('originator_not_admitted')())
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
  yield* Ref.update(learned, (context) => ({ ...context, ...refusalTenant(subject.principal.tenantId) }));

  if (installed.composition.revision !== payload.compositionRevision) {
    return yield* new GatewayDelegationError({ code: 'reload_required', reason: 'release_changed' });
  }
  const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
  if (
    sourceContract?.deployment.buildMarker !== binding.sourceBuildMarker ||
    binding.compositionRevision !== installed.composition.revision
  ) {
    return yield* delegationForbidden('caller_build_not_installed')();
  }
  if (destination === undefined) {
    return yield* delegationForbidden('audience_not_installed')();
  }
  return yield* issueForSubject(input, { actor, caller, destination, sourceContract, subject });
});

/**
 * The calling module is the actor: its module credential's bound service principal goes in `act`, and only this
 * binding can set the app and build of `act`. The subject is the requester of a live request (`Assertion`), of the
 * invocation asynchronous work runs for (`Originator`), a registered workload, or a finite Privacy dispatch or
 * Organization governance Read.
 */
const issueWithin = Effect.fn('GatewayDelegation.issueWithin')(function* issueWithin(
  input: GatewayDelegationIssueInput,
  learned: Ref.Ref<RefusalContext>,
) {
  const bindings = yield* loadGatewayModuleBindings.pipe(Effect.mapError(bindingsUnavailable));
  const binding = bindings.find((candidate) => candidate.providerKeyId === input.verifiedProviderKeyId);
  if (binding === undefined) {
    return yield* delegationForbidden('module_credential_unbound')();
  }
  yield* Ref.set(learned, { callerAppId: binding.sourceAppId });
  return yield* issueForBinding(input, binding, learned);
});

/**
 * Module-to-module capability issuance. Every refusal writes one warning with the step that refused it and what the
 * issuer knew by then: the calling module once its key bound one, the subject's tenant once the subject was admitted.
 */
export const issueDelegatedGatewayContextAssertion = Effect.fn('GatewayDelegation.issue')(
  function* issueDelegatedGatewayContext(input: GatewayDelegationIssueInput) {
    const learned = yield* Ref.make<RefusalContext>({});
    const { audience } = input.payload;
    return yield* issueWithin(input, learned).pipe(
      Effect.tapErrorTag('GatewayDelegationError', (refusal) =>
        Ref.get(learned).pipe(
          Effect.flatMap((context) =>
            logDelegationRefusal({ audience, context, reason: refusal.reason, status: refusal.code }),
          ),
        ),
      ),
      Effect.tapErrorTag('GatewayIssuerError', (failure) =>
        Ref.get(learned).pipe(
          Effect.flatMap((context) =>
            logDelegationRefusal({
              audience,
              context,
              failureCause: gatewayIssuerFailureClass(failure),
              reason: gatewayIssuerRefusalReason(failure),
              status: failure.code,
            }),
          ),
        ),
      ),
    );
  },
);
