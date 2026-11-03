import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { czechPlural } from '@app/shared-contracts';
import { AutosaveStatus, useAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect, Fiber, Match, Option, Schema } from 'effect';
import type { HttpClient } from 'effect/http';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { PeopleList, PeopleRoleCatalog, Person } from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import type { PeopleOutcome } from './people-client.ts';
import { changeCompanyMembership, changeScopedRole, loadAllPeople, loadRoleCatalog } from './people-client.ts';
import {
  defaultPeopleFilters,
  isChangeConfirmed,
  membershipLabels,
  personKindLabel,
  personStatusKey,
  roleName,
} from './people-model.ts';
import { InvitePersonButton } from './invite-person-button.tsx';
import type { PeopleEditKind, PeopleFilters, PendingPeopleChange } from './people-model.ts';
import { PeopleTable, PeopleToolbar, PersonStatusDot } from './people-table.tsx';
import { baseOf, membershipDraftOf, membershipEditOf, sameMembershipDraft } from './people-membership-draft.ts';
import type { MembershipBase, MembershipDraft } from './people-membership-draft.ts';

interface Editor {
  readonly kind: PeopleEditKind;
  readonly person: Person;
}
const selectClass = 'w-full rounded-md border border-border-primary bg-base p-100';

const RolePicker = ({
  busy,
  catalog,
  onChange,
  operation,
  person,
  roleKey,
  scope,
}: {
  readonly busy: boolean;
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly onChange: (roleKey: string) => void;
  readonly operation: 'assign' | 'revoke';
  readonly person: Person;
  readonly roleKey: string;
  readonly scope: 'company' | 'tenant';
}) => {
  const selected = catalog?.items.find((role) => role.roleKey === roleKey);
  return (
    <>
      <p className="text-fg-secondary text-sm">
        Role platí pro {scope === 'tenant' ? 'celou organizaci' : 'vybranou firmu'}.
      </p>
      <label className="grid gap-50">
        Role
        <select
          className={selectClass}
          disabled={catalog === undefined || busy}
          onChange={(event) => onChange(event.target.value)}
          required
          value={roleKey}
        >
          <option value="">Vyberte roli</option>
          {catalog?.items.flatMap((role) =>
            operation === 'assign' || person.roleAssignments.some((assigned) => assigned.roleKey === role.roleKey)
              ? [
                  <option key={role.roleKey} value={role.roleKey}>
                    {role.name}
                  </option>,
                ]
              : [],
          )}
        </select>
      </label>
      {catalog === undefined ? (
        <StatusText status="warning">Seznam rolí se zatím nepodařilo načíst. Zkusíme to znovu automaticky.</StatusText>
      ) : null}
      {selected === undefined ? null : <p className="text-fg-secondary text-sm">{selected.description}</p>}
    </>
  );
};

