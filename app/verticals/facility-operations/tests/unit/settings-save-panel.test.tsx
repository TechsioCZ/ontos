// @rstest-environment happy-dom
// The notification settings form: a toggle changes only the draft. Nothing is sent while the user types, waits or
// leaves; the one Uložit button sends the whole draft once.
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { EmailReceiptsApi } from '@app/email-delivery/receipt-api';
import { browserNetwork, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Option } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { SettingsPanel } from '../../src/routes/[lang]/provoz/agenda/inbox.tsx';
import { mountInRoute } from '../support/module-ui.ts';

type SaveSettings = Parameters<typeof SettingsPanel>[0]['onSave'];

const EmailApi = EmailReceiptsApi.prefix('/shell-super-app-api');
const network = browserNetwork(
  serveApi(
    EmailApi,
    HttpApiBuilder.group(EmailApi, 'emailReceipts', (group) =>
      group.handle('provider', () => Effect.never).handle('list', () => Effect.never),
    ),
  ),
);

const saveButton = (): HTMLButtonElement => Option.getOrThrow(Option.fromUndefinedOr(buttons('Uložit')[0]));
const emailSwitch = (): HTMLElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>('[role="switch"]')));

afterEach(unmountAll);

describe('notification settings save', () => {
  it.live('a toggle waits without sending; Uložit sends the draft once', () =>
    Effect.gen(function* explicitSave() {
      const saves: Parameters<SaveSettings>[0][] = [];
      const saved = yield* Deferred.make<boolean>();
      const onSave: SaveSettings = (value) =>
        Effect.sync((): SaveOutcome => {
          saves.push(value);
          return 'saved';
        }).pipe(Effect.tap(() => Deferred.succeed(saved, true)));
      yield* mountInRoute(<SettingsPanel canWrite me="me" onSave={onSave} />, {
        path: 'provoz/agenda',
        url: '/cs/provoz/agenda',
      });

      expect(saveButton().disabled).toBe(true);

      yield* acted(() => emailSwitch().click());
      expect(saveButton().disabled).toBe(false);

      yield* Effect.sleep('1 second');
      expect(saves).toHaveLength(0);

      yield* acted(() => saveButton().click());
      yield* Deferred.await(saved);
      expect(saves).toHaveLength(1);

      yield* waitUntil(() => text().includes('Uloženo'));
      expect(text().includes('Uloženo')).toBe(true);
      expect(saves).toHaveLength(1);
    }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
  );
});
