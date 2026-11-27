// Assigns or removes an access role of a person, with the reason. Picking and typing change only the form; the
// shared Uložit sends the one change once; Zrušit and leaving the page with input ask first; an untouched dialog
// closes at once.
import { SaveBar, UnsavedChangesDialog, requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { Atom } from 'effect/reactivity';
import { useEffect } from 'react';

import {
  AssignAccessRolePayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
} from '../../../shared/access-admin-api.ts';
import type { Person } from '../../../shared/people-api.ts';
import { browserAtomRuntime } from '../../runtime/browser-effect-runtime.ts';
import type { PersonRoleCommand } from './people-client.ts';
import { changePersonRole } from './people-client.ts';
import { acceptedValue, incompleteChange, peopleSubmitErrors, usePeopleDialogSave } from './people-dialog-save.ts';
import { accessAssignmentOf, accessRolesOfScope } from './people-model.ts';
import type { AccessRoleChoice, PeopleAccessView, PendingPeopleChange } from './people-model.ts';

interface RoleDraft {
  readonly operation: 'assign' | 'revoke';
  readonly reason: string;
  readonly roleId: string;
}

/** The one role command a draft stands for, against the people revision the screen read; none while incomplete. */
const roleCommandOf = (
  access: PeopleAccessView | undefined,
  roles: readonly AccessRoleChoice[],
  principalId: string,
  draft: RoleDraft,
): PersonRoleCommand | undefined => {
  const chosen = roles.find((role) => role.roleId === draft.roleId);
  if (access === undefined || chosen === undefined || draft.reason.trim() === '') {
    return undefined;
  }
  if (draft.operation === 'assign') {
    const payload = Schema.decodeUnknownOption(AssignAccessRolePayloadSchema)({
      expectedRevision: access.people.revision,
      expectedRoleRevisionId: chosen.latestRevisionId,
      principalId,
      roleId: chosen.roleId,
      scope: chosen.scope,
    });
    return Option.isNone(payload) ? undefined : { operation: 'assign', payload: payload.value };
  }
  const held = accessAssignmentOf(access, principalId, chosen.roleId);
  if (held === undefined) {
    return undefined;
  }
  const payload = Schema.decodeUnknownOption(RevokeAccessAssignmentPayloadSchema)({
    expectedRevision: access.people.revision,
    incarnationId: held.incarnationId,
    reason: draft.reason.trim(),
  });
  return Option.isNone(payload) ? undefined : { operation: 'revoke', payload: payload.value };
};

/** The person and the access read the open editor changes a role of; the form's values pick the change. */
interface RoleTarget {
  readonly access: PeopleAccessView | undefined;
  readonly principalId: string;
  readonly roles: readonly AccessRoleChoice[];
}
const roleTarget = Atom.make(Option.none<RoleTarget>()).pipe(Atom.keepAlive);

interface RoleValues {
  readonly operation: string;
  readonly reason: string;
  readonly roleId: string;
}
const roleDraftOf = (values: RoleValues): RoleDraft => ({
  operation: values.operation === 'revoke' ? 'revoke' : 'assign',
  reason: values.reason,
  roleId: values.roleId,
});
const commandOf = (target: RoleTarget, values: RoleValues) =>
  roleCommandOf(target.access, target.roles, target.principalId, roleDraftOf(values));

const sendRoleChange = Effect.fn('PersonRoleEditor.send')(function* sendRoleChange(
  values: RoleValues,
  get: Atom.FnContext,
) {
  const command = Option.flatMap(get(roleTarget), (target) => Option.fromUndefinedOr(commandOf(target, values)));
  if (Option.isNone(command)) {
    return yield* incompleteChange;
  }
  return yield* changePersonRole(command.value).pipe(Effect.flatMap(acceptedValue));
});

const personRoleForm = FormReact.make(
  FormBuilder.empty
    .addField('operation', Schema.String)
    .addField('reason', Schema.String)
    .addField('roleId', Schema.String),
  {
    fields: { operation: ChoiceField, reason: TextField, roleId: ChoiceField },
    onSubmit: (_submit, { decoded, get }) => sendRoleChange(decoded, get),
    runtime: browserAtomRuntime,
    submitErrors: peopleSubmitErrors,
  },
);

const emptyRoleValues: RoleValues = { operation: 'assign', reason: '', roleId: '' };
const roleIdField = personRoleForm.getFieldAtoms(personRoleForm.fields.roleId);
const chosenRoleId = roleIdField.value.pipe(Atom.map(Option.getOrElse(() => '')));
/** The picked change, as a plain value that changes only when the person picks another one. */
const chosenOperation = personRoleForm
  .getFieldAtoms(personRoleForm.fields.operation)
  .value.pipe(Atom.map((operation) => (Option.contains(operation, 'revoke') ? 'revoke' : 'assign')));
const operations = [
  { label: 'Přiřadit', value: 'assign' },
  { label: 'Odebrat', value: 'revoke' },
];

/**
 * The role picker offers exactly the canonical roles of this scope, named by their canonical identity.
 * A role key never reaches a write: the assignment names the role id and the exact revision the screen read.
 */
const RolePicker = ({
  access,
  person,
  roles,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly person: Person;
  readonly roles: readonly AccessRoleChoice[];
}) => {
  const roleId = useAtomValue(chosenRoleId);
  const operation = useAtomValue(chosenOperation);
  const setRoleId = useAtomSet(roleIdField.setValue);
  // Another change offers other roles: the picked one is chosen again.
  useAtomSubscribe(chosenOperation, () => setRoleId(''), { immediate: false });
  const selected = roles.find((role) => role.roleId === roleId);
  const revocable = (role: AccessRoleChoice) =>
    accessAssignmentOf(access, person.principalRef.principalId, role.roleId) !== undefined;
  return (
    <>
      <p className="text-fg-secondary text-sm">
        Role platí pro {selected?.scope.kind === 'company' ? 'vybranou firmu' : 'celou organizaci'}. Rozsah role je daný
        rolí, ne volbou v této obrazovce.
      </p>
      <personRoleForm.roleId
        items={roles.map((role) => ({
          label: `${role.name}${operation === 'revoke' && !revocable(role) ? ' (nepřiřazena)' : ''}`,
          value: role.roleId,
        }))}
        label="Role"
        placeholder="Vyberte roli"
      />
      {roles.length === 0 ? (
        <StatusText status="warning">V tomto rozsahu není žádná role. Role založíte v části Přístup → Role.</StatusText>
      ) : null}
    </>
  );
};

export const PersonRoleEditor = ({
  access,
  companyId,
  onClose,
  onCommitted,
  person,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly companyId: string | undefined;
  readonly onClose: () => void;
  /** The change went through; the panel closes the editor and shows the change as pending. */
  readonly onCommitted: (change: PendingPeopleChange) => void;
  readonly person: Person;
  readonly scope: 'company' | 'tenant';
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { principalId } = person.principalRef;
  const roles = accessRolesOfScope(access, scope, companyId);
  const setTarget = useAtomSet(roleTarget);
  useEffect(() => {
    setTarget(Option.some({ access, principalId, roles }));
  }, [access, principalId, roles, setTarget]);
  const { guard, record, refusal } = usePeopleDialogSave({
    form: personRoleForm,
    onSaved: onCommitted,
    opened: emptyRoleValues,
    valid: (values) => commandOf({ access, principalId, roles }, values) !== undefined,
  });
  const busy = record.status === 'saving';
  const requestClose = () => {
    if (!busy) {
      guard.request(onClose);
    }
  };
  const handleSave = record.save;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" disabled={busy} onClick={requestClose} severity="secondary">
              Zrušit
            </Button>
            <SaveBar
              error={refusal}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        closeLabel="Zavřít"
        customTrigger
        onOpenChange={(details) => {
          if (!details.open) {
            requestClose();
          }
        }}
        open
        title={t('shell.people.roleEditorTitle')}
      >
        <FormRoot
          className="grid gap-200"
          defaultValues={emptyRoleValues}
          form={personRoleForm}
          translateMessage={(message) => t(message, { defaultValue: message })}
        >
          <p>{person.displayName}</p>
          <RolePicker access={access} person={person} roles={roles} />
          <personRoleForm.operation items={operations} label="Změna" />
          <personRoleForm.reason
            label={t('shell.people.changeReason')}
            maxLength={500}
            required
            requiredLabel={requiredLabelFor(language)}
          />
          {record.status === 'invalid' ? (
            <StatusText role="alert" status="warning">
              {access === undefined
                ? 'Přístupové údaje se nepodařilo načíst. Obnovte stránku.'
                : 'Vyberte roli, vyplňte důvod a u odebírání zvolte přiřazenou roli.'}
            </StatusText>
          ) : null}
        </FormRoot>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
