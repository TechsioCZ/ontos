import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Option, Schema } from 'effect';

import {
  TaxGovernanceConflictKindSchema,
  TaxGovernancePersistenceUnavailable,
} from '../../shared/domain/tax-governance-errors.ts';
import type { TaxGovernanceConflictKind } from '../../shared/domain/tax-governance-errors.ts';

export type PersistenceUnavailable = InstanceType<typeof TaxGovernancePersistenceUnavailable>;

/**
 * Owner-local transaction capability; inferred from Core's factory so the executor name never reaches handler
 * services (assortment precedent).
 */
export type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export type GovernanceConflict = Readonly<{ readonly conflict: TaxGovernanceConflictKind; readonly kind: 'conflict' }>;
export type GovernanceNotFound = Readonly<{ readonly kind: 'not_found' }>;
export type GovernanceStale = Readonly<{ readonly kind: 'stale_basis' }>;

const GovernanceConflictSchema = Schema.Struct({
  conflict: TaxGovernanceConflictKindSchema,
  kind: Schema.Literal('conflict'),
});

export const conflict = (kind: TaxGovernanceConflictKind): GovernanceConflict => ({ conflict: kind, kind: 'conflict' });
export const notFound: GovernanceNotFound = { kind: 'not_found' };
export const staleBasis: GovernanceStale = { kind: 'stale_basis' };

/** Core Action attribution shared by every governed TAX mutation. */
export interface GovernedInvocation {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export const unavailable = (cause?: unknown): PersistenceUnavailable => {
  const failure = new TaxGovernancePersistenceUnavailable({
    code: 'tax_governance_persistence_unavailable',
    reason: 'Tax governance persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const query = <Value, Failure>(
  effect: Effect.Effect<Value, Failure>,
): Effect.Effect<Value, PersistenceUnavailable> => effect.pipe(Effect.mapError(unavailable));

const uniqueViolationSqlState = ['23', '505'].join('');

const WriteConstraintNameSchema = Schema.Literals([
  'tax_fact_authority_contracts_code_uk',
  'tax_fact_authority_contracts_idempotency_uk',
  'tax_fact_authority_revisions_idempotency_uk',
  'tax_fact_authority_revisions_number_uk',
  'tax_rule_corrections_idempotency_uk',
  'tax_rule_corrections_pair_uk',
  'tax_rule_revision_end_facts_idempotency_uk',
  'tax_rule_revision_end_facts_revision_uk',
  'tax_rule_revisions_idempotency_uk',
  'tax_rule_revisions_rule_number_uk',
  'tax_rules_code_uk',
  'tax_rules_idempotency_uk',
]);
const isWriteConstraint = Schema.is(WriteConstraintNameSchema);

/** Durable unique constraints decide races; each maps to one typed governance conflict. */
const writeConflictConstraints = {
  tax_fact_authority_contracts_code_uk: 'STABLE_CODE',
  tax_fact_authority_contracts_idempotency_uk: 'IDEMPOTENCY_REUSED',
  tax_fact_authority_revisions_idempotency_uk: 'IDEMPOTENCY_REUSED',
  tax_fact_authority_revisions_number_uk: 'STALE_BASIS',
  tax_rule_corrections_idempotency_uk: 'IDEMPOTENCY_REUSED',
  tax_rule_corrections_pair_uk: 'LIFECYCLE',
  tax_rule_revision_end_facts_idempotency_uk: 'IDEMPOTENCY_REUSED',
  tax_rule_revision_end_facts_revision_uk: 'LIFECYCLE',
  tax_rule_revisions_idempotency_uk: 'IDEMPOTENCY_REUSED',
  tax_rule_revisions_rule_number_uk: 'STALE_BASIS',
  tax_rules_code_uk: 'STABLE_CODE',
  tax_rules_idempotency_uk: 'IDEMPOTENCY_REUSED',
} satisfies Readonly<Record<typeof WriteConstraintNameSchema.Type, TaxGovernanceConflictKind>>;

export const mutation = <Value>(
  effect: Effect.Effect<Value, EffectDrizzleQueryError>,
): Effect.Effect<Value | GovernanceConflict, PersistenceUnavailable> =>
  effect.pipe(
    Effect.mapError((failure) => {
      const metadata = findPostgresFailure(
        failure,
        ({ code, constraint }) =>
          code === uniqueViolationSqlState && constraint !== undefined && isWriteConstraint(constraint),
      );
      const constraint = Option.isSome(metadata) ? metadata.value.constraint : undefined;
      return constraint !== undefined && isWriteConstraint(constraint)
        ? conflict(writeConflictConstraints[constraint])
        : unavailable(failure);
    }),
    Effect.catchIf(
      (failure: PersistenceUnavailable | GovernanceConflict): failure is GovernanceConflict =>
        Schema.is(GovernanceConflictSchema)(failure),
      Effect.succeed,
    ),
  );

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));

/** Owner identities are UUIDs; any other reference cannot name a TAX row. */
export const isOwnerId = (value: string): boolean => isUuid(value);

/** The trusted Operational Scope, never the payload, decides Tenant and Selling Legal Entity (#950 F24-F28). */
export const trustedInvocation = (
  scope: OperationalScope,
  input: GovernedInvocation,
  refTenantIds: readonly string[],
): boolean =>
  input.tenantId === scope.tenantId &&
  scope.legalEntityId !== undefined &&
  input.legalEntityId === scope.legalEntityId &&
  refTenantIds.every((tenantId) => tenantId === scope.tenantId);

export const sameInstant = (left: Date | null, right: Date | null): boolean =>
  left === null || right === null ? left === right : left.getTime() === right.getTime();
