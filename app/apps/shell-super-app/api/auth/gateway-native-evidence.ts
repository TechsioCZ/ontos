import type { ModuleEntrypointAccess } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import type {
  RegisteredGatewayRouteScope,
  RegisteredGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { Context } from 'effect';
import type { Effect, Schema } from 'effect';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { GatewayDelegationError } from './gateway-delegation-errors.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';
import type { PaymentRouteScopeError, PaymentRouteWorkload } from './gateway-payment-route-errors.ts';

type InstalledContract = ShellInstalledCatalog['contracts'][number];
export type RecoverySubject = Extract<
  GatewayDelegationRequestPayload['subject'],
  { readonly _tag: 'RegisteredRecovery' }
>;
export type RecoverySource = RecoverySubject['source'];
type AssertionSubject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredAssertion' }>;
export type WorkloadSubject = Extract<
  GatewayDelegationRequestPayload['subject'],
  { readonly _tag: 'RegisteredWorkload' | 'RegisteredAdmission' }
>;
export type OriginalAction = InstalledContract['manifest']['publicSurface']['actions'][number];
export interface NativeWorkloadInput {
  readonly binding: GatewayModuleBinding;
  readonly destination: InstalledContract;
  readonly rule: GatewayRegisteredWorkloadRule;
  readonly source: InstalledContract;
  readonly subject: WorkloadSubject;
}
export interface NativeAssertionInput {
  readonly binding: GatewayModuleBinding;
  readonly destination: InstalledContract;
  readonly rule: GatewayRegisteredWorkloadRule;
  readonly source: InstalledContract;
  readonly sourceAccess: ModuleEntrypointAccess;
  readonly sourcePrincipal: TrustedPrincipalContext;
  readonly subject: AssertionSubject;
  readonly workload: RegisteredGatewayWorkload;
}
export interface HistoricalAdmissionPolicy {
  readonly agrees: (value: Schema.Json) => Effect.Effect<boolean, GatewayDelegationError>;
  readonly moduleId: string;
  readonly topic: string;
}
export interface NativeRecoveryInput {
  readonly binding: GatewayModuleBinding;
  readonly destination: InstalledContract;
  readonly historical: HistoricalAdmissionPolicy;
  readonly originalAction: OriginalAction;
  readonly recoveryOf: NonNullable<GatewayRegisteredWorkloadRule['recoveryOf']>;
  readonly rule: GatewayRegisteredWorkloadRule;
  readonly source: InstalledContract;
  readonly subject: RecoverySubject;
}
export interface RouteSourceWorkloads {
  readonly preferred: string;
  readonly secondary?: string;
}
export interface DispatchSelection {
  readonly deliveryId?: string;
  readonly dispatchInvocationId?: string;
  readonly tenantId: string;
}
export interface DispatchContract {
  readonly actionKey: string;
  readonly consumerModuleId: string;
  readonly producerModuleId: string;
  readonly resourceType: string;
  readonly topic: string;
  readonly workerKey: string;
}
export interface WorkloadEvidence {
  readonly principal: TrustedPrincipalContext;
  readonly sourceKey: string;
  readonly workload: RegisteredGatewayWorkload;
}
export interface Receiver {
  readonly bindingIncarnation: string;
  readonly principalId: TrustedPrincipalContext['principalId'];
}
export interface NativeReadReceiver extends Receiver {
  readonly originalWorkloadBindingIncarnation: string;
  readonly originalWorkloadKey: string;
}
type Evidence<A> = Effect.Effect<A, GatewayDelegationError>;

export interface GatewayNativeEvidenceOperations {
  readonly admitAssertion: (
    input: NativeAssertionInput,
  ) => Evidence<WorkloadEvidence & { readonly sourceAccess: ModuleEntrypointAccess }>;
  readonly admitRecovery: (input: NativeRecoveryInput) => Evidence<WorkloadEvidence>;
  readonly admitWorkload: (input: NativeWorkloadInput) => Evidence<WorkloadEvidence>;
  readonly loadDispatchRow: <A, I>(
    input: DispatchSelection,
    contract: DispatchContract,
    schema: Schema.Codec<A, I>,
    admits: (row: A) => boolean,
  ) => Evidence<A>;
  readonly selectNativeReadReceiver: (
    principal: TrustedPrincipalContext,
    legalEntityId: string | undefined,
    workloadKey: string,
    source: RouteSourceWorkloads,
  ) => Evidence<NativeReadReceiver>;
  readonly selectOnwardNativeReadReceiver: (input: {
    readonly principal: TrustedPrincipalContext;
    readonly routeScope: RegisteredGatewayRouteScope;
    readonly workloadKey: string;
  }) => Evidence<Receiver>;
  readonly validateCurrentHuman: (principal: TrustedPrincipalContext) => Evidence<void>;
  readonly validatePaymentRoutePrincipal: (
    candidate: TrustedPrincipalContext,
    workload: PaymentRouteWorkload,
  ) => Effect.Effect<TrustedPrincipalContext, PaymentRouteScopeError>;
  readonly validateRoutePrincipal: (
    candidate: TrustedPrincipalContext,
    source: RouteSourceWorkloads,
  ) => Evidence<TrustedPrincipalContext>;
}

/** Fresh native admission facts, never caller-controlled queries or database handles. */
export class GatewayNativeEvidence extends Context.Service<GatewayNativeEvidence, GatewayNativeEvidenceOperations>()(
  '@app/shell-super-app/api/auth/gateway-native-evidence/GatewayNativeEvidence',
) {}
