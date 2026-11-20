import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { accessWorkloadBindings, accessWorkloadCompanyBindings, legalEntities } from '../../db/schema.ts';

/*
 * When a company registration counts (D6), as the one predicate every reader joins: the registration is active, it was
 * written for the very workload binding read beside it, and it names an active company of that binding's Tenant. The
 * binding's own status stays each reader's condition. The company gate's read (`bindings.ts`) and the operator checks
 * over the holders of a binding (`binding-holders.ts`) join exactly these conditions, so a check never counts a
 * registration the gate refuses.
 */

/** The workload binding a registration is joined to: the registry table itself, or an alias of it. */
interface RegisteredBinding {
  readonly bindingId: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
}

/** The active registration of the workload binding the same statement reads. */
export const activeRegistrationOfBinding = (binding: RegisteredBinding = accessWorkloadBindings) =>
  and(
    eq(accessWorkloadCompanyBindings.tenantId, binding.tenantId),
    eq(accessWorkloadCompanyBindings.workloadBindingId, binding.bindingId),
    eq(accessWorkloadCompanyBindings.status, 'active'),
  );

/**
 * The company that registration names, only while it is an active company of the registration's Tenant: a suspended or
 * archived one is never selectable even though its registration is untouched.
 */
export const activeRegisteredCompany = () =>
  and(
    eq(legalEntities.tenantId, accessWorkloadCompanyBindings.tenantId),
    eq(legalEntities.legalEntityId, accessWorkloadCompanyBindings.legalEntityId),
    eq(legalEntities.status, 'active'),
  );
