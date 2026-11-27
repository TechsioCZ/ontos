import { formatDateTime } from '@app/admin-ui';
import type { AgentEntity } from '@app/shared-contracts/agent-access';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Fiber, Option, Redacted, Schedule, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import {
  ApiKeyIssueResponseSchema,
  PrincipalIdSchema,
  ShellPolicyConflictProblemSchema,
} from '../../../shared/browser-api.ts';
import type { ManagedApiKeyListResponse, SetManagedApiKeyStatusPayload } from '../../../shared/browser-api.ts';
import {
  issueManagedApiKey,
  listManagedApiKeys,
  rotateManagedApiKey,
  setManagedApiKeyStatus,
} from '../../api/auth-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';
import { KeyConfirmation } from './agent-key-confirmation.tsx';
import type { KeyCommandDraft, KeyCommandEnd } from './agent-key-confirmation.tsx';

class AgentKeyScopeError extends Schema.TaggedError<AgentKeyScopeError>()('AgentKeyScopeError', {
  reason: Schema.String,
}) {}
/** Live changes of Core-owned data (keys included) arrive for the pseudo app `shell`; `all` after a reconnect. */
const LiveChangeDetailSchema = Schema.Struct({
  apps: Schema.Union([Schema.Literal('all'), Schema.Array(Schema.String)]),
});
const changesKeys = (event: Event): boolean =>
  Schema.decodeUnknownOption(LiveChangeDetailSchema)('detail' in event ? event.detail : null).pipe(
    Option.exists(({ apps }) => apps === 'all' || apps.includes('shell')),
  );
type ManagedPrincipalId = typeof PrincipalIdSchema.Type;
type ManagedKey = NonNullable<ManagedApiKeyListResponse['items'][number]['key']>;
type KeyCommand =
  | { readonly kind: 'issue' }
  | { readonly key: ManagedKey; readonly kind: 'disable' | 'enable' | 'revoke' | 'rotate' };
/**
 * Whose keys are managed: an agent's in the selected company, or a tenant-managed integration's (or service's), whose
 * issue and rotation may register a key value the integration already holds.
 */
export interface ManagedKeySubject {
  readonly principalId: ManagedPrincipalId;
  readonly scope: 'company-agent' | 'tenant-managed';
}
const agentCopyKey = 'shell.agents.keys';
const companyAgentScope = 'company-agent';
const pageSize = 100;
const readTimeout = '30 seconds';

/** An agent key is always generated; a tenant-managed key may carry the value the integration already holds. */
const withSuppliedSecret = <Payload extends object>(
  subject: ManagedKeySubject,
  draft: KeyCommandDraft,
  payload: Payload,
): Payload | (Payload & { readonly secret: Redacted.Redacted }) =>
  subject.scope === 'tenant-managed' && draft.suppliedSecret !== undefined
    ? { ...payload, secret: draft.suppliedSecret }
    : payload;

