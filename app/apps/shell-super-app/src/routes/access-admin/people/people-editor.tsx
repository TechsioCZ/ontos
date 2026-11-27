import { SaveBar, UnsavedChangesDialog, saveLabelsFor } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { constVoid } from 'effect/Function';
import { useId, useState } from 'react';

import { DelegationEditor } from './delegation-editor.tsx';
import { PeopleChoiceField } from './people-choice.tsx';
import { usePeopleFormSave } from './people-form-save.ts';
import type { PeopleFormContext, PeopleReview } from './people-form-save.ts';
import type { PeopleFeedback, PeopleScopeChoices, PeopleViewModel } from './people-view-model.ts';

const prefix = 'shell.accessAdmin.people';
interface AssignDraft {
  readonly expiryInput: string;
  readonly personId: string;
  readonly roleId: string;
}
const emptyAssign: AssignDraft = { expiryInput: '', personId: '', roleId: '' };

/**
 * Assigning a role: picking the person and role and typing the end date change only the draft; Uložit opens the
 * confirmation of the assignment, which alone sends it; Enter never does; leaving the page with input asks first.
 */
const AssignRoleForm = ({
  context,
  disabled,
  draft,
  onChange,
  scope,
}: {
  readonly context: PeopleFormContext;
  readonly disabled: boolean;
  readonly draft: AssignDraft;
  readonly onChange: (next: AssignDraft) => void;
  readonly scope: PeopleScopeChoices;
}) => {
  const { language, t } = useModernI18n();
  const id = useId();
  const person = scope.people.find((item) => item.id === draft.personId);
  const role = scope.roles.find((item) => item.id === draft.roleId);
  const save = usePeopleFormSave({
    empty: emptyAssign,
    feedback: context.feedback,
    onDiscard: () => onChange(emptyAssign),
    onReview: (onConfirmed) => {
      if (disabled || person === undefined || role === undefined) {
        return;
      }
      context.onPreview(
        {
          command: {
            expiryInput: draft.expiryInput,
            kind: 'assign',
            personId: draft.personId,
            roleId: draft.roleId,
            scopeId: scope.id,
          },
          facts: [
            person.label,
            scope.label,
            role.label,
            draft.expiryInput.length === 0 ? t(`${prefix}.noExpiry`) : draft.expiryInput,
          ],
          titleKey: `${prefix}.confirmAssign`,
        },
        onConfirmed,
      );
    },
    valid: !disabled && person !== undefined && role !== undefined,
    value: draft,
  });
  const labels = saveLabelsFor(language);
  const handleRefresh = context.onRefresh;
  return (
    <form
      aria-label={t(`${prefix}.assignRole`)}
      className="shell:grid shell:gap-4"
      onSubmit={(event) => {
        // Enter never sends: only Uložit opens the confirmation.
        event.preventDefault();
      }}
    >
      <h3 className="shell:text-title-md">{t(`${prefix}.assignRole`)}</h3>
      <PeopleChoiceField
        disabled={disabled}
        items={scope.roles}
        label={t(`${prefix}.role`)}
        onChange={(value) => onChange({ ...draft, roleId: value[0] ?? '' })}
        value={draft.roleId.length > 0 ? [draft.roleId] : []}
      />
      <FormInput
        disabled={disabled}
        helpText={t(`${prefix}.localTime`)}
        id={`${id}-expiry`}
        label={t(`${prefix}.endDate`)}
        onChange={(event) => onChange({ ...draft, expiryInput: event.target.value })}
        type="datetime-local"
        value={draft.expiryInput}
      />
      <p>{t(`${prefix}.endDateHelp`)}</p>
      <SaveBar labels={labels} onReloadLatest={handleRefresh} onSave={save.handleSave} status={save.saveState} />
      <UnsavedChangesDialog labels={labels} prompt={save.guard.prompt} />
    </form>
  );
};

