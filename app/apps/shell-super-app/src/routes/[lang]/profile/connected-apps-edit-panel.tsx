import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import type { ConnectionSummary } from '@app/shared-contracts/agent-access';
import { SaveBar, useDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { useRef, useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { updateConnectionAccess } from './connected-apps-client.ts';
import {
  draftFromConnection,
  draftProblem,
  draftToRequest,
  failureText,
  isStale,
  moduleChoices,
  policyChoices,
  setModuleChoice,
  widenHint,
} from './connected-apps-model.ts';
import type { EditDraft, ModuleChoice } from './connected-apps-model.ts';

/** Right-side panel that narrows one connection. The server enforces the limits again on save. */
export const ConnectedAppsEditPanel = ({
  connection,
  onClose,
  onSaved,
  onStale,
}: {
  readonly connection: ConnectionSummary;
  readonly onClose: () => void;
  readonly onSaved: (name: string) => void;
  /** The connection is no longer active (revoked elsewhere): the list reloads with this Czech notice. */
  readonly onStale: (notice: string) => void;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<EditDraft>(() => draftFromConnection(connection));
  const [failure, setFailure] = useState<string | undefined>();
  // The access of an existing connection saves itself: every choice is one narrowing the server re-checks.
  const saved = useRef(false);
  const autosave = useDraftSave<EditDraft, never>({
    isValid: (value) => draftProblem(value) === undefined,
    runtime: browserRuntime,
    save: (value): Effect.Effect<SaveOutcome> =>
      updateConnectionAccess(draftToRequest(connection.grantId, value)).pipe(
        Effect.map((outcome): SaveOutcome => {
          if (outcome.status === 'ok') {
            saved.current = true;
            setFailure(undefined);
            return 'saved';
          }
          if (isStale(outcome.reason)) {
            onStale(failureText(outcome.reason, outcome.detail));
            onClose();
            return 'saved';
          }
          setFailure(failureText(outcome.reason, outcome.detail));
          return 'failed';
        }),
      ),
    value: draft,
  });
  const problem = draftProblem(draft);
  const { name } = connection.client;
  const policies = policyChoices(connection);
  const modules = moduleChoices(connection);

  const setChoice = (moduleId: string, choice: ModuleChoice) => {
    setDraft((current) => setModuleChoice(current, moduleId, choice));
  };

  const handleSave = autosave.save;
  const close = () => {
    if (saved.current) {
      onSaved(name);
    }
    onClose();
  };

  return (
    <Dialog
      actions={
        <>
          <SaveBar onReloadLatest={close} onSave={handleSave} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            Zavřít
          </Button>
        </>
      }
      closeLabel="Zavřít"
      customTrigger
      description={`${widenHint} Změny se ukládají samy.`}
      onOpenChange={(details) => {
        if (!details.open) {
          close();
        }
      }}
      open
      placement="right"
      size="md"
      title={`Upravit přístup – ${name}`}
    >
      <div className="grid gap-300">
        <section className="grid gap-150">
          <h3 className="font-semibold text-sm">K čemu bude mít přístup</h3>
          <label className="flex items-start gap-150">
            <input
              checked={draft.allModules}
              disabled={!connection.allModules}
              name="connected-app-scope"
              onChange={() => setDraft((current) => ({ ...current, allModules: true }))}
              type="radio"
            />
            <span className="text-sm">
              {connection.acting.kind === 'human' ? 'Vše, co smíte' : 'Vše, co agent smí'}
            </span>
          </label>
          <label className="flex items-start gap-150">
            <input
              checked={!draft.allModules}
              name="connected-app-scope"
              onChange={() => setDraft((current) => ({ ...current, allModules: false }))}
              type="radio"
            />
            <span className="text-sm">Vybrat moduly</span>
          </label>
          {draft.allModules ? null : (
            <div className="grid gap-150">
              {modules.map((module) => {
                const choice = draft.modules[module.moduleId] ?? 'none';
                return (
                  <div className="grid gap-100 rounded-md border border-border-primary p-150" key={module.moduleId}>
                    <p className="font-medium text-sm">{module.label}</p>
                    <div className="flex flex-wrap gap-300">
                      <FormCheckbox
                        checked={choice !== 'none'}
                        disabled={!module.canRead}
                        label={t('shell.connect.access.read')}
                        onCheckedChange={(checked) => setChoice(module.moduleId, checked ? 'read' : 'none')}
                      />
                      <FormCheckbox
                        checked={choice === 'write'}
                        disabled={!module.canWrite}
                        label={t('shell.connect.access.write')}
                        onCheckedChange={(checked) => setChoice(module.moduleId, checked ? 'write' : 'read')}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="grid gap-150">
          <h3 className="font-semibold text-sm">Jak bude zapisovat</h3>
          {policies.map((policy) => (
            <label className="flex items-start gap-150" key={policy.value}>
              <input
                checked={draft.writePolicy === policy.value}
                disabled={policy.disabled}
                name="connected-app-write-policy"
                onChange={() => setDraft((current) => ({ ...current, writePolicy: policy.value }))}
                type="radio"
              />
              <span className="grid min-w-0 gap-50">
                <span className="font-medium text-sm">{policy.label}</span>
                {policy.description === '' ? null : (
                  <span className="text-fg-secondary text-xs">{policy.description}</span>
                )}
                {policy.disabledReason === null ? null : (
                  <span className="text-fg-secondary text-xs">{policy.disabledReason}</span>
                )}
              </span>
            </label>
          ))}
        </section>

        {problem === undefined ? null : (
          <StatusText showIcon status="error">
            {problem}
          </StatusText>
        )}
        {failure === undefined ? null : (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
