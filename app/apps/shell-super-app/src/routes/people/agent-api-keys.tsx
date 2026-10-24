import { dialogCloseLabel, formatDateTime } from '@app/admin-ui';
import type { AgentEntity } from '@app/shared-contracts/agent-access';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { DateTime, Effect, Fiber, Option, Redacted, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';

import { ApiKeyIssueResponseSchema, PrincipalIdSchema, ShellPolicyConflictProblemSchema } from '../../../shared/api.ts';
import type { ManagedApiKeyListResponse, SetManagedApiKeyStatusPayload } from '../../../shared/api.ts';
import {
  issueManagedApiKey,
  listManagedApiKeys,
  rotateManagedApiKey,
  setManagedApiKeyStatus,
} from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';

class AgentKeyScopeError extends Schema.TaggedError<AgentKeyScopeError>()('AgentKeyScopeError', {
  reason: Schema.String,
}) {}
type AgentPrincipalId = typeof PrincipalIdSchema.Type;
type AgentKey = NonNullable<ManagedApiKeyListResponse['items'][number]['key']>;
type KeyCommand =
  | { readonly kind: 'issue' }
  | { readonly key: AgentKey; readonly kind: 'disable' | 'enable' | 'revoke' | 'rotate' };
const copyKey = 'shell.agents.keys';
const companyAgentScope = 'company-agent';
const pageSize = 100;

const keyCommand = (
  command: KeyCommand,
  principalId: AgentPrincipalId,
  name: string,
  reason: string,
  token: string,
) => {
  const scope = companyAgentScope;
  const options = { idempotencyKey: token };
  if (command.kind === 'issue') {
    return issueManagedApiKey({ name, principalId, scope }, options);
  }
  if (command.kind === 'rotate') {
    return rotateManagedApiKey(
      { name, oldAuthBindingId: command.key.authBindingId, principalId, reason, scope },
      options,
    );
  }
  const common = {
    authBindingId: command.key.authBindingId,
    expectedStatus: command.key.bindingStatus,
    principalId,
    reason,
    scope,
  } satisfies Pick<
    SetManagedApiKeyStatusPayload,
    'authBindingId' | 'expectedStatus' | 'principalId' | 'reason' | 'scope'
  >;
  return setManagedApiKeyStatus(
    command.kind === 'revoke'
      ? { ...common, newStatus: 'revoked' }
      : { ...common, newStatus: command.kind === 'enable' ? 'active' : 'disabled' },
    options,
  );
};

interface KeyProjection {
  readonly authBindingId: AgentKey['authBindingId'];
  readonly bindingStatus: AgentKey['bindingStatus'] | 'revoked';
  readonly cleanupPending: boolean;
}
const projectionMatches = (projection: KeyProjection, keys: readonly AgentKey[], nextOffset: number | null) => {
  const target = keys.find((candidate) => candidate.authBindingId === projection.authBindingId);
  return projection.bindingStatus === 'revoked'
    ? nextOffset === null && target === undefined
    : target?.bindingStatus === projection.bindingStatus;
};

const useAgentKeys = (principalId: AgentPrincipalId) => {
  const [keys, setKeys] = useState<readonly AgentKey[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'conflict' | 'failed' | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [secret, setSecret] = useState<Redacted.Redacted | null>(null);
  const [notice, setNotice] = useState<'cleanupPending' | 'projectionPending' | 'updated' | null>(null);
  const pending = useRef<Fiber.Fiber<void> | null>(null);
  const expected = useRef<KeyProjection | null>(null);
  const loadedKeys = useRef<readonly AgentKey[]>([]);

  useEffect(
    () => () => {
      if (pending.current !== null) {
        browserRuntime.runFork(Fiber.interrupt(pending.current));
      }
    },
    [],
  );

  const updateKeys = (offset: number, items: readonly AgentKey[], next: number | null) => {
    const all = offset === 0 ? items : [...loadedKeys.current, ...items];
    loadedKeys.current = [...new Map(all.map((item) => [item.authBindingId, item])).values()];
    setKeys(loadedKeys.current);
    setNextOffset(next);
    const projection = expected.current;
    const confirmed = projection === null || projectionMatches(projection, loadedKeys.current, next);
    setNeedsRefresh(!confirmed);
    if (projection !== null) {
      if (projection.cleanupPending) {
        setNotice('cleanupPending');
      } else {
        setNotice(confirmed ? 'updated' : 'projectionPending');
      }
      if (confirmed) {
        expected.current = null;
      }
    }
  };
  const read = (offset: number) =>
    listManagedApiKeys({ limit: pageSize, offset, principalId, scope: companyAgentScope }).pipe(
      Effect.flatMap((response) => {
        // A server scope violation is a failed read, never a client-side ownership filter.
        if (response.items.some((item) => item.principalId !== principalId || item.kind !== 'agent')) {
          return Effect.fail(
            new AgentKeyScopeError({ reason: 'Agent key response does not match its requested scope' }),
          );
        }
        const items = response.items.flatMap((item) => (item.key === null ? [] : [item.key]));
        return Effect.sync(() => {
          updateKeys(offset, items, response.nextOffset);
        });
      }),
    );

  const load = (offset = 0) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    pending.current = browserRuntime.runFork(
      read(offset).pipe(
        Effect.timeout('30 seconds'),
        Effect.match({
          onFailure: (problem) => {
            setFailure(Schema.is(ShellPolicyConflictProblemSchema)(problem) ? 'conflict' : 'failed');
            setNeedsRefresh(true);
          },
          onSuccess: () => {
            /* The scoped read updated metadata only. */
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  const handleExecute = (command: KeyCommand, name: string, reason: string, onCommitted: () => void) => {
    if (busy || needsRefresh || secret !== null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    setNotice(null);
    pending.current = browserRuntime.runFork(
      newRequestToken.pipe(
        Effect.flatMap((token) => keyCommand(command, principalId, name, reason, token)),
        Effect.tap((response) =>
          Effect.sync(() => {
            if (Schema.is(ApiKeyIssueResponseSchema)(response)) {
              setSecret(response.secret);
            }
            let bindingStatus: KeyProjection['bindingStatus'] = 'active';
            if (command.kind === 'disable') {
              bindingStatus = 'disabled';
            } else if (command.kind === 'revoke') {
              bindingStatus = 'revoked';
            }
            expected.current = {
              authBindingId: response.authBindingId,
              bindingStatus,
              cleanupPending: response.cleanupPending,
            };
            setNotice(response.cleanupPending ? 'cleanupPending' : 'projectionPending');
            setNeedsRefresh(true);
            onCommitted();
          }),
        ),
        // A committed mutation is never retried, even when this subsequent projection read fails.
        Effect.andThen(() => read(0)),
        Effect.timeout('30 seconds'),
        Effect.match({
          onFailure: (problem) => {
            setFailure(Schema.is(ShellPolicyConflictProblemSchema)(problem) ? 'conflict' : 'failed');
            setNeedsRefresh(true);
          },
          onSuccess: () => {
            /* The fresh list confirms the binding projection. */
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return { busy, failure, handleExecute, keys, load, needsRefresh, nextOffset, notice, secret, setSecret };
};

const OneTimeSecret = ({
  onDismiss,
  secret,
}: {
  readonly onDismiss: () => void;
  readonly secret: Redacted.Redacted;
}) => {
  const { t } = useModernI18n();
  const field = useRef<HTMLTextAreaElement | null>(null);
  return (
    <section className="flex min-w-0 flex-col gap-150 rounded-md border border-warning p-200">
      <StatusText showIcon status="warning">
        {t(`${copyKey}.oneTime`)}
      </StatusText>
      <FormTextarea
        autoComplete="off"
        label={t(`${copyKey}.secret`)}
        readOnly
        ref={field}
        rows={3}
        value={Redacted.value(secret)}
      />
      <div className="flex flex-wrap gap-100">
        <Button onClick={() => field.current?.select()} size="sm" theme="outlined" type="button" variant="secondary">
          {t(`${copyKey}.selectSecret`)}
        </Button>
        <Button onClick={onDismiss} size="sm" type="button" variant="primary">
          {t(`${copyKey}.hideSecret`)}
        </Button>
      </div>
    </section>
  );
};

const AgentKeyRow = ({
  item,
  locked,
  onCommand,
}: {
  readonly item: AgentKey;
  readonly locked: boolean;
  readonly onCommand: (command: KeyCommand) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <li className="flex min-w-0 flex-col gap-100 border-border-primary/60 border-b py-150 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-100">
        <span className="font-medium text-sm [overflow-wrap:anywhere]">{item.name ?? t(`${copyKey}.unnamed`)}</span>
        <Badge size="sm" variant={item.bindingStatus === 'active' ? 'success' : 'outline'}>
          {t(`${copyKey}.status.${item.bindingStatus}`)}
        </Badge>
        {item.start !== null && <code className="text-fg-secondary text-xs">{item.start}…</code>}
      </div>
      <p className="text-fg-secondary text-xs">
        {item.expiresAt === null
          ? t(`${copyKey}.noExpiry`)
          : t(`${copyKey}.expires`, { date: formatDateTime(DateTime.formatIso(item.expiresAt)) })}
      </p>
      <div className="flex flex-wrap gap-100">
        {item.bindingStatus === 'active' && (
          <Button
            disabled={locked}
            onClick={() => onCommand({ key: item, kind: 'rotate' })}
            size="sm"
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {t(`${copyKey}.rotate`)}
          </Button>
        )}
        <Button
          disabled={locked}
          onClick={() => onCommand({ key: item, kind: item.bindingStatus === 'active' ? 'disable' : 'enable' })}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(item.bindingStatus === 'active' ? `${copyKey}.disable` : `${copyKey}.enable`)}
        </Button>
        <Button
          disabled={locked}
          onClick={() => onCommand({ key: item, kind: 'revoke' })}
          size="sm"
          type="button"
          variant="danger"
        >
          {t(`${copyKey}.revoke`)}
        </Button>
      </div>
    </li>
  );
};

const KeyConfirmation = ({
  busy,
  command,
  failure,
  locked,
  onClose,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly command: KeyCommand;
  readonly failure: ReturnType<typeof useAgentKeys>['failure'];
  readonly locked: boolean;
  readonly onClose: () => void;
  readonly onConfirm: ReturnType<typeof useAgentKeys>['handleExecute'];
}) => {
  const { t } = useModernI18n();
  const [name, setName] = useState(command.kind === 'rotate' ? (command.key.name ?? '') : '');
  const [reason, setReason] = useState('');
  const namedCommand = command.kind === 'issue' || command.kind === 'rotate';
  const valid = (command.kind === 'issue' || reason.trim().length > 0) && (!namedCommand || name.trim().length > 0);
  return (
    <Dialog
      actions={
        <>
          <Button disabled={busy} onClick={() => onClose()} theme="outlined" type="button" variant="secondary">
            {t(`${copyKey}.cancel`)}
          </Button>
          <Button
            disabled={!valid || locked}
            onClick={() => {
              if (command !== null) {
                onConfirm(command, name.trim(), reason.trim(), onClose);
              }
            }}
            type="button"
            variant="primary"
          >
            {t(`${copyKey}.confirm`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      closeOnInteractOutside={false}
      description={t(`${copyKey}.confirmDescription`)}
      onOpenChange={(details) => {
        if (!details.open && !busy) {
          onClose();
        }
      }}
      open
      title={t(`${copyKey}.${command.kind}`)}
    >
      <div className="flex flex-col gap-200">
        {namedCommand && (
          <FormInput
            autoComplete="off"
            label={t(`${copyKey}.name`)}
            maxLength={32}
            name="keyName"
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        )}
        {command.kind !== 'issue' && (
          <FormTextarea
            label={t(`${copyKey}.reason`)}
            maxLength={500}
            name="keyReason"
            onChange={(event) => setReason(event.target.value)}
            required
            rows={2}
            value={reason}
          />
        )}
        {failure !== null && (
          <StatusText showIcon status="error">
            {t(`${copyKey}.${failure}`)}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};

const AgentKeyDetail = ({ principalId }: { readonly principalId: AgentPrincipalId }) => {
  const { t } = useModernI18n();
  const state = useAgentKeys(principalId);
  const [command, setCommand] = useState<KeyCommand | null>(null);
  const locked = state.busy || state.needsRefresh || state.secret !== null;
  return (
    <section className="flex min-w-0 flex-col gap-150 border-border-primary/60 border-t py-250">
      <h3 className="font-semibold text-sm">{t(`${copyKey}.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${copyKey}.description`)}</p>
      <div className="flex flex-wrap gap-100">
        <Button
          disabled={state.busy}
          onClick={() => state.load()}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(state.keys === null ? `${copyKey}.show` : `${copyKey}.refresh`)}
        </Button>
        <Button
          disabled={locked || state.keys === null}
          onClick={() => setCommand({ kind: 'issue' })}
          size="sm"
          type="button"
          variant="primary"
        >
          {t(`${copyKey}.issue`)}
        </Button>
      </div>
      {state.busy && (
        <p aria-live="polite" className="text-fg-secondary text-sm">
          {t(`${copyKey}.working`)}
        </p>
      )}
      {state.failure !== null && (
        <StatusText showIcon status="error">
          {t(`${copyKey}.${state.failure}`)}
        </StatusText>
      )}
      {state.notice !== null && (
        <StatusText showIcon status={state.notice === 'updated' ? 'success' : 'warning'}>
          {t(`${copyKey}.${state.notice}`)}
        </StatusText>
      )}
      {state.needsRefresh && !state.busy && <StatusText status="warning">{t(`${copyKey}.refreshRequired`)}</StatusText>}
      {state.secret !== null && <OneTimeSecret onDismiss={() => state.setSecret(null)} secret={state.secret} />}
      {state.keys?.length === 0 && <p className="text-fg-secondary text-sm">{t(`${copyKey}.empty`)}</p>}
      <ul className="flex min-w-0 flex-col">
        {state.keys?.map((item) => (
          <AgentKeyRow item={item} key={item.authBindingId} locked={locked} onCommand={setCommand} />
        ))}
      </ul>
      {state.nextOffset !== null && (
        <Button
          disabled={state.busy}
          onClick={() => {
            if (state.nextOffset !== null) {
              state.load(state.nextOffset);
            }
          }}
          size="sm"
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {t(`${copyKey}.more`)}
        </Button>
      )}
      {command !== null && (
        <KeyConfirmation
          busy={state.busy}
          command={command}
          failure={state.failure}
          locked={locked}
          onClose={() => setCommand(null)}
          onConfirm={state.handleExecute}
        />
      )}
    </section>
  );
};

export const AgentApiKeys = ({ agent }: { readonly agent: AgentEntity }) => {
  const { t } = useModernI18n();
  if (!agent.hasProfile || agent.status !== 'active') {
    return <p className="text-fg-secondary text-sm">{t(`${copyKey}.requiresProfile`)}</p>;
  }
  const principalId = Schema.decodeOption(PrincipalIdSchema)(agent.principalId);
  if (Option.isNone(principalId)) {
    return <StatusText status="error">{t(`${copyKey}.failed`)}</StatusText>;
  }
  return <AgentKeyDetail key={principalId.value} principalId={principalId.value} />;
};
