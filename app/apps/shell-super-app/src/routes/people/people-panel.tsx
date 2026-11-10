import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { czechPlural } from '@app/shared-contracts';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect, Fiber, Match, Option, Schema } from 'effect';
import type { HttpClient } from 'effect/http';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { PeopleList, Person } from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import type { PeopleOutcome } from './people-client.ts';
import { changeCompanyMembership, loadAllPeople, loadPeopleAccess } from './people-client.ts';
import {
  accessRoleNamesOf,
  defaultPeopleFilters,
  isChangeConfirmed,
  membershipLabels,
  personKindLabel,
  personStatusKey,
} from './people-model.ts';
import type { PeopleAccessView, PeopleEditKind, PeopleFilters, PendingPeopleChange } from './people-model.ts';
import { InvitePersonButton } from './invite-person-button.tsx';
import { PersonRoleEditor } from './person-role-editor.tsx';
import { PeopleTable, PeopleToolbar, PersonStatusDot } from './people-table.tsx';
import { baseOf, membershipDraftOf, membershipEditOf, sameMembershipDraft } from './people-membership-draft.ts';
import type { MembershipBase, MembershipDraft } from './people-membership-draft.ts';

interface Editor {
  readonly kind: PeopleEditKind;
  readonly person: Person;
}
const selectClass = 'w-full rounded-md border border-border-primary bg-base p-100';

