// Save of the lease screen's edit panels: one command against the revision its draft builds on.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Crypto, Effect, Option, PlatformError, Predicate, Schema } from 'effect';
import type { OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import type { RecordsResponse, RentTerms, TenantContact, TenantDossier } from '../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { crownsInput, parseCrowns } from './lease-story.tsx';

const browserCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.tryPromise({
      catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'WebCrypto' }),
      try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, algorithm, new Uint8Array(data)),
    }).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.timeoutOrElse({
        duration: '5 seconds',
        orElse: () =>
          Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'digest', module: 'WebCrypto' })),
      }),
    ),
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});
/** A fresh UUID for new records and idempotency keys. */
export const newUuid = browserCrypto.randomUUIDv4();

/** Whether the records still hold the edited record as the draft's base version. */
export type UnchangedSince = (records: RecordsResponse) => boolean;

/** Told about a change that was parked for approval instead of being saved. */
export type OnProposal = (proposal: ActionProposalAccepted) => void;

/** Saves one edit of a lease-screen panel against the revision its draft builds on. */
export type LeasingAutosave = (
  command: OccupancyCommand,
  expectedRevision: number,
  unchanged: UnchangedSince,
  onProposal?: OnProposal,
) => Effect.Effect<RevisionedSaveResult>;

const send = (command: OccupancyCommand, expectedRevision: number) =>
  Effect.all(
    {
      idempotencyKey: newUuid,
      referenceCredentials: makeReferenceGatewayCredentials([
        'property-portfolio',
        'property-portfolio',
        'party-registry',
        'legal-agreements',
      ]),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
      executeApplyCommand({ command, expectedRevision }, 'property-leasing.command', {
        idempotencyKey,
        referenceCredentials,
      }),
    ),
  );

/**
 * An autosave outcome: the new revision once saved, `conflict` for the occupancy conflict, else `failed`. A change
 * parked for approval is not saved: the draft stays unconfirmed, its base revision stays, and `onProposal` hears of it.
 */
export const leasingAutosaveResult = <E>(
  write: Effect.Effect<{ readonly revision: number } | ActionProposalAccepted, E>,
  onProposal?: OnProposal,
): Effect.Effect<RevisionedSaveResult> =>
  write.pipe(
    Effect.match({
      onFailure: (error): RevisionedSaveResult =>
        Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') &&
        Predicate.hasProperty(error, 'code') &&
        error.code === 'occupancy_conflict'
          ? 'conflict'
          : 'failed',
      onSuccess: (result): RevisionedSaveResult => {
        if (Schema.is(ActionProposalAcceptedSchema)(result)) {
          onProposal?.(result);
          return 'failed';
        }
        return result.revision;
      },
    }),
  );

/**
 * The revision covers every lease and dossier of the company, so a conflict is resent once against a fresh read while
 * `unchanged` holds for it; a change of the edited record itself stays a conflict.
 */
export const autosaveLeasingCommand: LeasingAutosave = (command, expectedRevision, unchanged, onProposal) =>
  leasingAutosaveResult(
    send(command, expectedRevision).pipe(
      Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
        conflict.code === 'occupancy_conflict'
          ? executeRecords({}, 'property-leasing.records').pipe(
              Effect.flatMap((fresh) => (unchanged(fresh) ? send(command, fresh.revision) : Effect.fail(conflict))),
            )
          : Effect.fail(conflict),
      ),
    ),
    onProposal,
  );

// Rent terms of one lease.

export interface RentDraft {
  readonly monthly: string;
  readonly paymentDay: string;
  readonly service: string;
}

export const rentDraftOf = (terms: RentTerms | undefined): RentDraft =>
  terms === undefined
    ? { monthly: '', paymentDay: '15', service: '' }
    : {
        monthly: crownsInput(terms.monthlyRentMinor),
        paymentDay: String(terms.paymentDay),
        service: crownsInput(terms.serviceChargesMinor),
      };

export const sameRentDraft = (left: RentDraft, right: RentDraft): boolean =>
  left.monthly.trim() === right.monthly.trim() &&
  left.paymentDay.trim() === right.paymentDay.trim() &&
  left.service.trim() === right.service.trim();

export interface RentProblems {
  readonly monthly: boolean;
  readonly paymentDay: boolean;
  readonly service: boolean;
}

export const rentProblems = (draft: RentDraft): RentProblems => {
  const paymentDay = Number(draft.paymentDay);
  return {
    monthly: parseCrowns(draft.monthly) === undefined,
    paymentDay: !Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31,
    service: draft.service.trim().length > 0 && parseCrowns(draft.service) === undefined,
  };
};

/** The agreed rent of a draft; None while a field is invalid, so an invalid draft is never saved. */
export const rentTermsOf = (draft: RentDraft): Option.Option<RentTerms> => {
  const monthlyRentMinor = parseCrowns(draft.monthly);
  const serviceChargesMinor = draft.service.trim().length === 0 ? 0 : parseCrowns(draft.service);
  const problems = rentProblems(draft);
  return monthlyRentMinor === undefined ||
    serviceChargesMinor === undefined ||
    problems.monthly ||
    problems.paymentDay ||
    problems.service
    ? Option.none()
    : Option.some({ currency: 'CZK', monthlyRentMinor, paymentDay: Number(draft.paymentDay), serviceChargesMinor });
};

