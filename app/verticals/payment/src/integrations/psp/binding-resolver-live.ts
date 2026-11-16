import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Layer, Option, Schema } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type {
  GatewayCredentialSecretRef,
  GatewayHttpsUrl,
  GatewayMerchantIdentity,
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../../shared/domain/psp-configuration.ts';
import type { GatewayCredentialStatus, GatewayEnvironment } from '../../../shared/domain/psp-vocabulary.ts';
import { pspResolveExecutionTarget, pspResolveNotificationBinding } from '../../persistence/psp-worker-routines.ts';
import type { PspExecutionTarget } from '../../persistence/psp-worker-routines.ts';
import { GatewayBindingResolver } from './binding-resolver.ts';
import type { GatewayExecutionTargetQuery, GatewayNotificationTargetQuery } from './binding-resolver.ts';
import { GatewayProviderUnavailable } from './psp-errors.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';
import { GatewayExecutionTargetSchema } from './psp-request.ts';
import type { GatewayExecutionTarget } from './psp-request.ts';

/**
 * Worker-side `GatewayBindingResolver` (#1155) over the scoped routines `psp_resolve_execution_target` and
 * `psp_resolve_notification_binding`, invoked through the Core-verified worker scope. The routines return the
 * exact binding named by the ref in that environment, Current or retired, with its current credential
 * revision; another environment, another Tenant or another Selling Legal Entity never matches, and no Current
 * binding is ever substituted. Unknown refs, environment mismatches, a binding of another family, a non-ACTIVE
 * credential and unreadable routines are all UNAVAILABLE for the query's family.
 */

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

/** The binding facts an execution target is built from; the shape both resolvers read. */
export interface ResolvedBindingFacts {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly credentialRevision: number;
  readonly credentialSecretRef: GatewayCredentialSecretRef;
  readonly credentialStatus: GatewayCredentialStatus;
  readonly environment: GatewayEnvironment;
  readonly merchantIdentity: GatewayMerchantIdentity;
  readonly notificationUrl: GatewayHttpsUrl;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly providerFamily: PaymentGatewayProviderFamily;
  readonly returnUrl: Option.Option<GatewayHttpsUrl>;
}

export const gatewayBindingUnavailable = (family: PaymentGatewayProviderFamily, reason: string) =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });

const decodeExecutionTarget = Schema.decodeUnknownEffect(GatewayExecutionTargetSchema);

/**
 * The execution target of one resolved binding in the verified scope. Only an ACTIVE credential revision can
 * authenticate; anything else is UNAVAILABLE for this binding, never a fallback to another one.
 */
export const executionTargetOf = (
  facts: ResolvedBindingFacts,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
): Effect.Effect<GatewayExecutionTarget, GatewayProviderUnavailableError> =>
  facts.credentialStatus === 'ACTIVE'
    ? decodeExecutionTarget({
        binding: {
          _tag: 'GATEWAY_ACCOUNT',
          environment: facts.environment,
          providerAccountRef: facts.providerAccountRef,
          providerFamily: facts.providerFamily,
        },
        bindingId: facts.bindingId,
        credentialRevision: facts.credentialRevision,
        credentialSecretRef: facts.credentialSecretRef,
        legalEntityId: scope.legalEntityId,
        merchantIdentity: facts.merchantIdentity,
        notificationUrl: facts.notificationUrl,
        returnUrl: facts.returnUrl,
        tenantId: scope.tenantId,
      }).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.fail(
            gatewayBindingUnavailable(facts.providerFamily, 'The resolved binding does not form an execution target'),
          ),
        ),
      )
    : Effect.fail(gatewayBindingUnavailable(facts.providerFamily, 'credential_not_active'));

const factsOf = (target: PspExecutionTarget): ResolvedBindingFacts => ({
  bindingId: target.bindingId,
  credentialRevision: target.credentialRevision,
  credentialSecretRef: target.credentialSecretRef,
  credentialStatus: target.credentialStatus,
  environment: target.environment,
  merchantIdentity: target.merchantIdentity,
  notificationUrl: target.notificationUrl,
  providerAccountRef: target.providerAccountRef,
  providerFamily: target.providerFamily,
  returnUrl: Option.fromUndefinedOr(target.returnUrl),
});

const otherEnvironment = (environment: GatewayEnvironment): GatewayEnvironment =>
  environment === 'LIVE' ? 'SANDBOX' : 'LIVE';

interface ResolverQuery {
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly providerFamily: PaymentGatewayProviderFamily;
}

const routineFailed = (query: ResolverQuery) => () =>
  Effect.fail(gatewayBindingUnavailable(query.providerFamily, 'resolver_routine_failed'));

/**
 * A ref that does not resolve in the requested environment: `environment_mismatch` when the same ref names a
 * binding in the other environment (never used as a target), otherwise `binding_unknown`.
 */
const unresolved = Effect.fn('GatewayBindingResolver.unresolved')(function* unresolved(
  invoker: ScopedRoutineInvoker,
  query: ResolverQuery,
) {
  const elsewhere = yield* pspResolveNotificationBinding(invoker, {
    environment: otherEnvironment(query.environment),
    providerAccountRef: query.providerAccountRef,
  }).pipe(Effect.catchTag('ScopedRoutineInvocationError', routineFailed(query)));
  return yield* gatewayBindingUnavailable(
    query.providerFamily,
    Option.isSome(elsewhere) ? 'environment_mismatch' : 'binding_unknown',
  );
});

const resolveWith = (
  invoker: ScopedRoutineInvoker,
  query: ResolverQuery,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
  resolved: Option.Option<PspExecutionTarget>,
): Effect.Effect<GatewayExecutionTarget, GatewayProviderUnavailableError> =>
  Option.match(resolved, {
    onNone: () => unresolved(invoker, query),
    onSome: (target) =>
      target.providerFamily === query.providerFamily
        ? executionTargetOf(factsOf(target), scope)
        : Effect.fail(gatewayBindingUnavailable(query.providerFamily, 'binding_mismatch')),
  });

const resolveExecutionTarget = Effect.fn('GatewayBindingResolver.resolveExecutionTarget')(
  function* resolveExecutionTarget(query: GatewayExecutionTargetQuery) {
    const invoker = query.scope.routineInvoker;
    const resolved = yield* pspResolveExecutionTarget(invoker, {
      customerConfigurationId: query.customerConfigurationId,
      environment: query.environment,
      providerAccountRef: query.providerAccountRef,
    }).pipe(Effect.catchTag('ScopedRoutineInvocationError', routineFailed(query)));
    return yield* resolveWith(invoker, query, query.scope, resolved);
  },
);

const resolveForNotification = Effect.fn('GatewayBindingResolver.resolveForNotification')(
  function* resolveForNotification(query: GatewayNotificationTargetQuery) {
    const invoker = query.scope.routineInvoker;
    const resolved = yield* pspResolveNotificationBinding(invoker, {
      environment: query.environment,
      providerAccountRef: query.providerAccountRef,
    }).pipe(Effect.catchTag('ScopedRoutineInvocationError', routineFailed(query)));
    return yield* resolveWith(invoker, query, query.scope, resolved);
  },
);

export const GatewayBindingResolverLive = Layer.succeed(GatewayBindingResolver, {
  resolveExecutionTarget,
  resolveForNotification,
});
