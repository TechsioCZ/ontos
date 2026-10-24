import { v1 } from '@authzed/authzed-node';
import { DateTime, Effect, Option, Schema } from 'effect';

import { PeopleModelTransitionError } from '../packages/core-runtime/src/install/people-model-transition.ts';
import { RETAIL_PORTAL_PERMISSION_CODES } from '../verticals/commerce-customer-context/shared/domain/profile-contracts.ts';

export const reviewedPeopleInventorySha256 = 'b6c621652f155644a1d5f3c0c4e922daa3d0d43dc8ba24870cad032ef52617a8';
export const ReviewedPeopleInventorySchema = Schema.Struct({
  capturedAt: Schema.DateTimeUtcFromString,
  companies: Schema.Array(
    Schema.Struct({ legal_entity_id: Schema.String, status: Schema.String, tenant_id: Schema.String }),
  ),
  principals: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      principal_id: Schema.String,
      status: Schema.String,
      tenant_id: Schema.String,
    }),
  ),
  tenants: Schema.Array(Schema.Struct({ status: Schema.String, tenant_id: Schema.String })),
});
export interface CurrentPrincipal {
  readonly createdAt: Date | string;
  readonly kind: string;
  readonly principalId: string;
  readonly status: string;
  readonly tenantId: string;
}
export interface RetailEnrollment extends Record<string, unknown> {
  readonly legalEntityId: string;
  readonly permission: string;
  readonly principalId: string;
  readonly profileId: string;
  readonly tenantId: string;
}
const reject = (reason: string) => Effect.fail(new PeopleModelTransitionError({ reason }));

/** SQL identity evidence only; this never evaluates a graph permission. */
export const postBaselinePrincipals = (
  baseline: typeof ReviewedPeopleInventorySchema.Type,
  current: readonly CurrentPrincipal[],
) =>
  Effect.gen(function* validateSqlPrincipals() {
    const capturedAt = DateTime.toEpochMillis(baseline.capturedAt);
    const original = new Map(baseline.principals.map((p) => [p.principal_id, p]));
    if (
      !Number.isFinite(capturedAt) ||
      original.size !== baseline.principals.length ||
      new Set(current.map((p) => p.principalId)).size !== current.length
    ) {
      return yield* reject('Invalid or duplicate SQL inventory');
    }
    for (const archived of original.values()) {
      const live = current.find((p) => p.principalId === archived.principal_id);
      if (
        !live ||
        live.tenantId !== archived.tenant_id ||
        live.kind !== archived.kind ||
        live.status !== archived.status
      ) {
        return yield* reject('Reviewed SQL principal changed or disappeared');
      }
    }
    const added = current.filter((p) => !original.has(p.principalId));
    for (const p of added) {
      const parsed = DateTime.make(p.createdAt);
      const createdAt = Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : Number.NaN;
      if (
        p.kind !== 'human' ||
        p.status !== 'active' ||
        !Number.isFinite(createdAt) ||
        createdAt <= capturedAt ||
        !baseline.tenants.some((t) => t.tenant_id === p.tenantId && t.status === 'active')
      ) {
        return yield* reject('Extra principal is not a SQL-proven post-baseline active human in a reviewed tenant');
      }
    }
    return added;
  });

const objectId = (parts: readonly string[]) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(parts).pipe(
    Effect.map((encoded) => `ctx_${Buffer.from(encoded).toString('base64url')}`),
  );
const tupleKey = (r: v1.Relationship) => v1.Relationship.toJsonString(r);
const edge = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

