import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  MultiChoiceField,
  SubmitButton,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect } from 'react';

import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { PeopleChoice, PeoplePendingChange, PeopleScopeChoices, PeopleViewModel } from './people-view-model.ts';

const prefix = 'shell.accessAdmin.people';
const ids = Schema.Array(Schema.String);
/** An amount ceiling in minor units: empty for none, else a whole number that stays exact. */
const minorAmount = Schema.String.check(
  Schema.makeFilter(
    (amount: string) => amount.length === 0 || (/^\d+$/u.test(amount) && Number.isSafeInteger(Number(amount))),
    { message: `${prefix}.invalidAmount` },
  ),
);
const currencyMessage = `${prefix}.invalidCurrency`;
const delegatedChoices = ['people', 'roles', 'capabilities'] as const;

/** The choices the open scope offers now; a refresh can withdraw one the person already picked. */
const offeredDelegationChoices = Atom.make<PeopleScopeChoices | null>(null).pipe(Atom.keepAlive);

/** Picked people, roles or permissions the scope no longer offers: the person picks them again. */
class WithdrawnDelegationChoices extends Schema.TaggedError<WithdrawnDelegationChoices>()(
  'WithdrawnDelegationChoices',
  { paths: Schema.Array(Schema.Literals(delegatedChoices)) },
) {}
/** A three-letter ISO currency code, or empty while no amount needs one. */
const currencyCode = Schema.String.check(Schema.isPattern(/^(?:[A-Z]{3})?$/u, { message: currencyMessage }));

