// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
// Shared browser data layer for every Siampark provoz page (owned by ops-scaffold; lanes import, do not fork).
//   const ops = useAgendaRecords(['assets']);
//   ops.data?.agendas.assets?.state.assets         -> typed agenda state
//   await ops.run({ _tag: 'AssetCreate', ... })     -> picks the owning agenda's revision, reloads on success
//   await uploadFile(file) / await downloadFile(fileId)
import { DateTime, Effect, Match, Random } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { executeApplyCommand } from '../api/apply-command-action-client.ts';
import { executeRecords } from '../api/records-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { agendaOfCommand } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { ApplyCommandResult } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse, StoredFile } from '../../shared/apis/records.ts';
import type { AgendaId } from '../../shared/domain/common.ts';
import type { StoredFileRef } from '../../shared/domain/documents.ts';

/** `conflict` = stale revision; `rejected` = business rule refused the change. */
export type FailureReason = 'conflict' | 'forbidden' | 'invalid' | 'rejected' | 'unavailable';

export type CommandOutcome =
  | { readonly ok: true; readonly result: ApplyCommandResult }
  | { readonly ok: false; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

const newId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second, third]) => `siampark-ops:${first}:${second}:${third}`,
);

const recordsReason = (error: RecordsFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('RecordsPolicyConflictProblem', (): FailureReason => 'conflict'),
    Match.tag('RecordsAuthenticationProblem', 'RecordsForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('GatewayAuthenticationRequiredProblem', 'GatewayForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('RecordsInvalidProblem', 'RecordsPolicyProblem', (): FailureReason => 'invalid'),
    Match.orElse((): FailureReason => 'unavailable'),
  );

const commandReason = (error: CommandFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('ApplyCommandActionConflictProblem', (problem): FailureReason =>
      problem.code === 'siampark_ops_lifecycle_conflict' ? 'rejected' : 'conflict',
    ),
    Match.tag('ApplyCommandActionIneligibleProblem', (): FailureReason => 'rejected'),
    Match.tag('ApplyCommandActionNotFoundProblem', (): FailureReason => 'rejected'),
    Match.tag(
      'ApplyCommandActionAuthenticationProblem',
      'ApplyCommandActionForbiddenProblem',
      (): FailureReason => 'forbidden',
    ),
    Match.tag('ApplyCommandActionInvalidProblem', (): FailureReason => 'invalid'),
    Match.orElse((): FailureReason => 'unavailable'),
  );

/** Runs the governed records read once. */
export const loadRecords = (
  request: { readonly agendas?: readonly AgendaId[]; readonly fileId?: string; readonly historyFor?: string } = {},
): Promise<{ readonly ok: true; readonly data: RecordsResponse } | { readonly ok: false; readonly reason: FailureReason }> =>
  browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((correlation) =>
        executeRecords(
          {
            ...(request.agendas === undefined ? {} : { agendas: [...request.agendas] }),
            ...(request.fileId === undefined ? {} : { fileId: request.fileId }),
            ...(request.historyFor === undefined ? {} : { historyFor: request.historyFor }),
          },
          correlation,
        ),
      ),
      Effect.match({
        onFailure: (error) => ({ ok: false as const, reason: recordsReason(error) }),
        onSuccess: (data) => ({ ok: true as const, data }),
      }),
    ),
  );

/**
 * One command through the single governed apply-command Action (fresh idempotency key per call).
 * `baseUpdatedAt` = `updatedAt` of the agenda data the command was built from: the server then reports a conflict
 * only when a record this command changes was edited by someone else in the meantime (per-record conflicts).
 */
export const runCommand = (
  command: OpsCommand,
  expectedRevision: number,
  baseUpdatedAt?: string,
): Promise<CommandOutcome> =>
  browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((idempotencyKey) =>
        executeApplyCommand(
          { command, expectedRevision, ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }) },
          idempotencyKey,
          { idempotencyKey },
        ),
      ),
      Effect.match({
        onFailure: (error): CommandOutcome => ({ ok: false, reason: commandReason(error) }),
        onSuccess: (result): CommandOutcome => ({ ok: true, result }),
      }),
    ),
  );

const readAsBase64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Uploads a browser File (≤ 5 MB). On success returns the snapshot to store in a documents command. */
export const uploadFile = async (
  file: File,
): Promise<{ readonly ok: true; readonly file: StoredFileRef } | { readonly ok: false; readonly reason: FailureReason }> => {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'invalid' };
  }
  const contentBase64 = await readAsBase64(file);
  const outcome = await runCommand(
    {
      _tag: 'FileUpload',
      contentBase64,
      mime: file.type === '' ? 'application/octet-stream' : file.type,
      name: file.name,
    },
    0,
  );
  if (!outcome.ok) {
    return outcome;
  }
  return outcome.result.file === undefined ? { ok: false, reason: 'unavailable' } : { ok: true, file: outcome.result.file };
};

/** Fetches a stored file through the governed read and saves it in the browser. */
export const downloadFile = async (fileId: string): Promise<{ readonly ok: boolean; readonly file?: StoredFile }> => {
  const outcome = await loadRecords({ agendas: [], fileId });
  if (!outcome.ok || outcome.data.file === undefined) {
    return { ok: false };
  }
  const stored = outcome.data.file;
  const binary = atob(stored.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: stored.mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = stored.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true, file: stored };
};

export type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden';

/** React hook: loads the given agendas, exposes typed data and a `run` that uses the right agenda revision. */
export const useAgendaRecords = (agendas: readonly AgendaId[]) => {
  const [data, setData] = useState<RecordsResponse | undefined>(undefined);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const latest = useRef(0);
  const key = agendas.join(',');

  const reload = useCallback(async () => {
    latest.current += 1;
    const ticket = latest.current;
    const outcome = await loadRecords({ agendas: key === '' ? [] : (key.split(',') as AgendaId[]) });
    if (ticket !== latest.current) {
      return;
    }
    if (outcome.ok) {
      setData(outcome.data);
      setStatus('ready');
    } else {
      setStatus(outcome.reason === 'forbidden' ? 'forbidden' : 'error');
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (command: OpsCommand): Promise<CommandOutcome> => {
      const agenda = agendaOfCommand(command)?.id;
      const envelope = agenda === undefined ? undefined : data?.agendas[agenda];
      const revision = envelope?.revision ?? 0;
      const base = envelope === undefined ? undefined : DateTime.formatIso(envelope.updatedAt);
      const outcome = await runCommand(command, revision, base);
      if (outcome.ok || outcome.reason === 'conflict') {
        await reload();
      }
      return outcome;
    },
    [data, reload],
  );

  const access = (agenda: AgendaId) => data?.access.find((entry) => entry.agenda === agenda);
  return { access, data, reload, run, status };
};