const PeopleEditor = ({
  editor,
  onClose,
  onCommitted,
}: {
  readonly editor: Editor;
  readonly onClose: () => void;
  readonly onCommitted: (change: PendingPeopleChange) => void;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { person } = editor;
  const membership = person.selectedCompanyMembership;
  const { kind, principalRef } = person;
  const [error, setError] = useState('');
  // The company membership is saved only by Uložit. The change is audited, so it is sent only once the reason is
  // filled in, and the revision the server answered with is the one the next change builds on.
  const openedBase: MembershipBase = {
    affiliation: membership?.affiliation ?? null,
    status: membership?.status ?? 'invited',
  };
  const base = useRef<MembershipBase>(openedBase);
  const revision = useRef(membership?.revision ?? 0);
  const [membershipDraft, setMembershipDraft] = useState<MembershipDraft>(() => membershipDraftOf(openedBase));
  const record = useDraftSave<MembershipDraft, HttpClient.HttpClient>({
    equals: sameMembershipDraft,
    isValid: (value) => Option.isSome(membershipEditOf(value, base.current)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(membershipEditOf(value, base.current), {
        onNone: () => Effect.succeed<SaveOutcome>('saved'),
        onSome: (edit) =>
          changeCompanyMembership({
            affiliation: kind === 'agent' ? null : edit.affiliation,
            expectedRevision: revision.current,
            principalRef,
            reason: edit.reason,
            status: edit.status,
          }).pipe(
            Effect.map((outcome): SaveOutcome => {
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
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setMembershipDraft(record.confirmed),
  });
  const handleReloadLatest = () => record.adopt(membershipDraftOf(baseOf(person)));
  const requestClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button onClick={requestClose} theme="outlined" variant="secondary">
              Zavřít
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
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
        title={t('shell.people.membershipTitle')}
      >
        <div className="grid gap-200">
          <p>{person.displayName}</p>
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
            Zařazení ve firmě a stav členství jsou organizační údaje: neurčují práva a jejich změna sama neodebere
            žádnou roli. Oprávnění se mění přiřazením role; členství a správu firmy nastavujete ve správě přístupu.
          </p>
          <FormInput
            label={t('shell.people.changeReason')}
            maxLength={500}
            onChange={(event) => patchMembership({ reason: event.target.value })}
            required
            value={membershipDraft.reason}
          />
          {error === '' ? null : (
            <StatusText role="alert" status="error">
              {error}
            </StatusText>
          )}
        </div>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
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
  access,
  onClose,
  onEdit,
  person,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
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
      <p>Role v tomto rozsahu: {accessRoleNamesOf(access, person.principalRef.principalId).join(', ') || 'Žádné'}</p>
      {person.selectedCompanyMembership?.status === 'departed' ? (
        <p>
          Odchod je organizační stav: sám neodebere žádnou roli. Historie zůstává zachována a případné přeřazení práce
          ověřte přímo v agendě, která práci eviduje.
        </p>
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

/** The open editor of one person: their roles, or their company membership. */
const EditorDialog = ({
  access,
  companyId,
  editor,
  onClose,
  onCommitted,
  scope,
}: {
  readonly access: PeopleAccessView | undefined;
  readonly companyId: string | undefined;
  readonly editor: Editor;
  readonly onClose: () => void;
  readonly onCommitted: (change: PendingPeopleChange) => void;
  readonly scope: 'company' | 'tenant';
}) =>
  editor.kind === 'role' ? (
    <PersonRoleEditor
      access={access}
      companyId={companyId}
      onClose={onClose}
      onCommitted={onCommitted}
      person={editor.person}
      scope={scope}
    />
  ) : (
    <PeopleEditor editor={editor} onClose={onClose} onCommitted={onCommitted} />
  );

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
  const [accessLoaded, setAccessLoaded] = useState<Loaded<PeopleAccessView>>();
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
  const access =
    accessLoaded?.key === viewKey && accessLoaded.outcome.status === 'ok' ? accessLoaded.outcome.value : undefined;
  const loading = current === undefined;
  const error = peopleReadError(current, linkedPerson, linkedPersonError, linkedPersonCompanyQualified, companyId);
  const acceptRead = useEffectEvent(
    (key: string, people: PeopleOutcome<PeopleList>, roles: PeopleOutcome<PeopleAccessView>) => {
      const firstRead = loaded?.key !== key;
      setLoaded({ key, outcome: people });
      setAccessLoaded({ key, outcome: roles });
      if (people.status !== 'ok') {
        setDetail(undefined);
        setEditor(undefined);
      }
      if (roles.status === 'failed') {
        setEditor(undefined);
      }
      if (people.status === 'ok') {
        setDetail((selected) => {
          // A deep link opens its person once; a later reload only refreshes a detail the user still has open.
          const principalId = selected?.principalRef.principalId ?? (firstRead ? linkedPerson : undefined);
          return linkedPersonOf(people.value, principalId, linkedPersonCompanyQualified, companyId);
        });
        const rolesOfRead = roles.status === 'ok' ? roles.value : undefined;
        setPending((changes) => changes.filter((change) => !isChangeConfirmed(change, people.value, rolesOfRead)));
      }
    },
  );
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      Effect.all({ access: loadPeopleAccess(scope, companyId), people: loadAllPeople(scope) }, { concurrency: 2 }).pipe(
        Effect.andThen(({ access: roles, people }) => Effect.sync(() => acceptRead(viewKey, people, roles))),
        Effect.withSpan('PeoplePanel.load', { attributes: { reload } }),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [viewKey, scope, companyId, reload]);
  useLiveReload(() => setReload((value) => value + 1));
  const commit = (change: PendingPeopleChange) => {
    setPending((changes) => [...changes, change]);
    setReload((value) => value + 1);
  };

  return (
    <div className="grid min-w-0 gap-200">
      <PeopleToolbar
        access={access}
        actions={scope === 'company' && list !== undefined ? <InvitePersonButton onCommitted={commit} /> : null}
        companyAvailable={companyId !== undefined}
        filters={filters}
        onFiltersChange={setFilters}
        onScopeChange={(next) => {
          setScope(next);
          setEditor(undefined);
          setFilters((value) => ({ ...value, roleId: 'all' }));
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
          access={access}
          onClose={() => setDetail(undefined)}
          onEdit={setEditor}
          person={detail}
          scope={scope}
        />
      )}
      {current?.status === 'failed' ? null : (
        <PeopleTable
          access={access}
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
        <EditorDialog
          access={access}
          companyId={companyId}
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
