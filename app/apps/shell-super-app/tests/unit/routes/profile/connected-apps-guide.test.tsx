import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it as test, rstest } from 'effect-rstest';
import { Effect } from 'effect';
import { createInstance } from 'i18next';

import cs from '../../../../locales/cs/shell.json';
import en from '../../../../locales/en/shell.json';
import { connectGuide } from '../../../../src/routes/[lang]/profile/connected-apps-guide-model.ts';
import { ConnectedAppsGuide } from '../../../../src/routes/[lang]/profile/connected-apps-guide.tsx';

const i18n = createInstance();
void i18n.init({ initAsync: false, lng: 'cs', resources: { cs: { translation: cs }, en: { translation: en } } });

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ t: i18n.t.bind(i18n) }),
}));

const translate = (key: string, values?: Record<string, string>) => i18n.t(key, values ?? {});

const url = 'https://tenant.example.test/mcp';

beforeEach(async () => {
  await i18n.changeLanguage('cs');
});

afterEach(() => {
  cleanup();
  rstest.restoreAllMocks();
  rstest.unstubAllGlobals();
});

test.effect.each(['cs', 'en'])('renders translated current instructions for all clients in %s', (language) =>
  Effect.promise(async () => {
    await i18n.changeLanguage(language);
    render(<ConnectedAppsGuide mcpUrl={url} />);
    const clients = connectGuide(url, translate);
    expect(clients.map((client) => client.id)).toEqual(['chatgpt', 'claude', 'claude-code', 'vscode', 'cursor']);
    for (const client of clients) {
      const section = screen.getByRole('region', { name: client.title });
      expect(within(section).getAllByRole('listitem')).toHaveLength(client.steps.length);
      expect(within(section).getByText(client.requirements)).toBeTruthy();
      expect(within(section).getByRole('link').getAttribute('href')).toBe(client.docs);
      expect(client.prompt).toContain(url);
      expect(client.prompt).toContain(client.title);
      expect(client.prompt).toContain('OAuth');
      expect(client.prompt).not.toContain('shell.connectedAppsGuide');
    }
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
    expect(screen.getByRole('region', { name: i18n.t('shell.connectedAppsGuide.title') }).textContent).not.toContain(
      'https://ontos-stage.techsio.cz',
    );
  }),
);

test.effect.each(['ChatGPT', 'Claude (claude.ai / Desktop)', 'Claude Code', 'VS Code', 'Cursor'])(
  'copies a Czech OAuth-only guided prompt for %s with a real read-only check',
  (title) =>
    Effect.promise(async () => {
      const write = rstest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      render(<ConnectedAppsGuide mcpUrl={url} />);
      const client = connectGuide(url, translate).find((entry) => entry.title === title);
      const section = screen.getByRole('region', { name: title });
      fireEvent.click(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' }));
      await waitFor(() => expect(write).toHaveBeenCalledWith(client?.prompt));
      await waitFor(() => expect(within(section).getByRole('button', { name: 'Zkopírováno' })).toBeTruthy());
      const prompt = write.mock.calls[0]?.[0];
      expect(prompt).toContain(url);
      expect(prompt).toContain('Konektor nemůžeš přidat za mě');
      expect(prompt).toContain('Hesla, API klíče ani tokeny ode mě nikdy nechtěj');
      expect(prompt).toContain('skutečně zavolej dostupné nástroje OntOS pouze pro čtení');
      expect(prompt).toContain('Nic neměň, nevytvářej ani nemaž');
      expect(prompt).toContain('netvrď, že je spojení ověřené bez úspěšného volání');
    }),
);

test.effect('copies the environment URL and client configurations without credentials', () =>
  Effect.promise(async () => {
    const write = rstest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<ConnectedAppsGuide mcpUrl={url} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(url));
    const claudeCode = screen.getByRole('region', { name: 'Claude Code' });
    fireEvent.click(within(claudeCode).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(`claude mcp add --transport http ontos ${url}`));
    const cursor = screen.getByRole('region', { name: 'Cursor' });
    fireEvent.click(within(cursor).getByRole('button', { name: 'Kopírovat konfiguraci / příkaz' }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    expect(JSON.parse(write.mock.calls[2]?.[0] ?? '')).toEqual({ mcpServers: { ontos: { url } } });
  }),
);

test.effect('exposes the prompt for manual copying when clipboard access fails', () =>
  Effect.promise(async () => {
    rstest.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('permission denied'));
    render(<ConnectedAppsGuide mcpUrl={url} />);
    const section = screen.getByRole('region', { name: 'ChatGPT' });
    fireEvent.click(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' }));
    await waitFor(() => expect(within(section).getByRole('alert').textContent).toContain('Rozbalte'));
    const details = section.querySelector('details');
    expect(details?.textContent).toContain(url);
    expect(details?.textContent).toContain('OAuth');
    expect(within(section).getByRole('button', { name: 'Zkopírovat pokyn pro AI' })).toBeTruthy();
  }),
);

test.effect('handles a missing clipboard API without an unhandled error', () =>
  Effect.promise(async () => {
    rstest.stubGlobal('navigator', {});
    render(<ConnectedAppsGuide mcpUrl={url} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kopírovat adresu' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('označte adresu ručně'));
  }),
);