/** Company directory people who hold no access in this company yet; admission never names a role. */
const AdmitSection = ({
  disabled,
  onPreview,
  scope,
}: {
  readonly disabled: boolean;
  readonly onPreview: PeopleReview;
  readonly scope: PeopleScopeChoices;
}) => {
  const { t } = useModernI18n();
  return (
    <section aria-label={t(`${prefix}.admitSection`)} className="shell:grid shell:gap-4">
      <h3 className="shell:text-title-md">{t(`${prefix}.admitSection`)}</h3>
      <p>{t(`${prefix}.admitHelp`)}</p>
      {scope.candidates.length === 0 ? (
        <StatusText>{t(`${prefix}.noCandidates`)}</StatusText>
      ) : (
        <ul className="shell:grid shell:gap-2">
          {scope.candidates.map((candidate) => (
            <li className="shell:flex shell:flex-wrap shell:items-center shell:gap-2" key={candidate.id}>
              <span>{candidate.label}</span>
              <Button
                aria-label={t(`${prefix}.admitMemberNamed`, { person: candidate.label })}
                disabled={disabled}
                onClick={() =>
                  onPreview(
                    {
                      command: { kind: 'admit', personId: candidate.id, scopeId: scope.id },
                      facts: [candidate.label, scope.label, t(`${prefix}.admitEffect`)],
                      titleKey: `${prefix}.confirmAdmit`,
                    },
                    // A one-click admission keeps no draft to clear once it is sent.
                    constVoid,
                  )
                }
                type="button"
                variant="secondary"
              >
                {t(`${prefix}.admitMember`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ScopeEditor = ({
  busy,
  context,
  scope,
  writes,
}: {
  readonly busy: boolean;
  readonly context: PeopleFormContext;
  readonly scope: PeopleScopeChoices;
  readonly writes: PeopleViewModel['writes'];
}) => {
  const { t } = useModernI18n();
  const [assign, setAssign] = useState(emptyAssign);
  const [teamId, setTeamId] = useState('');
  const { personId } = assign;
  const person = scope.people.find((item) => item.id === personId);
  const team = scope.teams.find((item) => item.id === teamId);
  const handleAdmitPreview = context.onPreview;
  return (
    <div className="shell:grid shell:gap-6">
      {scope.id === 'tenant' ? null : (
        <AdmitSection disabled={busy || !writes.admit} onPreview={handleAdmitPreview} scope={scope} />
      )}
      <PeopleChoiceField
        disabled={busy}
        items={scope.people}
        label={t(`${prefix}.person`)}
        onChange={(value) => setAssign((current) => ({ ...current, personId: value[0] ?? '' }))}
        value={personId.length > 0 ? [personId] : []}
      />
      <AssignRoleForm
        context={context}
        disabled={busy || !writes.assign}
        draft={assign}
        onChange={setAssign}
        scope={scope}
      />
      <div className="shell:grid shell:gap-4">
        <h3 className="shell:text-title-md">{t(`${prefix}.teams`)}</h3>
        <PeopleChoiceField
          disabled={busy || !writes.team}
          items={scope.teams}
          label={t(`${prefix}.team`)}
          onChange={(value) => setTeamId(value[0] ?? '')}
          value={teamId.length > 0 ? [teamId] : []}
        />
        <Button
          disabled={busy || !writes.team || person === undefined || team === undefined}
          onClick={() => {
            if (person !== undefined && team !== undefined) {
              context.onPreview(
                {
                  command: { action: 'join', kind: 'team', personId, teamId },
                  facts: [person.label, scope.label, team.label],
                  titleKey: `${prefix}.teamAdd`,
                },
                () => setTeamId(''),
              );
            }
          }}
          type="button"
        >
          {t(`${prefix}.teamAdd`)}
        </Button>
      </div>
      <DelegationEditor context={context} disabled={busy || !writes.delegate} scope={scope} />
    </div>
  );
};

export const PeopleEditor = ({
  busy,
  feedback,
  model,
  onPreview,
  onRefresh,
}: {
  readonly busy: boolean;
  readonly feedback: PeopleFeedback;
  readonly model: PeopleViewModel;
  readonly onPreview: PeopleReview;
  readonly onRefresh: () => void;
}) => {
  const { t } = useModernI18n();
  const [scopeId, setScopeId] = useState('');
  const scope = model.scopes.find((item) => item.id === scopeId);
  return (
    <section className="shell:grid shell:gap-4">
      <PeopleChoiceField
        disabled={busy}
        items={model.scopes}
        label={t(`${prefix}.scope`)}
        onChange={(value) => setScopeId(value[0] ?? '')}
        value={scopeId.length > 0 ? [scopeId] : []}
      />
      {scope === undefined ? (
        <StatusText>{t(`${prefix}.chooseScope`)}</StatusText>
      ) : (
        <ScopeEditor
          busy={busy}
          context={{ feedback, onPreview, onRefresh }}
          key={scope.id}
          scope={scope}
          writes={model.writes}
        />
      )}
    </section>
  );
};
