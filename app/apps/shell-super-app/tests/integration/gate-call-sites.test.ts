import type { DemoAccountGrants } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { lifecycleQuestionOf } from '../../../../packages/core-runtime/src/auth/agent-proposal-command-preparation.ts';
import { prepareRevocationNotes } from '../../../../packages/core-runtime/src/auth/oauth-connection-revocation-notes-read.ts';
import { OAuthGrantOwners } from '../../../../packages/core-runtime/src/auth/oauth-grant-owners.ts';
import { preparePeopleSearch } from '../../../../packages/core-runtime/src/people/people-search.ts';
import { CoreSearchQueryRuntime } from '../../../../packages/core-runtime/src/search/query-runtime.ts';
import { connectedAppsAdministration, tenantReleaseHintAdmitted } from '../../api/auth/administration-access.ts';
import { requireAdministrator } from '../../api/auth/demo-accounts.ts';
import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The gate questions the legacy rows moved to, asked through the very function each production call site runs, over
 * the real gate on a v2-only tenant. Each test asserts an admitted person AND a refused one, so it fails if the call
 * site stops asking the gate (everyone would then get one answer). The helpers' own answers are covered by
 * `legacy-context-access-v2.test.ts`; this suite pins where they are called.
 */

/** Values whose shape the code under test reads only in part, built without a type assertion. */
const untyped = Schema.decodeUnknownSync(Schema.Any);

/** The selected-company scope of one persona; the other tenant's owner is presented with THIS tenant and company. */
const companyScopeOf = Effect.fn('CallSites.companyScope')(function* companyScopeOf(
  accessCase: AccessAdminCase,
  persona: Persona,
  company?: string,
) {
  const legalEntityId = company ?? accessCase.companies[0] ?? '';
  const scope = yield* accessCase.scopeFor(persona, legalEntityId);
  return { ...scope, legalEntityId, tenantId: accessCase.tenantId };
});

const withGate = (accessCase: AccessAdminCase) => Effect.provideService(AccessDecisionGate, accessCase.gate);

/** `requireAdministrator`: the agent-management handlers' gate question, then the company's members. */
const administers = Effect.fn('CallSites.requireAdministrator')(function* administers(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const grants: DemoAccountGrants = untyped({ companyMembers: () => Effect.succeed([]) });
  const exit = yield* Effect.exit(
    requireAdministrator({ legalName: 'Case company', principal: yield* companyScopeOf(accessCase, persona) }, grants),
  );
  return Exit.isSuccess(exit);
});

/** The People search read's `prepare`: the hits it lets through for one person of the selected company. */
const peopleHits = Effect.fn('CallSites.peopleHits')(function* peopleHits(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = yield* companyScopeOf(accessCase, persona);
  const owner = accessCase.ids.get('owner')?.principalId ?? '';
  const hit = untyped({
    archived: false,
    ref: {
      moduleId: 'core.identity',
      resourceId: `${scope.legalEntityId}.${owner}`,
      resourceType: 'core.identity.person',
      tenantId: accessCase.tenantId,
    },
    selectedLegalEntityId: scope.legalEntityId,
  });
  return yield* preparePeopleSearch({ query: 'owner' }, { readKey: 'core.identity.people', scope }).pipe(
    Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
    withGate(accessCase),
  );
});

/** The revocation-notes read's `prepare`: whose notes it lets a person read (their own, or everyone's). */
const notesReadable = Effect.fn('CallSites.notesReadable')(function* notesReadable(
  accessCase: AccessAdminCase,
  persona: Persona,
  grants: { readonly mine: string; readonly theirs: string },
) {
  const scope = yield* companyScopeOf(accessCase, persona);
  const other = persona === 'owner' ? 'member' : 'owner';
  const owners = [
    { grantId: grants.mine, principal: scope.principalId },
    { grantId: grants.theirs, principal: accessCase.ids.get(other)?.principalId ?? '' },
  ].map(({ grantId, principal }) => ({
    grantId,
    legalEntityId: scope.legalEntityId,
    tenantId: scope.tenantId,
    userPrincipalId: principal,
  }));
  const readable = yield* prepareRevocationNotes(untyped({ grantIds: [grants.mine, grants.theirs] }), {
    readKey: 'core.identity.oauth-connection-revocation-notes',
    scope,
  }).pipe(
    Effect.provideService(OAuthGrantOwners, { owners: () => Effect.succeed(untyped(owners)) }),
    withGate(accessCase),
  );
  return [...readable].toSorted();
});

