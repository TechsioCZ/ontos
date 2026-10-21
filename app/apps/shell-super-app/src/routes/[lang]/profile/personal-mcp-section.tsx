// @effect-diagnostics globalDate:off cryptoRandomUUID:off -- Browser UI boundary: formats server timestamps for display and creates idempotency keys with the platform UUID. expires: 2027-03-31.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { mcpConnectionSnippets } from '@app/shared-contracts/agent-access';
import type { McpTokenIssueResponse, PersonalMcpOverview } from '@app/shared-contracts/agent-access';
import { useEffect, useEffectEvent, useId, useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { loadPersonalMcp, runPersonalMcpToken } from './personal-mcp-client.ts';
import type { PersonalMcpFailure, PersonalMcpOutcome } from './personal-mcp-client.ts';

type OverviewView =
  | { readonly status: 'failed'; readonly reason: PersonalMcpFailure }
  | { readonly status: 'loading' }
  | { readonly overview: PersonalMcpOverview; readonly status: 'ready' };

const toView = (outcome: PersonalMcpOutcome<PersonalMcpOverview>): OverviewView =>
  outcome.status === 'ok' ? { overview: outcome.value, status: 'ready' } : { reason: outcome.reason, status: 'failed' };

const CopyButton = ({ value }: { readonly value: string }) => {
  const { t } = useModernI18n();
  const [copyState, setCopyState] = useState<'copied' | 'failed' | 'idle'>('idle');
  const copy = () => {
    navigator.clipboard.writeText(value).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-150">
      <Button icon="icon-[mdi--content-copy]" onClick={copy} size="sm" variant="secondary">
        {copyState === 'copied' ? t('shell.profile.mcp.copied') : t('shell.profile.mcp.copy')}
      </Button>
      {copyState === 'failed' ? (
        <StatusText showIcon size="sm" status="warning">
          {t('shell.profile.mcp.copyFailed')}
        </StatusText>
      ) : null}
    </div>
  );
};

const SnippetBlock = ({ text, title }: { readonly text: string; readonly title: string }) => (
  <div className="grid min-w-0 gap-100">
    <h3 className="font-semibold text-sm">{title}</h3>
    <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-overlay p-150 text-xs">{text}</pre>
    <CopyButton value={text} />
  </div>
);

const IssuedSecret = ({
  issued,
  onDone,
}: {
  readonly issued: McpTokenIssueResponse;
  readonly onDone: () => void;
}) => {
  const { t } = useModernI18n();
  if (issued.secret === null) {
    return null;
  }
  const snippets = mcpConnectionSnippets(issued.mcpUrl, issued.secret);
  return (
    <section className="grid min-w-0 gap-200 rounded-md border border-warning bg-base p-200">
      <StatusText showIcon status="warning">
        {t('shell.profile.mcp.once')}
      </StatusText>
      <SnippetBlock text={issued.secret} title={t('shell.profile.mcp.secretLabel')} />
      <div className="grid min-w-0 gap-150">
        <h3 className="font-semibold text-sm">{t('shell.profile.mcp.chatgptTitle')}</h3>
        <p className="text-fg-secondary text-sm">{t('shell.profile.mcp.chatgptNote')}</p>
        <SnippetBlock text={issued.mcpUrl} title={t('shell.profile.mcp.chatgptUrl')} />
        <SnippetBlock text={`Authorization: ${snippets.chatgptAuthorization}`} title={t('shell.profile.mcp.chatgptHeader')} />
      </div>
      <SnippetBlock text={snippets.claudeDesktopJson} title={t('shell.profile.mcp.claudeDesktopTitle')} />
      <SnippetBlock text={snippets.claudeCodeCommand} title={t('shell.profile.mcp.claudeCodeTitle')} />
      <div>
        <Button onClick={onDone} variant="primary">
          {t('shell.profile.mcp.done')}
        </Button>
      </div>
    </section>
  );
};

/** Personal MCP access card of the selected company: list, one-time issue, and revoke with a required reason. */
export const PersonalMcpSection = () => {
  const { language, t } = useModernI18n();
  const reasonId = useId();
  const [view, setView] = useState<OverviewView>({ status: 'loading' });
  const [busy, setBusy] = useState<'issue' | 'revoke' | undefined>(undefined);
  const [actionFailure, setActionFailure] = useState<PersonalMcpFailure | undefined>(undefined);
  const [issued, setIssued] = useState<McpTokenIssueResponse | undefined>(undefined);
  const [revokeId, setRevokeId] = useState<string | undefined>(undefined);
  const [revokeReason, setRevokeReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);

  const reload = (): Promise<void> =>
    browserRuntime.runPromise(loadPersonalMcp).then((outcome) => {
      setView(toView(outcome));
    });
  const loadOnMount = useEffectEvent(() => {
    void reload();
  });
  useEffect(() => {
    loadOnMount();
  }, []);

  const dateFormat = new Intl.DateTimeFormat(language === 'cs' ? 'cs-CZ' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const formatDate = (iso: string) => dateFormat.format(new Date(iso));

  const issue = () => {
    setBusy('issue');
    setActionFailure(undefined);
    void browserRuntime
      .runPromise(runPersonalMcpToken({ operation: 'issue' }, globalThis.crypto.randomUUID()))
      .then((outcome) => {
        setBusy(undefined);
        if (outcome.status === 'ok') {
          setIssued(outcome.value);
        } else {
          setActionFailure(outcome.reason);
        }
      });
  };

  const revoke = (authBindingId: string) => {
    const reason = revokeReason.trim();
    if (reason === '') {
      setReasonMissing(true);
      return;
    }
    setBusy('revoke');
    setActionFailure(undefined);
    void browserRuntime
      .runPromise(
        runPersonalMcpToken({ authBindingId, operation: 'revoke', reason }, globalThis.crypto.randomUUID()),
      )
      .then((outcome) => {
        setBusy(undefined);
        if (outcome.status === 'ok') {
          setRevokeId(undefined);
          setRevokeReason('');
          setReasonMissing(false);
          void reload();
        } else {
          setActionFailure(outcome.reason);
        }
      });
  };

  const finishIssued = () => {
    setIssued(undefined);
    setView({ status: 'loading' });
    void reload();
  };

  if (view.status === 'loading') {
    return (
      <section className="grid w-full max-w-3xl min-w-0 gap-200 rounded-lg border border-border-primary bg-base p-300">
        <StatusText aria-live="polite" showIcon status="default">
          {t('shell.profile.loading')}
        </StatusText>
      </section>
    );
  }
  if (view.status === 'failed') {
    return (
      <section className="grid w-full max-w-3xl min-w-0 gap-200 rounded-lg border border-border-primary bg-base p-300">
        <StatusText aria-live="polite" showIcon status="error">
          {t(`shell.profile.errors.${view.reason}`)}
        </StatusText>
      </section>
    );
  }

  const { overview } = view;
  const { tokens } = overview;
  return (
    <section className="grid w-full max-w-3xl min-w-0 gap-200 rounded-lg border border-border-primary bg-base p-300">
      <h2 className="font-semibold text-lg">{t('shell.profile.mcp.title')}</h2>
      <p className="text-fg-secondary text-sm">
        {t('shell.profile.mcp.description', { company: overview.company.legalName })}
      </p>
      <p className="text-fg-secondary text-xs">{t('shell.profile.mcp.otherCompanies')}</p>

      {issued === undefined ? null : <IssuedSecret issued={issued} onDone={finishIssued} />}

      {actionFailure === undefined ? null : (
        <StatusText aria-live="polite" showIcon status="error">
          {t(`shell.profile.errors.${actionFailure}`)}
        </StatusText>
      )}

      {tokens.length === 0 ? (
        <StatusText status="default">{t('shell.profile.mcp.empty')}</StatusText>
      ) : (
        <ul className="grid min-w-0 gap-150">
          {tokens.map((token) => (
            <li className="grid min-w-0 gap-100 rounded-md border border-border-primary p-200" key={token.authBindingId}>
              <div className="flex min-w-0 flex-wrap items-center gap-150">
                <span className="min-w-0 break-all font-mono text-sm">
                  {token.start === null ? (token.name ?? '') : `${token.start}…`}
                </span>
                <Badge size="sm" variant={token.enabled ? 'success' : 'warning'}>
                  {token.enabled ? t('shell.profile.mcp.active') : t('shell.profile.mcp.disabled')}
                </Badge>
              </div>
              <p className="text-fg-secondary text-xs">
                {t('shell.profile.mcp.created', { date: formatDate(token.createdAt) })}
              </p>
              <p className="text-fg-secondary text-xs">
                {token.lastUsedAt === null
                  ? t('shell.profile.mcp.neverUsed')
                  : t('shell.profile.mcp.lastUsed', { date: formatDate(token.lastUsedAt) })}
              </p>
              {token.enabled ? (
                revokeId === token.authBindingId ? (
                  <div className="grid min-w-0 gap-150">
                    <p className="text-fg-secondary text-sm">{t('shell.profile.mcp.revokeHint')}</p>
                    <label className="grid gap-100 text-sm" htmlFor={reasonId}>
                      {t('shell.profile.mcp.reason')}
                      <textarea
                        aria-describedby={reasonMissing ? `${reasonId}-required` : undefined}
                        className="min-h-[5rem] w-full rounded-md border border-border-primary bg-base p-150 text-sm"
                        id={reasonId}
                        maxLength={500}
                        onChange={(event) => {
                          setRevokeReason(event.target.value);
                        }}
                        value={revokeReason}
                      />
                    </label>
                    {reasonMissing ? (
                      <StatusText id={`${reasonId}-required`} showIcon status="error">
                        {t('shell.profile.mcp.reasonRequired')}
                      </StatusText>
                    ) : null}
                    <div className="flex flex-wrap gap-150">
                      <Button
                        disabled={busy !== undefined}
                        onClick={() => {
                          revoke(token.authBindingId);
                        }}
                        variant="danger"
                      >
                        {t('shell.profile.mcp.confirmRevoke')}
                      </Button>
                      <Button
                        onClick={() => {
                          setRevokeId(undefined);
                          setReasonMissing(false);
                        }}
                        variant="secondary"
                      >
                        {t('shell.profile.mcp.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button
                      onClick={() => {
                        setRevokeId(token.authBindingId);
                        setRevokeReason('');
                      }}
                      variant="secondary"
                    >
                      {t('shell.profile.mcp.revoke')}
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          disabled={busy !== undefined}
          icon="icon-[mdi--key-plus]"
          onClick={issue}
          variant="primary"
        >
          {busy === 'issue' ? t('shell.profile.mcp.issuing') : t('shell.profile.mcp.issue')}
        </Button>
      </div>
    </section>
  );
};
