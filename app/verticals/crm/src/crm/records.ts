// Browser data access for every CRM page (owned by crm-scaffold). One governed records read returns the
// ACL-projected aggregate; one governed apply-command Action changes it. Pages never filter for security.
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import { Effect, Option, Predicate, Random, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CrmCommandSchema } from '../../shared/actions/apply-command.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';

import { partyLinksOf } from '../../shared/commands/index.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { executeApplyCommand } from '../api/apply-command-action-client.ts';
import { executeRecords } from '../api/records-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export type CrmRecordsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'ready'; readonly records: RecordsResponse };

const randomToken = Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt], {
  concurrency: 1,
}).pipe(Effect.map((parts) => parts.map((part) => (part + 2 ** 31).toString(16).padStart(8, '0')).join('')));

const correlation = (purpose: string) => randomToken.pipe(Effect.map((token) => `crm:${purpose}:${token}`));

type RecordsFailure = Effect.Error<ReturnType<typeof loadCrmRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof runCrmCommand>>;

const isForbidden = (error: RecordsFailure) =>
  Predicate.isTagged(error, 'RecordsForbiddenProblem') || Predicate.isTagged(error, 'GatewayForbiddenProblem');

const isConflict = (error: CommandFailure) => Predicate.isTagged(error, 'ApplyCommandActionConflictProblem');

export const loadCrmRecords = (clientId?: string) =>
  correlation('records').pipe(
    Effect.flatMap((requestCorrelation) => {
      const input: Parameters<typeof executeRecords>[0] = { requestNonce: requestCorrelation };
      if (clientId !== undefined) {
        Object.assign(input, { clientId });
      }
      return executeRecords(input, requestCorrelation);
    }),
  );

/**
 * Runs one CRM command with a fresh idempotency key against the revision the caller last saw. A command that links a
 * Party Registry identity forwards one single-use registry assertion per link, so the CRM server can read the
 * Counterparty with the signed-in user's own rights before it stores the PartyRef.
 */
export const runCrmCommand = Effect.fn('Crm.runCommand')(function* runCommand(
  input: CrmCommandInput,
  expectedRevision: number,
) {
  const command = yield* Schema.decodeEffect(CrmCommandSchema)(input);
  const [requestCorrelation, idempotencyKey] = yield* Effect.all([correlation('command'), randomToken], {
    concurrency: 1,
  });
  const links = partyLinksOf(command);
  const referenceCredentials =
    links.length === 0 ? undefined : yield* makeReferenceGatewayCredentials(links.map(() => 'party-registry'));
  const options: NonNullable<Parameters<typeof executeApplyCommand>[2]> = { idempotencyKey };
  if (referenceCredentials !== undefined) {
    Object.assign(options, { referenceCredentials });
  }
  return yield* executeApplyCommand({ command, expectedRevision }, requestCorrelation, options);
});

const retryCommandAtLatestRevision = (command: CrmCommandInput) =>
  loadCrmRecords().pipe(Effect.flatMap((latest) => runCrmCommand(command, latest.revision)));

const CommandProblemFieldsSchema = Schema.Struct({
  detail: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
});

/** Human-readable reason of a failed command (domain errors carry Czech reasons). */
export const commandErrorMessage = (error: unknown): string | undefined => {
  const problem = Schema.decodeUnknownOption(CommandProblemFieldsSchema)(error);
  if (Option.isSome(problem)) {
    for (const field of ['detail', 'reason', 'title', 'message'] as const) {
      const value = problem.value[field];
      if (Schema.is(Schema.String)(value) && value !== '') {
        return value;
      }
    }
  }
  return undefined;
};

export interface CrmCommandOutcome {
  readonly entityIds: readonly string[];
  readonly message?: string;
  readonly ok: boolean;
}

/** Owner feature port. UI event adapters run the returned Effect in the browser runtime. */
export type CrmCommandServices = Effect.Services<ReturnType<typeof runCrmCommand>>;
export type CrmCommandSubmit = (command: CrmCommandInput) => Effect.Effect<CrmCommandOutcome>;

