import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  MemberCheckboxField,
  RadioField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { AgentEntity, AgentWritePolicy, PrincipalRef } from '@app/shared-contracts/agent-access';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Schema } from 'effect';
import type { HttpClient } from 'effect/http';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { AgentApiKeys } from './agent-api-keys.tsx';
import { runAgentCommand } from './agent-entities-client.ts';
import { browserAtomRuntime, browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';
import {
  AgentDraftSchema,
  configureRequest,
  createRequest,
  draftFromAgent,
  emptyAgentDraft,
} from './agent-editor-model.ts';

export interface AgentEditorPanelProps {
  readonly agent: AgentEntity | null;
  readonly members: readonly PrincipalRef[];
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
}

const key = 'shell.agents.editor';
const RESIZE_LABEL_KEY = 'shell.agents.resize';
const policies: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];
const policyDescriptionsId = 'agent-policy-descriptions';

/**
 * The agent being created or configured. The draft's own checks validate it; the write policy is one of the offered
 * choices. Enter sends it like Uložit, through the panel's one save.
 */
const agentEditorForm = FormReact.make(
  FormBuilder.empty
    .addField('description', AgentDraftSchema.fields.description)
    .addField('displayName', AgentDraftSchema.fields.displayName)
    .addField('operatorPrincipalIds', AgentDraftSchema.fields.operatorPrincipalIds)
    .addField('ownerPrincipalId', AgentDraftSchema.fields.ownerPrincipalId)
    .addField('writePolicy', Schema.String),
  {
    fields: {
      description: TextAreaField,
      displayName: TextField,
      operatorPrincipalIds: MemberCheckboxField,
      ownerPrincipalId: ChoiceField,
      writePolicy: RadioField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type AgentEditorValues = typeof agentEditorForm.schema.Encoded;

const isSendable = Schema.is(AgentDraftSchema);

export const AgentEditorPanel = (props: AgentEditorPanelProps) => {
  const { agent, members, onClose, onSaved } = props;
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  // The values the editor opens with; the form reads them once, when it starts.
  const opened: AgentEditorValues = agent === null ? emptyAgentDraft : draftFromAgent(agent);
  const values = Option.getOrElse(useAtomValue(agentEditorForm.values), () => opened);
  const setValues = useAtomSet(agentEditorForm.setValues);
  const validate = useAtomSet(agentEditorForm.validate);
  const [serverError, setServerError] = useState<string | null>(null);
  // Nothing is sent until Uložit: the one save writes the whole draft once.
  const record = useDraftSave<AgentEditorValues, HttpClient.HttpClient>({
    isValid: isSendable,
    runtime: browserRuntime,
    save: (value) =>
      Schema.decodeUnknownEffect(AgentDraftSchema)(value).pipe(
        Effect.flatMap((draft) => {
          const request = agent === null ? createRequest(draft) : configureRequest(draft, agent.principalId);
          const name = draft.displayName.trim();
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
        }),
        Effect.catchTag('SchemaError', () => Effect.succeed<SaveOutcome>('failed')),
      ),
    value: values,
  });
  // Field messages show once the draft is changed and invalid, the same moment the save bar says so.
  const invalid = record.status === 'invalid';
  useEffect(() => {
    if (invalid) {
      validate();
    }
  }, [invalid, validate]);
  // Enter in the form is Uložit.
  useAtomSubscribe(agentEditorForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      record.save();
    }
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setValues(record.confirmed),
  });

  const handleSave = record.save;
  const handleReloadLatest = () => {
    const latest = agent === null ? emptyAgentDraft : draftFromAgent(agent);
    record.adopt(latest);
    setValues(latest);
  };
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" onClick={() => guard.request(onClose)} severity="secondary">
              {t(`${key}.cancel`)}
            </Button>
            <SaveBar
              error={serverError}
              labels={labels}
              onReloadLatest={handleReloadLatest}
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
        <FormRoot
          className="relative flex flex-col gap-250 py-200"
          defaultValues={opened}
          form={agentEditorForm}
          id="agent-editor-form"
          translateMessage={t}
        >
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <agentEditorForm.displayName
            autoComplete="off"
            id="agent-name"
            label={t(`${key}.name`)}
            name="displayName"
            required
            requiredLabel={requiredLabelFor(language)}
          />
          <agentEditorForm.description
            id="agent-description"
            label={t(`${key}.description`)}
            name="description"
            rows={2}
          />
          <agentEditorForm.ownerPrincipalId
            items={members.map((member) => ({ label: member.displayName, value: member.principalId }))}
            label={t(`${key}.owner`)}
            placeholder={t('shell.agents.selectPlaceholder')}
          />
          <p className="text-fg-secondary text-xs">{t(`${key}.rightsFromRoles`)}</p>
          <section className="flex flex-col gap-150">
            <agentEditorForm.writePolicy
              describedBy={policyDescriptionsId}
              items={policies.map((policy) => ({ label: t(`${key}.policy.${policy}.label`), value: policy }))}
              label={<span className="font-semibold text-sm">{t(`${key}.policyTitle`)}</span>}
            />
            <dl className="grid gap-100" id={policyDescriptionsId}>
              {policies.map((policy) => (
                <div className="grid min-w-0 gap-50" key={policy}>
                  <dt className="font-medium text-sm">{t(`${key}.policy.${policy}.label`)}</dt>
                  <dd className="text-fg-secondary text-xs">{t(`${key}.policy.${policy}.description`)}</dd>
                </div>
              ))}
            </dl>
          </section>
          {agent === null && (
            <section className="flex flex-col gap-150">
              <h3 className="font-semibold text-sm">{t(`${key}.operatorsTitle`)}</h3>
              <p className="text-fg-secondary text-xs">{t(`${key}.operatorsHint`)}</p>
              {members.map((member) => (
                <agentEditorForm.operatorPrincipalIds
                  id={`agent-new-operator-${member.principalId}`}
                  key={member.principalId}
                  label={member.displayName}
                  member={member.principalId}
                />
              ))}
            </section>
          )}
        </FormRoot>
        {agent !== null && (
          <AgentApiKeys agent={agent} key={`${agent.principalId}:${agent.status}:${agent.hasProfile}`} />
        )}
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
