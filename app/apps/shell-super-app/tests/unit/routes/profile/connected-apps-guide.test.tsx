// @rstest-environment happy-dom
// The guide under the Shell's real copy, copying through the test DOM's own clipboard.
import { settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { connectGuide } from '../../../../src/routes/[lang]/profile/connected-apps-guide-model.ts';
import { ConnectedAppsGuide } from '../../../../src/routes/[lang]/profile/connected-apps-guide.tsx';
import { ShellI18n, shellLocaleCopy } from '../../../support/shell-i18n.tsx';

const translations = shellLocaleCopy('cs');
const translate = (key: string, values?: Record<string, string>) => translations.t(key, values ?? {});
const url = 'https://tenant.example.test/mcp';

/** The clipboard's own permission; TypeScript's DOM names omit `clipboard-write`, so it is read as the DOM spells it. */
const clipboardWrite: PermissionDescriptor = JSON.parse('{"name":"clipboard-write"}');

/** Sets the page's clipboard permission, as the person granted or refused it. */
const setClipboardPermission = async (state: PermissionState) => {
  Reflect.set(await navigator.permissions.query(clipboardWrite), 'state', state);
};
const clipboardPermission = (state: PermissionState) => Effect.promise(async () => await setClipboardPermission(state));

afterEach(async () => {
  cleanup();
  await setClipboardPermission('granted');
});

const renderGuide = () =>
  render(
    <ShellI18n translations={translations}>
      <ConnectedAppsGuide mcpUrl={url} />
    </ShellI18n>,
  );

const clipboardText = Effect.promise(async () => await navigator.clipboard.readText());

/** Settles until the clipboard holds `expected`; returns what it holds. */
const clipboardHolds = (expected: string, attempts = 400): Effect.Effect<string> =>
  clipboardText.pipe(
    Effect.flatMap((held) =>
      held === expected || attempts === 0
        ? Effect.succeed(held)
        : settle.pipe(Effect.andThen(clipboardHolds(expected, attempts - 1))),
    ),
  );

const click = (element: HTMLElement) =>
  Effect.sync(() => {
    fireEvent.click(element);
  }).pipe(Effect.andThen(settle));

it.live.each(['ChatGPT', 'Claude (claude.ai / Desktop)', 'Claude Code', 'VS Code', 'Cursor'])(
  'copies a Czech OAuth-only guided prompt for %s with a real read-only check',
  (title) =>
    Effect.gen(function* copyGuidedPrompt() {
      renderGuide();
      const client = connectGuide(url, translate).find((entry) => entry.title === title);
      const section = screen.getByRole('region', { name: title });
      yield* click(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' }));
      const prompt = yield* clipboardHolds(client?.prompt ?? '');
      expect(prompt).toBe(client?.prompt);
      yield* waitUntil(() => within(section).queryByRole('button', { name: 'Zkopírováno' }) !== null);
      expect(prompt).toContain(url);
      expect(prompt).toContain('Konektor nemůžeš přidat za mě');
      expect(prompt).toContain('Hesla, API klíče ani tokeny ode mě nikdy nechtěj');
      expect(prompt).toContain('skutečně zavolej dostupné nástroje OntOS pouze pro čtení');
      expect(prompt).toContain('Nic neměň, nevytvářej ani nemaž');
      expect(prompt).toContain('netvrď, že je spojení ověřené bez úspěšného volání');
    }),
);

it.live('copies the environment URL and client configurations without credentials', () =>
  Effect.gen(function* copyConfigurations() {
    renderGuide();
    yield* click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    expect(yield* clipboardHolds(url)).toBe(url);
    const claudeCode = screen.getByRole('region', { name: 'Claude Code' });
    yield* click(within(claudeCode).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    const command = `claude mcp add --transport http ontos ${url}`;
    expect(yield* clipboardHolds(command)).toBe(command);
    const cursor = screen.getByRole('region', { name: 'Cursor' });
    yield* click(within(cursor).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    const configuration = JSON.stringify({ mcpServers: { ontos: { url } } }, null, 2);
    const held = yield* clipboardHolds(configuration);
    expect(JSON.parse(held)).toEqual({ mcpServers: { ontos: { url } } });
  }),
);

it.live('exposes the prompt for manual copying when clipboard access fails', () =>
  Effect.gen(function* refusedClipboard() {
    yield* clipboardPermission('denied');
    renderGuide();
    const section = screen.getByRole('region', { name: 'ChatGPT' });
    yield* click(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' }));
    yield* waitUntil(() => within(section).queryByRole('alert')?.textContent?.includes('Rozbalte') === true);
    const details = section.querySelector('details');
    expect(details?.textContent).toContain(url);
    expect(details?.textContent).toContain('OAuth');
    expect(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' })).toBeTruthy();
    // The address falls back to manual selection the same way.
    yield* click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    yield* waitUntil(() =>
      screen.queryAllByRole('alert').some((alert) => (alert.textContent ?? '').includes('označte adresu ručně')),
    );
  }),
);
