import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import {
  DetailList,
  foldSearchText,
  EmptyState,
  PageHeader,
  SectionCard,
  SidePanel,
  StatCard,
  StatRow,
  Toaster,
  dataTableRowLabels,
  formatDateTime,
  formatNumber,
  paginationTranslations,
  surfaceTileClassName,
} from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef, DataTableTranslations, Row } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect, Option, Schema } from 'effect';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useState } from 'react';
import { runPeopleCommand } from '../../../../api/people-admin-client.ts';
import type {
  AuditEntry,
  ManageResult,
  PeopleCommand,
  PeopleFailure,
  PeopleOutcome,
  PeopleOverview,
  Person,
} from '../../../../api/people-admin-client.ts';
import { isCrmSalesRole, syncCrmSalesperson } from '../../../../api/crm-salesperson-sync.ts';
import type { SalespersonAccount, SalespersonSync } from '../../../../api/crm-salesperson-sync.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf, usePageData } from '../../../../runtime/use-page-data.ts';
import { AgentEntitiesSection } from './agent-entities-section.tsx';
import { peopleData } from './people-data.ts';
import csResource from '../../../../../locales/cs/workforce.json';
import enResource from '../../../../../locales/en/workforce.json';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { newRequestToken } from '../../prodej/zamestnanci/employee-model.ts';

const workforceI18nResources = {
  cs: { workforce: csResource },
  en: { workforce: enResource },
} as const;

const key = 'workforce.people';
const RESIZE_LABEL_KEY = 'workforce.sidePanel.resize';
const selectLabelProps = { className: 'text-label-md' };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PersonDetailSearchSchema = Schema.Struct({ person: Schema.optionalKey(Schema.String) });

type Translate = (key: string, options?: Record<string, unknown>) => string;

type LoadState =
  | { readonly reason: PeopleFailure; readonly status: 'failed' }
  | { readonly status: 'loading' }
  | { readonly data: PeopleOverview; readonly status: 'ready' };

const loadStateOf = (snapshot: PageDataSnapshot<PeopleOverview, PeopleFailure>): LoadState => {
  if (snapshot.state === 'pending') {
    return { status: 'loading' };
  }
  return snapshot.state === 'failed'
    ? { reason: snapshot.error, status: 'failed' }
    : { data: snapshot.value, status: 'ready' };
};

/** Named export of the exposed page: the Shell prepares the people and the agents before it reveals the page. */
export { preloadPeoplePage as preloadPage } from './people-data.ts';

const statusVariant = { active: 'success', archived: 'outline', disabled: 'danger' } as const;

const czechSort = (left: Row<Person>, right: Row<Person>, columnId: string): number =>
  String(left.getValue(columnId) ?? '').localeCompare(String(right.getValue(columnId) ?? ''), 'cs');

const initials = (name: string) =>
  name
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const Avatar = ({ name, muted }: { readonly muted: boolean; readonly name: string }) => (
  <span
    aria-hidden
    className={`flex size-400 shrink-0 items-center justify-center rounded-full font-semibold text-xs ${
      muted
        ? 'bg-surface-secondary text-fg-secondary'
        : 'border border-border-primary bg-surface-secondary text-fg-primary'
    }`}
  >
    {initials(name)}
  </span>
);

interface CommandResult {
  /** CRM salesperson follow-up, present only when the account holds or held a salesperson role. */
  readonly crm?: { readonly register: boolean; readonly sync: SalespersonSync };
  readonly outcome: PeopleOutcome<ManageResult>;
}

/** Account state after the change, when it concerns a CRM salesperson role (now or before). */
type CrmAccountOf = (result: ManageResult) => SalespersonAccount | undefined;

const crmAccount = (account: SalespersonAccount) =>
  isCrmSalesRole(account.roleKey) || isCrmSalesRole(account.previousRoleKey) ? account : undefined;

