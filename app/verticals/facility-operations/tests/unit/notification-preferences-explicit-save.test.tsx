// @rstest-environment happy-dom
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { EmailReceiptsApi } from '@app/email-delivery/receipt-api';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { updatePersonalAgendaActionSchemaErrorLive } from '../../api/update-personal-agenda-action-problems.ts';
import { UpdatePersonalAgendaActionApi } from '../../shared/apis/update-personal-agenda-action.ts';
import type { UpdatePersonalAgendaPayloadSchema } from '../../shared/actions/personal-agenda.ts';
import { SettingsPanel } from '../../src/routes/[lang]/provoz/agenda/inbox.tsx';
import { facilitySaveOutcome } from '../../src/ui/facility-save.ts';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const requests: (typeof UpdatePersonalAgendaPayloadSchema.Encoded)[] = [];
const Owner = UpdatePersonalAgendaActionApi.prefix('/facility-operations-api');
const Email = EmailReceiptsApi.prefix('/shell-super-app-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    Email,
    HttpApiBuilder.group(Email, 'emailReceipts', (g) =>
      g
        .handle('provider', () => Effect.succeed({ configured: false, label: Option.none<string>() }))
        .handle('list', () => Effect.never),
    ),
  ),
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'updatePersonalAgendaAction', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          requests.push(payload);
          return { entityIds: [], revision: 2 };
        }),
      ),
    ).pipe(Layer.provide(updatePersonalAgendaActionSchemaErrorLive)),
  ),
);
const saveButton = () => Option.getOrThrow(Option.fromUndefinedOr(buttons(saveLabelsFor('cs').save)[0]));
afterEach(unmountAll);

it.live('keeps a changed email preference local until Save and sends the complete preference once', () =>
  Effect.gen(function* explicitPreferenceSave() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <SettingsPanel
        canWrite
        me="me"
        onSave={(value) =>
          facilitySaveOutcome(
            runCommand(
              {
                _tag: 'AgendaPreferencesSet',
                emailCategories: value.optional,
                emailOptIn: value.email,
                leadDays: Number(value.leadDays),
              },
              1,
            ),
          )
        }
      />,
      { path: 'provoz/agenda', url: '/cs/provoz/agenda' },
    );
    expect(saveButton().disabled).toBe(true);
    const email = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>('[role="switch"]')));
    yield* acted(() => email.click());
    yield* waitUntil(() => !saveButton().disabled);
    expect(saveButton().disabled).toBe(false);
    yield* networkIdle;
    expect(requests).toEqual([]);
    yield* acted(() => saveButton().click());
    yield* waitUntil(() => text().includes('Uloženo'));
    yield* networkIdle;
    expect(text()).toContain('Uloženo');
    expect(requests).toEqual([
      expect.objectContaining({
        command: {
          _tag: 'AgendaPreferencesSet',
          emailCategories: ['DEADLINE', 'CHANGE'],
          emailOptIn: true,
          leadDays: 14,
        },
        expectedRevision: 1,
      }),
    ]);
  }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
);
