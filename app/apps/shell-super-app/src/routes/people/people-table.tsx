import { EmptyState, paginationTranslations } from '@app/admin-ui';
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
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

import type { Person } from '../../../shared/people-api.ts';
import { browserAtomRuntime } from '../../runtime/browser-effect-runtime.ts';
import {
  accessRoleNamesOf,
  allPeopleFilters,
  defaultPeopleFilters,
  filterPeople,
  PeopleStatusFilterSchema,
  PersonKindKeySchema,
  personKindLabel,
  personKindOptions,
  PersonStatusKeySchema,
  personStatusKey,
  personStatusPresentation,
} from './people-model.ts';
import type {
  PeopleAccessView,
  PeopleAdminScope,
  PeopleEditKind,
  PeopleFilters,
  PersonStatusKey,
  PersonStatusTone,
} from './people-model.ts';

const dotTone = {
  danger: 'bg-danger',
  neutral: 'bg-fg-secondary',
  success: 'bg-success',
  warning: 'bg-warning',
} as const satisfies Record<PersonStatusTone, string>;

/** The dot is decorative; the visible label carries the status, so colour is never the only signal. */
export const PersonStatusDot = ({ status }: { readonly status: PersonStatusKey }) => {
  const { label, tone } = personStatusPresentation[status];
  return (
    <span className="inline-flex items-center gap-100 whitespace-nowrap" data-status={status}>
      <span aria-hidden="true" className={`size-[0.5rem] shrink-0 rounded-full ${dotTone[tone]}`} data-tone={tone} />
      <span>{label}</span>
    </span>
  );
};

const VISIBLE_ROLE_CHIPS = 2;
type PeopleTranslator = ReturnType<typeof useModernI18n>['t'];

export const RoleChips = ({ names }: { readonly names: readonly string[] }) => {
  const { t } = useModernI18n();
  if (names.length === 0) {
    return <span className="text-fg-secondary">—</span>;
  }
  const shown = names.slice(0, VISIBLE_ROLE_CHIPS);
  const rest = names.slice(VISIBLE_ROLE_CHIPS);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-50">
      {shown.map((name) => (
        <Badge appearance="outline" key={name} severity="neutral" size="sm">
          {name}
        </Badge>
      ))}
      {rest.length === 0 ? null : (
        <Tooltip content={rest.join(', ')}>
          <span className="inline-flex">
            <span aria-hidden="true">
              <Badge appearance="outline" severity="neutral" size="sm">{`+${rest.length}`}</Badge>
            </span>
            <span className="sr-only">{t('shell.people.table.moreRoles', { roles: rest.join(', ') })}</span>
          </span>
        </Tooltip>
      )}
    </span>
  );
};

const invitationNotes = {
  pending: 'shell.people.table.invitation.pending',
  sent: 'shell.people.table.invitation.sent',
  undeliverable: 'shell.people.table.invitation.undeliverable',
  unknown: 'shell.people.table.invitation.unknown',
} as const;

const invitationNote = (person: Person, t: PeopleTranslator): string | undefined => {
  const delivery = person.invitationDelivery;
  if (delivery === null || person.selectedCompanyMembership?.status !== 'invited') {
    return undefined;
  }
  return t(invitationNotes[delivery.status]);
};

const PersonName = ({ person, secondary }: { readonly person: Person; readonly secondary: string | undefined }) => (
  <span className="grid min-w-0">
    <span className="truncate font-medium">{person.displayName}</span>
    {secondary === undefined ? null : <span className="truncate text-fg-secondary text-xs">{secondary}</span>}
  </span>
);

const actionItems = (scope: PeopleAdminScope, t: PeopleTranslator): MenuItem[] => [
  ...(scope === 'company'
    ? [{ label: t('shell.people.table.editMembership'), type: 'action', value: 'membership' } as const]
    : []),
  { label: t('shell.people.table.manageRoles'), type: 'action', value: 'role' },
];

export const PersonActionsMenu = ({
  onEdit,
  person,
  scope,
}: {
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly person: Person;
  readonly scope: PeopleAdminScope;
}) => {
  const { t } = useModernI18n();
  const actionsLabel = t('shell.people.table.personActions', { name: person.displayName });
  return (
    // The menu lives inside a clickable row; its clicks must never also open the detail. The wrapper only stops
    // propagation (see the oxlint.config.ts exemption); the Menu's Button trigger is the keyboard target.
    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <Menu
        aria-label={actionsLabel}
        customTrigger={
          <Button
            appearance="ghost"
            aria-label={actionsLabel}
            icon="icon-[mdi--dots-horizontal]"
            severity="secondary"
            size="sm"
          />
        }
        items={actionItems(scope, t)}
        onSelect={({ value }) => {
          if (value === 'membership' || value === 'role') {
            onEdit(value, person);
          }
        }}
        size="sm"
      />
    </span>
  );
};

