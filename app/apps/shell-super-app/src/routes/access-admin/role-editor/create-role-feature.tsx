import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Schema } from 'effect';
import { useRef, useState } from 'react';

import { CreateAccessRolePayloadSchema } from '../../../../shared/access-admin-api.ts';
import type { GetAccessRoleResponse, ListAccessRoleTemplatesResponse } from '../../../../shared/access-admin-api.ts';
import { createAccessAdministrationIdempotencyKey, createAccessRole } from '../../../api/auth-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { roleFormErrorStatus } from './role-commands.ts';
import type { RoleEditorStatus } from './model.ts';

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
  const [name, setName] = useState('');
  const [company, setCompany] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [status, setStatus] = useState<RoleEditorStatus>('idle');
  const active = useRef(false);
  const key = useRef<string | null>(null);
  const template = catalog.templates.find(
    (candidate) =>
      candidate.source === 'blank' &&
      candidate.cells.length === 0 &&
      candidate.catalogSnapshotId === catalog.catalogSnapshotId,
  );
  const pending = status === 'saving';
  const changed = () => {
    key.current = null;
    setStatus('idle');
  };
  const rememberKey = (value: string) =>
    Effect.sync(() => {
      key.current = value;
    });
  const submit = () => {
    if (active.current || !writesAvailable || template === undefined) {
      return;
    }
    active.current = true;
    setStatus('saving');
    void browserRuntime.runPromise(
      Schema.decodeEffect(CreateAccessRolePayloadSchema)({
        catalogSnapshotId: catalog.catalogSnapshotId,
        cells: [],
        name: name.trim(),
        scope: company ? { kind: 'company', legalEntityId: companyId.trim() } : { kind: 'tenant' },
        templateKey: template.templateKey,
      }).pipe(
        Effect.flatMap((payload) => {
          const requestKey =
            key.current === null ? createAccessAdministrationIdempotencyKey() : Effect.succeed(key.current);
          return requestKey.pipe(
            Effect.tap(rememberKey),
            Effect.flatMap((idempotencyKey) => createAccessRole(payload, { idempotencyKey, locale: language })),
          );
        }),
        Effect.match({
          onFailure: (error) => setStatus(roleFormErrorStatus(error)),
          onSuccess: (role) => {
            setStatus('saved');
            setName('');
            key.current = null;
            onCreated(role);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            active.current = false;
          }),
        ),
      ),
    );
  };
  return (
    <form action={submit} className="shell:grid shell:gap-4">
      <h2 className="shell:text-title-md">{t('shell.accessAdmin.role.createBlank')}</h2>
      <p>{t('shell.accessAdmin.role.createBlankHelp')}</p>
      <FormInput
        disabled={pending || !writesAvailable}
        id="new-role-name"
        label={t('shell.accessAdmin.role.name')}
        maxLength={200}
        name="name"
        onChange={(event) => {
          changed();
          setName(event.currentTarget.value);
        }}
        required
        value={name}
      />
      <FormCheckbox
        checked={company}
        disabled={pending || !writesAvailable}
        id="new-role-company"
        label={t('shell.accessAdmin.role.createScopeCompany')}
        onCheckedChange={(checked) => {
          changed();
          setCompany(checked);
        }}
      />
      {company ? (
        <FormInput
          autoCapitalize="off"
          disabled={pending || !writesAvailable}
          id="new-role-company-id"
          label={t('shell.accessAdmin.role.companyId')}
          name="companyId"
          onChange={(event) => {
            changed();
            setCompanyId(event.currentTarget.value);
          }}
          required
          spellCheck={false}
          value={companyId}
        />
      ) : (
        <p>{t('shell.accessAdmin.role.createScopeTenant')}</p>
      )}
      {writesAvailable ? null : (
        <StatusText status="warning">{t('shell.accessAdmin.role.writesUnavailable')}</StatusText>
      )}
      {template === undefined ? <StatusText>{t('shell.accessAdmin.role.templateUnavailable')}</StatusText> : null}
      {status === 'idle' ? null : (
        <StatusText aria-live="polite" status={status === 'saved' ? 'success' : 'warning'}>
          {t(`shell.accessAdmin.common.${status === 'invalid' ? 'failed' : status}`)}
        </StatusText>
      )}
      <Button disabled={pending || !writesAvailable || template === undefined} isLoading={pending} type="submit">
        {t('shell.accessAdmin.role.createBlank')}
      </Button>
    </form>
  );
};
