// @rstest-environment happy-dom
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  AGENT_ACCESS_PATHS,
  AgentEntityOverviewSchema,
  ManageAgentEntityRequestSchema,
} from '@app/shared-contracts/agent-access';
import type { AgentEntitySchema, ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { browserNetwork, networkIdle } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { agentEntitiesData } from '../../src/routes/people/agent-data.ts';
import { AgentEntitiesSection } from '../../src/routes/people/agent-entities-section.tsx';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

const czech = shellLocaleCopy('cs');
const copy = (key: string) => {
  expect(czech.exists(key)).toBe(true);
  return czech.t(key);
};
const company = 'company';
const principalId = '00000000-0000-4000-8000-000000000004';
const AgentSection = () => <AgentEntitiesSection legalEntityId={company} onNotify={() => {}} />;

afterEach(cleanup);

for (const status of ['active', 'disabled'] as const) {
  it.live(
    `retains the original ${status} archive payload and key after a failed response and directory removal`,
    () => {
      let missing = false;
      const requests: { readonly key: string | undefined; readonly request: ManageAgentEntityRequest }[] = [];
      const agent: typeof AgentEntitySchema.Encoded = {
        connections: [],
        description: null,
        displayName: 'Asistent provozu',
        hasProfile: true,
        operators: [],
        operatorsRevision: 0,
        owner: null,
        principalId,
        roles: [],
        status,
        usable: [],
        writePolicy: 'approval',
      };
      const network = browserNetwork(
        Layer.mergeAll(
          HttpRouter.add(
            'POST',
            AGENT_ACCESS_PATHS.list,
            Effect.gen(function* listAgents() {
              const overview = yield* Schema.decodeUnknownEffect(AgentEntityOverviewSchema)({
                agents: missing ? [] : [agent],
                audit: [],
                company: { legalEntityId: company, legalName: 'Firma' },
                members: [],
                roles: [],
                rolesRevision: 'r0',
              });
              const encoded = yield* Schema.encodeEffect(AgentEntityOverviewSchema)(overview);
              return HttpServerResponse.jsonUnsafe(encoded);
            }).pipe(Effect.orDie),
          ),
          HttpRouter.add(
            'POST',
            AGENT_ACCESS_PATHS.manage,
            Effect.gen(function* archiveAgent() {
              const incoming = yield* HttpServerRequest.HttpServerRequest;
              const request = yield* Schema.decodeUnknownEffect(ManageAgentEntityRequestSchema)(yield* incoming.json);
              requests.push({ key: incoming.headers['idempotency-key'], request });
              return HttpServerResponse.jsonUnsafe({ detail: 'Přerušeno' }, { status: 409 });
            }).pipe(Effect.orDie),
          ),
        ),
      );
      return Effect.gen(function* retainArchivePayload() {
        yield* agentEntitiesData.refresh(company);
        yield* renderShellRoute(
          makeShellRouter({ page: { component: AgentSection, path: 'people' }, url: '/cs/people' }),
          czech,
        );
        yield* settle;
        yield* acted(() => {
          fireEvent.click(screen.getByRole('button', { name: copy('shell.agents.section.delete') }));
        });
        const confirmName = copy('shell.agents.section.dialog.deleteConfirm');
        yield* acted(() => {
          fireEvent.click(screen.getByRole('button', { name: confirmName }));
        });
        expect(screen.getByText(copy('shell.agents.section.dialog.reasonRequired'))).toBeTruthy();
        yield* networkIdle;
        expect(requests).toHaveLength(0);
        yield* Effect.promise(() => userEvent.type(screen.getByRole('textbox'), '  Ukončení provozu  '));
        yield* acted(() => {
          fireEvent.click(screen.getByRole('button', { name: confirmName }));
        });
        yield* Effect.promise(() => screen.findByText('Přerušeno'));
        missing = true;
        yield* agentEntitiesData.refresh(company);
        yield* settle;
        expect(screen.queryByText(agent.displayName)).toBeNull();
        yield* acted(() => {
          fireEvent.click(screen.getByRole('button', { name: confirmName }));
        });
        yield* waitUntil(() => requests.length === 2);
        yield* networkIdle;
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual({
          key: expect.stringMatching(/^agent-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u),
          request: {
            expectedStatus: status,
            operation: 'delete',
            principalId,
            reason: 'Ukončení provozu',
          },
        });
        expect(requests[1]).toEqual(requests[0]);
        expect(new Set(requests.map(({ key }) => key)).size).toBe(1);
        yield* Effect.promise(() => screen.findByText('Přerušeno'));
      }).pipe(Effect.provide(network));
    },
  );
}
