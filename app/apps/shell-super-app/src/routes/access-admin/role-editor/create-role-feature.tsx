import {
  CheckboxField,
  FormReact,
  FormRoot,
  FormRootError,
  SubmitButton,
  TextField,
  fromPayload,
  makeActionAttempt,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema, Struct } from 'effect';
import type { PlatformError } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import type { Atom } from 'effect/reactivity';

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
const roleName = createRoleForm.getFieldAtoms(createRoleForm.fields.name);

const CreateRoleStatus = () => {
  const { t } = useModernI18n();
  const result = useAtomValue(createRoleForm.submit);
  if (result.waiting) {
    return (
      <StatusText aria-live="polite" status="warning">
        {t('shell.accessAdmin.common.saving')}
      </StatusText>
    );
  }
  return AsyncResult.isSuccess(result) ? (
    <StatusText aria-live="polite" status="success">
      {t('shell.accessAdmin.common.saved')}
    </StatusText>
  ) : (
    <FormRootError form={createRoleForm} />
  );
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
  const clearName = useAtomSet(roleName.setValue);
  const template = catalog.templates.find(
    (candidate) =>
      candidate.source === 'blank' &&
      candidate.cells.length === 0 &&
      candidate.catalogSnapshotId === catalog.catalogSnapshotId,
  );
  useAtomSubscribe(createRoleForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      clearName('');
      onCreated(result.value);
    }
  });
  return (
    <FormRoot
      className="grid gap-200"
      defaultValues={{
        catalogSnapshotId: catalog.catalogSnapshotId,
        company: false,
        companyId: '',
        locale: language,
        name: '',
        templateKey: template?.templateKey ?? '',
      }}
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
          spellCheck={false}
        />
      ) : (
        <p>{t('shell.accessAdmin.role.createScopeTenant')}</p>
      )}
      {writesAvailable ? null : (
        <StatusText status="warning">{t('shell.accessAdmin.role.writesUnavailable')}</StatusText>
      )}
      {template === undefined ? <StatusText>{t('shell.accessAdmin.role.templateUnavailable')}</StatusText> : null}
      <CreateRoleStatus />
      <SubmitButton disabled={!writesAvailable || template === undefined}>
        {t('shell.accessAdmin.role.createBlank')}
      </SubmitButton>
    </FormRoot>
  );
};
