// Browser data access for every CRM page (owned by crm-scaffold). One governed records read returns the
// ACL-projected aggregate; one governed apply-command Action changes it. Pages never filter for security.
import { Effect, Random } from 'effect';
import { useCallback, useEffect, useState } from 'react';
import type { CrmCommand } from '../../shared/actions/apply-command.ts';
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

/** Runs one CRM command with a fresh idempotency key against the revision the caller last saw. */
export const runCrmCommand = (command: CrmCommand, expectedRevision: number) =>
  Effect.all([correlation('command'), randomToken]).pipe(
    Effect.flatMap(([requestCorrelation, idempotencyKey]) =>
      executeApplyCommand({ command, expectedRevision }, requestCorrelation, { idempotencyKey }),
    ),
  );

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

/**
 * The CRM records of the signed-in principal plus `submit`, which runs a command against the current revision and
 * reloads on success. Use `state.kind === 'ready'` and `state.records.state` / `state.records.viewer`.
 */
export const useCrmRecords = (clientId?: string) => {
  const [state, setState] = useState<CrmRecordsState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void browserRuntime.runPromise(
      loadCrmRecords(clientId).pipe(
        Effect.match({
          onFailure: (error) => setState({ kind: isForbidden(error) ? 'forbidden' : 'error' }),
          onSuccess: (records) => setState({ kind: 'ready', records }),
        }),
      ),
    );
  }, [clientId]);
  useEffect(load, [load]);
  const submit = useCallback(
    (command: CrmCommand): Promise<CrmCommandOutcome> => {
      const revision = state.kind === 'ready' ? state.records.revision : 0;
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
          ),
        )
        .then((outcome) => {
          setBusy(false);
          load();
          return outcome;
        });
    },
    [load, state],
  );
  return { busy, load, state, submit };
};

/** Display name of a salesperson id, or undefined. */
export const salespersonName = (records: RecordsResponse, id: string | undefined) =>
  id === undefined ? undefined : records.state.salespeople.find((person) => person.id === id)?.name;

export const clientName = (records: RecordsResponse, id: string | undefined) =>
  id === undefined ? undefined : records.state.clients.items.find((client) => client.id === id)?.name;
