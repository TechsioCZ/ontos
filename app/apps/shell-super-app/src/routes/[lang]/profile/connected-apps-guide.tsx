import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useState } from 'react';

import { connectGuide, localDemoNote } from './connected-apps-model.ts';

const CopyButton = ({
  failedText,
  idleLabel,
  value,
}: {
  readonly failedText: string;
  readonly idleLabel: string;
  readonly value: string;
}) => {
  const [copyState, setCopyState] = useState<'copied' | 'failed' | 'idle'>('idle');
  const copy = () => {
    // Promise.resolve keeps a missing clipboard API (insecure context) on the failure path.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setCopyState('copied'),
        () => setCopyState('failed'),
      );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-150">
      <Button icon="icon-[mdi--content-copy]" onClick={copy} size="sm" variant="secondary">
        {copyState === 'copied' ? 'Zkopírováno' : idleLabel}
      </Button>
      {copyState === 'failed' ? (
        <StatusText showIcon size="sm" status="warning">
          {failedText}
        </StatusText>
      ) : null}
    </div>
  );
};

/** "Jak připojit": the one address to paste into an AI app, plus per-app steps. No secret is shown or copied. */
export const ConnectedAppsGuide = ({ mcpUrl }: { readonly mcpUrl: string }) => (
  <section className="grid min-w-0 gap-200 border-border-primary border-t pt-300">
    <div className="grid min-w-0 gap-100">
      <h3 className="font-semibold text-md">Jak připojit</h3>
      <p className="text-fg-secondary text-sm">
        Do aplikace vložte jen tuto adresu. Přihlásíte se svým účtem OntOS a na obrazovce souhlasu vyberete firmu,
        rozsah a režim zápisu. Žádný klíč ani token se nekopíruje.
      </p>
    </div>
    <div className="grid min-w-0 gap-150">
      <div className="min-w-0 rounded-md bg-overlay p-150">
        <code className="break-all">{mcpUrl}</code>
      </div>
      <CopyButton
        failedText="Kopírování se nepodařilo, označte adresu ručně."
        idleLabel="Kopírovat adresu"
        value={mcpUrl}
      />
    </div>
    <ol className="grid min-w-0 gap-200">
      {connectGuide(mcpUrl).map((step) => (
        <li key={step.id} className="grid min-w-0 gap-100">
          <p className="font-semibold text-sm">{step.title}</p>
          <p className="text-sm">{step.text}</p>
          {step.command === null ? null : (
            <>
              <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-overlay p-150 text-xs">
                {step.command}
              </pre>
              <CopyButton
                failedText="Kopírování se nepodařilo, označte příkaz ručně."
                idleLabel="Kopírovat příkaz"
                value={step.command}
              />
            </>
          )}
        </li>
      ))}
    </ol>
    <StatusText size="sm" status="default">
      {localDemoNote}
    </StatusText>
  </section>
);
