import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useId, useState } from 'react';

import { PeopleEditor } from './people-editor.tsx';
import type {
  PeopleCommand,
  PeopleFeedback,
  PeoplePendingChange,
  PeoplePersonView,
  PeopleViewModel,
} from './people-view-model.ts';

const prefix = 'shell.accessAdmin.people';
const emptyLabel = 'shell.accessAdmin.common.none';
const END_MEMBERSHIP = 'end-membership';

const PersonDetails = ({
  busy,
  onPreview,
  person,
}: {
  readonly busy: boolean;
  readonly onPreview: (change: PeoplePendingChange) => void;
  readonly person: PeoplePersonView;
}) => {
  const { t } = useModernI18n();
  return (
    <li className="shell:grid shell:gap-4">
      <h3 className="shell:text-title-md">{person.label}</h3>
      {person.suspended ? <Badge variant="warning">{t(`${prefix}.status.suspended`)}</Badge> : null}
      <h4 className="shell:text-title-sm">{t(`${prefix}.companyMemberships`)}</h4>
      {person.memberships.length === 0 ? (
        <p>{t(`${prefix}.noCompany`)}</p>
      ) : (
        <ul className="shell:grid shell:gap-2">
          {person.memberships.map((membership) => (
            <li className="shell:flex shell:flex-wrap shell:gap-2" key={membership.id}>
              <span>{membership.scope}</span>
              <Badge variant="outline">{t(`${prefix}.kind.${membership.kind}`)}</Badge>
              <Badge variant={membership.status === 'active' ? 'info' : 'warning'}>
                {t(`${prefix}.status.${membership.status}`)}
              </Badge>
              <span>
                {membership.expiryLabel === null
                  ? t(`${prefix}.noExpiry`)
                  : t('shell.accessAdmin.deadline.expiresAt', { date: membership.expiryLabel })}
              </span>
              {membership.kind === 'member' && membership.status === 'active' ? (
                <Button
                  aria-label={t(`${prefix}.endMembershipNamed`, { person: person.label, scope: membership.scope })}
                  disabled={busy || !membership.canEnd}
                  onClick={() =>
                    onPreview({
                      command: { kind: END_MEMBERSHIP, personId: person.id, reason: '', scopeId: membership.scopeId },
                      facts: [
                        person.label,
                        membership.scope,
                        t(`${prefix}.endMembershipEnds`, membership.ends),
                        t(`${prefix}.endMembershipEffect`),
                      ],
                      titleKey: `${prefix}.confirmEndMembership`,
                    })
                  }
                  type="button"
                  variant="secondary"
                >
                  {t(`${prefix}.endMembership`)}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {person.soleOwnerScopes.length > 0 ? (
        <div>
          <StatusText showIcon status="warning">
            {t(`${prefix}.lastOwnerTransfer`)}
          </StatusText>
          <ul>
            {person.soleOwnerScopes.map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
          <p>{t(`${prefix}.transferUnavailable`)}</p>
        </div>
      ) : null}
      <h4 className="shell:text-title-sm">{t(`${prefix}.roles`)}</h4>
      {person.assignments.length === 0 ? (
        <p>{t(emptyLabel)}</p>
      ) : (
        <ul className="shell:grid shell:gap-3">
          {person.assignments.map((assignment) => (
            <li className="shell:grid shell:gap-2" key={assignment.id}>
              <p>
                {assignment.role} · {assignment.scope}
              </p>
              <Badge variant="outline">{t(`${prefix}.status.${assignment.status}`)}</Badge>
              <p>
                {assignment.expiryLabel === null
                  ? t(`${prefix}.noExpiry`)
                  : t('shell.accessAdmin.deadline.expiresAt', { date: assignment.expiryLabel })}
              </p>
              {assignment.delegatedLimits === null ? null : (
                <div>
                  <p>{t(`${prefix}.delegationCeiling`)}</p>
                  <dl>
                    <dt>{t(`${prefix}.permissions`)}</dt>
                    <dd>{assignment.delegatedLimits.capabilities.join(', ')}</dd>
                    <dt>{t(`${prefix}.amountMinor`)}</dt>
                    <dd>{assignment.delegatedLimits.amount ?? t(`${prefix}.noAmountLimit`)}</dd>
                    <dt>{t(`${prefix}.endDate`)}</dt>
                    <dd>{assignment.delegatedLimits.expiryLabel}</dd>
                  </dl>
                </div>
              )}
              <Button
                aria-label={t('shell.accessAdmin.accessible.removeRoleNamed', {
                  person: person.label,
                  role: assignment.role,
                })}
                disabled={busy || !assignment.canRemove}
                onClick={() =>
                  onPreview({
                    command: { assignmentId: assignment.id, kind: 'remove-role' },
                    facts: [
                      person.label,
                      assignment.role,
                      assignment.scope,
                      t(`${prefix}.membershipHelp`),
                      ...(person.soleOwnerScopes.length > 0 ? [t(`${prefix}.lastOwnerTransfer`)] : []),
                    ],
                    titleKey: `${prefix}.confirmRemove`,
                  })
                }
                type="button"
                variant="secondary"
              >
                {t(`${prefix}.removeRole`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="shell:text-title-sm">{t(`${prefix}.teams`)}</h4>
      {person.teams.length === 0 ? (
        <p>{t(emptyLabel)}</p>
      ) : (
        <ul className="shell:grid shell:gap-3">
          {person.teams.map((team) => (
            <li key={team.id}>
              <p>
                {team.label} · {team.scope}
              </p>
              <Button
                disabled={busy || !team.canRemove}
                onClick={() =>
                  onPreview({
                    command: { action: 'leave', kind: 'team', personId: person.id, teamId: team.id },
                    facts: [person.label, team.label, team.scope],
                    titleKey: `${prefix}.teamRemove`,
                  })
                }
                type="button"
                variant="secondary"
              >
                {t(`${prefix}.teamRemove`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="shell:text-title-sm">{t(`${prefix}.delegation`)}</h4>
      {person.delegations.length === 0 ? (
        <p>{t(emptyLabel)}</p>
      ) : (
        <ul className="shell:grid shell:gap-4">
          {person.delegations.map((delegation) => (
            <li className="shell:grid shell:gap-2" key={delegation.id}>
              <dl className="shell:grid shell:gap-2">
                <dt>{t(`${prefix}.delegatedManager`)}</dt>
                <dd>{delegation.manager}</dd>
                <dt>{t(`${prefix}.scope`)}</dt>
                <dd>{delegation.scope}</dd>
                <dt>{t(`${prefix}.delegationPeople`)}</dt>
                <dd>{delegation.people.join(', ')}</dd>
                <dt>{t(`${prefix}.delegationRoles`)}</dt>
                <dd>{delegation.roles.join(', ')}</dd>
                <dt>{t(`${prefix}.permissions`)}</dt>
                <dd>{delegation.capabilities.join(', ')}</dd>
                <dt>{t(`${prefix}.amountMinor`)}</dt>
                <dd>{delegation.amount ?? t(`${prefix}.noAmountLimit`)}</dd>
                <dt>{t(`${prefix}.endDate`)}</dt>
                <dd>{delegation.expiryLabel}</dd>
              </dl>
              <Badge variant="outline">{t(`${prefix}.status.${delegation.status}`)}</Badge>
              <p>{t(`${prefix}.delegationHelp`)}</p>
              <Button
                disabled={busy || !delegation.canRevoke}
                onClick={() =>
                  onPreview({
                    command: { delegationId: delegation.id, kind: 'revoke-delegation' },
                    facts: [
                      delegation.manager,
                      delegation.scope,
                      ...delegation.people,
                      ...delegation.roles,
                      ...delegation.capabilities,
                    ],
                    titleKey: `${prefix}.delegationRevoke`,
                  })
                }
                type="button"
                variant="secondary"
              >
                {t(`${prefix}.delegationRevoke`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/** The wire requires a reason to end a membership; the other confirmed commands carry none. */
const confirmedCommand = (command: PeopleCommand, reason: string): PeopleCommand | null => {
  if (command.kind !== END_MEMBERSHIP) {
    return command;
  }
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : { ...command, reason: trimmed };
};
const feedbackKey = (feedback: PeopleFeedback): string => {
  if (feedback === 'invalid') {
    return `${prefix}.invalid`;
  }
  if (feedback === 'ownershipTransfer') {
    return `${prefix}.lastOwnerTransfer`;
  }
  return `shell.accessAdmin.common.${feedback}`;
};
const anyWriteAvailable = (model: PeopleViewModel) =>
  model.writes.admit ||
  model.writes.assign ||
  model.writes.delegate ||
  model.writes.team ||
  model.people.some(
    (person) =>
      person.memberships.some((membership) => membership.canEnd) ||
      person.assignments.some((assignment) => assignment.canRemove) ||
      person.teams.some((team) => team.canRemove) ||
      person.delegations.some((delegation) => delegation.canRevoke),
  );

const ConfirmDialog = ({
  blocked,
  busy,
  onCancel,
  onConfirm,
  onReason,
  pending,
  reason,
  stale,
}: {
  readonly blocked: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onReason: (reason: string) => void;
  readonly pending: PeoplePendingChange | null;
  readonly reason: string;
  readonly stale: boolean;
}) => {
  const { t } = useModernI18n();
  const reasonId = useId();
  return (
    <Dialog
      actions={
        <>
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">
            {t('shell.accessAdmin.common.cancel')}
          </Button>
          <Button disabled={blocked} onClick={onConfirm} type="button">
            {t('shell.accessAdmin.common.confirm')}
          </Button>
        </>
      }
      closeOnEscape={!busy}
      closeOnInteractOutside={!busy}
      customTrigger
      hideCloseButton
      onOpenChange={({ open }) => {
        if (!open && !busy) {
          onCancel();
        }
      }}
      open={pending !== null}
      title={t(pending?.titleKey ?? `${prefix}.title`)}
    >
      <ul className="shell:grid shell:gap-2">
        {pending?.facts.map((fact, index) => (
          <li key={`${index}-${fact}`}>{fact}</li>
        ))}
      </ul>
      {pending?.command.kind === END_MEMBERSHIP ? (
        <FormInput
          disabled={busy}
          id={`${reasonId}-reason`}
          label={t(`${prefix}.endMembershipReason`)}
          maxLength={500}
          onChange={(event) => onReason(event.target.value)}
          required
          value={reason}
        />
      ) : null}
      {stale ? <StatusText status="warning">{t('shell.accessAdmin.common.stalePreview')}</StatusText> : null}
    </Dialog>
  );
};

export const PeopleView = ({
  feedback,
  model,
  onCommand,
  onNextPage,
  onRefresh,
}: {
  readonly feedback: PeopleFeedback;
  readonly model: PeopleViewModel;
  readonly onCommand: (command: PeopleCommand, revision: string) => void;
  readonly onNextPage: () => void;
  readonly onRefresh: () => void;
}) => {
  const { t } = useModernI18n();
  const [pending, setPending] = useState<(PeoplePendingChange & { readonly revision: string }) | null>(null);
  const [reason, setReason] = useState('');
  const busy = feedback === 'saving';
  const writesAvailable = anyWriteAvailable(model);
  const preview = (change: PeoplePendingChange) => {
    setReason('');
    setPending({ ...change, revision: model.revision });
  };
  const stale = pending !== null && pending.revision !== model.revision;
  const command = pending === null ? null : confirmedCommand(pending.command, reason);
  const blocked = busy || stale || command === null || !writesAvailable || feedback === 'conflict';
  const confirm = () => {
    if (pending !== null && command !== null && !blocked) {
      onCommand(command, pending.revision);
      setPending(null);
    }
  };
  return (
    <section aria-label={t(`${prefix}.title`)} className="shell:grid shell:w-full shell:max-w-5xl shell:gap-6">
      <p>{t(`${prefix}.description`)}</p>
      <p>{t('shell.accessAdmin.description')}</p>
      <StatusText showIcon status="default">
        {t(`${prefix}.membershipHelp`)}
      </StatusText>
      {writesAvailable ? null : (
        <StatusText showIcon status="warning">
          {t(`${prefix}.previewOnly`)}
        </StatusText>
      )}
      {feedback === 'idle' ? null : (
        <StatusText aria-live="polite" status={feedback === 'saved' ? 'success' : 'warning'}>
          {t(feedbackKey(feedback))}
        </StatusText>
      )}
      <Button disabled={busy} onClick={onRefresh} type="button" variant="secondary">
        {t('shell.accessAdmin.common.refresh')}
      </Button>
      {model.people.length === 0 ? (
        <StatusText>{t(`${prefix}.empty`)}</StatusText>
      ) : (
        <ul aria-label={t('shell.accessAdmin.accessible.peopleList')} className="shell:grid shell:gap-6">
          {model.people.map((person) => (
            <PersonDetails busy={busy} key={person.id} onPreview={preview} person={person} />
          ))}
        </ul>
      )}
      {model.hasMore ? (
        <Button disabled={busy} onClick={onNextPage} type="button" variant="secondary">
          {t(`${prefix}.nextPage`)}
        </Button>
      ) : null}
      {model.scopes.length > 0 ? <PeopleEditor busy={busy} model={model} onPreview={preview} /> : null}
      <ConfirmDialog
        blocked={blocked}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
        onReason={setReason}
        pending={pending}
        reason={reason}
        stale={stale}
      />
    </section>
  );
};
