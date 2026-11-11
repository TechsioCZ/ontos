import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@app/admin-ui/form-controls';
import { Effect, Schema } from 'effect';
import { useRef, useState } from 'react';

import { CreateAccessRolePayloadSchema } from '../../../../shared/access-admin-api.ts';
import type { GetAccessRoleResponse, ListAccessRoleTemplatesResponse } from '../../../../shared/access-admin-api.ts';
import { createAccessAdministrationIdempotencyKey, createAccessRole } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { roleFormErrorStatus } from './role-commands.ts';
import type { RoleEditorStatus } from './model.ts';

/** What the create form holds until Uložit: the name, and the company the role is scoped to when one is picked. */
interface CreateDraft {
  readonly company: boolean;
  readonly companyId: string;
  readonly name: string;
}

const blankDraft: CreateDraft = { company: false, companyId: '', name: '' };

const sameDraft = (left: CreateDraft, right: CreateDraft): boolean =>
  left.company === right.company && left.companyId === right.companyId && left.name === right.name;

/** Creation grants no cells. Adding permissions always takes the preview/confirm edit path. */
export const CreateRoleFeature = ({
  catalog,
  onCreated,
  writesAvailable,
}: {
  readonly catalog: ListAccessRoleTemplatesResponse;
  readonly onCreated: (role: GetAccessRoleResponse['role']) => void;
  readonly writesAvailable: boolean;
}) => {
  const { language, t } = useModernI18n();
  const [draft, setDraft] = useState<CreateDraft>(blankDraft);
  const [failure, setFailure] = useState<RoleEditorStatus | null>(null);
  // The key of the last attempt: a retry of the same draft reuses it, so an answer that got lost cannot create twice.
  const attempt = useRef<{ readonly draft: CreateDraft; readonly key: string } | null>(null);
  const template = catalog.templates.find(
    (candidate) =>
      candidate.source === 'blank' &&
      candidate.cells.length === 0 &&
      candidate.catalogSnapshotId === catalog.catalogSnapshotId,
  );
  const available = writesAvailable && template !== undefined;

  const rememberAttempt = (value: CreateDraft, key: string) =>
    Effect.sync(() => {
      attempt.current = { draft: value, key };
    });

  const create = (value: CreateDraft): Effect.Effect<SaveOutcome> => {
    if (template === undefined) {
      return Effect.succeed('failed');
    }
    const previous = attempt.current;
    const idempotencyKey =
      previous !== null && sameDraft(previous.draft, value)
        ? Effect.succeed(previous.key)
        : createAccessAdministrationIdempotencyKey();
    return Schema.decodeEffect(CreateAccessRolePayloadSchema)({
      catalogSnapshotId: catalog.catalogSnapshotId,
      cells: [],
      name: value.name.trim(),
      scope: value.company ? { kind: 'company', legalEntityId: value.companyId.trim() } : { kind: 'tenant' },
      templateKey: template.templateKey,
    }).pipe(
      Effect.flatMap((payload) =>
        idempotencyKey.pipe(
          Effect.tap((key) => rememberAttempt(value, key)),
          Effect.flatMap((key) => createAccessRole(payload, { idempotencyKey: key, locale: language })),
        ),
      ),
      Effect.match({
        onFailure: (error): SaveOutcome => {
          setFailure(roleFormErrorStatus(error));
          return 'failed';
        },
        onSuccess: (role): SaveOutcome => {
          attempt.current = null;
          setFailure(null);
          onCreated(role);
          return 'saved';
        },
      }),
    );
  };

  const record = useDraftSave<CreateDraft, never>({
    equals: sameDraft,
    isValid: (value) => available && value.name.trim() !== '' && (!value.company || value.companyId.trim() !== ''),
    runtime: browserRuntime,
    save: create,
    value: draft,
  });
  // The form starts over after a created role, so the same name is not sent twice.
  const startOver = () => {
    setDraft(blankDraft);
    record.adopt(blankDraft);
  };
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        startOver();
      }
    });
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setDraft(record.confirmed);
    },
  });
  const pending = record.status === 'saving';
  const labels = saveLabelsFor(language);

  return (
    <form className="shell:grid shell:gap-4" onSubmit={(event) => event.preventDefault()}>
      <h2 className="shell:text-title-md">{t('shell.accessAdmin.role.createBlank')}</h2>
      <p>{t('shell.accessAdmin.role.createBlankHelp')}</p>
      <FormInput
        disabled={pending || !writesAvailable}
        id="new-role-name"
        label={t('shell.accessAdmin.role.name')}
        maxLength={200}
        name="name"
        onChange={(event) => {
          const { value } = event.currentTarget;
          setDraft((current) => ({ ...current, name: value }));
        }}
        required
        value={draft.name}
      />
      <FormCheckbox
        checked={draft.company}
        disabled={pending || !writesAvailable}
        id="new-role-company"
        label={t('shell.accessAdmin.role.createScopeCompany')}
        onCheckedChange={(checked) => {
          setDraft((current) => ({ ...current, company: checked }));
        }}
      />
      {draft.company ? (
        <FormInput
          autoCapitalize="off"
          disabled={pending || !writesAvailable}
          id="new-role-company-id"
          label={t('shell.accessAdmin.role.companyId')}
          name="companyId"
          onChange={(event) => {
            const { value } = event.currentTarget;
            setDraft((current) => ({ ...current, companyId: value }));
          }}
          required
          spellCheck={false}
          value={draft.companyId}
        />
      ) : (
        <p>{t('shell.accessAdmin.role.createScopeTenant')}</p>
      )}
      {writesAvailable ? null : (
        <StatusText status="warning">{t('shell.accessAdmin.role.writesUnavailable')}</StatusText>
      )}
      {template === undefined ? <StatusText>{t('shell.accessAdmin.role.templateUnavailable')}</StatusText> : null}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
      <SaveBar
        error={
          failure === null ? undefined : t(`shell.accessAdmin.common.${failure === 'invalid' ? 'failed' : failure}`)
        }
        labels={labels}
        onReloadLatest={startOver}
        onSave={handleSave}
        status={record.status}
      />
    </form>
  );
};
