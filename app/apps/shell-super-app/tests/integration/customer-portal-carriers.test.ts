import { decodeAccessWorkload } from '@app/core-runtime';
import { PORTAL_OWN_CARRIER } from '@app/commerce-customer-context/portal-auth/own-session';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The storefront customer's own profile, consents and password, as the real gate decides their carriers on a v2-only
 * tenant: only the registered storefront client (`commerce.storefront-client`) of this tenant, in a company its
 * binding is registered for, is admitted. No person — the tenant's owner included — no agent, no unbound or
 * unregistered workload and no other tenant's workload or company. Which Party a request reaches is then the owner
 * overlay's session rule (Customer Context's own unit suite).
 *
 * The five carriers are workload-only and company-required. They are read from Customer Context's public carrier table,
 * which its registered descriptors use and its unit suite pins them to (its private source is not importable here).
 */

/** The five carriers exactly as Customer Context registers them (its unit suite pins every descriptor to this table). */
const CARRIERS = Object.entries(PORTAL_OWN_CARRIER).map(
  ([label, carrier]) =>
    [
      label,
      {
        accessWorkload: Result.getOrThrow(
          decodeAccessWorkload(carrier.workload, {
            access: carrier.access,
            authorization: { kind: 'protected' },
            moduleKey: 'commerce.customer-context',
            role: carrier.role,
          }),
        ),
      },
    ] as const,
);

const answersFor = Effect.fn('PortalCarriers.answers')(function* answersFor(
  accessCase: AccessAdminCase,
  persona: Persona,
  company: string | undefined,
) {
  const scope = yield* accessCase.scopeFor(persona, company);
  return yield* Effect.forEach(
    CARRIERS,
    ([label, carrier]) => {
      const question: GateInput = {
        carrier,
        legalEntityScope: 'required',
        now: DECISION_AT,
        scope: { ...scope, tenantId: accessCase.tenantId },
      };
      return accessCase.gate
        .decide(question)
        .pipe(Effect.map((decision) => ({ codes: decision.reasons.map(({ code }) => code), label })));
    },
    { concurrency: 1 },
  );
});

const all = (codes: readonly string[]) => CARRIERS.map(([label]) => ({ codes, label }));

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the customer portal carriers admit the registered storefront client only',
  (suite) => {
    suite.effect('the storefront workload in its registered company, and nobody else anywhere', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* storefrontOnly() {
          const [companyA = '', companyB = ''] = accessCase.companies;
          const [foreign = ''] = accessCase.foreignCompanies;
          // No binding yet: the workload is refused as unbound.
          expect(yield* answersFor(accessCase, 'workload', companyA)).toEqual(all(['deny.workload_unbound']));
          yield* accessCase.bindWorkload({
            legalEntityIds: [companyA],
            persona: 'workload',
            workloadKey: 'commerce.storefront-client',
          });
          expect(yield* answersFor(accessCase, 'workload', companyA)).toEqual(all(['allow.workload']));
          // Another company of the same tenant its binding is not registered for: refused.
          expect(yield* answersFor(accessCase, 'workload', companyB)).toEqual(all(['deny.workload_unbound']));
          // Another tenant's company named in this tenant: refused by the company-of-tenant rule.
          expect(yield* answersFor(accessCase, 'workload', foreign)).toEqual(all(['deny.scope_mismatch']));
          // People never run these carriers, whatever they hold; an agent is refused as an agent before that.
          for (const persona of ['owner', 'companyAdmin', 'member'] as const) {
            expect(yield* answersFor(accessCase, persona, companyA)).toEqual(all(['deny.workload_only']));
          }
          expect(yield* answersFor(accessCase, 'agent', companyA)).toEqual(all(['deny.agent_forbidden']));
        }),
      ),
    );

    suite.effect("another tenant's principal presented in this tenant is refused", () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* otherTenant() {
          const [companyA = ''] = accessCase.companies;
          yield* accessCase.bindWorkload({
            legalEntityIds: [companyA],
            persona: 'workload',
            workloadKey: 'commerce.storefront-client',
          });
          const answers = yield* answersFor(accessCase, 'foreignOwner', companyA);
          expect(answers.every(({ codes }) => !codes.includes('allow.workload'))).toBe(true);
        }),
      ),
    );
  },
);
