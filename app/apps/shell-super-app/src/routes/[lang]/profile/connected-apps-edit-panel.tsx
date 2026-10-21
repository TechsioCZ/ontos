import type { ConnectionSummary } from '@app/shared-contracts/agent-access';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { useState } from 'react';

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
  const [draft, setDraft] = useState<EditDraft>(() => draftFromConnection(connection));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const problem = draftProblem(draft);
  const name = connection.client.name;
  const policies = policyChoices(connection);
  const modules = moduleChoices(connection);

  const setChoice = (moduleId: string, choice: ModuleChoice) => {
    setDraft((current) => setModuleChoice(current, moduleId, choice));
  };

  const save = () => {
    if (problem !== undefined || busy) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    void browserRuntime
      .runPromise(updateConnectionAccess(draftToRequest(connection.grantId, draft)))
      .then((outcome) => {
        if (outcome.status === 'ok') {
          onSaved(name);
          onClose();
          return;
        }
        if (isStale(outcome.reason)) {
          onStale(failureText(outcome.reason, outcome.detail));
          onClose();
          return;
        }
        setBusy(false);
        setFailure(failureText(outcome.reason, outcome.detail));
      });
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button disabled={busy || problem !== undefined} onClick={save} variant="primary">
            Uložit změny
          </Button>
        </>
      }
      closeLabel="Zavřít"
      closeOnInteractOutside={false}
      customTrigger
      description="Přístup můžete jen zúžit. Změna platí do 30 sekund bez nového přihlášení."
      onOpenChange={(details) => {
        if (!details.open) {
          onClose();
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
            <span className="grid min-w-0 gap-50">
              <span className="text-sm">
                {connection.acting.kind === 'human' ? 'Vše, co smíte' : 'Vše, co agent smí'}
              </span>
              {connection.allModules ? null : <span className="text-fg-secondary text-xs">{widenHint}</span>}
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
                  <div key={module.moduleId} className="grid gap-100 rounded-md border border-border-primary p-150">
                    <p className="font-medium text-sm">{module.label}</p>
                    <div className="flex flex-wrap gap-300">
                      <FormCheckbox
                        checked={choice !== 'none'}
                        disabled={!module.canRead}
                        label="Čtení"
                        onCheckedChange={(checked) => setChoice(module.moduleId, checked ? 'read' : 'none')}
                      />
                      <FormCheckbox
                        checked={choice === 'write'}
                        disabled={!module.canWrite}
                        label="Zápis"
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
            <label key={policy.value} className="flex items-start gap-150">
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
