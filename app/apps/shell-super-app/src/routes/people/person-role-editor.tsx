// Assigns or removes an access role of a person, with the reason. Picking and typing change only the draft; the
// shared Uložit sends the one change once; Zrušit and leaving the page with input ask first; an untouched dialog
// closes at once.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import type { HttpClient } from 'effect/http';
import { useState } from 'react';

import {
  AssignAccessRolePayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
} from '../../../shared/access-admin-api.ts';
import type { Person } from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import type { PersonRoleCommand } from './people-client.ts';
import { changePersonRole } from './people-client.ts';
import { accessAssignmentOf, accessRolesOfScope } from './people-model.ts';
import type { AccessRoleChoice, PeopleAccessView, PendingPeopleChange } from './people-model.ts';

const selectClass = 'w-full rounded-md border border-border-primary bg-base p-100';

/**
 * The role picker offers exactly the canonical roles of this scope, named by their canonical identity.
 * A role key never reaches a write: the assignment names the role id and the exact revision the screen read.
 */
const RolePicker = ({
  access,
  busy,
  onChange,
  operation,
  person,
  roleId,
  roles,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly busy: boolean;
  readonly onChange: (roleId: string) => void;
  readonly operation: 'assign' | 'revoke';
  readonly person: Person;
  readonly roleId: string;
  readonly roles: readonly AccessRoleChoice[];
}) => {
  const selected = roles.find((role) => role.roleId === roleId);
  const revocable = (role: AccessRoleChoice) =>
    accessAssignmentOf(access, person.principalRef.principalId, role.roleId) !== undefined;
  return (
    <>
      <p className="text-fg-secondary text-sm">
        Role platí pro {selected?.scope.kind === 'company' ? 'vybranou firmu' : 'celou organizaci'}. Rozsah role je daný
        rolí, ne volbou v této obrazovce.
      </p>
      <label className="grid gap-50">
        Role
        <select
          className={selectClass}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          required
          value={roleId}
        >
          <option value="">Vyberte roli</option>
          {roles.map((role) => (
            <option key={role.roleId} value={role.roleId}>
              {role.name}
              {operation === 'revoke' && !revocable(role) ? ' (nepřiřazena)' : ''}
            </option>
          ))}
        </select>
      </label>
      {roles.length === 0 ? (
        <StatusText status="warning">V tomto rozsahu není žádná role. Role založíte v části Přístup → Role.</StatusText>
      ) : null}
    </>
  );
};

interface RoleDraft {
  readonly operation: 'assign' | 'revoke';
  readonly reason: string;
  readonly roleId: string;
}
const emptyRoleDraft: RoleDraft = { operation: 'assign', reason: '', roleId: '' };

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
  const [draft, setDraft] = useState(emptyRoleDraft);
  const [error, setError] = useState<string | null>(null);
  const record = useDraftSave<RoleDraft, HttpClient.HttpClient>({
    initial: emptyRoleDraft,
    isValid: (value) => roleCommandOf(access, roles, principalId, value) !== undefined,
    runtime: browserRuntime,
    save: (value) => {
      const command = roleCommandOf(access, roles, principalId, value);
      if (command === undefined) {
        return Effect.succeed<SaveOutcome>('failed');
      }
      return changePersonRole(command).pipe(
        Effect.map((outcome): SaveOutcome => {
          if (outcome.status === 'failed') {
            setError(outcome.message);
            return 'failed';
          }
          setError(null);
          onCommitted(outcome.value);
          return 'saved';
        }),
      );
    },
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setError(null);
      setDraft(emptyRoleDraft);
    },
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
            <Button disabled={busy} onClick={requestClose} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <SaveBar
              error={error}
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
        <div className="grid gap-200">
          <p>{person.displayName}</p>
          <RolePicker
            access={access}
            busy={busy}
            onChange={(roleId) => setDraft((current) => ({ ...current, roleId }))}
            operation={draft.operation}
            person={person}
            roleId={draft.roleId}
            roles={roles}
          />
          <label className="grid gap-50">
            Změna
            <select
              className={selectClass}
              disabled={busy}
              onChange={(event) => {
                const operation = event.target.value === 'revoke' ? 'revoke' : 'assign';
                setDraft((current) => ({ ...current, operation, roleId: '' }));
              }}
              value={draft.operation}
            >
              <option value="assign">Přiřadit</option>
              <option value="revoke">Odebrat</option>
            </select>
          </label>
          <FormInput
            disabled={busy}
            label={t('shell.people.changeReason')}
            maxLength={500}
            onChange={(event) => {
              const { value } = event.target;
              setDraft((current) => ({ ...current, reason: value }));
            }}
            required
            value={draft.reason}
          />
          {record.status === 'invalid' ? (
            <StatusText role="alert" status="warning">
              {access === undefined
                ? 'Přístupové údaje se nepodařilo načíst. Obnovte stránku.'
                : 'Vyberte roli, vyplňte důvod a u odebírání zvolte přiřazenou roli.'}
            </StatusText>
          ) : null}
        </div>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