const PeopleEditor = ({
  catalog,
  editor,
  onClose,
  onCommitted,
  scope,
}: {
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly editor: Editor;
  readonly onClose: () => void;
  readonly onCommitted: (change: PendingPeopleChange) => void;
  readonly scope: 'company' | 'tenant';
}) => {
  const { t } = useModernI18n();
  const { person } = editor;
  const membership = person.selectedCompanyMembership;
  const { kind, principalRef } = person;
  const [roleKey, setRoleKey] = useState('');
  const [operation, setOperation] = useState<'assign' | 'revoke'>('assign');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = editor.kind === 'role' ? 'Přiřadit nebo odebrat roli' : 'Členství ve firmě';
  // The company membership of an existing person saves itself: the change is audited, so it is sent only once the
  // reason is filled in, and the revision the server answered with is the one the next change builds on.
  const openedBase: MembershipBase = {
    affiliation: membership?.affiliation ?? null,
    status: membership?.status ?? 'invited',
  };
  const base = useRef<MembershipBase>(openedBase);
  const revision = useRef(membership?.revision ?? 0);
  const [membershipDraft, setMembershipDraft] = useState<MembershipDraft>(() => membershipDraftOf(openedBase));
  const autosave = useAutosave<MembershipDraft, HttpClient.HttpClient>({
    equals: sameMembershipDraft,
    isValid: (value) => Option.isSome(membershipEditOf(value, base.current)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(membershipEditOf(value, base.current), {
        onNone: () => Effect.succeed<AutosaveOutcome>('saved'),
        onSome: (edit) =>
          changeCompanyMembership({
            affiliation: kind === 'agent' ? null : edit.affiliation,
            expectedRevision: revision.current,
            principalRef,
            reason: edit.reason,
            status: edit.status,
          }).pipe(
            Effect.map((outcome): AutosaveOutcome => {
              if (outcome.status === 'failed') {
                setError(outcome.message);
                return 'failed';
              }
              const changed = outcome.value.membership;
              revision.current = changed.revision;
              base.current = { affiliation: changed.affiliation, status: changed.status };
              setError('');
              onCommitted({ kind: 'membership', result: outcome.value });
              return 'saved';
            }),
          ),
      }),
    value: membershipDraft,
  });
  const patchMembership = (patch: Partial<MembershipDraft>) =>
    setMembershipDraft((current) => ({ ...current, ...patch }));
  const close = () => {
    autosave.flush();
    onClose();
  };
  const handleRetry = autosave.retry;
  const handleReloadLatest = () => autosave.adopt(membershipDraftOf(baseOf(person)));
  const requestClose = () => {
    if (editor.kind === 'role') {
      if (!busy) {
        onClose();
      }
      return;
    }
    close();
  };
  const submit = () => {
    if (busy || reason.trim() === '' || roleKey.trim() === '') {
      return;
    }
    setBusy(true);
    setError('');
    void browserRuntime.runPromise(
      changeScopedRole(scope, { operation, principalRef, reason: reason.trim(), roleKey: roleKey.trim() }).pipe(
        Effect.map((outcome): PeopleOutcome<PendingPeopleChange> =>
          outcome.status === 'failed' ? outcome : { status: 'ok', value: { kind: 'role', result: outcome.value } },
        ),
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setError(outcome.message);
            } else {
              onCommitted(outcome.value);
            }
          }),
        ),
      ),
    );
  };
  return (
    <Dialog
      actions={
        editor.kind === 'role' ? (
          <>
            <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button disabled={busy || reason.trim() === '' || roleKey.trim() === ''} onClick={submit} variant="primary">
              {busy ? 'Odesílám…' : 'Potvrdit změnu'}
            </Button>
          </>
        ) : (
          <>
            <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
            <Button onClick={close} theme="outlined" variant="secondary">
              Zavřít
            </Button>
          </>
        )
      }
      closeLabel="Zavřít"
      customTrigger
      onOpenChange={(details) => {
        if (!details.open) {
          requestClose();
        }
      }}
      open
      title={title}
    >
      <div className="grid gap-200">
        <p>{person.displayName}</p>
        {editor.kind === 'role' ? (
          <>
            <RolePicker
              busy={busy}
              catalog={catalog}
              onChange={setRoleKey}
              operation={operation}
              person={person}
              roleKey={roleKey}
              scope={scope}
            />
            <label className="grid gap-50">
              Změna
              <select
                className={selectClass}
                onChange={(event) => {
                  setOperation(event.target.value === 'revoke' ? 'revoke' : 'assign');
                  setRoleKey('');
                }}
                value={operation}
              >
                <option value="assign">Přiřadit</option>
                <option value="revoke">Odebrat</option>
              </select>
            </label>
          </>
        ) : (
          <>
            {kind === 'human' ? (
              <label className="grid gap-50">
                Zařazení ve firmě
                <select
                  className={selectClass}
                  onChange={(event) =>
                    patchMembership({ affiliation: event.target.value === 'employee' ? 'employee' : 'external' })
                  }
                  value={membershipDraft.affiliation}
                >
                  <option value="employee">Zaměstnanec</option>
                  <option value="external">Externí osoba</option>
                </select>
              </label>
            ) : (
              <p>AI agent nemá zaměstnanecké ani externí zařazení.</p>
            )}
            {editor.kind === 'membership' ? (
              <label className="grid gap-50">
                Stav členství
                <select
                  className={selectClass}
                  onChange={(event) => {
                    const { value } = event.target;
                    if (value === 'active' || value === 'disabled' || value === 'departed' || value === 'invited') {
                      patchMembership({ status: value });
                    }
                  }}
                  value={membershipDraft.status}
                >
                  {Object.entries(membershipLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="text-fg-secondary text-sm">
              Zařazení zaměstnance ani pracovní pozice nepřidělují žádná práva. Při odchodu historie zůstává zachována;
              změna přístupu se zpracuje po potvrzení.
            </p>
          </>
        )}
        <FormInput
          label={t('shell.people.changeReason')}
          maxLength={500}
          onChange={(event) =>
            editor.kind === 'role' ? setReason(event.target.value) : patchMembership({ reason: event.target.value })
          }
          required
          value={editor.kind === 'role' ? reason : membershipDraft.reason}
        />
        {error === '' ? null : (
          <StatusText role="alert" status="error">
            {error}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};

const invitationFailureReasons = {
  invitation_expired: 'Platnost pozvánky vypršela před odesláním.',
  recipient_unavailable: 'Na tuto e-mailovou adresu nelze odesílat zprávy.',
  rejected: 'Poštovní služba odeslání odmítla.',
  retry_expired: 'Poštovní služba nebyla dostupná ani po opakovaných pokusech.',
} as const;

const InvitationDelivery = ({ delivery }: { readonly delivery: Person['invitationDelivery'] }) => {
  if (delivery === null) {
    return null;
  }
  return Match.value(delivery).pipe(
    Match.when({ status: 'sent' }, () => (
      <p>E-mail s pozvánkou: odesláno. Poštovní služba zprávu přijala; přečtení není ověřené.</p>
    )),
    Match.when({ status: 'undeliverable' }, ({ reason }) => (
      <p>E-mail s pozvánkou: nelze doručit. {invitationFailureReasons[reason]}</p>
    )),
    Match.when({ status: 'unknown' }, () => (
      <p>E-mail s pozvánkou: doručení nelze ověřit. Spojení se přerušilo; zpráva už mohla být odeslána.</p>
    )),
    Match.when({ status: 'pending' }, () => <p>E-mail s pozvánkou: čeká na odeslání.</p>),
    Match.exhaustive,
  );
};

const PersonDetail = ({
  catalog,
  onClose,
  onEdit,
  person,
  scope,
}: {
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly onClose: () => void;
  readonly onEdit: (editor: Editor) => void;
  readonly person: Person;
  readonly scope: 'company' | 'tenant';
}) => (
  <Dialog
    actions={
      <div className="grid w-full gap-100 sm:flex sm:w-auto sm:justify-end">
        <Button
          className="w-full rounded-button-md p-button-md text-button-md whitespace-normal sm:w-auto"
          onClick={() => {
            onEdit({ kind: 'role', person });
            onClose();
          }}
          size="current"
          variant="primary"
        >
          Spravovat role
        </Button>
        {scope === 'company' ? (
          <Button
            className="w-full rounded-button-md p-button-md text-button-md whitespace-normal sm:w-auto"
            onClick={() => {
              onEdit({ kind: 'membership', person });
              onClose();
            }}
            size="current"
            theme="outlined"
            variant="secondary"
          >
            Upravit členství
          </Button>
        ) : null}
      </div>
    }
    closeLabel="Zavřít"
    customTrigger
    onOpenChange={(persons) => {
      if (!persons.open) {
        onClose();
      }
    }}
    open
    title={person.displayName}
  >
    <div className="grid gap-150">
      <p className="flex flex-wrap items-center gap-100">
        <span>{personKindLabel(person)}</span>
        <PersonStatusDot status={personStatusKey(person)} />
      </p>
      <p>
        {person.selectedCompanyMembership === null
          ? 'Bez členství ve vybrané firmě'
          : membershipLabels[person.selectedCompanyMembership.status]}
      </p>
      <InvitationDelivery delivery={person.invitationDelivery} />
      <p>
        Role v tomto rozsahu:{' '}
        {person.roleAssignments.map((role) => roleName(catalog, role.roleKey)).join(', ') || 'Žádné'}
      </p>
      {person.selectedCompanyMembership?.status === 'departed' ? (
        <p>Odchod zachovává historii. Případné přeřazení práce ověřte přímo v agendě, která práci eviduje.</p>
      ) : null}
    </div>
  </Dialog>
);

const personMatchesLink = (
  person: PeopleList['items'][number],
  list: PeopleList,
  linkedPerson: string,
  linkedPersonCompanyQualified: boolean,
  companyId: string | undefined,
): boolean => {
  if (person.principalRef.principalId !== linkedPerson || person.principalRef.tenantId !== list.tenantId) {
    return false;
  }
  return (
    !linkedPersonCompanyQualified ||
    (companyId !== undefined && person.selectedCompanyMembership?.legalEntityId === companyId)
  );
};

const linkedPersonOf = (
  list: PeopleList | undefined,
  linkedPerson: string | undefined,
  linkedPersonCompanyQualified: boolean,
  companyId: string | undefined,
): Person | undefined => {
  if (list === undefined || linkedPerson === undefined) {
    return undefined;
  }
  return list.items.find((person) =>
    personMatchesLink(person, list, linkedPerson, linkedPersonCompanyQualified, companyId),
  );
};

const peopleReadError = (
  current: PeopleOutcome<PeopleList> | undefined,
  linkedPerson: string | undefined,
  linkedPersonError: string | undefined,
  linkedPersonCompanyQualified: boolean,
  companyId: string | undefined,
): string => {
  if (current?.status === 'failed') {
    return current.message;
  }
  if (linkedPersonError !== undefined) {
    return linkedPersonError;
  }
  const list = current?.status === 'ok' ? current.value : undefined;
  if (list === undefined || linkedPerson === undefined) {
    return '';
  }
  return linkedPersonOf(list, linkedPerson, linkedPersonCompanyQualified, companyId) === undefined
    ? 'Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'
    : '';
};

/** Core-owned people data changes arrive as live changes for the pseudo app `shell`; `all` after a reconnect. */
const LiveChangeDetailSchema = Schema.Struct({
  apps: Schema.Union([Schema.Literal('all'), Schema.Array(Schema.String)]),
});
const changesPeople = (event: Event): boolean =>
  Schema.decodeUnknownOption(LiveChangeDetailSchema)('detail' in event ? event.detail : null).pipe(
    Option.exists(({ apps }) => apps === 'all' || apps.includes('shell')),
  );

/** Push-based list: reload on a committed people change and on return to the tab, never on a timer. */
const useLiveReload = (reload: () => void) => {
  const onChange = useEffectEvent(reload);
  useEffect(() => {
    const follow = (event: Event) => {
      if (changesPeople(event)) {
        onChange();
      }
    };
    const returned = () => {
      if (document.visibilityState !== 'hidden') {
        onChange();
      }
    };
    globalThis.addEventListener(moduleChangeEvent, follow);
    document.addEventListener('visibilitychange', returned);
    return () => {
      globalThis.removeEventListener(moduleChangeEvent, follow);
      document.removeEventListener('visibilitychange', returned);
    };
  }, []);
};

interface Loaded<Value> {
  readonly key: string;
  readonly outcome: PeopleOutcome<Value>;
}

const scopeOf = (companyId: string | undefined): 'company' | 'tenant' =>
  companyId === undefined ? 'tenant' : 'company';

export const PeoplePanel = ({
  companyId,
  linkedPerson,
  linkedPersonCompanyQualified = false,
  linkedPersonError,
}: {
  readonly companyId: string | undefined;
  readonly linkedPerson?: string | undefined;
  readonly linkedPersonCompanyQualified?: boolean | undefined;
  readonly linkedPersonError?: string | undefined;
}) => {
  const [scope, setScope] = useState<'company' | 'tenant'>(() => scopeOf(companyId));
  const [catalogLoaded, setCatalogLoaded] = useState<Loaded<PeopleRoleCatalog>>();
  const [detail, setDetail] = useState<Person>();
  const [loaded, setLoaded] = useState<Loaded<PeopleList>>();
  const [editor, setEditor] = useState<Editor | undefined>();
  const [pending, setPending] = useState<readonly PendingPeopleChange[]>([]);
  const [filters, setFilters] = useState<PeopleFilters>(defaultPeopleFilters);
  const [reload, setReload] = useState(0);
  const viewKey = `${companyId}:${scope}:${linkedPersonCompanyQualified}:${linkedPerson ?? ''}`;
  // A background reload keeps the rows of the same view on screen; only a new view starts empty.
  const current = loaded?.key === viewKey ? loaded.outcome : undefined;
  const list = current?.status === 'ok' ? current.value : undefined;
  const catalog =
    catalogLoaded?.key === viewKey && catalogLoaded.outcome.status === 'ok' ? catalogLoaded.outcome.value : undefined;
  const loading = current === undefined;
  const error = peopleReadError(current, linkedPerson, linkedPersonError, linkedPersonCompanyQualified, companyId);
  const acceptRead = useEffectEvent(
    (key: string, people: PeopleOutcome<PeopleList>, roles: PeopleOutcome<PeopleRoleCatalog>) => {
      const firstRead = loaded?.key !== key;
      setLoaded({ key, outcome: people });
      setCatalogLoaded({ key, outcome: roles });
      if (people.status !== 'ok') {
        setDetail(undefined);
        setEditor(undefined);
      }
      if (roles.status !== 'ok') {
        setEditor(undefined);
      }
      if (people.status === 'ok') {
        setDetail((selected) => {
          // A deep link opens its person once; a later reload only refreshes a detail the user still has open.
          const principalId = selected?.principalRef.principalId ?? (firstRead ? linkedPerson : undefined);
          return linkedPersonOf(people.value, principalId, linkedPersonCompanyQualified, companyId);
        });
        setPending((changes) => changes.filter((change) => !isChangeConfirmed(change, people.value)));
      }
    },
  );
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      Effect.all({ people: loadAllPeople(scope), roles: loadRoleCatalog(scope) }, { concurrency: 2 }).pipe(
        Effect.andThen(({ people, roles }) => Effect.sync(() => acceptRead(viewKey, people, roles))),
        Effect.withSpan('PeoplePanel.load', { attributes: { reload } }),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [viewKey, scope, reload]);
  useLiveReload(() => setReload((value) => value + 1));
  const commit = (change: PendingPeopleChange) => {
    setPending((changes) => [...changes, change]);
    setReload((value) => value + 1);
  };

  return (
    <div className="grid min-w-0 gap-200">
      <PeopleToolbar
        actions={scope === 'company' && list !== undefined ? <InvitePersonButton onCommitted={commit} /> : null}
        catalog={catalog}
        companyAvailable={companyId !== undefined}
        filters={filters}
        onFiltersChange={setFilters}
        onScopeChange={(next) => {
          setScope(next);
          setEditor(undefined);
          setFilters((value) => ({ ...value, roleKey: 'all' }));
        }}
        scope={scope}
      />
      {pending.length === 0 ? null : (
        <StatusText aria-live="polite" status="warning">
          Zpracovává se {pending.length}{' '}
          {czechPlural(pending.length, { few: 'změny', many: 'změny', one: 'změna', other: 'změn' })}. Potvrzení zápisu
          není potvrzením promítnutí přístupu. Seznam se obnoví sám, jakmile ověříme skutečný přístup.
        </StatusText>
      )}
      {error === '' ? null : (
        <StatusText role="alert" status="error">
          {error}
        </StatusText>
      )}
      {detail === undefined ? null : (
        <PersonDetail
          catalog={catalog}
          onClose={() => setDetail(undefined)}
          onEdit={setEditor}
          person={detail}
          scope={scope}
        />
      )}
      {current?.status === 'failed' ? null : (
        <PeopleTable
          catalog={catalog}
          filters={filters}
          loading={loading}
          onEdit={(kind, person) => setEditor({ kind, person })}
          onFiltersChange={setFilters}
          onOpen={setDetail}
          people={list?.items ?? []}
          scope={scope}
        />
      )}
      {editor === undefined ? null : (
        <PeopleEditor
          catalog={catalog}
          editor={editor}
          key={`${scope}:${editor.kind}:${editor.person.principalRef.principalId}`}
          onClose={() => setEditor(undefined)}
          onCommitted={(change) => {
            commit(change);
            setEditor(undefined);
          }}
          scope={scope}
        />
      )}
    </div>
  );
};
