import { DateTime, Effect, Match, Option, Predicate } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { AccessConfigureBasis } from '../changes/authority.ts';
import { LegalEntityIdSchema } from '../ids.ts';
import type { AccessIntentError } from '../intent/errors.ts';
import type { AccessTransactions } from '../intent/persistence.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';
import type { Holder } from '../model.ts';
import { ApprovalAuthorityUnavailableError } from './errors.ts';
import type { LiveMembershipFacts, ScopeRow } from './live-authority.ts';
import {
  holdsMembershipPath,
  membershipFactsOf,
  membershipPathOf,
  readTenantMembershipRows,
} from './live-authority.ts';
import type { ApprovalScopeAdministration } from './service.ts';

/*
 * Who administers one exact scope (O61): a resolved Core fact, never a browser flag, a generic
 * `ALLOWED` answer or a hard-coded `true`.
 *
 * The management facts themselves are the shipped configure bases — a tenant owner, or an
 * `access_admin` membership of that company (O28, O81) — but a basis alone never proves the power.
 * The canonical membership schema is:
 *
 *   company access      = member(company) & tenant->access - suspended
 *   company administer  = (access_admin(company) & company access) + tenant->administer - suspended
 *   tenant administer   = owner - suspended, and it does not require a company membership
 *
 * So this adapter reads the membership rows itself and requires the company's own live membership
 * (plus the tenant context's) before an `access_admin` basis counts, while a tenant owner needs the
 * tenant membership the tenant context gives it. That is stricter than the bases alone: the shipped
 * `configureBasesOf` derives `ScopeAdmin` from the `access_admin` membership, and inheriting that
 * derivation without the membership proof would let a suspended or company-less `access_admin` decide.
 */

const authorityUnavailable = (reason: string) =>
  new ApprovalAuthorityUnavailableError({ code: 'approval_authority_unavailable', reason });

const intentUnavailable = (failure: AccessIntentError): ApprovalAuthorityUnavailableError =>
  authorityUnavailable(`${failure.code}: ${failure.reason}`);

/** A tenant owner covers every scope of its tenant; it is the one basis without a company (O28). */
const hasOwnerBasis = (bases: readonly AccessConfigureBasis[]): boolean =>
  bases.some((basis) => Predicate.isTagged(basis, 'Owner'));

/** An `access_admin` basis administers exactly the companies it names, until its membership ends. */
const administersCompany = (
  bases: readonly AccessConfigureBasis[],
  legalEntityId: ReturnType<typeof LegalEntityIdSchema.make>,
  at: Date,
): boolean =>
  bases.some((basis) =>
    Match.value(basis).pipe(
      Match.tag('ScopeAdmin', ({ deadlines, legalEntityIds }) => {
        const deadline = deadlines?.find((one) => one.legalEntityId === legalEntityId)?.until;
        return new Set(legalEntityIds).has(legalEntityId) && (deadline === undefined || at < deadline);
      }),
      Match.orElse(() => false),
    ),
  );

/**
 * Whether these membership facts and configure bases make one person a manager of one exact scope.
 * A company administrator needs the company's `access_admin` fact AND the company's own live
 * membership AND the tenant context's; a tenant owner inherits every scope of its tenant from the
 * tenant context, so it needs that membership and no company one. A suspension anywhere on the path
 * subtracts either power. A delegation is bounded management of some roles, not scope administration,
 * so it never answers this question.
 */
export const administersScope = (input: {
  readonly at: Date;
  readonly bases: readonly AccessConfigureBasis[];
  readonly facts: LiveMembershipFacts;
  readonly row: ScopeRow;
  readonly tenantScopeIds: readonly string[];
}): boolean => {
  if (
    input.tenantScopeIds.length === 0 ||
    input.facts.suspendedScopeIds.has(input.row.scopeId) ||
    !holdsMembershipPath(input.facts, { requiredScopeIds: input.tenantScopeIds })
  ) {
    return false;
  }
  if (hasOwnerBasis(input.bases)) {
    return true;
  }
  // The tenant context accepts no company administrator: an access-admin membership of a company is
  // management power in that company, never in the tenant itself (O81, `basisCoversKey`).
  if (input.row.legalEntityId === null) {
    return false;
  }
  return (
    holdsMembershipPath(input.facts, { requiredScopeIds: [input.row.scopeId, ...input.tenantScopeIds] }) &&
    administersCompany(input.bases, LegalEntityIdSchema.make(input.row.legalEntityId), input.at)
  );
};

/** The intent read this question needs: the shipped configure bases of one person in one tenant. */
export interface LiveAdministrationIntentReads {
  readonly loadConfigureBases: TenantIntentLoaderService['loadConfigureBases'];
}

/** Everything the live administrator check reads: the intent loader, the membership rows, the scope. */
export interface LiveAdministrationSources {
  readonly intent: LiveAdministrationIntentReads;
  /** The request's own scope: the check runs inside it and never inside another tenant. */
  readonly scope: OperationalScope;
  /** The membership rows of this request's scope, from a transaction per read or from the caller's own. */
  readonly transactions: AccessTransactions;
}

/**
 * The live scope administration of one request scope. The tenant's scope rows, the membership rows and
 * the configure bases are read on every question, so a suspension, a revoked membership or a lapsed
 * `access_admin` window is answered at the next decision instead of at the next restart. An
 * unreadable source is unavailability; a scope this tenant does not own is unavailability too, because
 * "no such scope" is not an answer about the person.
 */
export const liveApprovalScopeAdministration = (sources: LiveAdministrationSources): ApprovalScopeAdministration => {
  const isAdministrator = Effect.fn('LiveApprovalScopeAdministration.isAdministrator')(function* isAdministratorEffect(
    input: Parameters<ApprovalScopeAdministration['isAdministrator']>[0],
  ): Effect.fn.Return<boolean, ApprovalAuthorityUnavailableError> {
    if (input.tenantId !== sources.scope.tenantId) {
      return yield* authorityUnavailable('Administration is only decided inside the request own tenant');
    }
    const at = yield* DateTime.nowAsDate;
    const { membershipRows, scopeRows } = yield* readTenantMembershipRows(sources);
    const row = scopeRows.find((candidate) => candidate.scopeId === input.scopeId);
    // The scope itself must exist in this tenant; which membership its administration needs is the
    // owner/access-admin distinction `administersScope` decides below.
    if (row === undefined || Option.isNone(membershipPathOf(scopeRows, input.scopeId))) {
      return yield* authorityUnavailable('The scope of this proposal is not an access scope of this tenant');
    }
    const holder: Holder = { _tag: 'Principal', principalId: input.principalId };
    const facts = membershipFactsOf({ at, holder, rows: membershipRows });
    const bases = yield* sources.intent
      .loadConfigureBases(sources.scope, { actor: input.principalId, at, tenantId: input.tenantId })
      .pipe(Effect.mapError(intentUnavailable));
    return administersScope({
      at,
      bases,
      facts,
      row,
      tenantScopeIds: scopeRows.flatMap(({ legalEntityId, scopeId }) => (legalEntityId === null ? [scopeId] : [])),
    });
  });

  return Object.freeze({ isAdministrator });
};
