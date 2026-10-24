import { czechPlural } from '@app/shared-contracts';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Fiber } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';

import type {
  PeopleList,
  PeopleRoleCatalog,
  Person,
  SetPeopleCompanyMembershipRequest,
} from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import type { PeopleOutcome } from './people-client.ts';
import {
  changeCompanyMembership,
  changeScopedRole,
  loadPeople,
  loadPeopleForPerson,
  loadRoleCatalog,
} from './people-client.ts';
import { isChangeConfirmed, membershipLabels, personKindLabel, principalStatusLabels } from './people-model.ts';
import { InvitePersonButton } from './invite-person-button.tsx';
import type { PendingPeopleChange } from './people-model.ts';

interface Editor {
  readonly kind: 'membership' | 'role';
  readonly person: Person;
}
const roleName = (catalog: PeopleRoleCatalog | undefined, roleKey: string) =>
  catalog?.items.find((role) => role.roleKey === roleKey)?.name ?? 'Název role není dostupný';
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
        <StatusText status="warning">Seznam rolí není dostupný. Obnovte seznam.</StatusText>
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
  const { person } = editor;
  const membership = person.selectedCompanyMembership;
  const { kind, principalRef } = person;
  const [affiliation, setAffiliation] = useState<'employee' | 'external'>(membership?.affiliation ?? 'external');
  const [status, setStatus] = useState<SetPeopleCompanyMembershipRequest['status']>(membership?.status ?? 'invited');
  const [roleKey, setRoleKey] = useState('');
  const [operation, setOperation] = useState<'assign' | 'revoke'>('assign');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = editor.kind === 'role' ? 'Přiřadit nebo odebrat roli' : 'Členství ve firmě';
  const submit = () => {
    if (busy || reason.trim() === '' || (editor.kind === 'role' && roleKey.trim() === '')) {
      return;
    }
    setBusy(true);
    setError('');
    const command =
      editor.kind === 'role'
        ? changeScopedRole(scope, { operation, principalRef, reason: reason.trim(), roleKey: roleKey.trim() }).pipe(
            Effect.map((outcome): PeopleOutcome<PendingPeopleChange> =>
              outcome.status === 'failed' ? outcome : { status: 'ok', value: { kind: 'role', result: outcome.value } },
            ),
          )
        : changeCompanyMembership({
            affiliation: kind === 'agent' ? null : affiliation,
            expectedRevision: membership?.revision ?? 0,
            principalRef,
            reason: reason.trim(),
            status,
          }).pipe(
            Effect.map((outcome): PeopleOutcome<PendingPeopleChange> =>
              outcome.status === 'failed'
                ? outcome
                : { status: 'ok', value: { kind: 'membership', result: outcome.value } },
            ),
          );
    void browserRuntime.runPromise(
      command.pipe(
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
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            disabled={busy || reason.trim() === '' || (editor.kind === 'role' && roleKey.trim() === '')}
            onClick={submit}
            variant="primary"
          >
            {busy ? 'Odesílám…' : 'Potvrdit změnu'}
          </Button>
        </>
      }
      closeLabel="Zavřít"
      customTrigger
      onOpenChange={(details) => {
        if (!details.open && !busy) {
          onClose();
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
                  onChange={(event) => setAffiliation(event.target.value === 'employee' ? 'employee' : 'external')}
                  value={affiliation}
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
                      setStatus(value);
                    }
                  }}
                  value={status}
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
          label="Důvod změny"
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          required
          value={reason}
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
      <p>
        {personKindLabel(person)} · {principalStatusLabels[person.principalStatus]}
      </p>
      <p>
        {person.selectedCompanyMembership === null
          ? 'Bez členství ve vybrané firmě'
          : membershipLabels[person.selectedCompanyMembership.status]}
      </p>
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

const PersonCard = ({
  catalog,
  onDetail,
  onEdit,
  person,
  scope,
}: {
  readonly catalog: PeopleRoleCatalog | undefined;
  readonly onDetail: (person: Person) => void;
  readonly onEdit: (editor: Editor) => void;
  readonly person: Person;
  readonly scope: 'company' | 'tenant';
}) => (
  <li className="grid gap-150 rounded-lg border border-border-primary bg-base p-250">
    <div className="flex flex-wrap items-center justify-between gap-150">
      <div className="grid gap-50">
        <h2 className="font-semibold">
          <button
            className="cursor-pointer text-left underline-offset-4 hover:underline"
            onClick={() => onDetail(person)}
            type="button"
          >
            {person.displayName}
          </button>
        </h2>
        <span className="text-fg-secondary text-sm">
          {personKindLabel(person)} · {principalStatusLabels[person.principalStatus]}
        </span>
      </div>
      <Badge variant={person.selectedCompanyMembership?.status === 'departed' ? 'warning' : 'outline'}>
        {person.selectedCompanyMembership === null
          ? 'Organizace'
          : membershipLabels[person.selectedCompanyMembership.status]}
      </Badge>
    </div>
    {person.selectedCompanyMembership?.status === 'departed' ? (
      <p className="text-fg-secondary text-sm">Osoba odešla z firmy. Historie zůstává zachována.</p>
    ) : null}
    <div className="flex flex-wrap gap-100">
      {person.roleAssignments.length === 0 ? (
        <span className="text-fg-secondary text-sm">Žádné role v tomto rozsahu</span>
      ) : (
        person.roleAssignments.map((role) => (
          <Badge key={role.roleKey} variant="outline">
            {roleName(catalog, role.roleKey)}
          </Badge>
        ))
      )}
    </div>
    <div className="flex flex-wrap gap-100">
      {scope === 'company' ? (
        <Button onClick={() => onEdit({ kind: 'membership', person })} theme="outlined" variant="secondary">
          Upravit členství
        </Button>
      ) : null}
      <Button onClick={() => onEdit({ kind: 'role', person })} theme="outlined" variant="secondary">
        Spravovat role
      </Button>
    </div>
  </li>
);

const peopleReadError = (current: PeopleOutcome<PeopleList> | undefined, linkedPerson: string | undefined): string => {
  const list = current?.status === 'ok' ? current.value : undefined;
  let error = '';
  if (current?.status === 'failed') {
    error = current.message;
  } else if (
    linkedPerson !== undefined &&
    list !== undefined &&
    !list.items.some((person) => person.principalRef.principalId === linkedPerson)
  ) {
    error = 'Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.';
  }
  return error;
};

const currentRoleCatalog = (
  loaded: { readonly key: string; readonly outcome: PeopleOutcome<PeopleRoleCatalog> } | undefined,
  requestKey: string,
) => (loaded?.key === requestKey && loaded.outcome.status === 'ok' ? loaded.outcome.value : undefined);

export const PeoplePanel = ({
  companyId,
  linkedPerson,
}: {
  readonly companyId: string | undefined;
  readonly linkedPerson?: string | undefined;
}) => {
  const [scope, setScope] = useState<'company' | 'tenant'>(companyId === undefined ? 'tenant' : 'company');
  const [catalogLoaded, setCatalogLoaded] = useState<{
    readonly key: string;
    readonly outcome: PeopleOutcome<PeopleRoleCatalog>;
  }>();
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Person>();
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly outcome: PeopleOutcome<PeopleList> }>();
  const [editor, setEditor] = useState<Editor | undefined>();
  const [pending, setPending] = useState<readonly PendingPeopleChange[]>([]);
  const [invitationQueued, setInvitationQueued] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const requestKey = `${companyId}:${scope}:${offset}:${refresh}:${linkedPerson}`;
  const current = loaded?.key === requestKey ? loaded.outcome : undefined;
  const catalog = currentRoleCatalog(catalogLoaded, requestKey);
  const loading = current === undefined;
  const list = current?.status === 'ok' ? current.value : undefined;
  const error = peopleReadError(current, linkedPerson);
  const acceptRead = useEffectEvent((key: string, outcome: PeopleOutcome<PeopleList>) => {
    setLoaded({ key, outcome });
    if (outcome.status === 'ok') {
      if (linkedPerson !== undefined) {
        setDetail(outcome.value.items.find((person) => person.principalRef.principalId === linkedPerson));
      }
      setPending((changes) => changes.filter((change) => !isChangeConfirmed(change, outcome.value)));
    }
  });
  useEffect(() => {
    const request =
      linkedPerson === undefined ? loadPeople(scope, { limit: 50, offset }) : loadPeopleForPerson(scope, linkedPerson);
    const fiber = browserRuntime.runFork(
      Effect.all({ people: request, roles: loadRoleCatalog(scope) }, { concurrency: 2 }).pipe(
        Effect.andThen(({ people, roles }) =>
          Effect.sync(() => {
            acceptRead(requestKey, people);
            setCatalogLoaded({ key: requestKey, outcome: roles });
          }),
        ),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [requestKey, scope, offset, linkedPerson]);

  return (
    <div className="grid min-w-0 gap-300">
      <section className="grid gap-150 rounded-lg border border-border-primary bg-base p-300">
        <p>
          Každý člověk i agent má vlastní přihlášení. Role určují, co může ve firmě dělat. Pracovní zařazení samo o sobě
          přístup nepřiděluje.
        </p>
        <div className="flex flex-wrap items-end gap-150">
          <label className="grid gap-50">
            Rozsah správy
            <select
              className={selectClass}
              onChange={(event) => {
                setScope(event.target.value === 'tenant' ? 'tenant' : 'company');
                setOffset(0);
                setEditor(undefined);
              }}
              value={scope}
            >
              {companyId === undefined ? null : <option value="company">Vybraná firma</option>}
              <option value="tenant">Celá organizace</option>
            </select>
          </label>
          <Button
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
            theme="outlined"
            variant="secondary"
          >
            Obnovit seznam
          </Button>
          {scope === 'company' && list !== undefined ? (
            <InvitePersonButton
              onCommitted={(change) => {
                setInvitationQueued(true);
                setPending((changes) => [...changes, change]);
                setRefresh((value) => value + 1);
              }}
            />
          ) : null}
        </div>
      </section>
      {invitationQueued ? (
        <StatusText aria-live="polite" status="warning">
          Pozvánka se zpracovává. Přihlášení a pozvané členství jsou zapsané; e-mail čeká na odeslání. Doručení zatím
          není ověřené. Pozvánka sama nepřiděluje žádné role ani neaktivuje členství.
        </StatusText>
      ) : null}
      {pending.length === 0 ? null : (
        <StatusText aria-live="polite" status="warning">
          Zpracovává se {pending.length}{' '}
          {czechPlural(pending.length, { few: 'změny', many: 'změny', one: 'změna', other: 'změn' })}. Potvrzení zápisu
          není potvrzením promítnutí přístupu. Obnovte seznam; čekáme na ověření skutečného přístupu.
        </StatusText>
      )}
      {loading ? (
        <StatusText aria-live="polite" status="default">
          Načítám lidi a role…
        </StatusText>
      ) : null}
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
      {list === undefined ? null : (
        <>
          {list.items.length === 0 ? (
            <p>V tomto rozsahu nejsou žádná evidovaná členství.</p>
          ) : (
            <ul className="grid gap-150">
              {list.items.map((person) => (
                <PersonCard
                  catalog={catalog}
                  key={person.principalRef.principalId}
                  onDetail={setDetail}
                  onEdit={setEditor}
                  person={person}
                  scope={scope}
                />
              ))}
            </ul>
          )}
          <div className="flex gap-150">
            <Button
              disabled={offset === 0 || loading}
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
              theme="outlined"
              variant="secondary"
            >
              Předchozí
            </Button>
            <Button
              disabled={list.nextOffset === null || loading}
              onClick={() => {
                if (list.nextOffset !== null) {
                  setOffset(list.nextOffset);
                }
              }}
              theme="outlined"
              variant="secondary"
            >
              Další
            </Button>
          </div>
          {editor === undefined ? null : (
            <PeopleEditor
              catalog={catalog}
              editor={editor}
              key={`${scope}:${editor.kind}:${editor.person.principalRef.principalId}`}
              onClose={() => setEditor(undefined)}
              onCommitted={(change) => {
                setPending((changes) => [...changes, change]);
                setEditor(undefined);
                setRefresh((value) => value + 1);
              }}
              scope={scope}
            />
          )}
        </>
      )}
    </div>
  );
};