/** The connected-apps handlers' admin question for one persona in one company. */
const connectedAppsFor = Effect.fn('CallSites.connectedApps')(function* connectedAppsFor(
  accessCase: AccessAdminCase,
  persona: Persona,
  company: string | undefined,
) {
  return yield* connectedAppsAdministration(yield* companyScopeOf(accessCase, persona, company));
});

/** The release-hint question for one persona in the tenant context. */
const releaseHintFor = Effect.fn('CallSites.releaseHint')(function* releaseHintFor(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = yield* accessCase.scopeFor(persona);
  return yield* tenantReleaseHintAdmitted({ ...scope, tenantId: accessCase.tenantId });
});

/**
 * The withdrawal's lifecycle question exactly as the preflight builds it (`lifecycleQuestionOf`), answered by the real
 * gate. Its preparation and in-transaction re-check are pinned by the preparation's own unit suite.
 */
const lifecycleFor = Effect.fn('CallSites.lifecycle')(function* lifecycleFor(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = yield* companyScopeOf(accessCase, persona);
  return (yield* accessCase.gate.decide(lifecycleQuestionOf(scope, DECISION_AT))).outcome;
});

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the gate questions are asked at their call sites',
  (suite) => {
    suite.effect('agent management: requireAdministrator admits the company administrators only', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* agentManagement() {
          expect(yield* administers(accessCase, 'owner')).toBe(true);
          expect(yield* administers(accessCase, 'companyAdmin')).toBe(true);
          expect(yield* administers(accessCase, 'member')).toBe(false);
          expect(yield* administers(accessCase, 'foreignOwner')).toBe(false);
        }).pipe(withGate(accessCase)),
      ),
    );

    suite.effect('People search prepare: hits only for those the People list admits', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* peopleSearch() {
          expect(yield* peopleHits(accessCase, 'owner')).toHaveLength(1);
          expect(yield* peopleHits(accessCase, 'member')).toEqual([]);
          // A company access administrator is not a holder of the list right (see the People agreement suite).
          expect(yield* peopleHits(accessCase, 'companyAdmin')).toEqual([]);
          expect(yield* peopleHits(accessCase, 'foreignOwner')).toEqual([]);
        }),
      ),
    );

    suite.effect("revocation notes prepare: others' notes only for connected-apps administrators", () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* revocationNotes() {
          const grants = {
            mine: '00000000-0000-4000-8000-0000000000a1',
            theirs: '00000000-0000-4000-8000-0000000000a2',
          };
          expect(yield* notesReadable(accessCase, 'owner', grants)).toEqual([grants.mine, grants.theirs]);
          expect(yield* notesReadable(accessCase, 'companyAdmin', grants)).toEqual([grants.mine, grants.theirs]);
          expect(yield* notesReadable(accessCase, 'member', grants)).toEqual([grants.mine]);
        }),
      ),
    );

    suite.effect('release hint: only for those tenant-context page dispatch admits', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* releaseHint() {
          expect(yield* releaseHintFor(accessCase, 'owner')).toBe(true);
          expect(yield* releaseHintFor(accessCase, 'member')).toBe(false);
          expect(yield* releaseHintFor(accessCase, 'foreignOwner')).toBe(false);
        }).pipe(withGate(accessCase)),
      ),
    );

    suite.effect('connected apps: the handlers see a company administrator only where they administer', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* connectedApps() {
          const [companyA, companyB] = accessCase.companies;
          expect(yield* connectedAppsFor(accessCase, 'owner', companyA)).toBe(true);
          expect(yield* connectedAppsFor(accessCase, 'companyAdmin', companyA)).toBe(true);
          expect(yield* connectedAppsFor(accessCase, 'companyAdmin', companyB)).toBe(false);
          expect(yield* connectedAppsFor(accessCase, 'member', companyA)).toBe(false);
          expect(yield* connectedAppsFor(accessCase, 'foreignOwner', companyA)).toBe(false);
        }).pipe(withGate(accessCase)),
      ),
    );

    suite.effect('agent withdrawal: the question the preflight prepares admits the agent administrators only', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* withdrawal() {
          expect(yield* lifecycleFor(accessCase, 'owner')).toBe('ALLOWED');
          expect(yield* lifecycleFor(accessCase, 'companyAdmin')).toBe('ALLOWED');
          expect(yield* lifecycleFor(accessCase, 'member')).toBe('DENIED');
          expect(yield* lifecycleFor(accessCase, 'foreignOwner')).toBe('DENIED');
        }),
      ),
    );
  },
);
