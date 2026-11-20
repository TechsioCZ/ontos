import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../auth/staff-authentication-namespace.ts';
import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  legalEntities,
  principalAuthBindings,
  principals,
  tenants,
} from '../../db/schema.ts';
import type { PrincipalKind } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../ids.ts';
import { activeRegisteredCompany, activeRegistrationOfBinding } from './company-registration.ts';

const CompanyRegistrationSchema = Schema.Literals(['binding', 'none', 'other_binding']);

/** One active Principal holding an active binding of a workload. */
export interface WorkloadBindingHolder {
  /**
   * The Principal holds an active, unrevoked Better Auth API-key auth binding of the staff namespace, the binding the
   * Shell gateway resolves an `x-api-key` to (`resolveBetterAuthApiKey`).
   */
  readonly apiKey: boolean;
  /**
   * Reported only when the read names the company the binding must serve (a tenant-only call needs no registration):
   * where the holder is registered for it (D6), as the company gate reads it (`bindings.ts`). `binding`: this very
   * binding of the workload is, the one registration that admits a verified gateway workload acting under the binding
   * there. `other_binding`: only another of the holder's active bindings is, which still admits the holder's own direct
   * calls there, as the gate reads the companies of all its active bindings. `none`: the gate refuses the holder in
   * that company with `deny.workload_unbound`.
   */
  readonly companyRegistration?: typeof CompanyRegistrationSchema.Type;
  readonly kind: PrincipalKind;
  readonly principalId: string;
}

const querySchema = Schema.Struct({
  legalEntityId: Schema.optional(LegalEntityIdSchema),
  tenantId: TenantIdSchema,
  workloadKey: WorkloadKeySchema,
});

/** Another active binding of the same holder, whose registration also admits the holder's direct calls. */
const holderBinding = alias(accessWorkloadBindings, 'holder_binding');

/**
 * Factual registry read for an operator check: every active Principal of an active Tenant that holds an active
 * binding of one workload, in Principal order, whether each holds an active, unrevoked API-key auth binding and, for
 * the company a binding must serve, where each is registered for it by the company gate's own predicate
 * (`company-registration.ts`). It names who may run the workload; it constructs no authentication context and grants
 * nothing. A caller decides on the whole list, so another holder of the same workload is never hidden by a limit or by
 * its registration.
 */
export const readActiveWorkloadBindingHolders = Effect.fn('AccessWorkloadBindings.readActiveHolders')(
  function* readActiveHolders(
    transaction: Pick<CoreTransaction, 'select'>,
    tenantId: string,
    workloadKey: string,
    legalEntityId?: string,
  ) {
    const query = yield* Schema.decodeUnknownEffect(querySchema)({ legalEntityId, tenantId, workloadKey }).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The Tenant, workload key or company is invalid', cause)),
    );
    const company = query.legalEntityId;
    const companyRegistration =
      company === undefined
        ? sql<null>`null`
        : sql<string>`case when ${exists(
            transaction
              .select({ legalEntityId: accessWorkloadCompanyBindings.legalEntityId })
              .from(accessWorkloadCompanyBindings)
              .innerJoin(legalEntities, activeRegisteredCompany())
              .where(and(activeRegistrationOfBinding(), eq(accessWorkloadCompanyBindings.legalEntityId, company))),
          )} then 'binding' when ${exists(
            transaction
              .select({ legalEntityId: accessWorkloadCompanyBindings.legalEntityId })
              .from(holderBinding)
              .innerJoin(accessWorkloadCompanyBindings, activeRegistrationOfBinding(holderBinding))
              .innerJoin(legalEntities, activeRegisteredCompany())
              .where(
                and(
                  eq(holderBinding.tenantId, accessWorkloadBindings.tenantId),
                  eq(holderBinding.principalId, accessWorkloadBindings.principalId),
                  eq(holderBinding.status, 'active'),
                  eq(accessWorkloadCompanyBindings.legalEntityId, company),
                ),
              ),
          )} then 'other_binding' else 'none' end`;
    const rows = yield* transaction
      .select({
        apiKey: sql<boolean>`${exists(
          transaction
            .select({ bindingId: principalAuthBindings.principalAuthBindingId })
            .from(principalAuthBindings)
            .where(
              and(
                eq(principalAuthBindings.tenantId, principals.tenantId),
                eq(principalAuthBindings.principalId, principals.principalId),
                eq(principalAuthBindings.provider, 'better_auth'),
                eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
                eq(principalAuthBindings.subjectType, 'api_key'),
                eq(principalAuthBindings.status, 'active'),
                isNull(principalAuthBindings.revokedAt),
              ),
            ),
        )}`,
        companyRegistration,
        kind: principals.kind,
        principalId: principals.principalId,
      })
      .from(accessWorkloadBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, accessWorkloadBindings.tenantId),
          eq(principals.principalId, accessWorkloadBindings.principalId),
        ),
      )
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, query.tenantId),
          eq(accessWorkloadBindings.workloadKey, query.workloadKey),
          eq(accessWorkloadBindings.status, 'active'),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      )
      .orderBy(asc(principals.principalId))
      .pipe(Effect.mapError((cause) => accessDecisionUnavailable('The workload bindings could not be read', cause)));
    const registrations = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.OptionFromNullOr(CompanyRegistrationSchema)),
    )(rows.map(({ companyRegistration: registration }) => registration)).pipe(
      Effect.mapError((cause) =>
        accessDecisionUnavailable('The company registration of a workload binding could not be read', cause),
      ),
    );
    return rows.map(({ companyRegistration: _read, ...holder }, index): WorkloadBindingHolder =>
      Option.match(Option.flatten(Option.fromUndefinedOr(registrations[index])), {
        onNone: () => holder,
        onSome: (registration) => ({ ...holder, companyRegistration: registration }),
      }),
    );
  },
);
