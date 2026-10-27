// Shared browser data layer for every Facility operations page (owned by ops-scaffold; lanes import, do not fork).
//   const ops = useAgendaRecords(['assets']);
//   ops.data?.agendas.assets?.state.assets         -> typed agenda state
//   yield* ops.run({ _tag: 'AssetCreate', ... })     -> picks the owning agenda's revision, re-reads on success
//   export const preloadPage = preloadAgendaRecords(['assets']) -> the Shell loads it before it reveals the page
//   browserRuntime.runPromise(uploadFile(file)) / browserRuntime.runPromise(downloadFile(fileId))
import { optionalField } from '../../shared/domain/common.ts';
import { Schema, DateTime, Effect, Match, Option, Random, Schedule } from 'effect';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import { useEffect, useSyncExternalStore } from 'react';
import { executeApplyCommand } from '../api/apply-command-action-client.ts';
import { executeRecords } from '../api/records-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { agendaIds, agendaOfCommand } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { ApplyCommandResult } from '../../shared/actions/apply-command.ts';
import type { AgendaId } from '../../shared/domain/common.ts';
import { BaseUpdatedAtSchema } from '../../shared/domain/change-log.ts';

/** `conflict` = stale revision; `rejected` = business rule refused the change. */
export const FailureReasonSchema = Schema.Literals(['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable']);
export type FailureReason = typeof FailureReasonSchema.Type;

export type CommandOutcome =
  | { readonly ok: true; readonly result: ApplyCommandResult }
  | { readonly ok: false; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

const newId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second, third]) => `facility-operations:${first}:${second}:${third}`,
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
      problem.code === 'facility_operations_lifecycle_conflict' ? 'rejected' : 'conflict',
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

/** Gateway / assertion hiccups (e.g. while the composition is republished) are retried before reporting „forbidden“. */
const transientAuthFailure = (error: RecordsFailure) =>
  Match.value(error).pipe(
    Match.tag(
      'RecordsAuthenticationProblem',
      'GatewayAuthenticationRequiredProblem',
      'GatewayReloadRequiredProblem',
      'GatewayUnavailableProblem',
      'RecordsUnavailableProblem',
      () => true,
    ),
    Match.orElse(() => false),
  );

/** The governed records read as an Effect (transient gateway failures are retried twice); failures stay typed. */
export const recordsRead = (request: {
  readonly agendas?: readonly AgendaId[];
  readonly fileId?: string;
  readonly historyFor?: string;
}) =>
  newId.pipe(
    Effect.flatMap((correlation) =>
      executeRecords(
        {
          ...optionalField('agendas', request.agendas === undefined ? undefined : [...request.agendas]),
          ...optionalField('fileId', request.fileId),
          ...optionalField('historyFor', request.historyFor),
        },
        correlation,
      ).pipe(Effect.retry({ schedule: Schedule.spaced('700 millis'), times: 2, while: transientAuthFailure })),
    ),
  );

/** Runs the governed read and maps its typed failure to the existing presentation outcome. */
export const loadRecords = (
  request: {
    readonly agendas?: readonly AgendaId[];
    readonly fileId?: string;
    readonly historyFor?: string;
  } = {},
) =>
  recordsRead(request).pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, reason: recordsReason(error) }),
      onSuccess: (data) => ({ data, ok: true as const }),
    }),
  );

/** One governed command, with a fresh idempotency key for every execution. */
export const runCommand = (command: OpsCommand, expectedRevision: number, baseUpdatedAt?: string) =>
  newId.pipe(
    Effect.flatMap((idempotencyKey) =>
      Schema.decodeEffect(Schema.OptionFromUndefinedOr(BaseUpdatedAtSchema))(baseUpdatedAt).pipe(
        Effect.flatMap((stamp) =>
          executeApplyCommand(
            { command, expectedRevision, ...optionalField('baseUpdatedAt', Option.getOrUndefined(stamp)) },
            idempotencyKey,
            {
              idempotencyKey,
            },
          ),
        ),
      ),
    ),
    Effect.match({
      onFailure: (error): CommandOutcome => ({ ok: false, reason: commandReason(error) }),
      onSuccess: (result): CommandOutcome => ({ ok: true, result }),
    }),
  );

class FileReadFailed extends Schema.TaggedError<FileReadFailed>()('FileReadFailed', {
  cause: Schema.Defect(),
}) {}

const readAsBase64 = (file: Blob) =>
  Effect.callback<string, FileReadFailed>((resume) => {
    const reader = new FileReader();
    const onLoad = () =>
      resume(
        Schema.decodeUnknownEffect(Schema.String)(reader.result).pipe(
          Effect.map((value) => value.slice(value.indexOf(',') + 1)),
          Effect.mapError((cause) => new FileReadFailed({ cause })),
        ),
      );
    const onError = () => resume(Effect.fail(new FileReadFailed({ cause: reader.error })));
    reader.addEventListener('load', onLoad);
    reader.addEventListener('error', onError);
    reader.addEventListener('abort', onError);
    reader.readAsDataURL(file);
    return Effect.sync(() => {
      reader.removeEventListener('load', onLoad);
      reader.removeEventListener('error', onError);
      reader.removeEventListener('abort', onError);
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
    });
  });

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Uploads a browser File (≤ 5 MB). On success returns the snapshot to store in a documents command. */
export const uploadFile = Effect.fn('FacilityOperations.uploadBrowserFile')(function* uploadFile(file: File) {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'invalid' } as const;
  }
  const contentBase64 = yield* readAsBase64(file);
  const outcome = yield* runCommand(
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
  return outcome.result.file === undefined
    ? { ok: false as const, reason: 'unavailable' as const }
    : { file: outcome.result.file, ok: true as const };
});

