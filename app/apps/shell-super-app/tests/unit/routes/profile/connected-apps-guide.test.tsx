// @rstest-environment happy-dom
// The guide under the Shell's real copy, copying through the test DOM's own clipboard.
import { settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import type { ComponentProps } from 'react';

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

const renderGuide = (clipboardEnvironment?: ComponentProps<typeof ConnectedAppsGuide>['clipboardEnvironment']) =>
  render(
    <ShellI18n translations={translations}>
      <ConnectedAppsGuide clipboardEnvironment={clipboardEnvironment} mcpUrl={url} />
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

it.live.each(['cs', 'en'] as const)('renders translated current instructions for all clients in %s', (language) =>
  Effect.sync(() => {
    const expectedCopy = shellLocaleCopy(language);
    const clients = connectGuide(url, (key, values) => expectedCopy.t(key, values ?? {}));
    const copy = expectedCopy.cloneInstance({ forkResourceStore: true, initAsync: false });
    copy.addResourceBundle(
      language,
      'translation',
      structuredClone(expectedCopy.getResourceBundle(language, 'translation')),
    );
    const view = render(
      <ShellI18n translations={copy}>
        <ConnectedAppsGuide mcpUrl={url} />
      </ShellI18n>,
    );
    // This component renders its instructions synchronously; no clipboard operation has started.
    expect(
      Array.from(view.container.querySelectorAll('section[aria-labelledby]'), (section) =>
        section.getAttribute('aria-labelledby')?.replace('mcp-guide-', ''),
      ),
    ).toEqual(['chatgpt', 'claude', 'claude-code', 'vscode', 'cursor']);
    const chatgpt = screen.getByRole('region', { name: 'ChatGPT' });
    expect(chatgpt.textContent).toContain('Plugins');
    expect(chatgpt.textContent).toContain('Add custom MCP server');
    expect(chatgpt.textContent).toContain('Business');
    expect(chatgpt.textContent).toContain('Enterprise');
    expect(chatgpt.textContent).toContain('Pro');
    expect(chatgpt.textContent).toContain('Create as a plugin');
    expect(chatgpt.textContent).not.toContain('Aplikace a konektory');
    expect(screen.getByRole('region', { name: 'Claude (claude.ai / Desktop)' }).textContent).toContain('Customize');
    expect(screen.getByRole('region', { name: 'VS Code' }).textContent).toContain('MCP: Add Server');
    expect(screen.getByRole('region', { name: 'Cursor' }).textContent).toContain('~/.cursor/mcp.json');
    expect(
      screen.getByRole('region', { name: expectedCopy.t('shell.connectedAppsGuide.title') }).textContent,
    ).not.toContain('https://ontos-stage.web-revolution.cz');
    for (const client of clients) {
      expect(
        within(view.container)
          .queryAllByRole('region', { name: client.title })
          .flatMap((section) => within(section).queryAllByRole('listitem')),
      ).toHaveLength(client.steps.length);
      const section = within(view.container).getByRole('region', { name: client.title });
      expect(within(section).queryByText(client.requirements)).toBeTruthy();
      expect(
        within(section)
          .queryByRole('link', { name: expectedCopy.t('shell.connectedAppsGuide.officialDocs') })
          ?.getAttribute('href'),
      ).toBe(client.docs);
      const prompt = section.querySelector('details p')?.textContent ?? '';
      expect(prompt).toContain(url);
      expect(prompt).toContain(client.title);
      expect(prompt).toContain('OAuth');
      expect(prompt).not.toContain('shell.connectedAppsGuide');
    }
  }),
);

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

it.live('copies the environment URL and client configurations exactly once each without credentials', () =>
  Effect.gen(function* copyConfigurations() {
    const writes: string[] = [];
    renderGuide({
      clipboard: {
        writeText: (value) => {
          writes.push(value);
          return Promise.resolve();
        },
      },
    });
    yield* click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    yield* waitUntil(() => screen.queryByRole('button', { name: 'Zkopírováno' }) !== null);
    const claudeCode = screen.getByRole('region', { name: 'Claude Code' });
    yield* click(within(claudeCode).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    yield* waitUntil(() => within(claudeCode).queryByRole('button', { name: 'Zkopírováno' }) !== null);
    const cursor = screen.getByRole('region', { name: 'Cursor' });
    yield* click(within(cursor).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    yield* waitUntil(() => within(cursor).queryByRole('button', { name: 'Zkopírováno' }) !== null);
    // Each success receipt follows its write promise. All three operations have completed before counting.
    expect(writes).toEqual([
      url,
      `claude mcp add --transport http ontos ${url}`,
      JSON.stringify({ mcpServers: { ontos: { url } } }),
    ]);
  }),
);

it.live('offers manual address copying when the browser has no clipboard API', () =>
  Effect.gen(function* missingClipboard() {
    renderGuide({});
    yield* click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    yield* waitUntil(() => screen.queryByRole('alert') !== null);
    expect(screen.getByRole('alert').textContent).toBe(translations.t('shell.connectedAppsGuide.copyUrlFailed'));
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
