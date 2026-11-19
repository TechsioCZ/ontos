// @rstest-environment happy-dom
import { acted } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  testCompositionRevision,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { cleanup, screen } from '@testing-library/react';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi, ShellTargetForbiddenProblemSchema } from '../../shared/browser-api.ts';
import type { ShellTargetForbiddenProblem } from '../../shared/browser-api.ts';
import { PeopleListResponseSchema } from '../../shared/people-api.ts';
import type { PeopleList } from '../../shared/people-api.ts';
import { PeopleView } from '../../src/routes/people/people-view.tsx';
import type { PeoplePageModel } from '../../src/routes/people/people-page-model.ts';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';

const companyId = '20000000-0000-4000-8000-000000000001';
const otherCompanyId = '20000000-0000-4000-8000-000000000002';
const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const missingPrincipalId = '00000000-0000-4000-8000-000000000004';
const principalRef = { principalId, tenantId };
const membership = {
  affiliation: 'external',
  legalEntityId: companyId,
  principalRef,
  revision: 1,
  status: 'invited',
} as const;
const person = {
  displayName: 'Jana Nováková',
  invitationDelivery: null,
  kind: 'human',
  principalRef,
  principalStatus: 'active',
  selectedCompanyMembership: membership,
} as const;
const list = {
  items: [person],
  nextOffset: null,
  scope: { _tag: 'company', legalEntityId: companyId },
  tenantId,
} as const;
const czech = shellLocaleCopy('cs');
const model = (): PeoplePageModel => ({
  peoplePage: true,
  shell: { ...authenticatedShellFixture(), compositionRevision: testCompositionRevision },
});
const contract = ShellAuthenticationApi.groups;
const PeopleApi = HttpApi.make('peopleDeepLink')
  .add(HttpApiGroup.make('peopleAdministration').add(contract.peopleAdministration.endpoints.listCompanyPeople))
  .add(
    HttpApiGroup.make('accessAdminPeople')
      .add(contract.accessAdminPeople.endpoints.listAccessPeople)
      .add(contract.accessAdminPeople.endpoints.listAccessPeopleOptions),
  )
  .add(HttpApiGroup.make('oauthConnectionsAdmin').add(contract.oauthConnectionsAdmin.endpoints.listAgentEntities))
  .prefix('/shell-super-app-api');
const accessOptions = Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
  admissionCandidates: [],
  capabilities: [],
  managers: [],
  people: [],
  revision: 'people-revision-1',
  roles: [],
  scopes: [],
  teams: [],
  writeAvailability: {
    canAdmitMember: false,
    canAssign: false,
    canDelegate: false,
    canEndMembership: false,
    canManageTeams: false,
    canRevokeDelegation: false,
    canTransferOwnership: false,
    canUnassign: false,
  },
});
const accessPeople = Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
  items: [],
  nextCursor: null,
  revision: 'people-revision-1',
});
const forbidden = ShellTargetForbiddenProblemSchema.make({
  detail: 'K této správě nemáte oprávnění.',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/shell-target-forbidden',
});
let directoryAnswer: Effect.Effect<PeopleList, ShellTargetForbiddenProblem>;
const handlers = Layer.mergeAll(
  HttpApiBuilder.group(PeopleApi, 'peopleAdministration', (group) =>
    group.handle('listCompanyPeople', () => Effect.suspend(() => directoryAnswer)),
  ),
  HttpApiBuilder.group(PeopleApi, 'accessAdminPeople', (group) =>
    group
      .handle('listAccessPeople', () => Effect.succeed(accessPeople))
      .handle('listAccessPeopleOptions', () => Effect.succeed(accessOptions)),
  ),
  HttpApiBuilder.group(PeopleApi, 'oauthConnectionsAdmin', (group) =>
    group.handle('listAgentEntities', () => Effect.fail(forbidden)),
  ),
);
const network = browserNetwork(serveApi(PeopleApi, handlers));
const mountPeople = (search = '') =>
  Effect.gen(function* mountPeopleRoute() {
    yield* pinTestDocument;
    expect(czech.exists('shell.people.detail.foreignCompany')).toBe(true);
    const query = search === '' ? '' : `?${search}`;
    const router = makeShellRouter({
      page: { component: () => <PeopleView model={model()} />, path: 'people' },
      url: `/cs/people${query}`,
    });
    yield* renderShellRoute(router, czech);
  });