/** The company or tenant whose people, roles and teams the editor offers; it is never submitted. */
const peopleScopeForm = FormReact.make(FormBuilder.empty.addField('scopeId', Schema.String), {
  fields: { scopeId: ChoiceField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/** A role for one person in the scope, with an optional local end date; its submit previews it. */
const assignRoleForm = FormReact.make(
  FormBuilder.empty
    .addField('endsAt', Schema.String)
    .addField('personId', Schema.String)
    .addField('roleId', Schema.String),
  {
    fields: { endsAt: TextField, personId: ChoiceField, roleId: ChoiceField },
    onSubmit: (_submit, { decoded }) => Effect.succeed(decoded),
    runtime: browserAtomRuntime,
  },
);

/** A team the person chosen in the role form joins; its submit previews the join. */
const teamJoinForm = FormReact.make(FormBuilder.empty.addField('teamId', Schema.String), {
  fields: { teamId: ChoiceField },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.teamId),
  runtime: browserAtomRuntime,
});

/** A bounded delegation from one manager to people, roles and permissions; its submit previews it. */
const delegationForm = FormReact.make(
  FormBuilder.empty
    .addField('amountMinor', minorAmount)
    .addField('capabilities', ids)
    .addField('currency', currencyCode)
    .addField('endsAt', Schema.String)
    .addField('managerId', Schema.String)
    .addField('people', ids)
    .addField('roles', ids)
    .refine(
      ({ amountMinor, currency }) =>
        amountMinor.length === 0 || currency.length > 0 || { issue: currencyMessage, path: ['currency'] },
    ),
  {
    fields: {
      amountMinor: TextField,
      capabilities: MultiChoiceField,
      currency: TextField,
      endsAt: TextField,
      managerId: ChoiceField,
      people: MultiChoiceField,
      roles: MultiChoiceField,
    },
    onSubmit: (_submit, { decoded, get }) => {
      const offered = get(offeredDelegationChoices);
      const withdrawn = delegatedChoices.filter((key) =>
        decoded[key].some((id) => !(offered?.[key] ?? []).some((choice) => choice.id === id)),
      );
      return withdrawn.length === 0
        ? Effect.succeed(decoded)
        : Effect.fail(new WithdrawnDelegationChoices({ paths: withdrawn }));
    },
    runtime: browserAtomRuntime,
    submitErrors: ({ paths }) => paths.map((path) => ({ message: `${prefix}.choiceWithdrawn`, path })),
  },
);

const scopeIdValue = peopleScopeForm.getFieldAtoms(peopleScopeForm.fields.scopeId).value;

const choices = (items: readonly PeopleChoice[]) => items.map((item) => ({ label: item.label, value: item.id }));
const selectedLabels = (items: readonly PeopleChoice[], selection: readonly string[]) => {
  const selected = new Set(selection);
  return items.flatMap((choice) => (selected.has(choice.id) ? [choice.label] : []));
};
const translateWith = (t: (key: string) => string) => (message: string) => t(message);

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
  const values = useAtomValue(delegationForm.values);
  const offer = useAtomSet(offeredDelegationChoices);
  useEffect(() => offer(scope), [offer, scope]);
  const complete = (draft: Option.Option.Value<typeof values>) =>
    scope.managers.some((item) => item.id === draft.managerId) &&
    draft.people.length > 0 &&
    draft.roles.length > 0 &&
    draft.capabilities.length > 0 &&
    draft.endsAt.length > 0;
  useAtomSubscribe(delegationForm.submit, (result) => {
    if (!AsyncResult.isSuccess(result) || result.waiting || disabled || !complete(result.value)) {
      return;
    }
    const { amountMinor, capabilities, currency, endsAt, managerId, people, roles } = result.value;
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
        ...selectedLabels(scope.managers, [managerId]),
        ...selectedLabels(scope.people, people),
        ...selectedLabels(scope.roles, roles),
        ...selectedLabels(scope.capabilities, capabilities),
        endsAt,
        amountMinor.length > 0 ? `${amountMinor} ${currency}` : t(`${prefix}.noAmountLimit`),
      ],
      titleKey: `${prefix}.delegationCreate`,
    });
  });
  const amountGiven = Option.exists(values, (draft) => draft.amountMinor.length > 0);
  return (
    <FormRoot
      aria-label={t(`${prefix}.delegationCreate`)}
      className="grid gap-200"
      defaultValues={{
        amountMinor: '',
        capabilities: [],
        currency: '',
        endsAt: '',
        managerId: '',
        people: [],
        roles: [],
      }}
      form={delegationForm}
      translateMessage={translateWith(t)}
    >
      <h3 className="text-xl">{t(`${prefix}.delegation`)}</h3>
      <p>{t(`${prefix}.delegationHelp`)}</p>
      <p>{t(`${prefix}.delegationCeiling`)}</p>
      <delegationForm.managerId
        disabled={disabled}
        items={choices(scope.managers)}
        label={t(`${prefix}.delegatedManager`)}
        placeholder={t(`${prefix}.delegatedManager`)}
      />
      <delegationForm.people
        disabled={disabled}
        items={choices(scope.people)}
        label={t(`${prefix}.delegationPeople`)}
        placeholder={t(`${prefix}.delegationPeople`)}
      />
      <delegationForm.roles
        disabled={disabled}
        items={choices(scope.roles)}
        label={t(`${prefix}.delegationRoles`)}
        placeholder={t(`${prefix}.delegationRoles`)}
      />
      <delegationForm.capabilities
        disabled={disabled}
        items={choices(scope.capabilities)}
        label={t(`${prefix}.permissions`)}
        placeholder={t(`${prefix}.permissions`)}
      />
      <delegationForm.amountMinor
        disabled={disabled}
        inputMode="numeric"
        label={t(`${prefix}.amountMinor`)}
        type="text"
      />
      <delegationForm.currency
        disabled={disabled}
        label={t(`${prefix}.currency`)}
        maxLength={3}
        required={amountGiven}
      />
      <delegationForm.endsAt
        disabled={disabled}
        helpText={t(`${prefix}.localTime`)}
        label={t(`${prefix}.endDate`)}
        required
        type="datetime-local"
      />
      <SubmitButton disabled={disabled || !Option.exists(values, complete)}>
        {t('shell.accessAdmin.common.preview')}
      </SubmitButton>
    </FormRoot>
  );
};

