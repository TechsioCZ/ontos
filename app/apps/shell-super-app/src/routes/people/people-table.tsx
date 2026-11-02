import { EmptyState, paginationTranslations } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

import type { PeopleRoleCatalog, Person } from '../../../shared/people-api.ts';
import {
  allPeopleFilters,
  filterPeople,
  PeopleStatusFilterSchema,
  PersonKindKeySchema,
  personKindLabel,
  personKindOptions,
  PersonStatusKeySchema,
  personStatusKey,
  personStatusPresentation,
  roleNames,
} from './people-model.ts';
import type {
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

export const RoleChips = ({ names }: { readonly names: readonly string[] }) => {
  if (names.length === 0) {
    return <span className="text-fg-secondary">—</span>;
  }
  const shown = names.slice(0, VISIBLE_ROLE_CHIPS);
  const rest = names.slice(VISIBLE_ROLE_CHIPS);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-50">
      {shown.map((name) => (
        <Badge key={name} size="sm" variant="outline">
          {name}
        </Badge>
      ))}
      {rest.length === 0 ? null : (
        <Tooltip content={rest.join(', ')}>
          <span className="inline-flex">
            <span aria-hidden="true">
              <Badge size="sm" variant="outline">{`+${rest.length}`}</Badge>
            </span>
            <span className="sr-only">{`a další role: ${rest.join(', ')}`}</span>
          </span>
        </Tooltip>
      )}
    </span>
  );
};

const invitationNotes = {
  pending: 'Pozvánka čeká na odeslání',
  sent: 'Pozvánka odeslána',
  undeliverable: 'Pozvánku nelze doručit',
  unknown: 'Doručení pozvánky nelze ověřit',
} as const;

const invitationNote = (person: Person): string | undefined => {
  const delivery = person.invitationDelivery;
  if (delivery === null || person.selectedCompanyMembership?.status !== 'invited') {
    return undefined;
  }
  return invitationNotes[delivery.status];
};

const PersonName = ({ person, secondary }: { readonly person: Person; readonly secondary: string | undefined }) => (
  <span className="grid min-w-0">
    <span className="truncate font-medium">{person.displayName}</span>
    {secondary === undefined ? null : <span className="truncate text-fg-secondary text-xs">{secondary}</span>}
  </span>
);

const actionItems = (scope: PeopleAdminScope): MenuItem[] => [
  ...(scope === 'company' ? [{ label: 'Upravit členství', type: 'action', value: 'membership' } as const] : []),
  { label: 'Spravovat role', type: 'action', value: 'role' },
];

export const PersonActionsMenu = ({
  onEdit,
  person,
  scope,
}: {
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly person: Person;
  readonly scope: PeopleAdminScope;
}) => (
  // The menu lives inside a clickable row; its clicks must never also open the detail.
  // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Only stops propagation; the Menu trigger is the keyboard target.
  <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
    <Menu
      aria-label={`Akce: ${person.displayName}`}
      customTrigger={
        <Button
          aria-label={`Akce: ${person.displayName}`}
          icon="icon-[mdi--dots-horizontal]"
          size="sm"
          theme="borderless"
          variant="secondary"
        />
      }
      items={actionItems(scope)}
      onSelect={({ value }) => {
        if (value === 'membership' || value === 'role') {
          onEdit(value, person);
        }
      }}
      size="sm"
    />
  </span>
);

const statusOptions = [
  { label: 'Aktuální členové', value: 'current' },
  { label: 'Všechny stavy', value: 'all' },
  ...PersonStatusKeySchema.literals.map((value) => ({ label: personStatusPresentation[value].label, value })),
] as const;
const isStatusFilter = Schema.is(PeopleStatusFilterSchema);
const isKindKey = Schema.is(PersonKindKeySchema);

const option = (value: string, label: string) => ({ displayValue: label, label, value });

