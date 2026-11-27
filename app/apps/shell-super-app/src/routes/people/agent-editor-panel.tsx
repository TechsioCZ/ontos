import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import type { AgentEntity, AgentWritePolicy, PrincipalRef } from '@app/shared-contracts/agent-access';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import type { HttpClient } from 'effect/http';
import { useState } from 'react';
import { AgentApiKeys } from './agent-api-keys.tsx';
import { runAgentCommand } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';
import { configureRequest, createRequest, draftErrors, draftFromAgent, emptyAgentDraft } from './agent-editor-model.ts';
import type { AgentDraft, AgentDraftError } from './agent-editor-model.ts';

export interface AgentEditorPanelProps {
  readonly agent: AgentEntity | null;
  readonly members: readonly PrincipalRef[];
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
}

const key = 'shell.agents.editor';
const RESIZE_LABEL_KEY = 'shell.agents.resize';
const selectLabelProps = { className: 'text-label-md' };
const policies: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

export const AgentEditorPanel = (props: AgentEditorPanelProps) => {
  const { agent, members, onClose, onSaved } = props;
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [draft, setDraft] = useState<AgentDraft>(() => (agent === null ? emptyAgentDraft : draftFromAgent(agent)));
  const [serverError, setServerError] = useState<string | null>(null);
  // Nothing is sent until Uložit: the one save writes the whole draft once.
  const record = useDraftSave<AgentDraft, HttpClient.HttpClient>({
    isValid: (value) => draftErrors(value).length === 0,
    runtime: browserRuntime,
    save: (value) => {
      const request = agent === null ? createRequest(value) : configureRequest(value, agent.principalId);
      const name = value.displayName.trim();
      return newRequestToken.pipe(
        Effect.flatMap((token) => runAgentCommand(request, `agent-${token}`)),
        Effect.map((outcome): SaveOutcome => {
          if (outcome.status === 'ok') {
            setServerError(null);
            onSaved(t(agent === null ? `${key}.toast.created` : `${key}.toast.saved`, { name }));
            return 'saved';
          }
          setServerError(outcome.detail ?? t(`shell.agents.errors.${outcome.reason}`));
          return 'failed';
        }),
      );
    },
    value: draft,
  });
  // Field messages show once the draft is changed and invalid, the same moment the save bar says so.
  const showErrors = record.status === 'invalid';
  const errors = draftErrors(draft);
  const operatorIds = new Set(draft.operatorPrincipalIds);
  const nameError = errors.find((error) => error === 'nameRequired' || error === 'nameTooLong');
  const descriptionError = errors.includes('descriptionTooLong') ? 'descriptionTooLong' : undefined;
  const ownerError = errors.includes('ownerRequired');
  const fieldStatus = (error: AgentDraftError | undefined) =>
    showErrors && error !== undefined
      ? { helpText: t(`${key}.errors.${error}`), validateStatus: 'error' as const }
      : {};
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setDraft(record.confirmed),
  });

  const handleSave = record.save;
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => guard.request(onClose)} theme="outlined" variant="secondary">
              {t(`${key}.cancel`)}
            </Button>
            <SaveBar
              error={serverError}
              labels={labels}
              onReloadLatest={() => record.adopt(agent === null ? emptyAgentDraft : draftFromAgent(agent))}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        description={t(`${key}.createDescription`)}
        guard={guard}
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#agent-name')}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={agent === null ? t(`${key}.createTitle`) : t(`${key}.editTitle`, { name: agent.displayName })}
      >
        {/* `relative` keeps the selects' visually hidden native controls inside the panel's own scroll area. */}
        <form
          className="relative flex flex-col gap-250 py-200"
          id="agent-editor-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            record.save();
          }}
        >
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <FormInput
            autoComplete="off"
            id="agent-name"
            label={t(`${key}.name`)}
            name="displayName"
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            required
            value={draft.displayName}
            {...fieldStatus(nameError)}
          />
          <FormTextarea
            id="agent-description"
            label={t(`${key}.description`)}
            name="description"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            rows={2}
            value={draft.description}
            {...fieldStatus(descriptionError)}
          />
          <SelectTemplate
            id="agent-owner"
            items={members.map((member) => ({
              displayValue: member.displayName,
              label: member.displayName,
              value: member.principalId,
            }))}
            label={t(`${key}.owner`)}
            labelProps={selectLabelProps}
            name="owner"
            onValueChange={(details) => setDraft({ ...draft, ownerPrincipalId: details.value[0] ?? null })}
            placeholder={t('shell.agents.selectPlaceholder')}
            value={draft.ownerPrincipalId === null ? [] : [draft.ownerPrincipalId]}
          />
          {showErrors && ownerError && (
            <StatusText showIcon status="error">
              {t(`${key}.errors.ownerRequired`)}
            </StatusText>
          )}
          <p className="text-fg-secondary text-xs">{t(`${key}.rightsFromRoles`)}</p>
          <section className="flex flex-col gap-150">
            <h3 className="font-semibold text-sm">{t(`${key}.policyTitle`)}</h3>
            {policies.map((policy) => (
              <label
                aria-label={t(`${key}.policy.${policy}.label`)}
                className="flex items-start gap-150"
                htmlFor={`agent-policy-${policy}`}
                key={policy}
              >
                <input
                  checked={draft.writePolicy === policy}
                  id={`agent-policy-${policy}`}
                  name="agent-write-policy"
                  onChange={() => setDraft({ ...draft, writePolicy: policy })}
                  type="radio"
                />
                <span className="grid min-w-0 gap-50">
                  <span className="font-medium text-sm">{t(`${key}.policy.${policy}.label`)}</span>
                  <span className="text-fg-secondary text-xs">{t(`${key}.policy.${policy}.description`)}</span>
                </span>
              </label>
            ))}
          </section>
          {agent === null && (
            <section className="flex flex-col gap-150">
              <h3 className="font-semibold text-sm">{t(`${key}.operatorsTitle`)}</h3>
              <p className="text-fg-secondary text-xs">{t(`${key}.operatorsHint`)}</p>
              {members.map((member) => (
                <FormCheckbox
                  checked={operatorIds.has(member.principalId)}
                  id={`agent-new-operator-${member.principalId}`}
                  key={member.principalId}
                  label={member.displayName}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      operatorPrincipalIds: checked
                        ? [...draft.operatorPrincipalIds, member.principalId]
                        : draft.operatorPrincipalIds.filter((id) => id !== member.principalId),
                    })
                  }
                  size="sm"
                />
              ))}
            </section>
          )}
        </form>
        {agent !== null && (
          <AgentApiKeys agent={agent} key={`${agent.principalId}:${agent.status}:${agent.hasProfile}`} />
        )}
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