const TeamJoin = ({
  busy,
  onPreview,
  person,
  scope,
  writes,
}: {
  readonly busy: boolean;
  readonly onPreview: (change: PeoplePendingChange) => void;
  readonly person: PeopleChoice | undefined;
  readonly scope: PeopleScopeChoices;
  readonly writes: PeopleViewModel['writes'];
}) => {
  const { t } = useModernI18n();
  const teamId = Option.getOrElse(useAtomValue(teamJoinForm.getFieldAtoms(teamJoinForm.fields.teamId).value), () => '');
  useAtomSubscribe(teamJoinForm.submit, (result) => {
    const team = AsyncResult.isSuccess(result) ? scope.teams.find((item) => item.id === result.value) : undefined;
    if (result.waiting || busy || !writes.team || person === undefined || team === undefined) {
      return;
    }
    onPreview({
      command: { action: 'join', kind: 'team', personId: person.id, teamId: team.id },
      facts: [person.label, scope.label, team.label],
      titleKey: `${prefix}.teamAdd`,
    });
  });
  return (
    <FormRoot
      className="grid gap-200"
      defaultValues={{ teamId: '' }}
      form={teamJoinForm}
      translateMessage={translateWith(t)}
    >
      <h3 className="text-xl">{t(`${prefix}.teams`)}</h3>
      <teamJoinForm.teamId
        disabled={busy || !writes.team}
        items={choices(scope.teams)}
        label={t(`${prefix}.team`)}
        placeholder={t(`${prefix}.team`)}
      />
      <SubmitButton
        disabled={busy || !writes.team || person === undefined || !scope.teams.some((item) => item.id === teamId)}
      >
        {t(`${prefix}.teamAdd`)}
      </SubmitButton>
    </FormRoot>
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
  const values = useAtomValue(assignRoleForm.values);
  const person = scope.people.find((item) => Option.exists(values, (draft) => draft.personId === item.id));
  const role = scope.roles.find((item) => Option.exists(values, (draft) => draft.roleId === item.id));
  useAtomSubscribe(assignRoleForm.submit, (result) => {
    if (!AsyncResult.isSuccess(result) || result.waiting || busy || !writes.assign) {
      return;
    }
    const { endsAt, personId, roleId } = result.value;
    const chosenPerson = scope.people.find((item) => item.id === personId);
    const chosenRole = scope.roles.find((item) => item.id === roleId);
    if (chosenPerson !== undefined && chosenRole !== undefined) {
      onPreview({
        command: { expiryInput: endsAt, kind: 'assign', personId, roleId, scopeId: scope.id },
        facts: [
          chosenPerson.label,
          scope.label,
          chosenRole.label,
          endsAt.length === 0 ? t(`${prefix}.noExpiry`) : endsAt,
        ],
        titleKey: `${prefix}.confirmAssign`,
      });
    }
  });
  return (
    <div className="grid gap-300">
      <FormRoot
        aria-label={t(`${prefix}.assignRole`)}
        className="grid gap-200"
        defaultValues={{ endsAt: '', personId: '', roleId: '' }}
        form={assignRoleForm}
        translateMessage={translateWith(t)}
      >
        <assignRoleForm.personId
          disabled={busy}
          items={choices(scope.people)}
          label={t(`${prefix}.person`)}
          placeholder={t(`${prefix}.person`)}
        />
        <h3 className="text-xl">{t(`${prefix}.assignRole`)}</h3>
        <assignRoleForm.roleId
          disabled={busy || !writes.assign}
          items={choices(scope.roles)}
          label={t(`${prefix}.role`)}
          placeholder={t(`${prefix}.role`)}
        />
        <assignRoleForm.endsAt
          disabled={busy || !writes.assign}
          helpText={t(`${prefix}.localTime`)}
          label={t(`${prefix}.endDate`)}
          type="datetime-local"
        />
        <p>{t(`${prefix}.endDateHelp`)}</p>
        <SubmitButton disabled={busy || !writes.assign || person === undefined || role === undefined}>
          {t(`${prefix}.assignRole`)}
        </SubmitButton>
      </FormRoot>
      <TeamJoin busy={busy} onPreview={onPreview} person={person} scope={scope} writes={writes} />
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
  const scopeId = useAtomValue(scopeIdValue);
  const scope = model.scopes.find((item) => Option.exists(scopeId, (id) => id === item.id));
  return (
    <section className="grid gap-200">
      <FormRoot defaultValues={{ scopeId: '' }} form={peopleScopeForm} translateMessage={translateWith(t)}>
        <peopleScopeForm.scopeId
          disabled={busy}
          items={choices(model.scopes)}
          label={t(`${prefix}.scope`)}
          placeholder={t(`${prefix}.scope`)}
        />
      </FormRoot>
      {scope === undefined ? (
        <StatusText>{t(`${prefix}.chooseScope`)}</StatusText>
      ) : (
        <ScopeEditor busy={busy} key={scope.id} onPreview={onPreview} scope={scope} writes={model.writes} />
      )}
    </section>
  );
};