const fileDownloadFailureFields = { cause: Schema.Defect() };
const FileDownloadFailureSchema = Schema.TaggedStruct('FileDownloadFailed', fileDownloadFailureFields);
const FileDownloadFailed = Schema.TaggedError<Schema.Schema.Type<typeof FileDownloadFailureSchema>>()(
  'FileDownloadFailed',
  fileDownloadFailureFields,
);

/** Fetches a stored file through the governed read and saves it in the browser. */
export const downloadFile = Effect.fn('FacilityOperations.downloadBrowserFile')(function* downloadFile(fileId: string) {
  const outcome = yield* loadRecords({ agendas: [], fileId });
  if (!outcome.ok || outcome.data.file === undefined) {
    return { ok: false } as const;
  }
  const stored = outcome.data.file;
  const url = yield* Effect.try({
    catch: (cause) => new FileDownloadFailed({ cause }),
    try: () => {
      const binary = atob(stored.contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
      }
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: stored.mime }));
      let downloaded = false;
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = stored.name;
        anchor.click();
        downloaded = true;
        return objectUrl;
      } finally {
        if (!downloaded) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    },
  });
  yield* Effect.forkDetach(
    Effect.sleep('10 seconds').pipe(Effect.ensuring(Effect.sync(() => URL.revokeObjectURL(url)))),
  );
  return { file: stored, ok: true as const };
});

export const LoadStatusSchema = Schema.Literals(['loading', 'ready', 'error', 'forbidden']);
export type LoadStatus = typeof LoadStatusSchema.Type;

/** Canonical agenda list of one records read (registry order, no duplicates): every reader of the same agendas shares one store entry. */
const agendaSet = (agendas: readonly string[]): readonly AgendaId[] => {
  const wanted = new Set(agendas);
  return agendaIds.filter((id) => wanted.has(id));
};

/**
 * The agenda records of the signed-in principal, one entry per sorted agenda list. The Shell fills it through a page's
 * `preloadPage` before it reveals the page, so the page (and every panel reading the same agendas) renders real data
 * in its first commit and never starts a second read.
 */
export const agendaRecordsData = definePageData({
  key: (agendas: readonly AgendaId[]) => agendas.join(','),
  load: (agendas: readonly AgendaId[]) => recordsRead({ agendas }),
  runtime: browserRuntime,
});

/** `preloadPage` of a page that reads `agendas` (the same list it passes to `useAgendaRecords`). */
export const preloadAgendaRecords = (agendas: readonly AgendaId[]) => {
  const input = agendaSet(agendas);
  return modulePagePreload(() => agendaRecordsData.preload(input));
};

type AgendaSnapshot = ReturnType<typeof agendaRecordsData.snapshot>;

const statusOf = (snapshot: AgendaSnapshot): LoadStatus => {
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  if (snapshot.state === 'failed') {
    return recordsReason(snapshot.error) === 'forbidden' ? 'forbidden' : 'error';
  }
  return 'ready';
};

const idleSnapshot = (): AgendaSnapshot => pageDataPending;

/**
 * React hook: reads the given agendas from the shared store, exposes typed data and a `run` that uses the right agenda
 * revision. `enabled: false` reads nothing (for panels that use the page's records when it passes them).
 */
interface AgendaCommandContext {
  readonly agendas: readonly AgendaId[];
  readonly data: Effect.Success<ReturnType<typeof recordsRead>> | undefined;
}

const executeAgendaCommand = Effect.fn('FacilityOperations.runAgendaCommand')(function* agendaCommand(
  command: OpsCommand,
  context: AgendaCommandContext,
) {
  const agenda = agendaOfCommand(command)?.id;
  const envelope = agenda === undefined ? undefined : context.data?.agendas[agenda];
  const revision = envelope?.revision ?? 0;
  const base = envelope === undefined ? undefined : DateTime.formatIso(envelope.updatedAt);
  const outcome = yield* runCommand(command, revision, base);
  if (outcome.ok || outcome.reason === 'conflict') {
    yield* agendaRecordsData.refresh(context.agendas);
  }
  return outcome;
});

export const useAgendaRecords = (agendas: readonly AgendaId[], options: { readonly enabled?: boolean } = {}) => {
  const enabled = options.enabled ?? true;
  const key = agendaRecordsData.key(agendaSet(agendas));
  const input = agendaSet(key.split(','));
  const snapshot = useSyncExternalStore(
    agendaRecordsData.subscribe,
    enabled ? () => agendaRecordsData.snapshot(input) : idleSnapshot,
    idleSnapshot,
  );
  useEffect(() => {
    if (enabled) {
      agendaRecordsData.ensure(agendaSet(key.split(',')));
    }
  }, [enabled, key]);
  const data = snapshot.state === 'ready' ? snapshot.value : undefined;
  const reload = () => agendaRecordsData.refresh(input);
  const run = (command: OpsCommand) => executeAgendaCommand(command, { agendas: input, data });
  const access = (agenda: AgendaId) => data?.access.find((entry) => entry.agenda === agenda);
  return { access, data, reload, run, status: statusOf(snapshot) };
};
