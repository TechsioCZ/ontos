import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Schema } from 'effect';
import { AgentWritePolicySchema } from '@app/shared-contracts/agent-access';
import type { ConnectionSummary } from '@app/shared-contracts/agent-access';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  MemberCheckboxField,
  RadioField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { useEffect, useRef, useState } from 'react';

import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { updateConnectionAccess } from './connected-apps-client.ts';
import {
  draftFromConnection,
  draftProblem,
  draftToRequest,
  failureText,
  isStale,
  moduleChoices,
  policyChoices,
  widenHint,
} from './connected-apps-model.ts';
import type { EditDraft, ModuleChoice } from './connected-apps-model.ts';

/**
 * The access of one connection as the panel edits it: the scope, the modules it may read and the modules it may
 * write (a written module is always read too), and the write policy. Uložit sends the draft through the save bar, so
 * the form only holds it.
 */
const accessForm = FormReact.make(
  FormBuilder.empty
    .addField('read', Schema.Array(Schema.String))
    .addField('scope', Schema.String)
    .addField('write', Schema.Array(Schema.String))
    .addField('writePolicy', Schema.String),
  {
    fields: { read: MemberCheckboxField, scope: RadioField, write: MemberCheckboxField, writePolicy: RadioField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type AccessValues = typeof accessForm.schema.Encoded;

const allScope = 'all';
const modulesScope = 'modules';

const valuesOf = (draft: EditDraft): AccessValues => {
  const granted = Object.entries(draft.modules);
  return {
    read: granted.flatMap(([moduleId, choice]) => (choice === 'none' ? [] : [moduleId])),
    scope: draft.allModules ? allScope : modulesScope,
    write: granted.flatMap(([moduleId, choice]) => (choice === 'write' ? [moduleId] : [])),
    writePolicy: draft.writePolicy,
  };
};

const choiceOf = (values: AccessValues, moduleId: string): ModuleChoice => {
  if (values.write.includes(moduleId)) {
    return 'write';
  }
  return values.read.includes(moduleId) ? 'read' : 'none';
};

/** The draft the form shows, over the modules of the connection's limits. */
const draftOf = (opened: EditDraft, values: AccessValues): EditDraft => ({
  allModules: values.scope === allScope,
  modules: Object.fromEntries(Object.keys(opened.modules).map((moduleId) => [moduleId, choiceOf(values, moduleId)])),
  writePolicy: Schema.is(AgentWritePolicySchema)(values.writePolicy) ? values.writePolicy : opened.writePolicy,
});

/**
 * Keeps writing within reading: unticking Číst also unticks Zapisovat, and ticking Zapisovat also ticks Číst.
 * `previous` is what the form showed before `next`, so the change tells which of the two was ticked.
 */
const coupleAccess = (previous: AccessValues, next: AccessValues): AccessValues => {
  const unread = new Set(previous.read.filter((moduleId) => !next.read.includes(moduleId)));
  const alsoRead = next.write.filter((moduleId) => !previous.write.includes(moduleId) && !next.read.includes(moduleId));
  if (alsoRead.length === 0 && !next.write.some((moduleId) => unread.has(moduleId))) {
    return next;
  }
  return {
    ...next,
    read: [...next.read, ...alsoRead],
    write: next.write.filter((moduleId) => !unread.has(moduleId)),
  };
};

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier mount left, so the values are read only after `onReady`.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

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
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const opened = draftFromConnection(connection);
  const [ready, setReady] = useState(false);
  const values = Option.filter(useAtomValue(accessForm.values), () => ready);
  const setValues = useAtomSet(accessForm.setValues);
  const draft = Option.match(values, { onNone: () => opened, onSome: (shown) => draftOf(opened, shown) });
  // What the form showed before its latest change, so a change tells which box was ticked.
  const shown = useRef<AccessValues | null>(null);
  useAtomSubscribe(accessForm.values, (next) => {
    if (!ready || Option.isNone(next)) {
      return;
    }
    const coupled = coupleAccess(shown.current ?? valuesOf(opened), next.value);
    shown.current = next.value;
    if (coupled !== next.value) {
      setValues(coupled);
    }
  });
  const [failure, setFailure] = useState<string | undefined>();
  // Nothing is sent until Uložit: the server re-checks every narrowing it receives.
  const saved = useRef(false);
  const record = useDraftSave<EditDraft, never>({
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
  const scopeChoices = [
    { label: connection.acting.kind === 'human' ? 'Vše, co smíte' : 'Vše, co agent smí', value: allScope },
    { label: 'Vybrat moduly', value: modulesScope },
  ];
  // Only what the approved grant and the live rights allow can be chosen; the wider policies are listed below.
  const policyItems = policies.flatMap((policy) =>
    policy.disabled ? [] : [{ label: policy.label, value: policy.value }],
  );

  const close = () => {
    if (saved.current) {
      onSaved(name);
    }
    onClose();
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setValues(valuesOf(record.confirmed)),
  });
  const requestClose = () => {
    guard.request(close);
  };

  const handleSave = record.save;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" onClick={requestClose} severity="secondary">
              Zavřít
            </Button>
            <SaveBar
              labels={labels}
              onReloadLatest={() => record.adopt(draftFromConnection(connection))}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        closeLabel="Zavřít"
        customTrigger
        description={widenHint}
        onOpenChange={(details) => {
          if (!details.open) {
            requestClose();
          }
        }}
        open
        placement="right"
        size="md"
        title={`Upravit přístup – ${name}`}
      >
        <FormRoot
          className="grid gap-300"
          defaultValues={valuesOf(opened)}
          form={accessForm}
          key={connection.grantId}
          translateMessage={(message) => t(message)}
        >
          <FormReady onReady={setReady} />
          <section className="grid gap-150">
            <accessForm.scope disabled={!connection.allModules} items={scopeChoices} label="K čemu bude mít přístup" />
            {draft.allModules ? null : (
              <div className="grid gap-150">
                {modules.map((module) => (
                  <div className="grid gap-100 rounded-md border border-border-primary p-150" key={module.moduleId}>
                    <p className="font-medium text-sm">{module.label}</p>
                    <div className="flex flex-wrap gap-300">
                      <accessForm.read
                        disabled={!module.canRead}
                        label={t('shell.connect.access.read')}
                        member={module.moduleId}
                      />
                      <accessForm.write
                        disabled={!module.canWrite}
                        label={t('shell.connect.access.write')}
                        member={module.moduleId}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-150">
            <accessForm.writePolicy items={policyItems} label="Jak bude zapisovat" />
            <ul className="grid gap-100">
              {policies.map((policy) =>
                policy.description === '' && policy.disabledReason === null ? null : (
                  <li className="grid min-w-0 gap-50" key={policy.value}>
                    <span className="font-medium text-sm">{policy.label}</span>
                    {policy.description === '' ? null : (
                      <span className="text-fg-secondary text-xs">{policy.description}</span>
                    )}
                    {policy.disabledReason === null ? null : (
                      <span className="text-fg-secondary text-xs">{policy.disabledReason}</span>
                    )}
                  </li>
                ),
              )}
            </ul>
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
        </FormRoot>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
