// @rstest-environment happy-dom
import { settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { AGENT_ACCESS_PATHS, AgentEntityOverviewSchema } from '@app/shared-contracts/agent-access';
import type { AgentEntityOverview } from '@app/shared-contracts/agent-access';
import { browserNetwork, pinTestDocument, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { cleanup, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { agentEntitiesData } from '../../src/routes/people/agent-data.ts';
import { AgentEntitiesSection } from '../../src/routes/people/agent-entities-section.tsx';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

const target = '00000000-0000-4000-8000-000000000003';
const agentName = 'Asistent provozu';
const linkedUrl = `/cs/people?agent=${target}`;
const czech = shellLocaleCopy('cs');
const copy = (key: string) => {
  expect(czech.exists(key), `${key} has cs copy`).toBe(true);
  return czech.t(key);
};
const editorTitle = () => {
  expect(czech.exists('shell.agents.editor.editTitle')).toBe(true);
  return czech.t('shell.agents.editor.editTitle', { name: agentName });
};

const overview = (hasProfile = true, principalId = target) =>
  Schema.decodeUnknownSync(AgentEntityOverviewSchema)({
    agents: [
      {
        connections: [],
        description: null,
        displayName: agentName,
        hasProfile,
        operators: [],
        operatorsRevision: 0,
        owner: null,
        principalId,
        roles: [],
        status: 'active',
        usable: [],
        writePolicy: 'approval',
      },
    ],
    audit: [],
    company: { legalEntityId: 'company', legalName: 'Firma' },
    members: [],
    roles: [],
    rolesRevision: 'r0',
  });

// Opening the real editor also reads the agent's keys through the Shell's typed identity endpoint.
const keysApi = HttpApi.make('linkedAgentKeys')
  .add(HttpApiGroup.make('identity').add(ShellAuthenticationApi.groups.identity.endpoints.listManagedApiKeys))
  .prefix(shellAuthenticationApiContract.apiPrefix);
const keys = serveApi(
  keysApi,
  HttpApiBuilder.group(keysApi, 'identity', (group) =>
    group.handle('listManagedApiKeys', () => Effect.succeed({ items: [], nextOffset: null })),
  ),
);

const agentNetwork = (read: () => AgentEntityOverview, forbidden = false) =>
  browserNetwork(
    HttpRouter.add(
      'POST',
      AGENT_ACCESS_PATHS.list,
      Effect.suspend(() =>
        forbidden
          ? HttpServerResponse.json({ detail: copy('shell.agents.errors.forbidden') }, { status: 403 })
          : Schema.encodeEffect(AgentEntityOverviewSchema)(read()).pipe(Effect.flatMap(HttpServerResponse.json)),
      ).pipe(Effect.orDie),
    ),
    keys,
  );

// A company change comes through the route loader while the same section remains mounted.
const AgentsPage = () => {
  const company = Schema.decodeUnknownSync(Schema.String)(useLoaderData({ strict: false }));
  return <AgentEntitiesSection legalEntityId={company} onNotify={() => {}} />;
};
const agentRouter = (company: () => string = () => 'company') =>
  makeShellRouter({
    page: { component: AgentsPage, loaderData: company, path: 'people' },
    url: linkedUrl,
  });

const editorName = () => screen.getByRole('textbox', { name: new RegExp(copy('shell.agents.editor.name'), 'u') });
const editor = () => screen.queryByRole('dialog', { name: editorTitle() });

afterEach(cleanup);

it.live('opens the linked real agent editor in-place, without a workforce route or redirect', () =>
  Effect.gen(function* openLinkedAgent() {
    yield* pinTestDocument;
    yield* agentEntitiesData.refresh('company');
    const router = agentRouter();
    yield* renderShellRoute(router, czech);
    yield* waitUntil(() => editor() !== null);
    expect(editorName().getAttribute('value')).toBe(agentName);
    expect(router.state.location.href).toBe(linkedUrl);
    yield* waitUntil(() => screen.queryByText(copy('shell.agents.keys.empty')) !== null);
  }).pipe(Effect.provide(agentNetwork(() => overview()))),
);

it.live('shows an absent profile honestly and an agent without roles as having no rights', () =>
  Effect.gen(function* absentAgentProfile() {
    yield* pinTestDocument;
    yield* agentEntitiesData.refresh('company');
    yield* renderShellRoute(agentRouter(), czech);
    yield* waitUntil(() => editor() !== null);
    expect(screen.getByText(copy('shell.agents.section.noProfile'))).toBeTruthy();
    expect(screen.queryByText(copy('shell.agents.connections.policy.approval'))).toBeNull();
    // Rights come only from roles: an agent with none says so, and nothing it could use is listed.
    expect(screen.getByText(copy('shell.agents.roles.badgeNone'))).toBeTruthy();
    expect(screen.getByText(copy('shell.agents.roles.none'))).toBeTruthy();
    expect(screen.getByText(copy('shell.agents.roles.usableNone'))).toBeTruthy();
  }).pipe(Effect.provide(agentNetwork(() => overview(false)))),
);

it.live('drops an old agent detail when the selected company no longer admits that principal', () => {
  let company = 'company';
  let answer = overview();
  return Effect.gen(function* dropUnadmittedAgent() {
    yield* pinTestDocument;
    yield* agentEntitiesData.refresh(company);
    const router = agentRouter(() => company);
    yield* renderShellRoute(router, czech);
    yield* waitUntil(() => editor() !== null);
    yield* waitUntil(() => screen.queryByText(copy('shell.agents.keys.empty')) !== null);

    company = 'other-company';
    answer = overview(true, '00000000-0000-4000-8000-000000000009');
    yield* agentEntitiesData.refresh(company);
    yield* Effect.promise(async () => await router.invalidate());
    yield* settle;
    expect(editor()).toBeNull();
  }).pipe(Effect.provide(agentNetwork(() => answer)));
});

it.live('does not render an admin-only creation control for a member without agent administration', () =>
  Effect.gen(function* forbiddenAgentAdministration() {
    yield* pinTestDocument;
    yield* agentEntitiesData.refresh('forbidden-company');
    yield* renderShellRoute(
      agentRouter(() => 'forbidden-company'),
      czech,
    );
    yield* waitUntil(() => screen.queryByText(copy('shell.agents.errors.forbidden')) !== null);
    expect(screen.queryByRole('button', { name: copy('shell.agents.section.create') })).toBeNull();
  }).pipe(Effect.provide(agentNetwork(() => overview(), true))),
);
