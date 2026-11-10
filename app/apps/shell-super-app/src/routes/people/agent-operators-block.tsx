// Who may connect an agent: ticking people changes only the draft; the shared Save button ("Uložit", last in the
// block) sends the whole operator set once, and leaving with an unsaved selection asks Uložit / Zahodit změny / Zůstat.
import {
  SaveBar,
  UnsavedChangesDialog,
  dialogCloseLabel,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { DraftSaveResult } from '@app/admin-ui';
import type { AgentEntity, PrincipalRef } from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Effect, Option } from 'effect';
import type { HttpClient } from 'effect/http';
import { useState } from 'react';
import { saveAgentOperators } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

const connectionsKey = 'shell.agents.connections';
const PEOPLE_ERROR_KEY = 'shell.agents.errors';

const sameIds = (left: readonly string[], right: readonly string[]) => {
  const rightIds = new Set(right);
  return left.length === right.length && left.every((id) => rightIds.has(id));
};

export interface OperatorsBlockProps {
  readonly agent: AgentEntity;
  readonly company: string;
  readonly members: readonly PrincipalRef[];
  readonly onChanged: () => void;
  readonly onNotify: (title: string, description?: string) => void;
}

/** The connections the selection would cut: the agent connected by people who are being removed. */
const cutConnections = (agent: AgentEntity, confirmed: readonly string[], selected: readonly string[]) => {
  const confirmedSet = new Set(confirmed);
  const selectedSet = new Set(selected);
  return agent.connections.filter(
    (connection) =>
      Option.isSome(connection.delegatedBy) &&
      confirmedSet.has(connection.delegatedBy.value.principalId) &&
      !selectedSet.has(connection.delegatedBy.value.principalId),
  );
};

export const OperatorsBlock = ({ agent, company, members, onChanged, onNotify }: OperatorsBlockProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The draft follows the server's operators while nothing is pending; a dirty selection survives a refresh.
  const record = useRecordDraft<readonly string[], HttpClient.HttpClient>({
    equals: sameIds,
    isValid: () => true,
    refresh: Effect.sync(onChanged),
    revision: agent.operatorsRevision,
    runtime: browserRuntime,
    // The shell refuses the save with 409 when the operators moved on since the revision this draft was read from.
    save: (value, expectedRevision) =>
      saveAgentOperators({
        agentPrincipalId: agent.principalId,
        expectedRevision,
        operatorPrincipalIds: value.map((id) => AgentPrincipalIdSchema.make(id)),
      }).pipe(
        Effect.map((outcome): DraftSaveResult<readonly string[]> => {
          if (outcome.status === 'failed') {
            if (outcome.reason === 'conflict') {
              return 'conflict';
            }
            setServerError(outcome.detail ?? t(`${PEOPLE_ERROR_KEY}.${outcome.reason}`));
            return 'failed';
          }
          setServerError(null);
          onNotify(t(`${connectionsKey}.operators.saved`, { name: agent.displayName }));
          if (outcome.value.revokedConnections > 0) {
            onNotify(t(`${connectionsKey}.operators.revoked`, { count: outcome.value.revokedConnections }));
          }
          onChanged();
          return 'saved';
        }),
      ),
    server: agent.operators.map((operator) => operator.principalId),
  });
  const selected = record.draft;
  const selectedSet = new Set(selected);
  const cut = cutConnections(agent, record.confirmed, selected);
  const cutNames = [
    ...new Set(
      cut.map((connection) =>
        Option.match(connection.delegatedBy, { onNone: () => '', onSome: (person) => person.displayName }),
      ),
    ),
  ].join(', ');
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    // Removing someone who has the agent connected disconnects them: that save goes through the confirmation only.
    draft: { ...record, canSave: record.canSave && cut.length === 0 },
    navigation: blocker,
    onDiscard: record.discard,
  });

  const toggle = (principalId: string, checked: boolean) =>
    record.setDraft((current) =>
      checked
        ? [...current.filter((id) => id !== principalId), principalId]
        : current.filter((id) => id !== principalId),
    );
  const handleConfirmedSave = () => {
    setConfirming(false);
    record.save();
  };
  const handleReloadLatest = record.reloadLatest;
  const handleSave = () => {
    if (cut.length > 0 && record.canSave) {
      setConfirming(true);
      return;
    }
    record.save();
  };

  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${connectionsKey}.operators.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${connectionsKey}.operators.hint`, { company })}</p>
      <div className="flex flex-col gap-100">
        {members.map((member) => (
          <FormCheckbox
            checked={selectedSet.has(member.principalId)}
            id={`agent-operator-${agent.principalId}-${member.principalId}`}
            key={member.principalId}
            label={member.displayName}
            onCheckedChange={(checked) => toggle(member.principalId, checked)}
            size="sm"
          />
        ))}
      </div>
      {selected.length === 0 && <p className="text-fg-secondary text-xs">{t(`${connectionsKey}.operators.empty`)}</p>}
      <SaveBar
        error={serverError}
        labels={labels}
        onReloadLatest={handleReloadLatest}
        onSave={handleSave}
        size="sm"
        status={record.status}
      />
      <Dialog
        actions={
          <>
            <Button onClick={() => setConfirming(false)} theme="outlined" type="button" variant="secondary">
              {t(`${connectionsKey}.operators.cancel`)}
            </Button>
            <Button onClick={handleConfirmedSave} type="button" variant="danger">
              {t(`${connectionsKey}.operators.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${connectionsKey}.operators.confirmDescription`, { count: cut.length, names: cutNames })}
        onOpenChange={(details) => setConfirming(details.open)}
        open={confirming}
        role="alertdialog"
        size="sm"
        title={t(`${connectionsKey}.operators.confirmTitle`)}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </section>
  );
};