const FilterSelect = ({
  items,
  label,
  name,
  onChange,
  value,
}: {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => (
  <div className="min-w-36 flex-1 sm:w-40 sm:flex-none">
    <SelectTemplate
      items={items.map((item) => option(item.value, item.label))}
      label={label}
      name={name}
      onValueChange={(details) => {
        const [next] = details.value;
        if (next !== undefined) {
          onChange(next);
        }
      }}
      size="sm"
      value={[value]}
    />
  </div>
);

export const PeopleToolbar = ({
  actions,
  catalog,
  companyAvailable,
  filters,
  onFiltersChange,
  onScopeChange,
  scope,
}: {
  readonly actions: ReactNode;
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly companyAvailable: boolean;
  readonly filters: PeopleFilters;
  readonly onFiltersChange: (filters: PeopleFilters) => void;
  readonly onScopeChange: (scope: PeopleAdminScope) => void;
  readonly scope: PeopleAdminScope;
}) => {
  const roles = [
    { label: 'Všechny role', value: 'all' },
    ...(catalog?.items ?? []).map((role) => ({ label: role.name, value: role.roleKey })),
  ];
  return (
    <div className="flex flex-wrap items-end gap-150">
      <Input
        aria-label="Hledat podle jména, typu nebo role"
        className="w-full sm:w-56"
        onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
        placeholder="Hledat jméno, typ nebo roli"
        size="sm"
        type="search"
        value={filters.query}
      />
      <FilterSelect
        items={[{ label: 'Všechny typy', value: 'all' }, ...personKindOptions]}
        label="Typ"
        name="people-kind"
        onChange={(kind) => onFiltersChange({ ...filters, kind: isKindKey(kind) ? kind : 'all' })}
        value={filters.kind}
      />
      <FilterSelect
        items={roles}
        label="Role"
        name="people-role"
        onChange={(roleKey) => onFiltersChange({ ...filters, roleKey })}
        value={filters.roleKey}
      />
      <FilterSelect
        items={statusOptions}
        label="Stav"
        name="people-status"
        onChange={(status) => onFiltersChange({ ...filters, status: isStatusFilter(status) ? status : 'current' })}
        value={filters.status}
      />
      {companyAvailable ? (
        <FilterSelect
          items={[
            { label: 'Vybraná firma', value: 'company' },
            { label: 'Celá organizace', value: 'tenant' },
          ]}
          label="Rozsah správy"
          name="people-scope"
          onChange={(next) => onScopeChange(next === 'tenant' ? 'tenant' : 'company')}
          value={scope}
        />
      ) : null}
      <Tooltip content="Každý člověk i agent má vlastní přihlášení. Role určují, co může ve firmě dělat. Pracovní zařazení samo o sobě přístup nepřiděluje.">
        <Button
          aria-label="Jak fungují role"
          icon="icon-[mdi--information-outline]"
          size="sm"
          theme="borderless"
          variant="secondary"
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

const tableTranslations: DataTableTranslations = {
  actionsLabel: 'Akce',
  emptyTitle: 'Nikdo neodpovídá filtrům.',
  loadingLabel: 'Načítám lidi a role…',
  pageSizeLabel: 'Na stránku',
  rangeLabel: ({ end, start, total }) => `${start}–${end} z ${total}`,
};

const peopleColumns = (catalog: PeopleRoleCatalog | undefined): ColumnDef<Person>[] => [
  {
    accessorKey: 'displayName',
    cell: (info) => <PersonName person={info.row.original} secondary={invitationNote(info.row.original)} />,
    header: 'Jméno',
    meta: { width: 260 },
  },
  {
    accessorFn: personKindLabel,
    header: 'Typ',
    id: 'kind',
    meta: { width: 140 },
  },
  {
    accessorFn: (person) => roleNames(catalog, person).join(', '),
    cell: (info) => <RoleChips names={roleNames(catalog, info.row.original)} />,
    header: 'Role',
    id: 'roles',
    meta: { width: 320 },
  },
  {
    accessorFn: (person) => personStatusPresentation[personStatusKey(person)].rank,
    cell: (info) => <PersonStatusDot status={personStatusKey(info.row.original)} />,
    header: 'Stav',
    id: 'status',
    meta: { width: 140 },
  },
];

const CompactPeopleList = ({
  catalog,
  onEdit,
  onOpen,
  people,
  scope,
}: {
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly onOpen: (person: Person) => void;
  readonly people: readonly Person[];
  readonly scope: PeopleAdminScope;
}) => (
  <ul aria-label="Lidé a role" className="grid divide-y divide-border-primary border-border-primary border-y">
    {people.map((person) => (
      <li className="flex items-start gap-100 py-100" key={person.principalRef.principalId}>
        <Button
          className="flex min-w-0 flex-1 flex-col items-start justify-start gap-50 text-start"
          onClick={() => onOpen(person)}
          size="current"
          theme="unstyled"
          variant="secondary"
        >
          <PersonName person={person} secondary={personKindLabel(person)} />
          <span className="flex flex-wrap items-center gap-100 text-sm">
            <PersonStatusDot status={personStatusKey(person)} />
            <RoleChips names={roleNames(catalog, person)} />
          </span>
        </Button>
        <PersonActionsMenu onEdit={onEdit} person={person} scope={scope} />
      </li>
    ))}
  </ul>
);

export const PeopleTable = ({
  catalog,
  filters,
  loading,
  onEdit,
  onFiltersChange,
  onOpen,
  people,
  scope,
}: {
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly filters: PeopleFilters;
  readonly loading: boolean;
  readonly onEdit: (kind: PeopleEditKind, person: Person) => void;
  readonly onFiltersChange: (filters: PeopleFilters) => void;
  readonly onOpen: (person: Person) => void;
  readonly people: readonly Person[];
  readonly scope: PeopleAdminScope;
}) => {
  const wide = useWideLayout();
  const visible = filterPeople(people, filters, catalog);
  const empty = () =>
    people.length > 0 ? (
      <EmptyState
        action={
          <Button onClick={() => onFiltersChange(allPeopleFilters)} size="sm" theme="outlined" variant="secondary">
            Zrušit filtry
          </Button>
        }
        title="Filtrům nikdo neodpovídá."
      />
    ) : (
      <EmptyState title="V tomto rozsahu nejsou žádná evidovaná členství." />
    );
  if (!wide) {
    return visible.length === 0 && !loading ? (
      empty()
    ) : (
      <CompactPeopleList catalog={catalog} onEdit={onEdit} onOpen={onOpen} people={visible} scope={scope} />
    );
  }
  return (
    <DataTable
      columns={peopleColumns(catalog)}
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
      translations={tableTranslations}
    />
  );
};
