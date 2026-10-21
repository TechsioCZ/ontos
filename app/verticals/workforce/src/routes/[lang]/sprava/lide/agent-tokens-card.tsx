import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SectionCard, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { mcpConnectionSnippets } from '@app/shared-contracts/agent-access';
import type { AgentEntity, AgentTokenRequest, McpToken } from '@app/shared-contracts/agent-access';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { runAgentTokenCommand } from '../../../../api/agent-entities-client.ts';
import type { AgentFailure } from '../../../../api/agent-entities-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from '../../prodej/zamestnanci/employee-model.ts';

const key = 'workforce.agents.tokens';
const PEOPLE_ERROR_KEY = 'workforce.people.errors';
const COPIED_MS = 2000;

export interface AgentTokensCardProps {
  readonly agent: AgentEntity;
  readonly mcpUrl: string;
  readonly onChanged: (message: string) => void;
}

export interface CopyBlockProps {
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
}

/** Labelled, copyable value; the secret and the connection snippets use it. */
export const CopyBlock = ({ label, value }: CopyBlockProps) => {
  const { t } = useModernI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    setFailed(false);
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      setFailed(true);
      return;
    }
    void clipboard.writeText(value).then(
      () => setCopied(true),
      () => setFailed(true),
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-100">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-100">
        <span className="text-label-md">{label}</span>
        <Button icon="icon-[mdi--content-copy]" onClick={copy} size="sm" theme="outlined" variant="secondary">
          {copied ? t(`${key}.copied`) : t(`${key}.copy`)}
        </Button>
      </div>
      <pre className="max-h-[16rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-primary bg-surface-secondary p-150 font-mono text-xs">
        {value}
      </pre>
      {failed && (
        <StatusText showIcon status="error">
          {t(`${key}.copyFailed`)}
        </StatusText>
      )}
    </div>
  );
};

type Operation = 'issue' | 'revoke' | 'rotate';

interface IssuedSecret {
  readonly mcpUrl: string;
  readonly operation: 'issue' | 'rotate';
  readonly secret: string;
}

interface ConfirmState {
  readonly authBindingId: string;
  readonly operation: 'revoke' | 'rotate';
}

const runTokenCommand = (command: AgentTokenRequest) =>
  browserRuntime.runPromise(
    newRequestToken.pipe(Effect.flatMap((token) => runAgentTokenCommand(command, `agent-token-${token}`))),
  );

