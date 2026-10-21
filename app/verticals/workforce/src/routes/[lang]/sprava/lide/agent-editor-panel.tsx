import { SidePanel } from '@app/admin-ui';
import type {
  AgentEntity,
  AgentModuleOption,
  AgentRolePreset,
  AgentWritePolicy,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useState } from 'react';
import { runAgentCommand } from '../../../../api/agent-entities-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from '../../prodej/zamestnanci/employee-model.ts';
import {
  type AgentDraft,
  type AgentDraftError,
  type ModuleChoice,
  configureRequest,
  createRequest,
  draftErrors,
  draftFromAgent,
  emptyAgentDraft,
  withModuleChoice,
  withPreset,
  writeIgnored,
} from './agent-editor-model.ts';

export interface AgentEditorPanelProps {
  readonly agent: AgentEntity | null;
  readonly members: readonly PrincipalRef[];
  readonly modules: readonly AgentModuleOption[];
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
  readonly presets: readonly AgentRolePreset[];
}

const key = 'workforce.agents.editor';
const RESIZE_LABEL_KEY = 'workforce.sidePanel.resize';
const selectLabelProps = { className: 'text-label-md' };
const policies: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

export const AgentEditorPanel = (props: AgentEditorPanelProps) => {
  const { agent, members, modules, onClose, onSaved, presets } = props;
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<AgentDraft>(() => (agent === null ? emptyAgentDraft : draftFromAgent(agent)));
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = draftErrors(draft, modules);
  const nameError = errors.find((error) => error === 'nameRequired' || error === 'nameTooLong');
  const descriptionError = errors.includes('descriptionTooLong') ? 'descriptionTooLong' : undefined;
  const ownerError = errors.includes('ownerRequired');
  const modulesError = errors.includes('modulesRequired');
  const fieldStatus = (error: AgentDraftError | undefined) =>
    submitted && error !== undefined ? { helpText: t(`${key}.errors.${error}`), validateStatus: 'error' as const } : {};

  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (errors.length > 0) {
      return;
    }
    const request =
      agent === null ? createRequest(draft, modules) : configureRequest(draft, modules, agent.principalId);
    const name = draft.displayName.trim();
    setBusy(true);
    setServerError(null);
    void browserRuntime
      .runPromise(newRequestToken.pipe(Effect.flatMap((token) => runAgentCommand(request, `agent-${token}`))))
      .then((outcome) => {
        setBusy(false);
        if (outcome.status === 'ok') {
          onSaved(t(agent === null ? `${key}.toast.created` : `${key}.toast.saved`, { name }));
        } else {
          setServerError(outcome.detail ?? t(`workforce.people.errors.${outcome.reason}`));
        }
      })
      .catch(() => {
        setBusy(false);
        setServerError(t('workforce.people.errors.error'));
      });
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.cancel`)}
          </Button>
          <Button
            form="agent-editor-form"
            isLoading={busy}
            loadingText={t(`${key}.saving`)}
            type="submit"
            variant="primary"
          >
            {t(agent === null ? `${key}.create` : `${key}.save`)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={t(`${key}.createDescription`)}
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
      <form
        className="flex flex-col gap-250 py-200"
        id="agent-editor-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
          placeholder={t('workforce.selectPlaceholder')}
          value={draft.ownerPrincipalId === null ? [] : [draft.ownerPrincipalId]}
        />
        {submitted && ownerError && (
          <StatusText showIcon status="error">
            {t(`${key}.errors.ownerRequired`)}
          </StatusText>
        )}
        <section className="flex flex-col gap-150">
          <h3 className="font-semibold text-sm">{t(`${key}.modulesTitle`)}</h3>
          <p className="text-fg-secondary text-xs">{t(`${key}.modulesHint`)}</p>
          {presets.length > 0 && (
            <SelectTemplate
              id="agent-preset"
              items={presets.map((preset) => ({ displayValue: preset.label, label: preset.label, value: preset.key }))}
              label={t(`${key}.preset`)}
              labelProps={selectLabelProps}
              name="preset"
              onValueChange={(details) => {
                const preset = presets.find((candidate) => candidate.key === details.value[0]);
                if (preset !== undefined) {
                  setPresetKey(preset.key);
                  setDraft(withPreset(draft, preset, modules));
                }
              }}
              placeholder={t('workforce.selectPlaceholder')}
              size="sm"
              value={presetKey === null ? [] : [presetKey]}
            />
          )}
          <ul className="flex flex-col">
            {modules.map((option) => {
              const choices: readonly ModuleChoice[] =
                option.maxAccess === 'write' ? ['none', 'read', 'write'] : ['none', 'read'];
              return (
                <li
                  className="grid grid-cols-1 gap-100 border-border-primary/60 border-b py-150 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center"
                  key={option.moduleId}
                >
                  <span className="text-sm">{option.label}</span>
                  <SelectTemplate
                    id={`agent-module-${option.moduleId}`}
                    items={choices.map((choice) => ({
                      displayValue: t(`${key}.choice.${choice}`),
                      label: t(`${key}.choice.${choice}`),
                      value: choice,
                    }))}
                    label={option.label}
                    labelProps={{ className: 'sr-only' }}
                    name={`module-${option.moduleId}`}
                    onValueChange={(details) =>
                      setDraft(
                        withModuleChoice(
                          draft,
                          option.moduleId,
                          (details.value[0] as ModuleChoice | undefined) ?? 'none',
                        ),
                      )
                    }
                    size="sm"
                    value={[draft.modules[option.moduleId] ?? 'none']}
                  />
                </li>
              );
            })}
          </ul>
          {submitted && modulesError && (
            <StatusText showIcon status="error">
              {t(`${key}.errors.modulesRequired`)}
            </StatusText>
          )}
        </section>
        <section className="flex flex-col gap-150">
          <h3 className="font-semibold text-sm">{t(`${key}.policyTitle`)}</h3>
          {policies.map((policy) => (
            <label className="flex items-start gap-150" key={policy}>
              <input
                checked={draft.writePolicy === policy}
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
          {writeIgnored(draft) && <p className="text-fg-secondary text-xs">{t(`${key}.readOnlyIgnoresWrite`)}</p>}
        </section>
        {agent === null && (
          <section className="flex flex-col gap-150">
            <h3 className="font-semibold text-sm">{t(`${key}.operatorsTitle`)}</h3>
            <p className="text-fg-secondary text-xs">{t(`${key}.operatorsHint`)}</p>
            {members.map((member) => (
              <FormCheckbox
                checked={draft.operatorPrincipalIds.includes(member.principalId)}
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
    </SidePanel>
  );
};
