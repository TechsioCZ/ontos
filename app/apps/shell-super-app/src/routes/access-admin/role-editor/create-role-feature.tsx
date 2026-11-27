import {
  SaveBar,
  UnsavedChangesDialog,
  draftSavable,
  requiredLabelFor,
  saveLabelsFor,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveState } from '@app/admin-ui';
import {
  CheckboxField,
  FormReact,
  FormRoot,
  TextField,
  fromPayload,
  makeActionAttempt,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema, Struct } from 'effect';
import type { PlatformError } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import type { Atom } from 'effect/reactivity';
import { useRef } from 'react';

import { AccessScopeTargetSchema, CreateAccessRolePayloadSchema } from '../../../../shared/access-admin-api.ts';
import type {
  CreateAccessRolePayload,
  GetAccessRoleResponse,
  ListAccessRoleTemplatesResponse,
} from '../../../../shared/access-admin-api.ts';
import { createAccessAdministrationIdempotencyKey, createAccessRole } from '../../../api/auth-client.ts';
import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { RoleEditorStatusSchema } from './model.ts';
import { roleFormErrorStatus } from './role-commands.ts';
import { useRoleDraft } from './role-save.ts';

/** Why the Shell did not create the role, as the editor status its message names. */
class CreateRoleRefused extends Schema.TaggedError<CreateRoleRefused>()('CreateRoleRefused', {
  /** The field the refusal is about, or `""` for the form as a whole. */
  path: Schema.Literals(['', 'companyId']),
  status: RoleEditorStatusSchema,
}) {}

const attempt = makeActionAttempt<CreateAccessRolePayload, PlatformError.PlatformError>(
  createAccessAdministrationIdempotencyKey(),
);

/** The company scope of the role; an id that is not a company id is refused on its field. */
const decodeCompanyScope = (companyId: string) =>
  Schema.decodeEffect(AccessScopeTargetSchema)({ kind: 'company', legalEntityId: companyId.trim() }).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(new CreateRoleRefused({ path: 'companyId', status: 'invalid' }))),
  );

const commitRole = Effect.fn('CreateRoleFeature.commitRole')(
  function* commitRole(
    input: {
      readonly catalogSnapshotId: string;
      readonly locale: string;
      readonly name: string;
      readonly scope: typeof AccessScopeTargetSchema.Type;
      readonly templateKey: string;
    },
    get: Atom.FnContext,
  ) {
    const payload = yield* Schema.decodeEffect(CreateAccessRolePayloadSchema)({
      catalogSnapshotId: input.catalogSnapshotId,
      cells: [],
      name: input.name.trim(),
      scope: input.scope,
      templateKey: input.templateKey,
    });
    const idempotencyKey = yield* attempt.key(get, payload);
    const role = yield* createAccessRole(payload, { idempotencyKey, locale: input.locale });
    yield* attempt.settle(get);
    return role;
  },
  Effect.mapError((failure) => new CreateRoleRefused({ path: '', status: roleFormErrorStatus(failure) })),
);

const createRole = Effect.fn('CreateRoleFeature.createRole')(function* createRole(
  input: {
    readonly catalogSnapshotId: string;
    readonly company: boolean;
    readonly companyId: string;
    readonly locale: string;
    readonly name: string;
    readonly templateKey: string;
  },
  get: Atom.FnContext,
) {
  const scope = input.company ? yield* decodeCompanyScope(input.companyId) : { kind: 'tenant' as const };
  return yield* commitRole({ ...input, scope }, get);
});

/**
 * The blank role the Action creates: its name comes from the payload, its catalog and template from
 * the published blank template, and the company scope is the form's own choice.
 */
const createRoleForm = FormReact.make(
  fromPayload(CreateAccessRolePayloadSchema.mapFields(Struct.pick(['catalogSnapshotId', 'name', 'templateKey'])))
    .addField('company', Schema.Boolean)
    .addField('companyId', Schema.String)
    .addField('locale', Schema.String),
  {
    fields: {
      catalogSnapshotId: TextField,
      company: CheckboxField,
      companyId: TextField,
      locale: TextField,
      name: TextField,
      templateKey: TextField,
    },
    onSubmit: (_submit, { decoded, get }) => createRole(decoded, get),
    runtime: browserAtomRuntime,
    submitErrors: ({ path, status }) => [
      path === 'companyId'
        ? { message: 'shell.accessAdmin.role.invalidCompanyId', path }
        : { message: `shell.accessAdmin.common.${status === 'invalid' ? 'failed' : status}`, path },
    ],
  },
);

const companyScope = createRoleForm.getFieldAtoms(createRoleForm.fields.company).value;

