// A delegation of role management within one scope (manager, people, roles, permissions, limit and end date).
import { SaveBar, UnsavedChangesDialog, saveLabelsFor } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useId, useState } from 'react';

import { PeopleChoiceField } from './people-choice.tsx';
import { usePeopleFormSave } from './people-form-save.ts';
import type { PeopleFormContext } from './people-form-save.ts';
import type { PeopleChoice, PeopleScopeChoices } from './people-view-model.ts';

const prefix = 'shell.accessAdmin.people';

interface DelegationDraft {
  readonly amountMinor: string;
  readonly capabilities: readonly string[];
  readonly currency: string;
  readonly expiryInput: string;
  readonly managerId: string;
  readonly people: readonly string[];
  readonly roles: readonly string[];
}
const emptyDelegation: DelegationDraft = {
  amountMinor: '',
  capabilities: [],
  currency: '',
  expiryInput: '',
  managerId: '',
  people: [],
  roles: [],
};

const selectedLabels = (choices: readonly PeopleChoice[], selection: readonly string[]) => {
  const selected = new Set(selection);
  return choices.flatMap((choice) => (selected.has(choice.id) ? [choice.label] : []));
};

/**
 * A delegation: typing and picking change only the draft; Uložit opens the confirmation of the delegation, which alone
 * sends it; Enter never does; leaving the page with input asks first.
 */
export const DelegationEditor = ({
  context,
  disabled,
  scope,
}: {
  readonly context: PeopleFormContext;
  readonly disabled: boolean;
  readonly scope: PeopleScopeChoices;
}) => {
  const { language, t } = useModernI18n();
  const id = useId();
  const [draft, setDraft] = useState(emptyDelegation);
  const change = (patch: Partial<DelegationDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const manager = scope.managers.find((item) => item.id === draft.managerId);
  const complete =
    manager !== undefined &&
    draft.people.length > 0 &&
    draft.roles.length > 0 &&
    draft.capabilities.length > 0 &&
    draft.expiryInput.length > 0;
  const review = (onConfirmed: () => void) => {
    if (disabled || !complete) {
      return;
    }
    context.onPreview(
      {
        command: {
          amountMinor: draft.amountMinor,
          capabilities: [...draft.capabilities],
          currency: draft.currency,
          expiryInput: draft.expiryInput,
          kind: 'delegate',
          managerId: draft.managerId,
          people: [...draft.people],
          roles: [...draft.roles],
          scopeId: scope.id,
        },
        facts: [
          scope.label,
          manager.label,
          ...selectedLabels(scope.people, draft.people),
          ...selectedLabels(scope.roles, draft.roles),
          ...selectedLabels(scope.capabilities, draft.capabilities),
          draft.expiryInput,
          draft.amountMinor.length > 0 ? `${draft.amountMinor} ${draft.currency}` : t(`${prefix}.noAmountLimit`),
        ],
        titleKey: `${prefix}.delegationCreate`,
      },
      onConfirmed,
    );
  };
  const save = usePeopleFormSave({
    empty: emptyDelegation,
    feedback: context.feedback,
    onDiscard: () => setDraft(emptyDelegation),
    onReview: review,
    valid: !disabled && complete,
    value: draft,
  });
  const labels = saveLabelsFor(language);
  const handleRefresh = context.onRefresh;
  return (
    <form
      aria-label={t(`${prefix}.delegationCreate`)}
      className="shell:grid shell:gap-4"
      onSubmit={(event) => {
        // Enter never sends: only Uložit opens the confirmation.
        event.preventDefault();
      }}
    >
      <h3 className="shell:text-title-md">{t(`${prefix}.delegation`)}</h3>
      <p>{t(`${prefix}.delegationHelp`)}</p>
      <p>{t(`${prefix}.delegationCeiling`)}</p>
      <PeopleChoiceField
        disabled={disabled}
        items={scope.managers}
        label={t(`${prefix}.delegatedManager`)}
        onChange={(value) => change({ managerId: value[0] ?? '' })}
        value={draft.managerId.length > 0 ? [draft.managerId] : []}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.people}
        label={t(`${prefix}.delegationPeople`)}
        multiple
        onChange={(people) => change({ people })}
        value={[...draft.people]}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.roles}
        label={t(`${prefix}.delegationRoles`)}
        multiple
        onChange={(roles) => change({ roles })}
        value={[...draft.roles]}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.capabilities}
        label={t(`${prefix}.permissions`)}
        multiple
        onChange={(capabilities) => change({ capabilities })}
        value={[...draft.capabilities]}
      />
      <FormInput
        disabled={disabled}
        id={`${id}-amount`}
        label={t(`${prefix}.amountMinor`)}
        min="0"
        onChange={(event) => change({ amountMinor: event.target.value })}
        step="1"
        type="number"
        value={draft.amountMinor}
      />
      <FormInput
        disabled={disabled}
        id={`${id}-currency`}
        label={t(`${prefix}.currency`)}
        maxLength={3}
        onChange={(event) => change({ currency: event.target.value })}
        pattern="[A-Z]{3}"
        required={draft.amountMinor.length > 0}
        value={draft.currency}
      />
      <FormInput
        disabled={disabled}
        helpText={t(`${prefix}.localTime`)}
        id={`${id}-expiry`}
        label={t(`${prefix}.endDate`)}
        onChange={(event) => change({ expiryInput: event.target.value })}
        required
        type="datetime-local"
        value={draft.expiryInput}
      />
      <SaveBar labels={labels} onReloadLatest={handleRefresh} onSave={save.handleSave} status={save.saveState} />
      <UnsavedChangesDialog labels={labels} prompt={save.guard.prompt} />
    </form>
  );
};