export const rentUnchangedSince =
  (resourceId: string, base: RentDraft): UnchangedSince =>
  (records) => {
    const occupancy = records.occupancies.find((item) => item.occupancyRef.resourceId === resourceId);
    return occupancy !== undefined && sameRentDraft(rentDraftOf(occupancy.rentTerms), base);
  };

// Contact people of one counterparty dossier.

const sameContact = (left: TenantContact, right: TenantContact) =>
  left.id === right.id &&
  left.name.trim() === right.name.trim() &&
  left.role.trim() === right.role.trim() &&
  left.email.trim() === right.email.trim() &&
  left.phone.trim() === right.phone.trim();

export const sameContacts = (left: readonly TenantContact[], right: readonly TenantContact[]): boolean =>
  left.length === right.length &&
  left.every((contact, index) => {
    const other = right[index];
    return other !== undefined && sameContact(contact, other);
  });

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** A contact needs a name; an e-mail, when given, must look like one. */
export const contactProblems = (contact: TenantContact) => ({
  email: contact.email.trim() !== '' && !emailPattern.test(contact.email.trim()),
  name: contact.name.trim().length === 0,
});

export const validContacts = (contacts: readonly TenantContact[]): boolean =>
  contacts.length <= 50 &&
  contacts.every((contact) => {
    const problems = contactProblems(contact);
    return !problems.email && !problems.name;
  });

export const trimmedContacts = (contacts: readonly TenantContact[]): TenantContact[] =>
  contacts.map((contact) => ({
    email: contact.email.trim(),
    id: contact.id,
    name: contact.name.trim(),
    phone: contact.phone.trim(),
    role: contact.role.trim(),
  }));

const dossierOf = (records: RecordsResponse, counterpartyId: string): TenantDossier | undefined =>
  records.tenantDossiers?.find((dossier) => dossier.counterpartyId === counterpartyId);

export const contactsUnchangedSince =
  (counterpartyId: string, base: readonly TenantContact[]): UnchangedSince =>
  (records) =>
    sameContacts(dossierOf(records, counterpartyId)?.contacts ?? [], base);

// Business case of one counterparty dossier.

export type DossierCommand = Extract<OccupancyCommand, { readonly _tag: 'UpdateTenantDossier' }>;
export type DossierChanges = Omit<DossierCommand, '_tag' | 'occupancyRef'>;
type CaseState = TenantDossier['caseState'];

export interface CaseDraft {
  readonly deadline: string;
  readonly owner: string;
  readonly state: CaseState;
  readonly subject: string;
  /** Estimated value in crowns as typed; empty means none. */
  readonly value: string;
}

export const caseDraftOf = (dossier: TenantDossier | undefined): CaseDraft => ({
  deadline: dossier?.caseDetails?.deadline ?? '',
  owner: dossier?.caseDetails?.owner ?? '',
  state: dossier?.caseState ?? 'NEW',
  subject: dossier?.caseDetails?.subject ?? '',
  value:
    dossier?.caseDetails === undefined
      ? ''
      : Option.match(dossier.caseDetails.estimatedValueMinor, {
          onNone: () => '',
          onSome: (minor) => crownsInput(minor),
        }),
});

export const sameCaseDraft = (left: CaseDraft, right: CaseDraft): boolean =>
  left.deadline === right.deadline &&
  left.owner.trim() === right.owner.trim() &&
  left.state === right.state &&
  left.subject.trim() === right.subject.trim() &&
  left.value.trim() === right.value.trim();

const hasCaseDetails = (draft: CaseDraft) =>
  draft.subject.trim() !== '' || draft.owner.trim() !== '' || draft.deadline !== '' || draft.value.trim() !== '';

export interface CaseProblems {
  readonly deadline: boolean;
  readonly owner: boolean;
  readonly subject: boolean;
  readonly value: boolean;
}

/**
 * The case details are filled in together: once one of them is, subject, owner and deadline are required and the
 * value must be an amount. A dossier that has details keeps them (they cannot be cleared).
 */
export const caseProblems = (draft: CaseDraft, dossier: TenantDossier | undefined): CaseProblems => {
  if (!hasCaseDetails(draft) && dossier?.caseDetails === undefined) {
    return { deadline: false, owner: false, subject: false, value: false };
  }
  return {
    deadline: draft.deadline === '',
    owner: draft.owner.trim() === '',
    subject: draft.subject.trim() === '',
    value: draft.value.trim() !== '' && parseCrowns(draft.value) === undefined,
  };
};

/** What a case draft sends; None while a field is invalid, so an invalid draft is never saved. */
export const caseChangesOf = (draft: CaseDraft, dossier: TenantDossier | undefined): Option.Option<DossierChanges> => {
  const problems = caseProblems(draft, dossier);
  if (problems.deadline || problems.owner || problems.subject || problems.value) {
    return Option.none();
  }
  if (!hasCaseDetails(draft)) {
    return Option.some({ caseState: draft.state });
  }
  const estimated = draft.value.trim() === '' ? undefined : parseCrowns(draft.value);
  return Option.some({
    caseDetails: {
      deadline: draft.deadline,
      estimatedValueMinor: Option.fromUndefinedOr(estimated),
      owner: draft.owner.trim(),
      subject: draft.subject.trim(),
    },
    caseState: draft.state,
  });
};

export const caseUnchangedSince =
  (counterpartyId: string, base: CaseDraft): UnchangedSince =>
  (records) =>
    sameCaseDraft(caseDraftOf(dossierOf(records, counterpartyId)), base);