/**
 * The shared save bar's status of the create form: what was typed waits for Uložit; a refusal of the
 * form as a whole can be sent again, a refusal of a field waits for that field to change.
 */
const createSaveState = ({
  available,
  changedSinceSubmit,
  dirty,
  refused,
  result,
  submitted,
}: {
  readonly available: boolean;
  readonly changedSinceSubmit: boolean;
  readonly dirty: boolean;
  readonly refused: boolean;
  readonly result: AsyncResult.AsyncResult<unknown, unknown>;
  /** Uložit ran since the form was opened; an earlier opening's outcome says nothing about this one. */
  readonly submitted: boolean;
}): SaveState => {
  if (result.waiting) {
    return 'saving';
  }
  if (!dirty) {
    return submitted && AsyncResult.isSuccess(result) ? 'saved' : 'idle';
  }
  if (submitted && AsyncResult.isFailure(result) && !changedSinceSubmit) {
    return refused ? 'error' : 'invalid';
  }
  return available ? 'dirty' : 'invalid';
};

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
  const company = useAtomValue(companyScope);
  const dirty = useAtomValue(createRoleForm.isDirty);
  const changedSinceSubmit = useAtomValue(createRoleForm.hasChangedSinceSubmit);
  const submitted = useAtomValue(createRoleForm.submitCount) > 0;
  const rootError = useAtomValue(createRoleForm.rootError);
  const result = useAtomValue(createRoleForm.submit);
  const submit = useAtomSet(createRoleForm.submit);
  const setValues = useAtomSet(createRoleForm.setValues);
  // Whoever waits for the running create (the leave question's Uložit) hears how it ended.
  const settle = useRef<((end: SaveState) => void) | null>(null);
  const template = catalog.templates.find(
    (candidate) =>
      candidate.source === 'blank' &&
      candidate.cells.length === 0 &&
      candidate.catalogSnapshotId === catalog.catalogSnapshotId,
  );
  const blank = {
    catalogSnapshotId: catalog.catalogSnapshotId,
    company: false,
    companyId: '',
    locale: language,
    name: '',
    templateKey: template?.templateKey ?? '',
  };
  const saveState = createSaveState({
    available: writesAvailable && template !== undefined,
    changedSinceSubmit,
    dirty,
    refused: Option.isSome(rootError),
    result,
    submitted,
  });
  useAtomSubscribe(createRoleForm.submit, (end) => {
    if (end.waiting) {
      return;
    }
    if (AsyncResult.isSuccess(end)) {
      // The form starts over after a created role, so the same name is not sent twice.
      setValues(blank);
      onCreated(end.value);
    }
    settle.current?.(AsyncResult.isSuccess(end) ? 'saved' : 'error');
    settle.current = null;
  });
  const draft = useRoleDraft({
    changed: dirty,
    onSave: (done) => {
      if (!(result.waiting || draftSavable(saveState))) {
        return false;
      }
      settle.current = done;
      if (!result.waiting) {
        submit();
      }
      return true;
    },
    savable: draftSavable(saveState),
    saveState,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => draft.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft, navigation: blocker, onDiscard: () => setValues(blank) });
  const handleSave = draft.save;
  const labels = saveLabelsFor(language);
  const requiredLabel = requiredLabelFor(language);
  return (
    <FormRoot
      className="grid gap-200"
      defaultValues={blank}
      form={createRoleForm}
      key={[catalog.catalogSnapshotId, template?.templateKey, language].join(':')}
      translateMessage={(message) => t(message, { defaultValue: t('shell.accessAdmin.common.failed') })}
    >
      <h2 className="text-xl">{t('shell.accessAdmin.role.createBlank')}</h2>
      <p>{t('shell.accessAdmin.role.createBlankHelp')}</p>
      <createRoleForm.name
        disabled={!writesAvailable}
        id="new-role-name"
        label={t('shell.accessAdmin.role.name')}
        maxLength={200}
        required
        requiredLabel={requiredLabel}
      />
      <createRoleForm.company
        disabled={!writesAvailable}
        id="new-role-company"
        label={t('shell.accessAdmin.role.createScopeCompany')}
      />
      {Option.getOrElse(company, () => false) ? (
        <createRoleForm.companyId
          autoCapitalize="off"
          disabled={!writesAvailable}
          id="new-role-company-id"
          label={t('shell.accessAdmin.role.companyId')}
          required
          requiredLabel={requiredLabel}
          spellCheck={false}
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
        error={Option.match(rootError, {
          onNone: () => null,
          onSome: (message) => t(message, { defaultValue: t('shell.accessAdmin.common.failed') }),
        })}
        labels={labels}
        onReloadLatest={() => setValues(blank)}
        onSave={handleSave}
        status={saveState}
      />
    </FormRoot>
  );
};
