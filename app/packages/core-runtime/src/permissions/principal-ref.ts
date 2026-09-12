import { Context, Effect, Schema } from 'effect';

const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrincipalRefTenantId'),
  Schema.decodeTo(Schema.String),
);
const PrincipalIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrincipalRefPrincipalId'),
  Schema.decodeTo(Schema.String),
);

/** Public authorization identity. Principal IDs are never meaningful without their tenant. */
export const PrincipalRefSchema = Schema.Struct({
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export type PrincipalRef = typeof PrincipalRefSchema.Type;

export const PrincipalEligibilityDecisionSchema = Schema.Literals(['eligible', 'ineligible', 'unavailable']);
export type PrincipalEligibilityDecision = typeof PrincipalEligibilityDecisionSchema.Type;

export interface PrincipalEligibilityResult {
  readonly decision: PrincipalEligibilityDecision;
  readonly principal: PrincipalRef;
  readonly reason: 'active' | 'inactive' | 'missing' | 'tenant_mismatch' | 'indeterminate';
}

export interface PrincipalEligibilityService {
  readonly resolve: (principal: PrincipalRef) => Effect.Effect<PrincipalEligibilityResult>;
}

export class PrincipalEligibility extends Context.Service<PrincipalEligibility, PrincipalEligibilityService>()(
  '@app/core-runtime/permissions/principal-ref/PrincipalEligibility',
) {}

export const unavailablePrincipalEligibility = (): PrincipalEligibilityService =>
  Object.freeze({
    resolve: (principal: PrincipalRef) =>
      Effect.succeed({
        decision: 'unavailable' as const,
        principal,
        reason: 'indeterminate' as const,
      }),
  });