const statusOptions = (t: PeopleTranslator) => [
  { label: t('shell.people.table.currentStatus'), value: 'current' },
  { label: t('shell.people.table.allStatuses'), value: 'all' },
  ...PersonStatusKeySchema.literals.map((value) => ({ label: personStatusPresentation[value].label, value })),
];
const isStatusFilter = Schema.is(PeopleStatusFilterSchema);
const isKindKey = Schema.is(PersonKindKeySchema);

/** The filters of the people list: they narrow what the table shows and are never submitted. */
const peopleFilterForm = FormReact.make(
  FormBuilder.empty
    .addField('kind', Schema.String)
    .addField('query', Schema.String)
    .addField('roleId', Schema.String)
    .addField('status', Schema.String),
  {
    fields: { kind: ChoiceField, query: TextField, roleId: ChoiceField, status: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The filters as the table applies them; the defaults until the toolbar is on screen. */
const peopleFilters = peopleFilterForm.values.pipe(
  Atom.map(
    Option.match({
      onNone: () => defaultPeopleFilters,
      onSome: ({ kind, query, roleId, status }): PeopleFilters => ({
        kind: isKindKey(kind) ? kind : 'all',
        query,
        roleId,
        status: isStatusFilter(status) ? status : 'current',
      }),
    }),
  ),
);
const roleFilter = peopleFilterForm.getFieldAtoms(peopleFilterForm.fields.roleId);

/** Company or whole organisation: picking one switches the list at once. */
const peopleScopeForm = FormReact.make(FormBuilder.empty.addField('scope', Schema.String), {
  fields: { scope: ChoiceField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) =>
    Effect.succeed<PeopleAdminScope>(decoded.scope === 'tenant' ? 'tenant' : 'company'),
  runtime: browserAtomRuntime,
});

const FilterSlot = ({ children }: { readonly children: ReactNode }) => (
  <div className="min-w-36 flex-1 sm:w-40 sm:flex-none">{children}</div>
);

const ScopeFilter = ({
  onScopeChange,
  scope,
}: {
  readonly onScopeChange: (scope: PeopleAdminScope) => void;
  readonly scope: PeopleAdminScope;
}) => {
  const { t } = useModernI18n();
  const setRoleFilter = useAtomSet(roleFilter.setValue);
  useAtomSubscribe(peopleScopeForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting && result.value !== scope) {
      // Roles belong to a scope: another scope starts from all of its roles.
      setRoleFilter('all');
      onScopeChange(result.value);
    }
  });
  return (
    <FormRoot
      className="contents"
      defaultValues={{ scope }}
      form={peopleScopeForm}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      <FilterSlot>
        <peopleScopeForm.scope
          items={[
            { label: t('shell.people.table.companyScope'), value: 'company' },
            { label: t('shell.people.table.tenantScope'), value: 'tenant' },
          ]}
          label={t('shell.people.table.scope')}
        />
      </FilterSlot>
    </FormRoot>
  );
};

export const PeopleToolbar = ({
  access,
  actions,
  companyAvailable,
  onScopeChange,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly actions: ReactNode;
  readonly companyAvailable: boolean;
  readonly onScopeChange: (scope: PeopleAdminScope) => void;
  readonly scope: PeopleAdminScope;
}) => {
  const { t } = useModernI18n();
  const roles = [
    { label: t('shell.people.table.allRoles'), value: 'all' },
    ...(access?.options.roles ?? []).map((role) => ({ label: role.name, value: role.roleId })),
  ];
  return (
    <div className="flex flex-wrap items-end gap-150">
      <FormRoot
        className="contents"
        defaultValues={defaultPeopleFilters}
        form={peopleFilterForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        <div className="w-full sm:w-56">
          <peopleFilterForm.query
            label={<span className="sr-only">{t('shell.people.table.searchLabel')}</span>}
            placeholder={t('shell.people.table.searchPlaceholder')}
            size="sm"
            type="search"
          />
        </div>
        <FilterSlot>
          <peopleFilterForm.kind
            items={[{ label: t('shell.people.table.allKinds'), value: 'all' }, ...personKindOptions]}
            label={t('shell.people.table.kind')}
          />
        </FilterSlot>
        <FilterSlot>
          <peopleFilterForm.roleId items={roles} label={t('shell.people.table.roles')} />
        </FilterSlot>
        <FilterSlot>
          <peopleFilterForm.status items={statusOptions(t)} label={t('shell.people.table.status')} />
        </FilterSlot>
      </FormRoot>
      {companyAvailable ? <ScopeFilter onScopeChange={onScopeChange} scope={scope} /> : null}
      <Tooltip content={t('shell.people.table.rolesHelp')}>
        <Button
          appearance="ghost"
          aria-label={t('shell.people.table.rolesHelpLabel')}
          icon="icon-[mdi--information-outline]"
          severity="secondary"
          size="sm"
        />
      </Tooltip>
      {actions}
    </div>
  );
};

const wideQuery = '(min-width: 48rem)';
const subscribeWide = (onChange: () => void) => {
  const media = globalThis.matchMedia?.(wideQuery);
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
};
const isWide = () => globalThis.matchMedia?.(wideQuery).matches ?? true;
const useWideLayout = () => useSyncExternalStore(subscribeWide, isWide, () => true);

const tableTranslations = (t: PeopleTranslator): DataTableTranslations => ({
  actionsLabel: t('shell.people.table.actions'),
  emptyTitle: t('shell.people.table.empty'),
  loadingLabel: t('shell.people.table.loading'),
  pageSizeLabel: t('shell.people.table.pageSize'),
  rangeLabel: ({ end, start, total }) => t('shell.people.table.range', { end, start, total }),
});

const peopleColumns = (access: PeopleAccessView | undefined, t: PeopleTranslator): ColumnDef<Person>[] => [
  {
    accessorKey: 'displayName',
    cell: (info) => <PersonName person={info.row.original} secondary={invitationNote(info.row.original, t)} />,
    header: t('shell.people.table.name'),
    meta: { width: 260 },
  },
  {
    accessorFn: personKindLabel,
    header: t('shell.people.table.kind'),
    id: 'kind',
    meta: { width: 140 },
  },
  {
    accessorFn: (person) => accessRoleNamesOf(access, person.principalRef.principalId).join(', '),
    cell: (info) => <RoleChips names={accessRoleNamesOf(access, info.row.original.principalRef.principalId)} />,
    header: t('shell.people.table.roles'),
    id: 'roles',
    meta: { width: 320 },
  },
  {
    accessorFn: (person) => personStatusPresentation[personStatusKey(person)].rank,
    cell: (info) => <PersonStatusDot status={personStatusKey(info.row.original)} />,
    header: t('shell.people.table.status'),
    id: 'status',
    meta: { width: 140 },
  },
];

const CompactPeopleList = ({
  access,
  onEdit,
  onOpen,
  people,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly onOpen: (person: Person) => void;
  readonly people: readonly Person[];
  readonly scope: PeopleAdminScope;
}) => {
  const { t } = useModernI18n();
  return (
    <ul
      aria-label={t('shell.people.title')}
      className="grid divide-y divide-border-primary border-border-primary border-y"
    >
      {people.map((person) => (
        <li className="flex items-start gap-100 py-100" key={person.principalRef.principalId}>
          <Button
            className="flex min-w-0 flex-1 flex-col items-start justify-start gap-50 text-start"
            onClick={() => onOpen(person)}
            severity="secondary"
            size="current"
            unstyled
          >
            <PersonName person={person} secondary={personKindLabel(person)} />
            <span className="flex flex-wrap items-center gap-100 text-sm">
              <PersonStatusDot status={personStatusKey(person)} />
              <RoleChips names={accessRoleNamesOf(access, person.principalRef.principalId)} />
            </span>
          </Button>
          <PersonActionsMenu onEdit={onEdit} person={person} scope={scope} />
        </li>
      ))}
    </ul>
  );
};

export const PeopleTable = ({
  access,
  loading,
  onEdit,
  onOpen,
  people,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly loading: boolean;
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly onOpen: (person: Person) => void;
  readonly people: readonly Person[];
  readonly scope: PeopleAdminScope;
}) => {
  const { t } = useModernI18n();
  const translations = tableTranslations(t);
  const wide = useWideLayout();
  const filters = useAtomValue(peopleFilters);
  const setFilters = useAtomSet(peopleFilterForm.setValues);
  const visible = filterPeople(people, filters, access);
  const empty = () =>
    people.length > 0 ? (
      <EmptyState
        action={
          <Button appearance="outline" onClick={() => setFilters(allPeopleFilters)} severity="secondary" size="sm">
            {t('shell.people.table.clearFilters')}
          </Button>
        }
        title={t('shell.people.table.noMatches')}
      />
    ) : (
      <EmptyState title={t('shell.people.table.noMemberships')} />
    );
  if (!wide) {
    if (visible.length === 0) {
      // The compact list has no skeleton rows, so a phone would show a blank page until the people arrive.
      return loading ? (
        <output aria-live="polite" className="block py-200 text-fg-secondary text-sm">
          {translations.loadingLabel}
        </output>
      ) : (
        empty()
      );
    }
    return <CompactPeopleList access={access} onEdit={onEdit} onOpen={onOpen} people={visible} scope={scope} />;
  }
  return (
    <DataTable
      columns={peopleColumns(access, t)}
      data={[...visible]}
      enablePagination
      enableSorting
      getRowId={(person) => person.principalRef.principalId}
      getRowLabel={(row) => row.original.displayName}
      interactive
      loading={loading}
      loadingRowCount={8}
      maxHeight="calc(100dvh - 15rem)"
      onRowClick={(row) => onOpen(row.original)}
      pageSizeOptions={[50, 100, 200]}
      paginationProps={{ translations: paginationTranslations }}
      renderEmpty={empty}
      renderRowActions={(row) => <PersonActionsMenu onEdit={onEdit} person={row.original} scope={scope} />}
      size="sm"
      stickyHeader
      tableLayout="fixed"
      translations={translations}
    />
  );
};