export const AgentTokensCard = ({ agent, mcpUrl, onChanged }: AgentTokensCardProps) => {
  const { t } = useModernI18n();
  const [busy, setBusy] = useState<Operation | null>(null);
  const [failure, setFailure] = useState<AgentFailure | null>(null);
  const [secret, setSecret] = useState<IssuedSecret | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);

  const active = agent.status === 'active';
  const { principalId, displayName } = agent;

  const closeConfirm = () => {
    setConfirm(null);
    setReason('');
    setReasonMissing(false);
  };

  const issue = () => {
    setBusy('issue');
    setFailure(null);
    void runTokenCommand({ operation: 'issue', principalId })
      .then((outcome) => {
        setBusy(null);
        if (outcome.status === 'failed') {
          setFailure(outcome.reason);
          return;
        }
        if (outcome.value.secret === null) {
          setFailure('error');
          return;
        }
        setSecret({ mcpUrl: outcome.value.mcpUrl, operation: 'issue', secret: outcome.value.secret });
      })
      .catch(() => {
        setBusy(null);
        setFailure('error');
      });
  };

  const submitConfirm = () => {
    if (confirm === null) {
      return;
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonMissing(true);
      return;
    }
    const { authBindingId, operation } = confirm;
    setBusy(operation);
    setFailure(null);
    void runTokenCommand({ authBindingId, operation, principalId, reason: trimmed })
      .then((outcome) => {
        setBusy(null);
        if (outcome.status === 'failed') {
          setFailure(outcome.reason);
          return;
        }
        if (operation === 'revoke') {
          closeConfirm();
          onChanged(t(`${key}.toastRevoked`, { name: displayName }));
          return;
        }
        if (outcome.value.secret === null) {
          setFailure('error');
          return;
        }
        closeConfirm();
        setSecret({ mcpUrl: outcome.value.mcpUrl, operation: 'rotate', secret: outcome.value.secret });
      })
      .catch(() => {
        setBusy(null);
        setFailure('error');
      });
  };

  const finishSecret = () => {
    if (secret === null) {
      return;
    }
    const message =
      secret.operation === 'rotate' ? t(`${key}.toastRotated`, { name: displayName }) : t(`${key}.toastIssued`, { name: displayName });
    setSecret(null);
    onChanged(message);
  };

  const issueButton = active && secret === null && (
    <Button
      icon="icon-[mdi--key-plus]"
      isLoading={busy === 'issue'}
      loadingText={t(`${key}.issuing`)}
      disabled={busy !== null}
      onClick={issue}
      size="sm"
      variant="primary"
    >
      {t(`${key}.issue`)}
    </Button>
  );

  return (
    <SectionCard actions={issueButton || undefined} title={t(`${key}.title`)}>
      <div className="flex min-w-0 flex-col gap-150">
        <p className="text-fg-secondary text-sm">{t(`${key}.description`)}</p>

        {!active && (
          <StatusText showIcon status="warning">
            {t(`${key}.inactive`)}
          </StatusText>
        )}

        {failure !== null && (
          <StatusText showIcon status="error">
            {t(`${PEOPLE_ERROR_KEY}.${failure}`)}
          </StatusText>
        )}

        {secret !== null ? (
          <div className="flex min-w-0 flex-col gap-150">
            <StatusText showIcon status="warning">
              {t(`${key}.once`)}
            </StatusText>
            <CopyBlock label={t(`${key}.secretLabel`)} value={secret.secret} />
            {(() => {
              const snippets = mcpConnectionSnippets(secret.mcpUrl, secret.secret);
              return (
                <>
                  <section className="flex min-w-0 flex-col gap-100">
                    <h3 className="font-semibold text-sm">{t(`${key}.chatgptTitle`)}</h3>
                    <CopyBlock label={t(`${key}.chatgptUrl`)} value={snippets.chatgptUrl} />
                    <CopyBlock label={t(`${key}.chatgptHeader`)} value={snippets.chatgptAuthorization} />
                    <p className="text-fg-secondary text-xs">{t(`${key}.chatgptNote`)}</p>
                  </section>
                  <section className="flex min-w-0 flex-col gap-100">
                    <h3 className="font-semibold text-sm">{t(`${key}.claudeDesktopTitle`)}</h3>
                    <CopyBlock label={t(`${key}.claudeDesktopTitle`)} multiline value={snippets.claudeDesktopJson} />
                  </section>
                  <section className="flex min-w-0 flex-col gap-100">
                    <h3 className="font-semibold text-sm">{t(`${key}.claudeCodeTitle`)}</h3>
                    <CopyBlock label={t(`${key}.claudeCodeTitle`)} multiline value={snippets.claudeCodeCommand} />
                  </section>
                </>
              );
            })()}
            <div>
              <Button onClick={finishSecret} size="sm" variant="primary">
                {t(`${key}.done`)}
              </Button>
            </div>
          </div>
        ) : agent.tokens.length === 0 ? (
          <p className="text-fg-secondary text-sm">{t(`${key}.empty`)}</p>
        ) : (
          <ul className="flex min-w-0 flex-col">
            {agent.tokens.map((token: McpToken) => {
              const open = confirm?.authBindingId === token.authBindingId ? confirm : null;
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-150 border-border-primary border-b py-150 last:border-b-0"
                  key={token.authBindingId}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-50">
                    <div className="flex min-w-0 flex-wrap items-center gap-100">
                      <code className="break-all text-sm">{token.start ?? '—'}…</code>
                      {token.name && (
                        <Badge size="sm" variant="outline">
                          {token.name}
                        </Badge>
                      )}
                      <Badge size="sm" variant={token.enabled ? 'success' : 'outline'}>
                        {t(token.enabled ? `${key}.active` : `${key}.disabled`)}
                      </Badge>
                    </div>
                    <p className="text-fg-secondary text-xs tabular-nums">
                      {t(`${key}.created`, { date: formatDateTime(token.createdAt) })}
                      {' · '}
                      {token.lastUsedAt === null
                        ? t(`${key}.neverUsed`)
                        : t(`${key}.lastUsed`, { date: formatDateTime(token.lastUsedAt) })}
                    </p>
                  </div>

                  {active && (
                    <div className="flex shrink-0 flex-wrap gap-100">
                      <Button
                        disabled={busy !== null}
                        onClick={() => {
                          setFailure(null);
                          setReason('');
                          setReasonMissing(false);
                          setConfirm({ authBindingId: token.authBindingId, operation: 'rotate' });
                        }}
                        size="sm"
                        theme="outlined"
                        variant="secondary"
                      >
                        {t(`${key}.rotate`)}
                      </Button>
                      <Button
                        disabled={busy !== null}
                        onClick={() => {
                          setFailure(null);
                          setReason('');
                          setReasonMissing(false);
                          setConfirm({ authBindingId: token.authBindingId, operation: 'revoke' });
                        }}
                        size="sm"
                        theme="outlined"
                        variant="danger"
                      >
                        {t(`${key}.revoke`)}
                      </Button>
                    </div>
                  )}

                  {open !== null && (
                    <div className="flex w-full min-w-0 basis-full flex-col gap-150 rounded-lg border border-border-primary p-200">
                      <p className="text-fg-secondary text-xs">
                        {t(open.operation === 'revoke' ? `${key}.revokeHint` : `${key}.rotateHint`)}
                      </p>
                      <FormTextarea
                        id={`agent-token-reason-${token.authBindingId}`}
                        label={t(`${key}.reason`)}
                        name="reason"
                        onChange={(event) => {
                          setReasonMissing(false);
                          setReason(event.target.value);
                        }}
                        rows={2}
                        value={reason}
                      />
                      {reasonMissing && (
                        <StatusText showIcon status="error">
                          {t(`${key}.reasonRequired`)}
                        </StatusText>
                      )}
                      <div className="flex flex-wrap gap-100">
                        <Button
                          disabled={busy !== null}
                          isLoading={busy === open.operation}
                          onClick={submitConfirm}
                          size="sm"
                          variant={open.operation === 'revoke' ? 'danger' : 'primary'}
                        >
                          {t(open.operation === 'revoke' ? `${key}.confirmRevoke` : `${key}.confirmRotate`)}
                        </Button>
                        <Button onClick={closeConfirm} size="sm" theme="outlined" variant="secondary">
                          {t(`${key}.cancel`)}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SectionCard>
  );
};
