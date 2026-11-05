import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { WorkloadKey } from '../../authorization/access-declaration.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { PrincipalId, TenantId } from '../ids.ts';
import type { AccessIntentError } from '../intent/errors.ts';

/*
 * The write side of the registered workload identities (O73). Core is its only writer: install and
 * bootstrap register a tenant's system workloads, the stage and local bootstrap register the
 * operator-declared ones, and later a Core admin Action will manage them. Every call names the
 * trusted request scope it runs in (O66), so a command that names another tenant is refused before
 * SQL sees it. The drizzle implementation is `binding-store.ts`.
 */

export const WORKLOAD_BINDING_STATUSES = ['active', 'revoked'] as const;
export const WorkloadBindingStatusSchema = Schema.Literals(WORKLOAD_BINDING_STATUSES);
export type WorkloadBindingStatus = typeof WorkloadBindingStatusSchema.Type;

export const AccessWorkloadBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AccessWorkloadBindingId'),
);
export type AccessWorkloadBindingId = typeof AccessWorkloadBindingIdSchema.Type;

/**
 * One registered workload identity: the principal, the workload key it may run, and the binding's
 * incarnation. A revoked binding stays as history and is never reopened, so a re-bind is a fresh row
 * with a fresh incarnation (D27).
 */
export interface AccessWorkloadBinding {
  readonly bindingId: AccessWorkloadBindingId;
  readonly createdAt: Date;
  readonly incarnation: AccessWorkloadBindingId;
  readonly principalId: PrincipalId;
  readonly revokedAt?: Date;
  readonly status: WorkloadBindingStatus;
  readonly tenantId: TenantId;
  readonly workloadKey: WorkloadKey;
}

/** One binding a writer registers: the principal, the workload key and the binding's identity. */
export interface RegisterWorkloadBindingInput {
  readonly bindingId: AccessWorkloadBindingId;
  readonly createdAt: Date;
  readonly incarnation: AccessWorkloadBindingId;
  readonly principalId: PrincipalId;
  readonly tenantId: TenantId;
  readonly workloadKey: WorkloadKey;
}

export interface RegisterWorkloadBindingsInput {
  /** One bootstrap registers every workload of a tenant in one statement, never one by one. */
  readonly bindings: readonly RegisterWorkloadBindingInput[];
}

export interface RevokeWorkloadBindingInput {
  readonly bindingId: AccessWorkloadBindingId;
  readonly revokedAt: Date;
}

/** The registry's write side, bound through `AccessWorkloadBindingStore`. */
export interface AccessWorkloadBindingStoreService {
  /** Registers active bindings; a binding that already exists is left exactly as it is. */
  readonly registerBindings: (
    scope: OperationalScope,
    input: RegisterWorkloadBindingsInput,
  ) => Effect.Effect<void, AccessIntentError>;
  /** Ends one binding. A revoked binding is never reopened: a re-bind is a new registration. */
  readonly revokeBinding: (
    scope: OperationalScope,
    input: RevokeWorkloadBindingInput,
  ) => Effect.Effect<void, AccessIntentError>;
}

/** The runtime binds the registry writer through this service tag. */
export class AccessWorkloadBindingStore extends Context.Service<
  AccessWorkloadBindingStore,
  AccessWorkloadBindingStoreService
>()('@app/core-runtime/access/workloads/store/AccessWorkloadBindingStore') {}
