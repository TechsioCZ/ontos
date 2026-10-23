import { Result, Schema } from 'effect';

type GuideTranslate = (key: string, values?: Record<string, string>) => string;

const CursorConfig = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Struct({ ontos: Schema.Struct({ url: Schema.String }) }) }),
);

const clientCommand = (id: string, mcpUrl: string): string | null => {
  if (id === 'claude-code') {
    return `claude mcp add --transport http ontos ${mcpUrl}`;
  }
  if (id === 'cursor') {
    return Result.getOrThrow(Schema.encodeResult(CursorConfig)({ mcpServers: { ontos: { url: mcpUrl } } }));
  }
  return null;
};

// UI labels and requirements verified against these official client docs, 2026-10-23.
// ChatGPT: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
// Claude web/Desktop: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
// Claude Code: https://code.claude.com/docs/en/mcp
// VS Code: https://code.visualstudio.com/docs/copilot/customization/mcp-servers
// Cursor: https://cursor.com/docs/context/mcp
const clients = [
  {
    docs: 'https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt',
    id: 'chatgpt',
    steps: 4,
    title: 'ChatGPT',
  },
  {
    docs: 'https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp',
    id: 'claude',
    steps: 4,
    title: 'Claude (claude.ai / Desktop)',
  },
  { docs: 'https://code.claude.com/docs/en/mcp', id: 'claude-code', steps: 3, title: 'Claude Code' },
  {
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    id: 'vscode',
    steps: 3,
    title: 'VS Code',
  },
  { docs: 'https://cursor.com/docs/context/mcp', id: 'cursor', steps: 3, title: 'Cursor' },
] as const;

export const connectGuide = (mcpUrl: string, t: GuideTranslate) =>
  clients.map((client) => {
    const steps = Array.from({ length: client.steps }, (_, index) =>
      t(`shell.connectedAppsGuide.clients.${client.id}.step${index + 1}`),
    );
    const command = clientCommand(client.id, mcpUrl);
    return {
      ...client,
      command,
      prompt: [
        t('shell.connectedAppsGuide.promptIntro', { client: client.title, mcpUrl }),
        ...steps,
        ...(command === null ? [] : [command]),
        t('shell.connectedAppsGuide.promptSafety'),
      ].join('\n'),
      requirements: t(`shell.connectedAppsGuide.clients.${client.id}.requirements`),
      steps,
    };
  });
