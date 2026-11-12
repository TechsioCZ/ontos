import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import {
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { PrincipalResolver, TenantModuleStateService, tenantStatesAllowingAccess } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import type { GatewayActorClaim, GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GatewayActorClaimSchema,
  GatewayTrustedPrincipalContextSchema,
  decodeGatewayContextProtectedHeader,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { DateTime, Effect, Match, Predicate, Redacted, Ref, Schema } from 'effect';
import { jwtVerify } from 'jose';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import type { InstalledModuleCatalogError } from '../modules/installed-module-catalog.ts';
import { GatewayIssuer } from './gateway-issuer.ts';
import { GatewayDelegationExchangeLedger } from './gateway-delegation-exchanges.service.ts';
import { validateDelegationAuthentication } from './gateway-delegation-authentication.service.ts';
import { GatewayDelegationVerification } from './gateway-delegation-verification.ts';
import {
  GatewayDelegationPolicyUnavailable,
  bindingAttestsSource,
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

/** The bindings could not be derived: the enrolment or the installed release could not be read. */
export const bindingsUnavailable = (cause: GatewayDelegationPolicyUnavailable | InstalledModuleCatalogError) =>
  Schema.is(GatewayDelegationPolicyUnavailable)(cause)
    ? delegationUnavailable('module_enrolment_unavailable')(cause)
    : delegationUnavailable('installed_release_unavailable')(cause);

const scopeFailure = (cause: unknown) =>
  Predicate.isTagged(cause, 'OperationContextUnavailable')
    ? delegationUnavailable('scope_unavailable')(cause)
    : delegationForbidden('scope_refused')(cause);

/** Verifies a live request's subject assertion exactly as its source module issued it, then rechecks its authentication. */
const admitAssertionSubject = Effect.fn('GatewayDelegation.admitAssertion')(function* admitAssertionSubject(input: {
  readonly assertion: Redacted.Redacted;
  readonly binding: GatewayModuleBinding;
  readonly currentDate: Date;
  readonly now: number;
  readonly requestedCompositionRevision: string;
}) {
  const verification = yield* GatewayDelegationVerification;
  const configuration = yield* verification.load;
  const verified = yield* Effect.tryPromise({
    catch: (cause) =>
      new GatewayDelegationError({ cause, code: 'authentication_required', reason: 'subject_assertion_unverified' }),
    try: jwtVerify.bind(undefined, Redacted.value(input.assertion), configuration.keys, {
      algorithms: ['EdDSA'],
      audience: input.binding.sourceAppId,
      clockTolerance: 0,
      currentDate: input.currentDate,
      issuer: configuration.issuer,
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.fail(delegationUnavailable('subject_verification_timeout')()),
    }),
  );
  yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(
    Effect.mapError(delegationForbidden('subject_assertion_malformed')),
  );
  const source = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(
    Effect.mapError(delegationForbidden('subject_assertion_malformed')),
  );
  if (
    source.iat > input.now ||
    source.exp <= input.now ||
    !bindingAttestsSource(input.binding, source, input.requestedCompositionRevision)
  ) {
    return yield* delegationForbidden('subject_assertion_not_attested')();
  }
  yield* validateDelegationAuthentication(source.principal, input.now);
  return {
    expiresAtEpochSeconds: source.exp,
    principal: source.principal,
    scopePrincipal: trustVerifiedGatewayPrincipalContext(source.principal, source.compositionRevision, {
      assertion: input.assertion,
      audience: input.binding.sourceAppId,
    }),
    sourceKey: source.jti,
    sourceValidity: { expiresAt: source.exp, issuedAt: source.iat },
  };
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

  const moduleStates = yield* TenantModuleStateService;
  const moduleKeys = [sourceContract.manifest.module.id, destination.manifest.module.id];
  const states = yield* moduleStates
    .getTenantModuleStates(principal.tenantId, moduleKeys)
    .pipe(Effect.mapError(delegationUnavailable('module_states_unavailable')));
  const readableStates = new Set(tenantStatesAllowingAccess('read'));
  const readable = (key: string) => states.some((state) => state.moduleKey === key && readableStates.has(state.state));
  if (!readable(sourceContract.manifest.module.id)) {
    return yield* delegationForbidden('module_not_active')();
  }
  // The one refusal a calling module may read as "not installed": the module it calls is not active for the tenant.
  if (!readable(destination.manifest.module.id)) {
    return yield* new GatewayDelegationError({ code: 'module_not_installed', reason: 'audience_module_not_active' });
  }

  const ledger = yield* GatewayDelegationExchangeLedger;
  const requestFingerprint = yield* exchangeFingerprint({
    actor,
    audience: payload.audience,
    compositionRevision: payload.compositionRevision,
    principal,
    requestCorrelation: input.requestCorrelation,
  }).pipe(Effect.mapError(delegationUnavailable('exchange_ledger_unavailable')));
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
          ? delegationForbidden('exchange_replayed')(cause)
          : delegationUnavailable('exchange_ledger_unavailable')(cause),
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
});

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
 * binding can set the app and build of `act`. The subject is the requester of a live request (`Assertion`) or of the
 * invocation asynchronous work runs for (`Originator`).
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
            logDelegationRefusal({ audience, context, reason: 'issuer_unavailable', status: failure.code }),
          ),
        ),
      ),
    );
  },
);
