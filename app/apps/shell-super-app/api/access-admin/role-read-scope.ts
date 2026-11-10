import type { AccessDeclaration, LegalEntityScope, OperationalScope } from '@app/core-runtime';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Effect } from 'effect';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import { accessAdminForbiddenProblem, accessAdminUnavailableProblem } from './session.ts';

/*
 * Which Roles one read may show (O88).
 *
 * The Role editor is tenant work (O28), but a company's roles belong to that company. Every reader,
 * including an owner, is admitted to those roles only in that company's own scope. This module answers one question —
 * which contexts did this operation's own declaration admit — and it never guesses from the request:
 *
 * 1. The tenant context is asked first, with the operation's own declaration. An owner, a tenant
 *    delegation or a role cell there proves reading of tenant-context roles; a company administrator is refused
 *    here, because a company's power is never a tenant's (O81, O88).
 * 2. Candidates are the companies in the tenant's authoritative intent, including companies with
 *    no roles yet. They never come from a browser list, selected company, declaration wording or key
 *    prefix. A request carries no company at all.
 * 3. Each of those companies is asked with `legalEntityScope: 'required'` in that company's exact
 *    scope, through the very same gate. Only that answer — a live `access_admin` membership of the
 *    company (with its tenant membership), a live delegation for it, or a role cell granted in it —
 *    makes the company's roles readable. The gate is the authority; this module adds no `isAdmin`.
 * 4. An unreadable answer is UNAVAILABLE (503) and never a smaller list: a person must never lose
 *    the roles they hold because one authority read failed.
 *
 * Tenant ownership inherits company administration, but it does not bypass a company's suspension.
 * A tenant-context owner answer is therefore never a substitute for the target company's decision.
 */

/** The tenant context of the administration surface: the one context a company question is not (O28). */
const ADMIN_SURFACE_SCOPE: LegalEntityScope = 'optional';
/** One company's own scope: the only context a company's roles are decided in (O88). */
const COMPANY_SCOPE: LegalEntityScope = 'required';

/** No company: the answer of a person whose authority covers no company's roles. */
const NO_COMPANIES: ReadonlySet<string> = new Set();

/** The one question shape every read asks: the declaration, the context and the instant, nothing else. */
const questionOf = (
  scope: OperationalScope,
  declaration: AccessDeclaration,
  now: Date,
  legalEntityScope: LegalEntityScope,
): GateInput => ({ carrier: { accessDeclaration: declaration }, legalEntityScope, now, scope });

/**
 * One access-admin declaration asked at one Core instant, in the exact context the caller names. The
 * gate is the only decision the administration surface ever takes (O81, O88): no caller flag, no key
 * prefix and no selected company reaches it.
 */
export const decideRoleDeclaration = Effect.fn('AccessAdminRoleReadScope.decide')(function* decideDeclaration(
  scope: OperationalScope,
  declaration: AccessDeclaration,
  now: Date,
  legalEntityScope: LegalEntityScope,
) {
  const gate = yield* AccessDecisionGate;
  return yield* gate.decide(questionOf(scope, declaration, now, legalEntityScope));
});

/** The trusted scope of one company of this tenant, minted from Core's own company id (O66). */
const companyScopeOf = (scope: OperationalScope, legalEntityId: string): OperationalScope =>
  Object.freeze({ ...scope, legalEntityId: LegalEntityIdSchema.make(legalEntityId) });

/**
 * The contexts one Role read may cover, as the operation's own declaration admitted them. `tenant`
 * covers the tenant-context roles and `companies` only the companies whose own decisions allowed it.
 */
export interface RoleReadScope {
  readonly companies: ReadonlySet<string>;
  readonly tenant: boolean;
}

/** Whether one role, named by the company it lives in, is inside what this read may show. */
export const roleIsReadable = (scope: RoleReadScope, legalEntityId: string | undefined): boolean =>
  legalEntityId === undefined ? scope.tenant : scope.companies.has(legalEntityId);

/** True exactly when no role of the tenant is readable: the read is refused, never answered empty. */
export const coversNoRole = (scope: RoleReadScope): boolean => !scope.tenant && scope.companies.size === 0;

/** The one refusal a Role read gives when it covers nothing at all: no context, never a hint. */
export const roleReadRefusal = (): AccessAdminProblem =>
  accessAdminForbiddenProblem('The Role editor is not available to this person.');

/** The companies one Role read asks about, in a stable order and asked once each. */
const askedCompanies = (companies: readonly string[]): readonly string[] =>
  [...new Set(companies)].toSorted((left, right) => left.localeCompare(right));

/** One authority read: the candidate companies, the operation's own declaration, one Core instant. */
interface ReadScopeRequest {
  readonly companies: readonly string[];
  readonly declaration: AccessDeclaration;
  readonly now: Date;
  readonly scope: OperationalScope;
}

