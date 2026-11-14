import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityId, TenantId } from '../ids.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import type { AccessWorkloadBindingId } from './store.ts';

/*
 * The write side of the explicit company registrations (D6). A registered workload binding is
 * tenant-wide, so a standalone workload that holds no verified module actor selects no company at
 * all unless its owner declared one. Core is its only writer: the stage and local bootstraps
 * register the operator-declared company, and later a Core admin Action will manage it. Every call
 * names the trusted request scope it runs in (O66), so a command that names another tenant is
 * refused before SQL sees it. The drizzle implementation is `company-bindings.ts`.
 */

export const WORKLOAD_COMPANY_BINDING_STATUSES = ['active', 'revoked'] as const;
export const WorkloadCompanyBindingStatusSchema = Schema.Literals(WORKLOAD_COMPANY_BINDING_STATUSES);
export type WorkloadCompanyBindingStatus = typeof WorkloadCompanyBindingStatusSchema.Type;

export const AccessWorkloadCompanyBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AccessWorkloadCompanyBindingId'),
);
export type AccessWorkloadCompanyBindingId = typeof AccessWorkloadCompanyBindingIdSchema.Type;

/**
 * One company registration of one workload binding: the binding it is tied to, the company, and the
 * registration's own incarnation. A revoked registration stays as history and is never reopened, so
 * a re-registration is a fresh row with a fresh incarnation (D27).
 */
export interface AccessWorkloadCompanyBinding {
  readonly companyBindingId: AccessWorkloadCompanyBindingId;
  readonly createdAt: Date;
  readonly incarnation: AccessWorkloadCompanyBindingId;
  readonly legalEntityId: LegalEntityId;
  readonly revokedAt?: Date;
  readonly status: WorkloadCompanyBindingStatus;
  readonly tenantId: TenantId;
  readonly workloadBindingId: AccessWorkloadBindingId;
}

/** One registration a writer stores: the binding, the company and the registration's own identity. */
export interface RegisterWorkloadCompanyBindingInput {
  readonly companyBindingId: AccessWorkloadCompanyBindingId;
  readonly createdAt: Date;
  readonly incarnation: AccessWorkloadCompanyBindingId;
  readonly legalEntityId: LegalEntityId;
  readonly tenantId: TenantId;
  readonly workloadBindingId: AccessWorkloadBindingId;
}

export interface RegisterWorkloadCompanyBindingsInput {
  /** One bootstrap registers the operator-declared company of every workload in one statement. */
  readonly bindings: readonly RegisterWorkloadCompanyBindingInput[];
}

export interface RevokeWorkloadCompanyBindingInput {
  readonly companyBindingId: AccessWorkloadCompanyBindingId;
  readonly revokedAt: Date;
}

/** The registration registry's write side, bound through `AccessWorkloadCompanyBindingStore`. */
export interface AccessWorkloadCompanyBindingStoreService {
  /**
   * Registers active company registrations. A registration that already exists is left exactly as it
   * is, and a registration that names a second company for a binding that already holds one is
   * refused: a workload binding selects exactly one company.
   */
  readonly registerCompanyBindings: (
    scope: OperationalScope,
    input: RegisterWorkloadCompanyBindingsInput,
  ) => Effect.Effect<void, AccessIntentError>;
  /** Ends one registration. A revoked one is never reopened: a re-registration is a new row. */
  readonly revokeCompanyBinding: (
    scope: OperationalScope,
    input: RevokeWorkloadCompanyBindingInput,
  ) => Effect.Effect<void, AccessIntentError>;
}

/** The runtime binds the registration writer through this service tag. */
export class AccessWorkloadCompanyBindingStore extends Context.Service<
  AccessWorkloadCompanyBindingStore,
  AccessWorkloadCompanyBindingStoreService
>()('@app/core-runtime/access/workloads/company-store/AccessWorkloadCompanyBindingStore') {}