afterEach(cleanup);
beforeEach(() => {
  directoryAnswer = Effect.succeed(Schema.decodeUnknownSync(PeopleListResponseSchema)(list));
});

it.live('a cold company-qualified link opens the real person detail and its existing administration actions', () =>
  Effect.gen(function* qualifiedColdLink() {
    yield* mountPeople(`person=${companyId}.${principalId}`);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Upravit členství' })).toBeDefined();
  }).pipe(Effect.provide(network)),
);

it.live('a link qualified with another company is refused instead of selecting the same principal locally', () =>
  Effect.gen(function* foreignCompany() {
    yield* mountPeople(`person=${otherCompanyId}.${principalId}`);
    yield* Effect.promise(() => screen.findByText(czech.t('shell.people.detail.foreignCompany')));
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a malformed person link is refused while a valid agent link keeps its own tab', () =>
  Effect.gen(function* malformedPerson() {
    yield* mountPeople('agent=00000000-0000-4000-8000-000000000099&person=broken-person');
    // The directory read the page started has been answered, so a person it wrongly selected would be open by now.
    yield* networkIdle;
    expect(screen.getByRole('button', { name: 'AI agenti' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a qualified person absent from the governed directory stays a truthful missing state', () =>
  Effect.gen(function* missingPerson() {
    yield* mountPeople(`person=${companyId}.${missingPrincipalId}`);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a forbidden governed directory read shows its denial and never claims or opens a person', () =>
  Effect.gen(function* forbiddenRead() {
    directoryAnswer = Effect.fail(forbidden);
    yield* mountPeople(`person=${companyId}.${principalId}`);
    yield* Effect.promise(() => screen.findByText('K této správě nemáte oprávnění.'));
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a refused reread removes a previously opened person and administration actions', () =>
  Effect.gen(function* refusedReread() {
    yield* mountPeople(`person=${companyId}.${principalId}`);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    directoryAnswer = Effect.fail(forbidden);
    yield* acted(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    yield* Effect.promise(() => screen.findByText('K této správě nemáte oprávnění.'));
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Spravovat role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upravit členství' })).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a row with the same principal but another company membership is not the linked person', () =>
  Effect.gen(function* foreignMembership() {
    directoryAnswer = Effect.succeed(
      Schema.decodeUnknownSync(PeopleListResponseSchema)({
        ...list,
        items: [{ ...person, selectedCompanyMembership: { ...membership, legalEntityId: otherCompanyId } }],
      }),
    );
    yield* mountPeople(`person=${companyId}.${principalId}`);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('a row from another tenant is not the linked person', () =>
  Effect.gen(function* foreignTenant() {
    directoryAnswer = Effect.succeed(
      Schema.decodeUnknownSync(PeopleListResponseSchema)({
        ...list,
        items: [{ ...person, principalRef: { ...principalRef, tenantId: otherTenantId } }],
      }),
    );
    yield* mountPeople(`person=${companyId}.${principalId}`);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('the existing people page still lists people without a deep link', () =>
  Effect.gen(function* existingPage() {
    yield* mountPeople();
    yield* Effect.promise(() => screen.findByRole('table'));
    expect(screen.getByText('Jana Nováková')).toBeDefined();
    yield* networkIdle;
    expect(screen.queryByRole('dialog')).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('the existing unqualified person bookmark keeps working', () =>
  Effect.gen(function* legacyBookmark() {
    yield* mountPeople(`person=${principalId}`);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
  }).pipe(Effect.provide(network)),
);
