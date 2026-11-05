import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useId, useState } from 'react';

import { PeopleChoiceField } from './people-choice.tsx';
import type { PeopleChoice, PeoplePendingChange, PeopleScopeChoices, PeopleViewModel } from './people-view-model.ts';

const prefix = 'shell.accessAdmin.people';
const selectedLabels = (choices: readonly PeopleChoice[], selection: readonly string[]) => {
  const selected = new Set(selection);
  return choices.flatMap((choice) => (selected.has(choice.id) ? [choice.label] : []));
};

const DelegationEditor = ({
  disabled,
  onPreview,
  scope,
}: {
  readonly disabled: boolean;
  readonly onPreview: (change: PeoplePendingChange) => void;
  readonly scope: PeopleScopeChoices;
}) => {
  const { t } = useModernI18n();
  const id = useId();
  const [managerId, setManagerId] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [endsAt, setEndsAt] = useState('');
  const [amountMinor, setAmountMinor] = useState('');
  const [currency, setCurrency] = useState('');
  const manager = scope.managers.find((item) => item.id === managerId);
  return (
    <form
      aria-label={t(`${prefix}.delegationCreate`)}
      className="shell:grid shell:gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          disabled ||
          manager === undefined ||
          people.length === 0 ||
          roles.length === 0 ||
          capabilities.length === 0 ||
          endsAt.length === 0
        ) {
          return;
        }
        onPreview({
          command: {
            amountMinor,
            capabilities,
            currency,
            expiryInput: endsAt,
            kind: 'delegate',
            managerId,
            people,
            roles,
            scopeId: scope.id,
          },
          facts: [
            scope.label,
            manager.label,
            ...selectedLabels(scope.people, people),
            ...selectedLabels(scope.roles, roles),
            ...selectedLabels(scope.capabilities, capabilities),
            endsAt,
            amountMinor.length > 0 ? `${amountMinor} ${currency}` : t(`${prefix}.noAmountLimit`),
          ],
          titleKey: `${prefix}.delegationCreate`,
        });
      }}
    >
      <h3 className="shell:text-title-md">{t(`${prefix}.delegation`)}</h3>
      <p>{t(`${prefix}.delegationHelp`)}</p>
      <p>{t(`${prefix}.delegationCeiling`)}</p>
      <PeopleChoiceField
        disabled={disabled}
        items={scope.managers}
        label={t(`${prefix}.delegatedManager`)}
        onChange={(value) => setManagerId(value[0] ?? '')}
        value={managerId.length > 0 ? [managerId] : []}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.people}
        label={t(`${prefix}.delegationPeople`)}
        multiple
        onChange={setPeople}
        value={people}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.roles}
        label={t(`${prefix}.delegationRoles`)}
        multiple
        onChange={setRoles}
        value={roles}
      />
      <PeopleChoiceField
        disabled={disabled}
        items={scope.capabilities}
        label={t(`${prefix}.permissions`)}
        multiple
        onChange={setCapabilities}
        value={capabilities}
      />
      <FormInput
        disabled={disabled}
        id={`${id}-amount`}
        label={t(`${prefix}.amountMinor`)}
        min="0"
        onChange={(event) => setAmountMinor(event.target.value)}
        step="1"
        type="number"
        value={amountMinor}
      />
      <FormInput
        disabled={disabled}
        id={`${id}-currency`}
        label={t(`${prefix}.currency`)}
        maxLength={3}
        onChange={(event) => setCurrency(event.target.value)}
        pattern="[A-Z]{3}"
        required={amountMinor.length > 0}
        value={currency}
      />
      <FormInput
        disabled={disabled}
        helpText={t(`${prefix}.localTime`)}
        id={`${id}-expiry`}
        label={t(`${prefix}.endDate`)}
        onChange={(event) => setEndsAt(event.target.value)}
        required
        type="datetime-local"
        value={endsAt}
      />
      <Button
        disabled={
          disabled ||
          manager === undefined ||
          people.length === 0 ||
          roles.length === 0 ||
          capabilities.length === 0 ||
          endsAt.length === 0
        }
        type="submit"
      >
        {t('shell.accessAdmin.common.preview')}
      </Button>
    </form>
  );
};

const ScopeEditor = ({
  busy,
  onPreview,
  scope,
  writes,
}: {
  readonly busy: boolean;
  readonly onPreview: (change: PeoplePendingChange) => void;
  readonly scope: PeopleScopeChoices;
  readonly writes: PeopleViewModel['writes'];
}) => {
  const { t } = useModernI18n();
  const id = useId();
  const [personId, setPersonId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const person = scope.people.find((item) => item.id === personId);
  const role = scope.roles.find((item) => item.id === roleId);
  const team = scope.teams.find((item) => item.id === teamId);
  return (
    <div className="shell:grid shell:gap-6">
      <PeopleChoiceField
        disabled={busy}
        items={scope.people}
        label={t(`${prefix}.person`)}
        onChange={(value) => setPersonId(value[0] ?? '')}
        value={personId.length > 0 ? [personId] : []}
      />
      <form
        aria-label={t(`${prefix}.assignRole`)}
        className="shell:grid shell:gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !writes.assign || person === undefined || role === undefined) {
            return;
          }
          onPreview({
            command: { expiryInput: endsAt, kind: 'assign', personId, roleId, scopeId: scope.id },
            facts: [person.label, scope.label, role.label, endsAt.length === 0 ? t(`${prefix}.noExpiry`) : endsAt],
            titleKey: `${prefix}.confirmAssign`,
          });
        }}
      >
        <h3 className="shell:text-title-md">{t(`${prefix}.assignRole`)}</h3>
        <PeopleChoiceField
          disabled={busy || !writes.assign}
          items={scope.roles}
          label={t(`${prefix}.role`)}
          onChange={(value) => setRoleId(value[0] ?? '')}
          value={roleId.length > 0 ? [roleId] : []}
        />
        <FormInput
          disabled={busy || !writes.assign}
          helpText={t(`${prefix}.localTime`)}
          id={`${id}-expiry`}
          label={t(`${prefix}.endDate`)}
          onChange={(event) => setEndsAt(event.target.value)}
          type="datetime-local"
          value={endsAt}
        />
        <p>{t(`${prefix}.endDateHelp`)}</p>
        <Button disabled={busy || !writes.assign || person === undefined || role === undefined} type="submit">
          {t(`${prefix}.assignRole`)}
        </Button>
      </form>
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
              onPreview({
                command: { action: 'join', kind: 'team', personId, teamId },
                facts: [person.label, scope.label, team.label],
                titleKey: `${prefix}.teamAdd`,
              });
            }
          }}
          type="button"
        >
          {t(`${prefix}.teamAdd`)}
        </Button>
      </div>
      <DelegationEditor disabled={busy || !writes.delegate} onPreview={onPreview} scope={scope} />
    </div>
  );
};

export const PeopleEditor = ({
  busy,
  model,
  onPreview,
}: {
  readonly busy: boolean;
  readonly model: PeopleViewModel;
  readonly onPreview: (change: PeoplePendingChange) => void;
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
        <ScopeEditor busy={busy} key={scope.id} onPreview={onPreview} scope={scope} writes={model.writes} />
      )}
    </section>
  );
};