export interface CrmRecordsInput {
  readonly clientId?: string;
}

const allRecords: CrmRecordsInput = {};

const recordsInput = (clientId: string | undefined): CrmRecordsInput =>
  clientId === undefined ? allRecords : { clientId };

/**
 * The governed records read of the signed-in principal, one entry per client filter ('all' without one). The Shell
 * fills it through `preloadPage` before it reveals a CRM page, so the page renders real data in its first commit.
 */
export const crmRecordsData = definePageData({
  key: ({ clientId }: CrmRecordsInput) => clientId ?? 'all',
  load: ({ clientId }: CrmRecordsInput) => loadCrmRecords(clientId),
  runtime: browserRuntime,
});

/** `preloadPage` of every exposed CRM page: all of them open on the full records read. */
export const preloadCrmRecords = modulePagePreload(() => crmRecordsData.preload(allRecords));

type CrmRecordsSnapshot = ReturnType<typeof crmRecordsData.snapshot>;

const stateOf = (snapshot: CrmRecordsSnapshot): CrmRecordsState => {
  if (snapshot.state === 'pending') {
    return { kind: 'loading' };
  }
  if (snapshot.state === 'failed') {
    return { kind: isForbidden(snapshot.error) ? 'forbidden' : 'error' };
  }
  return { kind: 'ready', records: snapshot.value };
};

const serverSnapshot = (): CrmRecordsSnapshot => pageDataPending;

/**
 * The CRM records of the signed-in principal plus `submit`, which runs a command against the current revision and
 * re-reads on success while the current records stay visible. Use `state.kind === 'ready'` and
 * `state.records.state` / `state.records.viewer`.
 */
export const useCrmRecords = (clientId?: string) => {
  const snapshot = useSyncExternalStore(
    crmRecordsData.subscribe,
    () => crmRecordsData.snapshot(recordsInput(clientId)),
    serverSnapshot,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => crmRecordsData.ensure(recordsInput(clientId)), [clientId]);
  const load = () => {
    browserRuntime.runFork(crmRecordsData.refresh(recordsInput(clientId)));
  };
  const revision = snapshot.state === 'ready' ? snapshot.value.revision : 0;
  const submit: CrmCommandSubmit = (command: CrmCommandInput) =>
    Effect.suspend(() => {
      setBusy(true);
      return runCrmCommand(command, revision).pipe(
        Effect.catchIf(isConflict, () => retryCommandAtLatestRevision(command)),
        Effect.match({
          onFailure: (error): CrmCommandOutcome => {
            const message = commandErrorMessage(error);
            return message === undefined ? { entityIds: [], ok: false } : { entityIds: [], message, ok: false };
          },
          onSuccess: (result): CrmCommandOutcome => ({ entityIds: result.entityIds, ok: true }),
        }),
        Effect.tap(() => crmRecordsData.refresh(recordsInput(clientId))),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      );
    });
  return { busy, load, state: stateOf(snapshot), submit };
};

/** Picker candidates come only from the Core-authorized company directory, never historical records alone. */
export const assignableSalespeople = (records: Pick<RecordsResponse, 'assignmentCandidates' | 'state'>) => {
  const eligible = new Set(records.assignmentCandidates.map((candidate) => candidate.principalRef.principalId));
  return records.state.salespeople.filter(
    (person) => person.active && person.principalId !== undefined && eligible.has(person.principalId),
  );
};

/** Keep historical owners visible, but make a departed person's outstanding work explicit. */
export const salespersonName = (records: RecordsResponse, id: string | undefined) => {
  const person = records.state.salespeople.find((candidate) => candidate.id === id);
  if (
    person !== undefined &&
    person.principalId !== undefined &&
    records.departedPrincipalIds.includes(person.principalId)
  ) {
    return `${person.name} · Odešel – přeřadit`;
  }
  return person?.name;
};

export const clientName = (records: RecordsResponse, id: string | undefined) =>
  id === undefined ? undefined : records.state.clients.items.find((client) => client.id === id)?.name;
