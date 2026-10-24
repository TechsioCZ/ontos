// Browser data access for every CRM page (owned by crm-scaffold). One governed records read returns the
// ACL-projected aggregate; one governed apply-command Action changes it. Pages never filter for security.
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import { Effect, Random } from 'effect';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CrmCommand } from '../../shared/actions/apply-command.ts';
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

const isForbidden = (error: unknown) =>
  typeof error === 'object' && error !== null && '_tag' in error && String(error._tag).includes('Forbidden');

const isConflict = (error: unknown) =>
  typeof error === 'object' && error !== null && '_tag' in error && String(error._tag).includes('Conflict');

export const loadCrmRecords = (clientId?: string) =>
  correlation('records').pipe(
    Effect.flatMap((requestCorrelation) =>
      executeRecords(
        { ...(clientId === undefined ? {} : { clientId }), refreshToken: requestCorrelation },
        requestCorrelation,
      ),
    ),
  );

/**
 * Runs one CRM command with a fresh idempotency key against the revision the caller last saw. A command that links a
 * Party Registry identity forwards one single-use registry assertion per link, so the CRM server can read the
 * Counterparty with the signed-in user's own rights before it stores the PartyRef.
 */
export const runCrmCommand = (command: CrmCommand, expectedRevision: number) =>
  Effect.gen(function* runCommand() {
    const [requestCorrelation, idempotencyKey] = yield* Effect.all([correlation('command'), randomToken]);
    const links = partyLinksOf(command);
    const referenceCredentials =
      links.length === 0 ? undefined : yield* makeReferenceGatewayCredentials(links.map(() => 'party-registry'));
    return yield* executeApplyCommand({ command, expectedRevision }, requestCorrelation, {
      idempotencyKey,
      ...(referenceCredentials === undefined ? {} : { referenceCredentials }),
    });
  });

/** Human-readable reason of a failed command (domain errors carry Czech reasons). */
export const commandErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    for (const field of ['detail', 'reason', 'title', 'message']) {
      const value = record[field];
      if (typeof value === 'string' && value !== '') {
        return value;
      }
    }
  }
  return undefined;
};

export interface CrmCommandOutcome {
  readonly ok: boolean;
  readonly entityIds: readonly string[];
  readonly message?: string;
}

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
  const load = useCallback(() => {
    browserRuntime.runFork(crmRecordsData.refresh(recordsInput(clientId)));
  }, [clientId]);
  const revision = snapshot.state === 'ready' ? snapshot.value.revision : 0;
  const submit = useCallback(
    (command: CrmCommand): Promise<CrmCommandOutcome> => {
      setBusy(true);
      return browserRuntime
        .runPromise(
          runCrmCommand(command, revision).pipe(
            // Another user changed the CRM since our last read (several personas demo at once): re-read the
            // current revision and try once more. Domain checks run again on the server, so this is safe.
            Effect.catchIf(isConflict, () =>
              loadCrmRecords().pipe(Effect.flatMap((latest) => runCrmCommand(command, latest.revision))),
            ),
            Effect.match({
              onFailure: (error): CrmCommandOutcome => {
                const message = commandErrorMessage(error);
                return message === undefined ? { entityIds: [], ok: false } : { entityIds: [], message, ok: false };
              },
              onSuccess: (result): CrmCommandOutcome => ({ entityIds: result.entityIds, ok: true }),
            }),
            Effect.tap(() => crmRecordsData.refresh(recordsInput(clientId))),
          ),
        )
        .then((outcome) => {
          setBusy(false);
          return outcome;
        });
    },
    [clientId, revision],
  );
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