const keyCommand = (command: KeyCommand, subject: ManagedKeySubject, draft: KeyCommandDraft, token: string) => {
  const { principalId, scope } = subject;
  const { name, reason } = draft;
  const options = { idempotencyKey: token };
  if (command.kind === 'issue') {
    return issueManagedApiKey(
      scope === companyAgentScope
        ? { name, principalId, scope }
        : withSuppliedSecret(subject, draft, { name, principalId, scope }),
      options,
    );
  }
  if (command.kind === 'rotate') {
    const rotation = { name, oldAuthBindingId: command.key.authBindingId, principalId, reason };
    return rotateManagedApiKey(
      scope === companyAgentScope ? { ...rotation, scope } : withSuppliedSecret(subject, draft, { ...rotation, scope }),
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
  readonly authBindingId: ManagedKey['authBindingId'];
  readonly bindingStatus: ManagedKey['bindingStatus'] | 'revoked';
  readonly cleanupPending: boolean;
}
const projectionMatches = (projection: KeyProjection, keys: readonly ManagedKey[], nextOffset: number | null) => {
  const target = keys.find((candidate) => candidate.authBindingId === projection.authBindingId);
  return projection.bindingStatus === 'revoked'
    ? nextOffset === null && target === undefined
    : target?.bindingStatus === projection.bindingStatus;
};

/**
 * One page of the subject's keys. An agent's list is scoped to the agent by the server, and a row of another principal
 * is a failed read. The tenant-managed list is the Tenant's (the administrator may see all of it); one integration's
 * keys are its rows.
 */
const readKeys = (subject: ManagedKeySubject, offset: number) =>
  subject.scope === companyAgentScope
    ? listManagedApiKeys({ limit: pageSize, offset, principalId: subject.principalId, scope: subject.scope }).pipe(
        Effect.flatMap((response) =>
          response.items.some((item) => item.principalId !== subject.principalId || item.kind !== 'agent')
            ? Effect.fail(new AgentKeyScopeError({ reason: 'Agent key response does not match its requested scope' }))
            : Effect.succeed(response),
        ),
      )
    : listManagedApiKeys({ limit: pageSize, offset, scope: subject.scope }).pipe(
        Effect.map((response) => ({
          ...response,
          items: response.items.filter((item) => item.principalId === subject.principalId),
        })),
      );

const useManagedKeys = (subject: ManagedKeySubject) => {
  const [keys, setKeys] = useState<readonly ManagedKey[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<'conflict' | 'failed' | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [secret, setSecret] = useState<Redacted.Redacted | null>(null);
  const [notice, setNotice] = useState<'cleanupPending' | 'projectionPending' | 'updated' | null>(null);
  const pending = useRef<Fiber.Fiber<void> | null>(null);
  const expected = useRef<KeyProjection | null>(null);
  const loadedKeys = useRef<readonly ManagedKey[]>([]);

  useEffect(
    () => () => {
      if (pending.current !== null) {
        browserRuntime.runFork(Fiber.interrupt(pending.current));
      }
    },
    [],
  );

  const updateKeys = (offset: number, items: readonly ManagedKey[], next: number | null) => {
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
    return confirmed;
  };
  const read = (offset: number) =>
    readKeys(subject, offset).pipe(
      Effect.flatMap((response) => {
        const items = response.items.flatMap((item) => (item.key === null ? [] : [item.key]));
        return Effect.sync(() => updateKeys(offset, items, response.nextOffset));
      }),
    );

  /**
   * After a command, re-reads the first page a few times with growing pauses until it shows the result (the
   * projection catches up on its own). Still unconfirmed, the list stays locked and offers a retry; no command is
   * ever repeated.
   */
  const readUntilConfirmed = () =>
    Effect.suspend(() => read(0)).pipe(
      Effect.repeat({
        schedule: Schedule.exponential('1 second'),
        times: 4,
        while: (confirmed) => !confirmed,
      }),
    );

  const runRead = (offset: number) =>
    browserRuntime.runFork(
      read(offset).pipe(
        Effect.timeout(readTimeout),
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
  const load = (offset = 0) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    pending.current = runRead(offset);
  };

  /** Runs one key command; false when it cannot start now. `onEnd` hears whether it committed or why it did not. */
  const handleExecute = (command: KeyCommand, draft: KeyCommandDraft, onEnd: (end: KeyCommandEnd) => void): boolean => {
    if (busy || needsRefresh || secret !== null) {
      return false;
    }
    let committed = false;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    pending.current = browserRuntime.runFork(
      newRequestToken.pipe(
        Effect.flatMap((token) => keyCommand(command, subject, draft, token)),
        Effect.tap((response) =>
          Effect.sync(() => {
            // Only a generated key's secret comes back; a registered existing value is the integration's own.
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
            committed = true;
            onEnd('saved');
          }),
        ),
        // A committed mutation is never retried, even when this subsequent projection read fails.
        Effect.andThen(readUntilConfirmed),
        Effect.timeout(readTimeout),
        Effect.matchEffect({
          onFailure: (problem) => {
            const conflict = Schema.is(ShellPolicyConflictProblemSchema)(problem);
            return Effect.sync(() => {
              setFailure(conflict ? 'conflict' : 'failed');
              setNeedsRefresh(true);
              // A failed read after the commit does not undo it: the form already heard it was saved.
              if (!committed) {
                onEnd(conflict ? 'conflict' : 'failed');
              }
            }).pipe(
              // A changed key is shown at once; the command itself is never repeated.
              Effect.andThen(conflict ? read(0).pipe(Effect.timeout(readTimeout), Effect.ignore) : Effect.void),
            );
          },
          onSuccess: () => Effect.void,
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
    return true;
  };

  // The keys load as soon as the detail is shown and follow live changes while it stays open.
  const loadOnEvent = useEffectEvent(() => load());
  // The first read starts with the detail; `busy` starts true for it.
  const startFirstRead = useEffectEvent(() => {
    pending.current = runRead(0);
  });
  useEffect(() => {
    startFirstRead();
    const follow = (event: Event) => {
      if (changesKeys(event)) {
        loadOnEvent();
      }
    };
    globalThis.addEventListener(moduleChangeEvent, follow);
    return () => globalThis.removeEventListener(moduleChangeEvent, follow);
  }, []);

  return { busy, failure, handleExecute, keys, load, needsRefresh, nextOffset, notice, secret, setSecret };
};

const OneTimeSecret = ({
  copyKey,
  onDismiss,
  secret,
}: {
  readonly copyKey: string;
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

const ManagedKeyRow = ({
  copyKey,
  item,
  locked,
  onCommand,
}: {
  readonly copyKey: string;
  readonly item: ManagedKey;
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

/** The keys of one agent or integration, with every key command; `copyKey` names the copy of that kind. */
export const ManagedKeyDetail = ({
  allowSuppliedSecret = false,
  copyKey,
  subject,
}: {
  readonly allowSuppliedSecret?: boolean;
  readonly copyKey: string;
  readonly subject: ManagedKeySubject;
}) => {
  const { t } = useModernI18n();
  const state = useManagedKeys(subject);
  const [command, setCommand] = useState<KeyCommand | null>(null);
  const locked = state.busy || state.needsRefresh || state.secret !== null;
  return (
    <section className="flex min-w-0 flex-col gap-150 border-border-primary/60 border-t py-250">
      <h3 className="font-semibold text-sm">{t(`${copyKey}.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${copyKey}.description`)}</p>
      <div className="flex flex-wrap gap-100">
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
      {(state.failure !== null || state.needsRefresh) && !state.busy && (
        <div>
          <Button onClick={() => state.load()} size="sm" theme="outlined" type="button" variant="secondary">
            {t(`${copyKey}.retry`)}
          </Button>
        </div>
      )}
      {state.notice !== null && (
        <StatusText showIcon status={state.notice === 'updated' ? 'success' : 'warning'}>
          {t(`${copyKey}.${state.notice}`)}
        </StatusText>
      )}
      {state.needsRefresh && !state.busy && <StatusText status="warning">{t(`${copyKey}.refreshRequired`)}</StatusText>}
      {state.secret !== null && (
        <OneTimeSecret copyKey={copyKey} onDismiss={() => state.setSecret(null)} secret={state.secret} />
      )}
      {state.keys?.length === 0 && <p className="text-fg-secondary text-sm">{t(`${copyKey}.empty`)}</p>}
      <ul className="flex min-w-0 flex-col">
        {state.keys?.map((item) => (
          <ManagedKeyRow
            copyKey={copyKey}
            item={item}
            key={item.authBindingId}
            locked={locked}
            onCommand={setCommand}
          />
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
          allowSuppliedSecret={allowSuppliedSecret}
          busy={state.busy}
          command={command}
          copyKey={copyKey}
          failure={state.failure}
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
    return <p className="text-fg-secondary text-sm">{t(`${agentCopyKey}.requiresProfile`)}</p>;
  }
  const principalId = Schema.decodeOption(PrincipalIdSchema)(agent.principalId);
  if (Option.isNone(principalId)) {
    return <StatusText status="error">{t(`${agentCopyKey}.failed`)}</StatusText>;
  }
  return (
    <ManagedKeyDetail
      copyKey={agentCopyKey}
      key={principalId.value}
      subject={{ principalId: principalId.value, scope: companyAgentScope }}
    />
  );
};