const runCommand = (command: PeopleCommand, crmAccountOf?: CrmAccountOf): Promise<CommandResult> =>
  browserRuntime.runPromise(
    newRequestToken.pipe(
      Effect.flatMap((token) =>
        runPeopleCommand(command, `people-${token}`).pipe(
          Effect.flatMap((outcome) => {
            const account = outcome.status === 'ok' ? crmAccountOf?.(outcome.value) : undefined;
            return account === undefined
              ? Effect.succeed<CommandResult>({ outcome })
              : syncCrmSalesperson(account, `people-${token}`).pipe(
                  Effect.map((sync): CommandResult => ({
                    crm: { register: account.active && isCrmSalesRole(account.roleKey), sync },
                    outcome,
                  })),
                );
          }),
        ),
      ),
    ),
  );

const columnsOf = (t: Translate): ColumnDef<Person>[] => [
  {
    accessorKey: 'displayName',
    cell: (info: CellContext<Person>) => {
      const person = info.row.original;
      return (
        <span className="flex min-w-0 items-center gap-150">
          <Avatar muted={person.status !== 'active'} name={person.displayName} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-100 truncate font-medium">
              {person.displayName}
              {person.self && (
                <Badge size="sm" variant="info">
                  {t(`${key}.table.self`)}
                </Badge>
              )}
            </span>
            <span className="truncate text-fg-secondary text-xs">{person.email ?? t(`${key}.table.emailMissing`)}</span>
          </span>
        </span>
      );
    },
    header: t(`${key}.table.name`),
    meta: { width: 280 },
    sortFn: czechSort,
  },
  {
    accessorFn: (row) => row.roleLabel ?? t(`${key}.table.noRole`),
    cell: (info: CellContext<Person>) =>
      info.row.original.roleLabel === null ? (
        <span className="text-fg-secondary">{t(`${key}.table.noRole`)}</span>
      ) : (
        <Badge size="sm" variant="outline">
          {info.row.original.roleLabel}
        </Badge>
      ),
    header: t(`${key}.table.role`),
    id: 'role',
    meta: { width: 200 },
    sortFn: czechSort,
  },
  {
    accessorFn: (row) => t(`${key}.status.${row.status}`),
    cell: (info: CellContext<Person>) => (
      <Badge size="sm" variant={statusVariant[info.row.original.status]}>
        {info.getValue<string>()}
      </Badge>
    ),
    header: t(`${key}.table.status`),
    id: 'status',
    meta: { width: 130 },
  },
  {
    accessorFn: (row) => row.otherCompanies.join(', '),
    cell: (info: CellContext<Person>) =>
      info.row.original.otherCompanies.length === 0 ? (
        <span className="text-fg-secondary">{t(`${key}.table.none`)}</span>
      ) : (
        <span className="block truncate text-fg-secondary text-xs">{info.getValue<string>()}</span>
      ),
    enableSorting: false,
    header: t(`${key}.table.companies`),
    id: 'companies',
    meta: { width: 220 },
  },
];

const auditText = (entry: AuditEntry, t: Translate): string => {
  const details = entry.details;
  const target = entry.targetName ?? details['displayName'] ?? '—';
  if (entry.eventType === 'authn.rejected') {
    return t(`${key}.audit.inactiveRejected`);
  }
  if (entry.outcome === 'denied') {
    return t(`${key}.audit.rejected`, {
      code: t(`${key}.audit.codes.${entry.outcomeCode}`, { defaultValue: entry.outcomeCode }),
    });
  }
  if (details['operation'] === 'create') {
    return t(`${key}.audit.create`, { role: details['newRoleLabel'] ?? '—', target });
  }
  if (details['operation'] === 'change-role') {
    return t(`${key}.audit.changeRole`, {
      from: details['previousRoleLabel'] ?? t(`${key}.audit.noPrevious`),
      target,
      to: details['newRoleLabel'] ?? '—',
    });
  }
  return t(details['newStatus'] === 'disabled' ? `${key}.audit.disable` : `${key}.audit.enable`, { target });
};

