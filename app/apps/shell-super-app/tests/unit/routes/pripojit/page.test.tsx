import { HttpApi } from '@modern-js/bff-effect/effect-client';
import {
  HttpApiBuilder,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from '@modern-js/bff-effect/effect-edge';
import { networkIdle, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { ConnectionGrantIdSchema, ConnectOptionsSchema } from '@app/shared-contracts/oauth-connections';
import type { ConnectDraftRequest } from '@app/shared-contracts/oauth-connections';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { shellAuthenticationApiContract } from '../../../../shared/browser-api.ts';
import { OAuthConnectApiGroup } from '../../../../shared/oauth-connect-api.ts';
import ConnectPage from '../../../../src/routes/[lang]/pripojit/page.tsx';
import { shellLocaleCopy } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';

const czech = shellLocaleCopy('cs');
const oauthQuery = 'client_id=https%3A%2F%2Fclaude.ai%2Fclient&sig=signed';
const connectUrl = `/cs/pripojit?${oauthQuery}`;

/** One company where the person may write to both modules and an agent may only propose changes to the CRM. */
const options = Schema.decodeUnknownSync(ConnectOptionsSchema)({
  client: { clientId: 'https://claude.ai/client', host: 'claude.ai', kind: 'cimd', logoUri: null, name: 'Claude' },
  companies: [
    {
      agents: [
        {
          displayName: 'Robot',
          modules: [
            { label: 'CRM', moduleId: 'crm', read: true, write: true },
            { label: 'Faktury', moduleId: 'invoices', read: true, write: false },
          ],
          principalId: 'agent-1',
          writePolicy: 'approval',
        },
      ],
      legalEntityId: 'company-1',
      legalName: 'Firma s.r.o.',
      modules: [
        { label: 'CRM', moduleId: 'crm', read: true, write: true },
        { label: 'Faktury', moduleId: 'invoices', read: true, write: true },
      ],
    },
  ],
  preselect: { agentPrincipalId: 'agent-1', legalEntityId: null },
  state: 'ready',
  user: { displayName: 'Ada', principalId: 'person-1' },
});

const ConnectApi = HttpApi.make('connect').add(OAuthConnectApiGroup).prefix(shellAuthenticationApiContract.apiPrefix);

/** The connect API and Better Auth's continue hand-off on the test DOM's network; `drafts` records each draft sent. */
const connectOrigin = () => {
  const drafts: ConnectDraftRequest[] = [];
  const handlers = HttpApiBuilder.group(ConnectApi, 'oauthConnect', (group) =>
    group
      .handle('connectOptions', () => Effect.succeed(options))
      .handle('connectDraft', ({ payload }) =>
        Effect.sync(() => {
          drafts.push(payload);
          return { grantId: ConnectionGrantIdSchema.make('grant-1') };
        }),
      )
      .handle('connectDraftSummary', () => Effect.die('The connect page never reads the summary'))
      .handle('connectApprove', () => Effect.die('The connect page never approves'))
      .handle('connectDeny', () => Effect.die('The connect page is not cancelled here')),
  );
  const handoff = HttpRouter.add(
    'POST',
    '/shell-super-app-api/oauth/oauth2/continue',
    Effect.gen(function* continueAuthorization() {
      yield* Effect.orDie(HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((request) => request.text)));
      return HttpServerResponse.jsonUnsafe({ url: 'https://claude.ai/callback' });
    }),
  );
  const application = Layer.mergeAll(HttpApiBuilder.layer(ConnectApi).pipe(Layer.provide(handlers)), handoff).pipe(
    Layer.provide(HttpServer.layerServices),
  );
  return { browser: streamingBrowserNetwork(application), drafts } as const;
};

afterEach(cleanup);

/** A radio button or checkbox by the Czech copy that names it. */
const radio = (name: string) => screen.getByRole('radio', { name });
const checkboxes = (key: string) => screen.getAllByRole('checkbox', { name: czech.t(key) });
const isChecked = (control: HTMLElement) => control.matches(':checked');
const checkedStates = (key: string) => checkboxes(key).map(isChecked);
const settled = (assertion: () => void) => Effect.promise(() => waitFor(assertion));
const click = (control: HTMLElement) => Effect.promise(() => userEvent.click(control));

it.effect('starts from the preselected agent, follows each choice and sends the draft the person chose', () =>
  Effect.gen(function* connectsWithPickedModules() {
    const origin = connectOrigin();
    const navigation = Promise.withResolvers<string | URL>();
    rstest.spyOn(window.location, 'assign').mockImplementation(navigation.resolve);
    window.history.replaceState(null, '', connectUrl);
    yield* Effect.gen(function* chooseAndContinue() {
      yield* renderShellRoute(
        makeShellRouter({ page: { component: ConnectPage, path: 'pripojit' }, url: connectUrl }),
        czech,
      );
      const asRobot = yield* Effect.promise(() =>
        screen.findByRole('radio', { name: czech.t('shell.connect.acting.agent', { name: 'Robot' }) }),
      );
      expect(isChecked(asRobot)).toBe(true);
      // The agent may only propose changes, so direct writing is not offered.
      expect(screen.queryByRole('radio', { name: czech.t('shell.connect.policy.direct') })).toBeNull();
      expect(isChecked(radio(czech.t('shell.connect.policy.approval')))).toBe(true);

      yield* click(radio(czech.t('shell.connect.access.pick')));
      yield* settled(() => expect(checkedStates('shell.connect.access.read')).toEqual([true, true]));
      expect(checkedStates('shell.connect.access.write')).toEqual([true, false]);
      expect(checkboxes('shell.connect.access.write').map((box) => box.matches(':disabled'))).toEqual([false, true]);

      // A module no longer read is no longer written.
      yield* click(checkboxes('shell.connect.access.read')[0] ?? document.body);
      yield* settled(() => expect(checkedStates('shell.connect.access.write')).toEqual([false, false]));

      // Acting as the person starts again from the person's own offer.
      yield* click(radio(czech.t('shell.connect.acting.me', { name: 'Ada' })));
      yield* settled(() => expect(checkedStates('shell.connect.access.read')).toEqual([true, true]));
      yield* click(screen.getByRole('button', { name: czech.t('shell.connect.continue') }));
      expect(yield* Effect.promise(() => navigation.promise)).toBe('https://claude.ai/callback');
      yield* networkIdle;
    }).pipe(Effect.provide(origin.browser));
    expect(origin.drafts).toHaveLength(1);
    expect(origin.drafts[0]?.modules).toEqual([
      { access: 'write', moduleId: 'crm' },
      { access: 'write', moduleId: 'invoices' },
    ]);
    expect(origin.drafts[0]?.writePolicy).toBe('approval');
    expect(origin.drafts[0]?.actingPrincipalId._tag).toBe('None');
  }),
);