/**
 * The candidate companies whose own required scope admits this declaration (O88). A surface whose
 * tenant-context admission has already answered (Novinky, Ke schválení) asks only this half, so the
 * tenant question is never asked twice for one request. The gate is passed as the `decide` port the
 * surface already holds, so the question is the gate's own and its requirement stays the caller's.
 */
export const readableCompanies = Effect.fn('AccessAdminRoleReadScope.companies')(function* resolveReadableCompanies(
  decide: AccessDecisionService['decide'],
  input: ReadScopeRequest,
) {
  const companies = askedCompanies(input.companies);
  if (companies.length === 0) {
    return NO_COMPANIES;
  }
  // One question per candidate company, each in that company's own required scope. They are
  // independent, so they run as one batch: a refusal drops that company, an unreadable answer refuses
  // the whole read rather than hiding roles this person may still hold.
  const answers: readonly AccessDecision[] = yield* Effect.all(
    companies.map((company) =>
      decide(questionOf(companyScopeOf(input.scope, company), input.declaration, input.now, COMPANY_SCOPE)),
    ),
    { concurrency: 1 },
  );
  if (answers.some(({ outcome }) => outcome === 'UNAVAILABLE')) {
    return yield* Effect.fail(accessAdminUnavailableProblem());
  }
  return new Set<string>(companies.filter((_, index) => answers[index]?.outcome === 'ALLOWED'));
});

/**
 * The contexts one Role read may show, decided by the gate in the tenant context and in the exact
 * scope of every company declared by the tenant's intent (O88). The companies are candidates only: each
 * one still has to admit this operation's own declaration in its own scope.
 */
export const roleReadScope = Effect.fn('AccessAdminRoleReadScope.resolve')(function* resolveRoleReadScope(
  input: ReadScopeRequest,
) {
  const gate = yield* AccessDecisionGate;
  const tenantDecision = yield* gate.decide(questionOf(input.scope, input.declaration, input.now, ADMIN_SURFACE_SCOPE));
  if (tenantDecision.outcome === 'UNAVAILABLE') {
    // An unreadable authority is a retry, never a smaller answer (O48).
    return yield* Effect.fail(accessAdminUnavailableProblem());
  }
  const companies: ReadonlySet<string> = yield* readableCompanies(gate.decide, input);
  return { companies, tenant: tenantDecision.outcome === 'ALLOWED' };
});

/** Several declarations of one request, asked in the same contexts at the same Core instant. */
interface ReadScopesRequest {
  readonly companies: readonly string[];
  readonly declarations: readonly AccessDeclaration[];
  readonly now: Date;
  readonly scope: OperationalScope;
}

/**
 * The contexts each of several declarations may cover, exactly as `roleReadScope` answers each one, asked
 * as ONE `decideMany`: the gate then reads the actor, each context's scope and its structural basis once
 * per context instead of once per question, and writes the evidence of a context in one transaction. Every
 * question is the one `roleReadScope` asks (the tenant context, then each candidate company in its own
 * required scope), and an unreadable answer for any of them is UNAVAILABLE, never a smaller answer.
 */
export const roleReadScopes = Effect.fn('AccessAdminRoleReadScope.resolveMany')(function* resolveRoleReadScopes(
  input: ReadScopesRequest,
) {
  const gate = yield* AccessDecisionGate;
  const companies = askedCompanies(input.companies);
  const questions = input.declarations.flatMap((declaration) => [
    questionOf(input.scope, declaration, input.now, ADMIN_SURFACE_SCOPE),
    ...companies.map((company) =>
      questionOf(companyScopeOf(input.scope, company), declaration, input.now, COMPANY_SCOPE),
    ),
  ]);
  const answers: readonly AccessDecision[] = questions.length === 0 ? [] : yield* gate.decideMany(questions);
  if (answers.length !== questions.length || answers.some(({ outcome }) => outcome === 'UNAVAILABLE')) {
    return yield* Effect.fail(accessAdminUnavailableProblem());
  }
  // The answers come back in question order: one tenant answer, then one per company, per declaration.
  const stride = companies.length + 1;
  return input.declarations.map((_, index): RoleReadScope => {
    const block = answers.slice(index * stride, (index + 1) * stride);
    return {
      companies:
        companies.length === 0
          ? NO_COMPANIES
          : new Set<string>(companies.filter((_company, position) => block[position + 1]?.outcome === 'ALLOWED')),
      tenant: block[0]?.outcome === 'ALLOWED',
    };
  });
});

/** The same answer, with the one refusal every Role read gives when it covers no role at all. */
export const readableRoleScope = (
  input: ReadScopeRequest,
): Effect.Effect<RoleReadScope, AccessAdminProblem, AccessDecisionGate> =>
  roleReadScope(input).pipe(
    Effect.flatMap((scope) =>
      coversNoRole(scope) ? Effect.fail(roleReadRefusal()) : Effect.succeed<RoleReadScope>(scope),
    ),
  );