const AuditList = ({ entries }: { readonly entries: readonly AuditEntry[] }) => {
  const { t } = useModernI18n();
  if (entries.length === 0) {
    return <p className="text-fg-secondary text-sm">{t(`${key}.audit.empty`)}</p>;
  }
  return (
    <ol className="flex flex-col">
      {entries.map((entry) => {
        const denied = entry.outcome === 'denied';
        const reason = entry.details['reason'];
        return (
          <li className="flex gap-150 border-border-primary border-b py-150 last:border-b-0" key={entry.auditEventId}>
            <span
              aria-hidden
              className={`mt-50 size-150 shrink-0 rounded-full ${denied ? 'bg-danger' : 'bg-success'}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-50">
              <p className="text-sm">
                <span className="font-medium">{entry.actorName ?? t(`${key}.audit.unknownActor`)}</span>{' '}
                {auditText(entry, t)}
              </p>
              {!denied && typeof reason === 'string' && reason.length > 0 && (
                <p className="text-fg-secondary text-xs">{t(`${key}.audit.reason`, { reason })}</p>
              )}
              <p className="text-fg-secondary text-xs tabular-nums">{formatDateTime(entry.occurredAt)}</p>
            </div>
            <span className="shrink-0 self-start">
              <Badge size="sm" variant={denied ? 'danger' : 'success'}>
                {t(denied ? `${key}.audit.denied` : `${key}.audit.succeeded`)}
              </Badge>
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const failureMessage = (reason: PeopleFailure, t: Translate) => t(`${key}.errors.${reason}`);

const CreateAccountPanel = ({
  onClose,
  onCreated,
  roles,
}: {
  readonly onClose: () => void;
  readonly onCreated: (name: string, result: ManageResult, crm: CommandResult['crm']) => void;
  readonly roles: PeopleOverview['roles'];
}) => {
  const { t } = useModernI18n();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const nameError = name.trim().length === 0 ? t(`${key}.form.nameRequired`) : null;
  const emailError = emailPattern.test(email.trim()) ? null : t(`${key}.form.emailInvalid`);
  const roleError = roleKey === null ? t(`${key}.form.roleRequired`) : null;
  const status = (error: string | null) =>
    submitted && error !== null ? { helpText: error, validateStatus: 'error' as const } : {};

  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (nameError !== null || emailError !== null || roleKey === null) {
      return;
    }
    setBusy(true);
    setServerError(null);
    const displayName = name.trim();
    const address = email.trim();
    void runCommand({ displayName, email: address, operation: 'create', roleKey }, (result) =>
      crmAccount({
        active: result.status === 'active',
        displayName,
        email: address.toLowerCase(),
        principalId: result.principalId,
        roleKey,
      }),
    ).then(({ crm, outcome }) => {
      setBusy(false);
      if (outcome.status === 'ok') {
        onCreated(displayName, outcome.value, crm);
      } else {
        setServerError(failureMessage(outcome.reason, t));
      }
    });
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <Button
            form="people-create-form"
            isLoading={busy}
            loadingText={t(`${key}.form.saving`)}
            type="submit"
            variant="primary"
          >
            {t(`${key}.form.submit`)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={t(`${key}.form.createDescription`)}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#people-name')}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={t(`${key}.form.createTitle`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        id="people-create-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <FormInput
          autoComplete="off"
          id="people-name"
          label={t(`${key}.form.name`)}
          name="displayName"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
          {...status(nameError)}
        />
        <FormInput
          autoComplete="off"
          id="people-email"
          label={t(`${key}.form.email`)}
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
          {...status(emailError)}
        />
        <SelectTemplate
          id="people-role"
          items={roles.map((role) => ({ displayValue: role.label, label: role.label, value: role.key }))}
          label={t(`${key}.form.role`)}
          labelProps={selectLabelProps}
          name="role"
          onValueChange={(details) => setRoleKey(details.value[0] ?? null)}
          placeholder={t('workforce.selectPlaceholder')}
          value={roleKey === null ? [] : [roleKey]}
        />
        {submitted && roleError !== null && (
          <StatusText showIcon status="error">
            {roleError}
          </StatusText>
        )}
        {roleKey !== null && (
          <p className="text-fg-secondary text-sm">
            {roles.find((role) => role.key === roleKey)?.description}
            {isCrmSalesRole(roleKey) && <> {t(`${key}.crm.roleHint`)}</>}
          </p>
        )}
        <div className={`${surfaceTileClassName} p-150 text-fg-secondary text-sm`}>{t(`${key}.form.password`)}</div>
      </form>
    </SidePanel>
  );
};

const PersonPanel = ({
  audit,
  onChanged,
  onClose,
  person,
  roles,
}: {
  readonly audit: readonly AuditEntry[];
  readonly onChanged: (message: string, result: ManageResult, crm: CommandResult['crm']) => void;
  readonly onClose: () => void;
  readonly person: Person;
  readonly roles: PeopleOverview['roles'];
}) => {
  const { t } = useModernI18n();
  const [roleKey, setRoleKey] = useState<string | null>(person.roleKey);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'role' | 'status' | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const history = audit.filter((entry) => entry.details['targetPrincipalId'] === person.principalId);
  const active = person.status === 'active';

  const execute = (kind: 'role' | 'status', command: PeopleCommand, message: string) => {
    setBusy(kind);
    setServerError(null);
    const nextRole = command.operation === 'change-role' ? command.roleKey : person.roleKey;
    void runCommand(command, (result) =>
      crmAccount({
        active: result.status === 'active',
        displayName: person.displayName,
        email: person.email,
        previousRoleKey: person.roleKey,
        principalId: person.principalId,
        roleKey: nextRole,
      }),
    ).then(({ crm, outcome }) => {
      setBusy(null);
      if (outcome.status === 'ok') {
        onChanged(message, outcome.value, crm);
      } else {
        setServerError(failureMessage(outcome.reason, t));
      }
    });
  };

  const changeRole = () => {
    if (roleKey === null || roleKey === person.roleKey) {
      setServerError(t(`${key}.panel.roleUnchanged`));
      return;
    }
    execute(
      'role',
      { operation: 'change-role', principalId: person.principalId, roleKey },
      t(`${key}.toast.roleChanged`),
    );
  };

  const changeStatus = () => {
    if (active && reason.trim().length === 0) {
      setReasonMissing(true);
      return;
    }
    execute(
      'status',
      active
        ? {
            expectedStatus: 'active',
            newStatus: 'disabled',
            operation: 'change-status',
            principalId: person.principalId,
            reason: reason.trim(),
          }
        : {
            expectedStatus: 'disabled',
            newStatus: 'active',
            operation: 'change-status',
            principalId: person.principalId,
          },
      t(active ? `${key}.toast.disabled` : `${key}.toast.enabled`),
    );
  };

  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          {t(`${key}.panel.close`)}
        </Button>
      }
      description={person.email ?? t(`${key}.table.emailMissing`)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="lg"
      title={person.displayName}
    >
      <div className="flex flex-col gap-250 py-200">
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <DetailList
          items={[
            {
              label: t(`${key}.panel.email`),
              value: <span className="break-all">{person.email ?? t(`${key}.table.emailMissing`)}</span>,
            },
            { label: t(`${key}.panel.role`), value: person.roleLabel ?? t(`${key}.table.noRole`) },
            {
              label: t(`${key}.panel.status`),
              value: (
                <Badge size="sm" variant={statusVariant[person.status]}>
                  {t(`${key}.status.${person.status}`)}
                </Badge>
              ),
            },
            {
              label: t(`${key}.panel.companies`),
              value: person.otherCompanies.length === 0 ? t(`${key}.table.none`) : person.otherCompanies.join(', '),
            },
          ]}
        />

        <details className="text-fg-secondary text-xs">
          <summary className="cursor-pointer">{t(`${key}.panel.diagnostics`)}</summary>
          <p className="mt-100">{t(`${key}.panel.principal`)}</p>
          <code className="break-all">{person.principalId}</code>
        </details>
        {person.editable ? (
          <>
            <section className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
              <h3 className="font-semibold text-sm">{t(`${key}.panel.roleSection`)}</h3>
              {person.otherCompanies.length > 0 && (
                <p className="text-fg-secondary text-xs">{t(`${key}.panel.sharedHint`)}</p>
              )}
              <SelectTemplate
                id="people-person-role"
                items={roles.map((role) => ({ displayValue: role.label, label: role.label, value: role.key }))}
                label={t(`${key}.panel.role`)}
                labelProps={selectLabelProps}
                name="personRole"
                onValueChange={(details) => setRoleKey(details.value[0] ?? null)}
                placeholder={t('workforce.selectPlaceholder')}
                value={roleKey === null ? [] : [roleKey]}
              />
              {roleKey !== null && (
                <p className="text-fg-secondary text-sm">
                  {roles.find((role) => role.key === roleKey)?.description}
                  {isCrmSalesRole(roleKey) && <> {t(`${key}.crm.roleHint`)}</>}
                </p>
              )}
              <div>
                <Button
                  disabled={busy !== null || roleKey === person.roleKey}
                  isLoading={busy === 'role'}
                  loadingText={t(`${key}.form.saving`)}
                  onClick={changeRole}
                  size="sm"
                  variant="primary"
                >
                  {t(`${key}.panel.changeRole`)}
                </Button>
              </div>
            </section>

            <section className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
              <h3 className="font-semibold text-sm">{t(`${key}.panel.statusSection`)}</h3>
              <p className="text-fg-secondary text-xs">
                {t(active ? `${key}.panel.disableHint` : `${key}.panel.enableHint`)}
              </p>
              {active && (
                <FormTextarea
                  id="people-reason"
                  label={t(`${key}.panel.reason`)}
                  name="reason"
                  onChange={(event) => {
                    setReasonMissing(false);
                    setReason(event.target.value);
                  }}
                  rows={2}
                  value={reason}
                  {...(reasonMissing
                    ? { helpText: t(`${key}.panel.reasonRequired`), validateStatus: 'error' as const }
                    : {})}
                />
              )}
              <div>
                <Button
                  disabled={busy !== null}
                  icon={active ? 'icon-[mdi--account-cancel-outline]' : 'icon-[mdi--account-check-outline]'}
                  isLoading={busy === 'status'}
                  loadingText={t(`${key}.form.saving`)}
                  onClick={changeStatus}
                  size="sm"
                  theme={active ? 'solid' : 'outlined'}
                  variant={active ? 'danger' : 'primary'}
                >
                  {t(active ? `${key}.panel.disable` : `${key}.panel.enable`)}
                </Button>
              </div>
            </section>
          </>
        ) : (
          <StatusText showIcon status="default">
            {t(`${key}.panel.selfHint`)}
          </StatusText>
        )}

        <section className="flex flex-col gap-100">
          <h3 className="font-semibold text-sm">{t(`${key}.panel.history`)}</h3>
          {history.length === 0 ? (
            <p className="text-fg-secondary text-sm">{t(`${key}.panel.historyEmpty`)}</p>
          ) : (
            <AuditList entries={history} />
          )}
        </section>
      </div>
    </SidePanel>
  );
};

const RolesCard = ({ data }: { readonly data: PeopleOverview }) => {
  const { t } = useModernI18n();
  return (
    <SectionCard title={t(`${key}.roles.title`)}>
      <p className="text-fg-secondary text-xs">{t(`${key}.roles.hint`)}</p>
      <ul className="grid grid-cols-1 gap-150 md:grid-cols-2">
        {data.roles.map((role) => {
          const count = data.accounts.filter((person) => person.roleKey === role.key).length;
          return (
            <li className={`${surfaceTileClassName} flex flex-col gap-50 p-150`} key={role.key}>
              <span className="flex flex-wrap items-center gap-100">
                <span className="font-medium text-sm">{role.label}</span>
                {role.administrator && (
                  <Badge size="sm" variant="info">
                    {t(`${key}.roles.admin`)}
                  </Badge>
                )}
                <span className="ml-auto text-fg-secondary text-xs tabular-nums">
                  {t(`${key}.roles.people`, { count })}
                </span>
              </span>
              <span className="text-fg-secondary text-xs">{role.description}</span>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
};

const usePersonSelection = () => {
  const linkedPerson = useRouterState({
    select: (routerState) =>
      Option.getOrUndefined(Schema.decodeOption(PersonDetailSearchSchema)(routerState.location.search))?.person ?? null,
  });
  const [selection, setSelection] = useState({ linkedPerson, openId: linkedPerson });
  // A new activity link replaces the selection; closing the panel does not reopen the same link on refresh.
  if (selection.linkedPerson !== linkedPerson) {
    setSelection({ linkedPerson, openId: linkedPerson });
  }
  return {
    openId: selection.openId,
    selectPerson: (openId: string | null) => setSelection({ linkedPerson, openId }),
  };
};

const PeoplePageContent = ({ legalEntityId }: { readonly legalEntityId: string }) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const snapshot = usePageData(peopleData, legalEntityId);
  const state = loadStateOf(snapshot);
  const [creating, setCreating] = useState(false);
  const { openId, selectPerson } = usePersonSelection();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [allAudit, setAllAudit] = useState(false);

  /** Re-reads the overview while the current one stays on screen. */
  const reload = () => {
    void browserRuntime.runPromise(peopleData.refresh(legalEntityId));
  };
  const reloading = snapshot.state !== 'pending' && snapshot.refreshing;

  const data = state.status === 'ready' ? state.data : undefined;
  const identityLabels: Readonly<Record<string, string>> = {
    Management: t(`${key}.identities.management`),
    Operations: t(`${key}.identities.operations`),
    Finance: t(`${key}.identities.finance`),
    'External Agent': t(`${key}.identities.external`),
  };
  const people = (data?.accounts ?? []).map((person) => ({
    ...person,
    displayName:
      person.email?.endsWith('@siampark.demo') === true
        ? (identityLabels[person.displayName] ?? person.displayName)
        : person.displayName,
  }));
  // Agent section and both histories use the same person labels as the table.
  const labelByName = new Map(
    (data?.accounts ?? []).map((account, index) => [
      account.displayName,
      people[index]?.displayName ?? account.displayName,
    ]),
  );
  const personLabel = (name: string) => labelByName.get(name) ?? name;
  const audit = (data?.audit ?? []).map((entry) => ({
    ...entry,
    actorName: entry.actorName === null ? null : personLabel(entry.actorName),
    targetName: entry.targetName === null ? null : personLabel(entry.targetName),
  }));
  const opened = people.find((person) => person.principalId === openId);
  const crmToast = (crm: CommandResult['crm']) => {
    if (crm === undefined || crm.sync.kind === 'unchanged') {
      return;
    }
    if (crm.sync.kind === 'failed') {
      toaster.create({
        description: crm.sync.reason ?? t(`${key}.crm.failedHint`),
        title: t(crm.register ? `${key}.crm.registerFailed` : `${key}.crm.retireFailed`),
        type: 'warning',
      });
      return;
    }
    toaster.create({
      description: t(`${key}.crm.${crm.sync.kind}Hint`),
      title: t(`${key}.crm.${crm.sync.kind}`, { name: crm.sync.name }),
      type: 'success',
    });
  };
  const grantsToast = (result: ManageResult) =>
    result.operation === 'change-status'
      ? undefined
      : t(`${key}.toast.grants`, { granted: result.grantsCopied, revoked: result.grantsRevoked });

  const translations: DataTableTranslations = {
    ...dataTableRowLabels,
    loadingLabel: t(`${key}.table.loading`),
  };

  if (state.status === 'failed') {
    const reason = state.reason === 'forbidden' || state.reason === 'signedOut' ? state.reason : 'error';
    return (
      <>
        <UltramodernRouteHead />
        <div className="flex min-w-0 flex-col gap-250">
          <PageHeader title={t(`${key}.title`)} />
          <EmptyState
            action={
              reason === 'error' ? (
                <Button disabled={reloading} onClick={reload} size="sm" theme="outlined" variant="secondary">
                  {t(`${key}.error.retry`)}
                </Button>
              ) : undefined
            }
            description={t(`${key}.${reason}.description`)}
            title={t(`${key}.${reason}.title`)}
          />
        </div>
      </>
    );
  }

  const activeCount = people.filter((person) => person.status === 'active').length;
  const adminKeys = new Set(data?.roles.filter((role) => role.administrator).map((role) => role.key));
  const adminCount = people.filter(
    (person) => person.status === 'active' && person.roleKey !== null && adminKeys.has(person.roleKey),
  ).length;
  const format = (value: number) => (data === undefined ? '—' : formatNumber(value));

  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <div className="flex min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            <>
              <Button
                disabled={reloading}
                icon="icon-[mdi--refresh]"
                onClick={reload}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${key}.reload`)}
              </Button>
              <Button
                disabled={data === undefined}
                icon="icon-[mdi--account-plus-outline]"
                onClick={() => setCreating(true)}
                size="sm"
                variant="primary"
              >
                {t(`${key}.create`)}
              </Button>
            </>
          }
          description={t(`${key}.description`, { company: data?.company.legalName ?? '…' })}
          meta={
            data === undefined ? undefined : (
              <Badge size="sm" variant="outline">
                {data.company.legalName}
              </Badge>
            )
          }
          title={t(`${key}.title`)}
        />

        <StatRow>
          <StatCard label={t(`${key}.stats.active`)} value={format(activeCount)} />
          <StatCard label={t(`${key}.stats.disabled`)} value={format(people.length - activeCount)} />
          <StatCard hint={t(`${key}.stats.adminsHint`)} label={t(`${key}.stats.admins`)} value={format(adminCount)} />
          <StatCard
            hint={t(`${key}.stats.changesHint`)}
            label={t(`${key}.stats.changes`)}
            value={format(data?.audit.length ?? 0)}
          />
        </StatRow>

        <div className="workforce-people-filters">
          <FormInput
            id="people-search"
            size="sm"
            label={t(`${key}.search`)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SelectTemplate
            size="sm"
            labelProps={selectLabelProps}
            label={t(`${key}.table.status`)}
            value={[statusFilter]}
            onValueChange={({ value }) => setStatusFilter(value[0] ?? 'active')}
            items={['active', 'disabled', 'all'].map((value) => ({
              value,
              label: t(`${key}.filters.${value}`),
              displayValue: t(`${key}.filters.${value}`),
            }))}
          />
        </div>
        <DataTable
          columns={columnsOf(t)}
          data={people.filter(
            (person) =>
              (statusFilter === 'all' || person.status === statusFilter) &&
              foldSearchText(`${person.displayName} ${person.email ?? ''}`).includes(foldSearchText(search.trim())),
          )}
          enableSorting
          getRowId={(row) => row.principalId}
          getRowLabel={(row) => row.original.displayName}
          loading={state.status === 'loading'}
          loadingRowCount={6}
          onRowClick={(row: { readonly original: Person }) => selectPerson(row.original.principalId)}
          paginationProps={{ translations: paginationTranslations }}
          size="sm"
          tableLayout="fixed"
          translations={translations}
        />

        {data !== undefined && (
          <div className="grid grid-cols-1 gap-250 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <SectionCard title={t(`${key}.audit.title`)}>
              <p className="text-fg-secondary text-xs">{t(`${key}.audit.source`)}</p>
              <AuditList entries={allAudit ? audit : audit.slice(0, 8)} />
              {data.audit.length > 8 && (
                <Button size="sm" theme="outlined" variant="secondary" onClick={() => setAllAudit((value) => !value)}>
                  {t(allAudit ? `${key}.audit.less` : `${key}.audit.more`, { count: data.audit.length })}
                </Button>
              )}
            </SectionCard>
            <RolesCard data={data} />
          </div>
        )}

        {data !== undefined && (
          <AgentEntitiesSection
            legalEntityId={legalEntityId}
            onNotify={(title, description) => toaster.create({ description, title, type: 'success' })}
            personLabel={personLabel}
          />
        )}
      </div>

      {creating && data !== undefined && (
        <CreateAccountPanel
          onClose={() => setCreating(false)}
          onCreated={(name, result, crm) => {
            setCreating(false);
            toaster.create({
              description: grantsToast(result),
              title: t(`${key}.toast.created`, { name }),
              type: 'success',
            });
            crmToast(crm);
            reload();
          }}
          roles={data.roles}
        />
      )}
      {opened !== undefined && data !== undefined && (
        <PersonPanel
          audit={audit}
          key={`${opened.principalId}:${opened.status}:${opened.roleKey ?? ''}`}
          onChanged={(message, result, crm) => {
            toaster.create({ description: grantsToast(result), title: message, type: 'success' });
            crmToast(crm);
            reload();
          }}
          onClose={() => selectPerson(null)}
          person={opened}
          roles={data.roles}
        />
      )}
    </>
  );
};

/** Rendered by the Shell with the props its `preloadPage` received; the standalone app passes none. */
const PeoplePage = (props: Partial<ModulePageProps>) => {
  const location = useRouterState({ select: (routerState) => routerState.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="workforce"
      fallbackLanguage="en"
      resources={workforceI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <PeoplePageContent key={location} legalEntityId={legalEntityOf(props)} />
    </FederatedI18nBoundary>
  );
};

/** `vertical.manifest.ts` imports this page under its registered name. */
export { PeoplePage };

export default PeoplePage;
