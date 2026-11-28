import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import { Effect } from 'effect';
import { useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { connectGuide } from './connected-apps-guide-model.ts';

interface ClipboardEnvironment {
  readonly clipboard?: Pick<Clipboard, 'writeText'>;
}

const browserClipboardEnvironment: ClipboardEnvironment = {
  get clipboard() {
    return navigator.clipboard;
  },
};

const CopyButton = ({
  clipboardEnvironment,
  copiedLabel,
  failedText,
  idleLabel,
  value,
}: {
  readonly clipboardEnvironment: ClipboardEnvironment;
  readonly copiedLabel: string;
  readonly failedText: string;
  readonly idleLabel: string;
  readonly value: string;
}) => {
  const [copyState, setCopyState] = useState<
    { readonly status: 'copied' | 'idle' } | { readonly error: Error; readonly status: 'failed' }
  >({ status: 'idle' });
  const copy = () => {
    // Unavailable browser APIs and rejected writes both offer manual copying.
    void browserRuntime.runPromise(
      Effect.suspend(() => Effect.fromNullishOr(clipboardEnvironment.clipboard)).pipe(
        Effect.flatMap((clipboard) => Effect.tryPromise(() => clipboard.writeText(value))),
        Effect.timeout('5 seconds'),
        Effect.match({
          onFailure: (error) => setCopyState({ error, status: 'failed' }),
          onSuccess: () => setCopyState({ status: 'copied' }),
        }),
      ),
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-150">
      <Button icon="icon-[mdi--content-copy]" onClick={copy} severity="secondary" size="sm">
        {copyState.status === 'copied' ? copiedLabel : idleLabel}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copyState.status === 'copied' ? copiedLabel : ''}
      </span>
      {copyState.status === 'failed' ? (
        <StatusText role="alert" showIcon size="sm" status="warning" title={copyState.error.message}>
          {failedText}
        </StatusText>
      ) : null}
    </div>
  );
};

/** Uses the environment's public MCP resource URL returned by the connections API. */
export const ConnectedAppsGuide = ({
  clipboardEnvironment = browserClipboardEnvironment,
  mcpUrl,
}: {
  readonly clipboardEnvironment?: ClipboardEnvironment | undefined;
  readonly mcpUrl: string;
}) => {
  const { t } = useModernI18n();
  const text = (key: string) => t(`shell.connectedAppsGuide.${key}`);
  return (
    <section aria-label={text('title')} className="grid min-w-0 gap-200 border-border-primary border-t pt-300">
      <div className="grid min-w-0 gap-100">
        <h3 className="font-semibold text-md">{text('title')}</h3>
        <p className="text-fg-secondary text-sm">{text('intro')}</p>
        <p className="text-fg-secondary text-sm">{text('aiHelp')}</p>
      </div>
      <div className="grid min-w-0 gap-150">
        <div className="min-w-0 rounded-md bg-overlay p-150">
          <code className="break-all">{mcpUrl}</code>
        </div>
        <CopyButton
          clipboardEnvironment={clipboardEnvironment}
          copiedLabel={text('copied')}
          failedText={text('copyUrlFailed')}
          idleLabel={text('copyUrl')}
          key={mcpUrl}
          value={mcpUrl}
        />
      </div>
      <div className="grid min-w-0 gap-200">
        {connectGuide(mcpUrl, t).map((client) => (
          <section
            aria-labelledby={`mcp-guide-${client.id}`}
            className="grid min-w-0 gap-150 rounded-md border border-border-primary p-200"
            key={client.id}
          >
            <h4 className="font-semibold text-sm" id={`mcp-guide-${client.id}`}>
              {client.title}
            </h4>
            <p className="text-fg-secondary text-sm">{client.requirements}</p>
            <ol className="grid list-decimal gap-100 pl-250 text-sm">
              {client.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {client.command === null ? null : (
              <>
                <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-overlay p-150 text-xs">
                  {client.command}
                </pre>
                <CopyButton
                  clipboardEnvironment={clipboardEnvironment}
                  copiedLabel={text('copied')}
                  failedText={text('copyCommandFailed')}
                  idleLabel={text('copyCommand')}
                  key={client.command}
                  value={client.command}
                />
              </>
            )}
            <CopyButton
              clipboardEnvironment={clipboardEnvironment}
              copiedLabel={text('copied')}
              failedText={text('copyPromptFailed')}
              idleLabel={text('copyPrompt')}
              key={client.prompt}
              value={client.prompt}
            />
            <Accordion appearance="ghost" size="sm">
              <Accordion.Item value="prompt">
                <Accordion.Header>
                  <Accordion.Title className="text-fg-secondary">{text('showPrompt')}</Accordion.Title>
                  <Accordion.Indicator />
                </Accordion.Header>
                <Accordion.Content>
                  <p className="whitespace-pre-wrap break-words rounded-md bg-overlay p-150">{client.prompt}</p>
                </Accordion.Content>
              </Accordion.Item>
            </Accordion>
            <Link className="w-fit" external href={client.docs} size="sm">
              {text('officialDocs')}
            </Link>
          </section>
        ))}
      </div>
      <StatusText size="sm" status="default">
        {text('networkNote')}
      </StatusText>
    </section>
  );
};
