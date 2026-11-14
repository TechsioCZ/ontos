import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useId } from 'react';

import type { ApprovalCardModel, ApprovalsContentModel } from '../../[lang]/access/approvals/approvals-page-model.ts';
import type { ApprovalDecision } from './approvals-contract.ts';

const notAvailableKey = 'shell.accessAdmin.common.notAvailable';

interface ApprovalCallbacks {
  readonly onDecision: (id: string, decision: ApprovalDecision) => void;
  readonly onExecute: (id: string) => void;
  readonly pending: boolean;
}

const ApprovalCard = ({
  item,
  onDecision,
  onExecute,
  pending,
}: ApprovalCallbacks & { readonly item: ApprovalCardModel }) => {
  const { t } = useModernI18n();
  const id = useId();
  return (
    <li className="shell:grid shell:gap-4">
      <article aria-labelledby={`${id}-title`} className="shell:grid shell:gap-4">
        <header className="shell:grid shell:gap-2">
          <h3 className="shell:text-title-md" id={`${id}-title`}>
            {item.title}
          </h3>
          <div className="shell:flex shell:flex-wrap shell:gap-2">
            <Badge variant="outline">{t(`shell.accessAdmin.approvals.status.${item.status}`)}</Badge>
            <Badge variant={item.risk === 'routine' ? 'info' : 'warning'}>
              {t(`shell.accessAdmin.risk.${item.risk}`)}
            </Badge>
          </div>
        </header>
        <dl className="shell:grid shell:gap-2 shell:text-body-sm">
          <div>
            <dt>{t('shell.accessAdmin.approvals.scope')}</dt>
            <dd>
              {t(
                item.scopeKind === 'tenant'
                  ? 'shell.accessAdmin.common.tenantContext'
                  : 'shell.accessAdmin.people.company',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('shell.accessAdmin.approvals.requester')}</dt>
            <dd>{item.requesterName ?? t(notAvailableKey)}</dd>
          </div>
          <div>
            <dt>{t('shell.accessAdmin.approvals.createdAt')}</dt>
            <dd>
              <time dateTime={item.createdAt}>{item.createdAt}</time>
            </dd>
          </div>
          <div>
            <dt>{t('shell.accessAdmin.approvals.proposalDeadline')}</dt>
            <dd>
              <time dateTime={item.expiresAt}>{item.expiresAt}</time>
            </dd>
          </div>
          {item.approval === undefined ? null : (
            <>
              <div>
                <dt>{t('shell.accessAdmin.approvals.approver')}</dt>
                <dd>{item.approval.approverName ?? t(notAvailableKey)}</dd>
              </div>
              <div>
                <dt>{t('shell.accessAdmin.approvals.approvedAt')}</dt>
                <dd>
                  <time dateTime={item.approval.approvedAt}>{item.approval.approvedAt}</time>
                </dd>
              </div>
              <div>
                <dt>{t('shell.accessAdmin.approvals.mandateDeadline')}</dt>
                <dd>
                  <time dateTime={item.approval.approvalExpiresAt}>{item.approval.approvalExpiresAt}</time>
                </dd>
              </div>
            </>
          )}
        </dl>
        <p className="shell:text-body-sm">{t('shell.accessAdmin.deadline.proposal')}</p>
        <p className="shell:text-body-sm">
          {t(
            item.risk === 'critical'
              ? 'shell.accessAdmin.deadline.mandateCritical'
              : 'shell.accessAdmin.deadline.mandate',
          )}
        </p>
        <section aria-labelledby={`${id}-command`} className="shell:grid shell:gap-2">
          <h4 className="shell:text-title-sm" id={`${id}-command`}>
            {t('shell.accessAdmin.approvals.frozenCommand')}
          </h4>
          <p className="shell:text-body-sm">{t('shell.accessAdmin.approvals.frozenCommandHelp')}</p>
          <dl className="shell:grid shell:gap-2 shell:text-body-sm">
            <div>
              <dt>{t('shell.accessAdmin.kind.action')}</dt>
              <dd>{item.command.actionKey}</dd>
            </div>
            <div>
              <dt>{t('shell.accessAdmin.approvals.digest')}</dt>
              <dd>{item.command.digestShort}</dd>
            </div>
            <div>
              <dt>{t('shell.accessAdmin.approvals.frozenAt')}</dt>
              <dd>
                <time dateTime={item.command.frozenAt}>{item.command.frozenAt}</time>
              </dd>
            </div>
            <div>
              <dt>{t('shell.accessAdmin.approvals.recordPreview')}</dt>
              <dd>{item.command.targetLabel ?? t(notAvailableKey)}</dd>
            </div>
          </dl>
          <h5 className="shell:text-title-sm">{t('shell.accessAdmin.approvals.frozenFields')}</h5>
          <dl className="shell:grid shell:gap-2 shell:text-body-sm">
            {item.command.fields.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
          {item.command.redactedFieldCount > 0 ? (
            <p>{t('shell.accessAdmin.approvals.redactedCount', { count: item.command.redactedFieldCount })}</p>
          ) : null}
        </section>
        <p className="shell:text-body-sm">{t('shell.accessAdmin.approvals.ownAuthority')}</p>
        <div className="shell:flex shell:flex-wrap shell:gap-2">
          {item.canApprove ? (
            <Button disabled={pending} onClick={() => onDecision(item.id, 'approve')} type="button">
              {t('shell.accessAdmin.approvals.actions.approve')}
            </Button>
          ) : null}
          {item.canReject ? (
            <Button disabled={pending} onClick={() => onDecision(item.id, 'reject')} type="button" variant="secondary">
              {t('shell.accessAdmin.approvals.actions.reject')}
            </Button>
          ) : null}
          {item.canWithdraw ? (
            <Button
              disabled={pending}
              onClick={() => onDecision(item.id, 'withdraw')}
              type="button"
              variant="secondary"
            >
              {t('shell.accessAdmin.approvals.actions.withdraw')}
            </Button>
          ) : null}
          <Button
            aria-describedby={`${id}-execution`}
            disabled={pending || !item.canExecute}
            onClick={() => onExecute(item.id)}
            type="button"
          >
            {t('shell.accessAdmin.approvals.actions.execute')}
          </Button>
        </div>
        <p className="shell:text-body-sm" id={`${id}-execution`}>
          {item.canExecute ? null : t(item.executionReasonKey)} {t('shell.accessAdmin.approvals.executeHelp')}
        </p>
      </article>
    </li>
  );
};

const failureKeys = {
  conflict: 'shell.accessAdmin.approvals.concurrentChange',
  forbidden: 'shell.accessAdmin.common.forbidden',
  invalid: 'shell.accessAdmin.common.failed',
  loading: 'shell.accessAdmin.common.loading',
  reload_required: 'shell.moduleTarget.reload_required',
  unauthenticated: 'shell.accessAdmin.common.unauthenticated',
  unavailable: 'shell.accessAdmin.common.unavailable',
} as const;

export const ApprovalsInbox = ({
  model,
  onDecision,
  onExecute,
  onNextPage,
  onRefresh,
  pending,
}: ApprovalCallbacks & {
  readonly model: ApprovalsContentModel;
  readonly onNextPage: () => void;
  readonly onRefresh: () => void;
}) => {
  const { t } = useModernI18n();
  const refreshable =
    model.state === 'ready' || model.state === 'conflict' || model.state === 'unavailable' || model.state === 'invalid';
  return (
    <section
      aria-busy={pending || model.state === 'loading'}
      aria-label={t('shell.accessAdmin.approvals.title')}
      className="shell:grid shell:w-full shell:max-w-5xl shell:gap-6"
    >
      <p>{t('shell.accessAdmin.approvals.description')}</p>
      {pending ? (
        <StatusText aria-live="polite" status="default">
          {t('shell.accessAdmin.common.loading')}
        </StatusText>
      ) : null}
      {model.state === 'ready' && model.items.length === 0 && (
        <StatusText status="default">{t('shell.accessAdmin.approvals.empty')}</StatusText>
      )}
      {model.state === 'ready' && model.items.length > 0 && (
        <ul aria-label={t('shell.accessAdmin.accessible.approvalList')} className="shell:grid shell:gap-6">
          {model.items.map((item) => (
            <ApprovalCard item={item} key={item.id} onDecision={onDecision} onExecute={onExecute} pending={pending} />
          ))}
        </ul>
      )}
      {model.state !== 'ready' && (
        <StatusText aria-live="polite" showIcon status={model.state === 'loading' ? 'default' : 'error'}>
          {t(failureKeys[model.state])}
        </StatusText>
      )}
      {model.state === 'ready' && model.nextCursor !== null ? (
        <Button disabled={pending} onClick={onNextPage} type="button" variant="secondary">
          {t('shell.accessAdmin.approvals.nextPage')}
        </Button>
      ) : null}
      {refreshable ? (
        <Button disabled={pending} onClick={onRefresh} type="button" variant="secondary">
          {t('shell.accessAdmin.common.refresh')}
        </Button>
      ) : null}
    </section>
  );
};