/** Only native self/tenant structure and exact SQL-owned retail self-service pairs may extend the seal. */
export const admitPostBaselineRelationships = (input: {
  readonly actual: readonly v1.Relationship[];
  readonly baseline: typeof ReviewedPeopleInventorySchema.Type;
  readonly enrollments: readonly RetailEnrollment[];
  readonly principals: readonly CurrentPrincipal[];
  readonly sealed: readonly v1.Relationship[];
}) =>
  Effect.gen(function* admitNativeRelationships() {
    const actors = yield* postBaselinePrincipals(input.baseline, input.principals);
    const allowed = new Set<string>();
    const paired = new Map<string, readonly string[]>();
    const sealed = new Set(input.sealed.map(tupleKey));
    const actual = new Set(input.actual.map(tupleKey));
    if (actual.size !== input.actual.length) {
      return yield* reject('Duplicate current relationship');
    }
    if ([...sealed].some((key) => !actual.has(key))) {
      return yield* reject('Missing sealed relationship');
    }
    for (const actor of actors) {
      allowed.add(tupleKey(edge('principal', actor.principalId, 'self', 'principal', actor.principalId)));
      allowed.add(tupleKey(edge('principal', actor.principalId, 'tenant', 'tenant', actor.tenantId)));
    }
    for (const enrollment of input.enrollments) {
      if (!actors.some((p) => p.principalId === enrollment.principalId && p.tenantId === enrollment.tenantId)) {
        continue;
      }
      if (
        !input.baseline.companies.some(
          (c) =>
            c.tenant_id === enrollment.tenantId &&
            c.legal_entity_id === enrollment.legalEntityId &&
            c.status === 'active',
        ) ||
        !RETAIL_PORTAL_PERMISSION_CODES.some((p) => p === enrollment.permission)
      ) {
        return yield* reject('Retail enrollment differs from reviewed company/native permission set');
      }
      const id = yield* objectId([
        enrollment.permission,
        enrollment.tenantId,
        enrollment.legalEntityId,
        'retail_profile',
        enrollment.profileId,
      ]);
      if (input.sealed.some((r) => r.resource?.objectType === 'business_permission' && r.resource.objectId === id)) {
        return yield* reject('Post-baseline enrollment cannot extend an archived resource');
      }
      const pair = [
        tupleKey(edge('business_permission', id, 'self_service_grantee', 'principal', enrollment.principalId)),
        tupleKey(
          edge(
            'business_permission',
            id,
            'legal_entity',
            'legal_entity',
            yield* objectId([enrollment.tenantId, enrollment.legalEntityId]),
          ),
        ),
      ];
      const previous = paired.get(id);
      if (previous && previous[0] !== pair[0]) {
        return yield* reject('Retail profile has more than one holder');
      }
      paired.set(id, pair);
      for (const key of pair) {
        allowed.add(key);
      }
    }
    const extras = input.actual.filter((r) => !sealed.has(tupleKey(r)));
    for (const row of extras) {
      if (!allowed.has(tupleKey(row))) {
        return yield* reject('Unreviewed relationship beyond sealed graph');
      }
    }
    for (const pair of paired.values()) {
      if (pair.some((k) => actual.has(k)) && !pair.every((k) => actual.has(k))) {
        return yield* reject('Incomplete native retail self-service pair');
      }
    }
    return extras;
  });

/** Read-only evidence: an active/pending native grant, exact binding, profile and permission intent. */
export const retailEnrollmentEvidenceSql = `select distinct b.principal_id as "principalId", b.tenant_id as "tenantId", b.legal_entity_id as "legalEntityId", b.retail_customer_profile_id as "profileId", m.permission_code as "permission"
from commerce_customer_context.retail_portal_profile_bindings b
join commerce_customer_context.retail_customer_profiles p on (p.tenant_id,p.legal_entity_id,p.retail_customer_profile_id)=(b.tenant_id,b.legal_entity_id,b.retail_customer_profile_id)
join commerce_customer_context.retail_portal_profile_binding_permission_mutations m on (m.tenant_id,m.legal_entity_id,m.retail_portal_profile_binding_id,m.principal_id,m.retail_customer_profile_id)=(b.tenant_id,b.legal_entity_id,b.retail_portal_profile_binding_id,b.principal_id,b.retail_customer_profile_id)
where b.lifecycle='ACTIVE' and b.revoked_at is null and b.authorization_operation='grant' and b.authorization_state in ('ACTIVE','PENDING_GRANT') and m.operation='grant' and m.state in ('ACTIVE','PENDING_GRANT')`;
