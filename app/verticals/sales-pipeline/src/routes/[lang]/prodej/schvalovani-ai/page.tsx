// AI level C for Obchodní firma (specs AGENT.md §3): the agent PROPOSES changes of opportunities and orders; a person
// compares before -> after here and approves or rejects each one. An applied run can be reverted at once ("Vrátit vše").
// Opportunity proposals live in this module, order proposals in merchandise; both use the same approval engine
// (@app/shared-contracts/ai-approvals). Every decision is an audited Core Action of the approving person.
import { EmptyState, PageHeader, SectionCard, formatDateTime } from '@app/admin-ui';
import { executeApplyCommand as executeMerchandiseCommand } from '@app/merchandise/clients/apply-command';
import { executeRecords as executeMerchandiseRecords } from '@app/merchandise/clients/records';
import { aiLogActionLabel, aiRiskLabel, aiStatusLabel } from '@app/shared-contracts/ai-approvals';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { listEmployees } from '@app/workforce/clients/records';
import type { AiBatch, AiChange, AiLogEntry } from '@app/shared-contracts/ai-approvals';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect, Match, Option, Random, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import csResource from '../../../../../locales/cs/sales-pipeline.json';
import enResource from '../../../../../locales/en/sales-pipeline.json';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import '../../../index.css';
import { applyPipelineCommand } from '../prilezitosti/pipeline-api.ts';
import { salesPipelineAiCommandSchemas } from '../../../../../shared/actions/apply-command.ts';
import { usePipelineReferences } from '../prilezitosti/pipeline-references.ts';
import { allRecordsInput, pipelineRecords, usePipelineRecordsSnapshot } from '../prilezitosti/pipeline-records.ts';
import type { RecordsLoadError } from '../prilezitosti/pipeline-records.ts';
import './review.css';

const i18nResources = {
  cs: { 'sales-pipeline': csResource },
  en: { 'sales-pipeline': enResource },
} as const;

const ModuleKeySchema = Schema.Literals(['opportunities', 'orders']);
type ModuleKey = typeof ModuleKeySchema.Type;
const HumanAiCommandSchema = Schema.Union([salesPipelineAiCommandSchemas[1], salesPipelineAiCommandSchemas[2]]);
type AiCommand = typeof HumanAiCommandSchema.Type;
const decodeHumanAiCommand = Schema.decodeEffect(HumanAiCommandSchema);

interface ModuleSlice {
  readonly batches: readonly AiBatch[];
  readonly canWrite: boolean;
  readonly changes: readonly AiChange<unknown>[];
  readonly log: readonly AiLogEntry[];
  /** Customer (partyId) of every opportunity or order, so a target reads „title · customer“. */
  readonly partyOf: ReadonlyMap<string, string>;
  readonly revision: number;
}

type ModuleState =
  | { readonly status: 'loading' }
  | { readonly status: 'absent' }
  | { readonly status: 'error' }
  | ({ readonly status: 'ready' } & ModuleSlice);

const moduleLabel = { opportunities: 'Příležitosti', orders: 'Objednávky' } satisfies Readonly<
  Record<ModuleKey, string>
>;

/** One agent run: the batch of each module that the run produced (same agent, same runId). */
interface RunGroup {
  readonly agentLabel: string;
  readonly agentPrincipalId: string;
  readonly createdAt: AiBatch['createdAt'];
  readonly instruction: string;
  readonly key: string;
  readonly parts: readonly {
    readonly batch: AiBatch;
    readonly changes: readonly AiChange<unknown>[];
    readonly module: ModuleKey;
  }[];
}

const correlation = (name: string) => Random.nextInt.pipe(Effect.map((nonce) => `sales-pipeline:ai:${name}:${nonce}`));

/** Opportunity proposals come with the unfiltered records read the records page shares. */
const opportunitySlice = (response: RecordsResponse): ModuleSlice => ({
  batches: response.aiChanges?.batches ?? [],
  canWrite: response.canWrite,
  changes: response.aiChanges?.changes ?? [],
  log: response.aiChanges?.log ?? [],
  partyOf: new Map<string, string>(response.items.map((item) => [item.id, item.partyId] as const)),
  revision: response.revision,
});

/** Merchandise reads at most 250 orders by id per call. */
const ORDER_ID_BATCH = 250;

/** Customer of each proposed order: only the orders the proposals target, read by id. */
const orderPartiesOf = (changes: readonly AiChange<unknown>[]) => {
  const ids = [...new Set(changes.flatMap((change) => (change.target.id === undefined ? [] : [change.target.id])))];
  const batches = Array.from({ length: Math.ceil(ids.length / ORDER_ID_BATCH) }, (_, index) =>
    ids.slice(index * ORDER_ID_BATCH, (index + 1) * ORDER_ID_BATCH),
  );
  return Effect.forEach(
    batches,
    (orderIds) =>
      correlation('order-parties').pipe(
        Effect.flatMap((key) =>
          executeMerchandiseRecords({ view: { limit: 0, orderIds, ordersLimit: ORDER_ID_BATCH } }, key),
        ),
      ),
    { concurrency: 2 },
  ).pipe(
    Effect.map(
      (responses) =>
        new Map<string, string>(
          responses.flatMap((response) => response.orders.map((order) => [order.id, order.partyId] as const)),
        ),
    ),
  );
};

const loadOrders = correlation('orders').pipe(
  Effect.flatMap((key) => executeMerchandiseRecords({ view: { limit: 0, ordersLimit: 0 } }, key)),
  Effect.flatMap((response) =>
    orderPartiesOf(response.aiChanges?.changes ?? []).pipe(
      Effect.map((partyOf): ModuleSlice => ({
        batches: response.aiChanges?.batches ?? [],
        canWrite: response.canWrite,
        changes: response.aiChanges?.changes ?? [],
        log: response.aiChanges?.log ?? [],
        partyOf,
        revision: response.revision,
      })),
    ),
  ),
);

const OrdersLoadErrorSchema = Schema.Literals(['absent', 'error']);
type OrdersLoadError = typeof OrdersLoadErrorSchema.Type;

/** A refused read means the person has no access to order proposals; any other failure is an error. */
const ordersLoadError = (problem: Effect.Error<typeof loadOrders>): OrdersLoadError =>
  Match.value(problem).pipe(
    Match.tag('RecordsForbiddenProblem', () => 'absent' as const),
    Match.orElse(() => 'error' as const),
  );

/** Order proposals of one legal entity. */
const aiOrders = definePageData({
  key: (legalEntityId: string) => (legalEntityId === '' ? 'all' : legalEntityId),
  load: (_legalEntityId: string) => loadOrders.pipe(Effect.mapError(ordersLoadError)),
  runtime: browserRuntime,
});

const legalEntityOf = (props: Partial<ModulePageProps>): string => props.context?.legalEntityId ?? '';

/** The Shell prepares both proposal reads before it reveals the page. */
export const preloadPage = modulePagePreload(
  (props) => pipelineRecords.preload(allRecordsInput(legalEntityOf(props))),
  (props) => aiOrders.preload(legalEntityOf(props)),
);

const RefusalDetailSchema = Schema.Struct({ detail: Schema.optional(Schema.String) });

/** Readable reason of a refused command (the module answers Czech details for AI refusals). */
const refusal = (
  error:
    | Effect.Error<ReturnType<typeof applyPipelineCommand>>
    | Effect.Error<ReturnType<typeof sendOrders>>
    | Effect.Error<ReturnType<typeof decodeHumanAiCommand>>,
): string => {
  const detail = Schema.decodeUnknownOption(RefusalDetailSchema)(error).pipe(
    Option.flatMap((problem) => Option.fromUndefinedOr(problem.detail)),
    Option.getOrUndefined,
  );
  return detail !== undefined && !detail.startsWith('The ')
    ? detail
    : 'Záznam se mezitím změnil nebo k akci nemáte oprávnění.';
};

const sendOrders = Effect.fn('SalesPipeline.sendAiOrderCommand')(
  function* sendOrders(command: AiCommand) {
    const key = yield* correlation('orders-command');
    const { revision } = yield* executeMerchandiseRecords({ view: { limit: 0, ordersLimit: 0 } }, `${key}:revision`);
    return yield* executeMerchandiseCommand({ command, expectedRevision: revision }, key, { idempotencyKey: key });
  },
  // Storefront orders bump the merchandise revision at any time: re-read once and send again.
  Effect.retry({
    times: 1,
    while: (error) =>
      Match.value(error).pipe(
        Match.tag('ApplyCommandActionConflictProblem', (problem) => problem.code === 'merchandise_revision_conflict'),
        Match.orElse(() => false),
      ),
  }),
);

/** Failure is the readable reason shown to the approver. */
const sendCommand = (module: ModuleKey, command: AiCommand, revision: number): Effect.Effect<void, string> =>
  decodeHumanAiCommand(command).pipe(
    Effect.mapError(refusal),
    Effect.flatMap((parsed) =>
      module === 'opportunities'
        ? applyPipelineCommand(parsed, revision).pipe(Effect.asVoid, Effect.mapError(refusal))
        : sendOrders(parsed).pipe(Effect.asVoid, Effect.mapError(refusal)),
    ),
  );

/** Principal id -> employee name, so decisions show who approved them (people only; agents have their label). */
const usePrincipalNames = () => {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    void browserRuntime.runPromise(
      listEmployees().pipe(
        Effect.map((items) =>
          items.flatMap((item) =>
            item.principalRef === undefined ? [] : [[item.principalRef.principalId, item.fullName] as const],
          ),
        ),
        Effect.tap((entries) =>
          Effect.sync(() => {
            if (active) {
              setNames(new Map(entries));
            }
          }),
        ),
        Effect.result,
      ),
    );
    return () => {
      active = false;
    };
  }, []);
  return names;
};

const moduleStateOf = <A, E>(
  snapshot: PageDataSnapshot<A, E>,
  slice: (value: A) => ModuleSlice,
  absent: (error: E) => boolean,
): ModuleState => {
  if (snapshot.state === 'ready') {
    return { status: 'ready', ...slice(snapshot.value) };
  }
  if (snapshot.state === 'failed') {
    return { status: absent(snapshot.error) ? 'absent' : 'error' };
  }
  return { status: 'loading' };
};

/** Both proposal reads, ready in the first render when the Shell prepared the page. */
const useProposalModules = (legalEntityId: string) => {
  const recordsInput = allRecordsInput(legalEntityId);
  const recordsSnapshot = usePipelineRecordsSnapshot(recordsInput);
  const ordersSnapshot = useSyncExternalStore(
    aiOrders.subscribe,
    () => aiOrders.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => aiOrders.ensure(legalEntityId), [legalEntityId]);
  const opportunities = moduleStateOf(
    recordsSnapshot,
    opportunitySlice,
    (failure: RecordsLoadError) => failure === 'forbidden',
  );
  const orders = moduleStateOf(
    ordersSnapshot,
    (slice: ModuleSlice) => slice,
    (failure) => failure === 'absent',
  );
  const refresh = () => {
    void browserRuntime.runPromise(
      Effect.all([pipelineRecords.refresh(recordsInput), aiOrders.refresh(legalEntityId)], {
        concurrency: 2,
        discard: true,
      }),
    );
  };
  return { opportunities, orders, refresh };
};

const groupRuns = (modules: Readonly<Record<ModuleKey, ModuleState>>): readonly RunGroup[] => {
  const groups = new Map<string, { group: RunGroup; parts: RunGroup['parts'][number][] }>();
  for (const module of ['opportunities', 'orders'] as const) {
    const state = modules[module];
    if (state.status !== 'ready') {
      continue;
    }
    for (const batch of state.batches) {
      const key = `${batch.agentPrincipalId}|${batch.runId ?? batch.id}`;
      const part = { batch, changes: state.changes.filter((change) => change.batchId === batch.id), module };
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          group: {
            agentLabel: batch.agentLabel,
            agentPrincipalId: batch.agentPrincipalId,
            createdAt: batch.createdAt,
            instruction: batch.instruction,
            key,
            parts: [],
          },
          parts: [part],
        });
      } else {
        existing.parts.push(part);
      }
    }
  }
  return [...groups.values()]
    .map(({ group, parts }) => ({ ...group, parts }))
    .toSorted((left, right) => DateTime.Order(right.createdAt, left.createdAt));
};

const changeStatusVariant = {
  applied: 'success',
  failed: 'secondary',
  pending: 'warning',
  rejected: 'secondary',
  reverted: 'secondary',
} as const;

const ChangeCard = ({
  busy,
  canWrite,
  change,
  decide,
  targetLabel,
  valueLabel,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly change: AiChange<unknown>;
  readonly decide: (ids: readonly AiChange<unknown>['id'][], decision: 'approve' | 'reject') => void;
  readonly targetLabel: string;
  readonly valueLabel: (field: string, value: string | undefined) => string | undefined;
}) => (
  <article className="sp-ai-review-change" data-change-id={change.id}>
    <div className="sp-ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{change.summary}</h3>
        <p className="text-fg-secondary text-sm">{targetLabel}</p>
      </div>
      <div className="sp-ai-review-actions">
        <Badge variant={changeStatusVariant[change.status]}>{aiStatusLabel[change.status]}</Badge>
        <span className="text-fg-secondary text-xs">{aiRiskLabel[change.risk]}</span>
      </div>
    </div>
    <p className="sp-ai-review-reason">
      <span className="font-medium">Proč AI změnu navrhuje: </span>
      {change.reason}
    </p>
    <Table aria-label={`Porovnání: ${change.summary}`} className="sp-ai-review-diff" size="sm">
      <Table.Header>
        <Table.Row className="sp-ai-review-diff-head">
          <Table.ColumnHeader>Údaj</Table.ColumnHeader>
          <Table.ColumnHeader>Před změnou</Table.ColumnHeader>
          <Table.ColumnHeader>Po schválení</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {change.diff.map((line) => (
          <Table.Row className="sp-ai-review-diff-row" key={line.field}>
            <Table.Cell className="font-medium">{line.label}</Table.Cell>
            <Table.Cell className="sp-ai-review-before">
              {valueLabel(line.field, line.before) ?? 'Neuvedeno'}
            </Table.Cell>
            <Table.Cell className="sp-ai-review-after">{valueLabel(line.field, line.after) ?? 'Vymazáno'}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
    {change.failure !== undefined && change.failure !== '' && (
      <p className="text-sm" role="alert">
        Změnu nelze provést: {change.failure}
      </p>
    )}
    {change.decisionNote !== undefined && change.decisionNote !== '' && (
      <p className="text-fg-secondary text-sm">Poznámka schvalovatele: {change.decisionNote}</p>
    )}
    {change.status === 'pending' && canWrite && (
      <div className="sp-ai-review-actions sp-ai-review-end">
        <Button
          disabled={busy}
          onClick={() => decide([change.id], 'reject')}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zamítnout změnu
        </Button>
        <Button disabled={busy} onClick={() => decide([change.id], 'approve')} size="sm">
          Schválit změnu
        </Button>
      </div>
    )}
  </article>
);

const RunCard = ({
  busy,
  canWrite,
  group,
  nameOf,
  run,
  targetLabel,
  valueLabel,
}: {
  readonly busy: boolean;
  readonly canWrite: (module: ModuleKey) => boolean;
  readonly group: RunGroup;
  readonly nameOf: (principalId: string | undefined) => string;
  readonly run: (
    steps: readonly { readonly command: AiCommand; readonly module: ModuleKey }[],
    success: string,
  ) => void;
  readonly targetLabel: (module: ModuleKey, change: AiChange<unknown>) => string;
  readonly valueLabel: (field: string, value: string | undefined) => string | undefined;
}) => {
  const { t } = useModernI18n();
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = group.parts.flatMap((part) =>
    part.changes.flatMap((change) => (change.status === 'pending' ? [{ change, module: part.module }] : [])),
  );
  const decidable = pending.filter((entry) => canWrite(entry.module));
  const revertible = group.parts.filter(
    (part) => part.batch.revertedAt === undefined && part.changes.some((change) => change.status === 'applied'),
  );
  const reverted = group.parts.find((part) => part.batch.revertedAt !== undefined)?.batch;
  const decideMany = (
    entries: readonly { readonly change: Pick<AiChange<unknown>, 'id'>; readonly module: ModuleKey }[],
    decision: 'approve' | 'reject',
  ) => {
    const steps = (['opportunities', 'orders'] as const).flatMap((module) => {
      const ids = entries.flatMap((entry) => (entry.module === module ? [entry.change.id] : []));
      if (ids.length === 0) {
        return [];
      }
      const command: AiCommand = { _tag: 'AiDecideChanges', changeIds: ids, decision };
      return [{ command: note.trim() === '' ? command : { ...command, note: note.trim() }, module }];
    });
    run(
      steps,
      decision === 'approve'
        ? 'Rozhodnutí uloženo a změny provedeny. Výsledek vidíte u jednotlivých změn.'
        : 'Návrhy zamítnuty. Data zůstala beze změny.',
    );
  };
  const decideOne = (module: ModuleKey) => (ids: readonly AiChange<unknown>['id'][], decision: 'approve' | 'reject') =>
    decideMany(
      ids.map((id) => ({ change: { id }, module })),
      decision,
    );
  let batchVariant: 'secondary' | 'success' | 'warning' = 'secondary';
  let batchLabel = 'Dávka vrácena';
  if (reverted === undefined) {
    batchLabel = 'Vyřízeno';
    if (pending.length > 0) {
      batchVariant = 'warning';
      batchLabel = `${pending.length} ke schválení`;
    } else if (revertible.length > 0) {
      batchVariant = 'success';
      batchLabel = 'Změny provedeny';
    }
  }
  return (
    <section className="sp-ai-review-batch" data-run-key={group.key}>
      <header className="sp-ai-review-batch-header">
        <div className="sp-ai-review-heading">
          <div>
            <p className="text-fg-secondary text-xs">
              {formatDateTime(DateTime.formatIso(group.createdAt))} · {group.agentLabel} ·{' '}
              {group.parts.map((part) => moduleLabel[part.module]).join(' + ')}
            </p>
            <h2 className="sp-ai-review-instruction">{group.instruction}</h2>
          </div>
          <Badge variant={batchVariant}>{batchLabel}</Badge>
        </div>
        {pending.length > decidable.length && (
          <p className="text-fg-secondary text-sm">
            Část změn může schválit jen uživatel s právem zápisu do daného modulu (
            {[...new Set(pending.flatMap((entry) => (canWrite(entry.module) ? [] : [moduleLabel[entry.module]])))].join(
              ', ',
            )}
            ).
          </p>
        )}
        {decidable.length > 0 && (
          <>
            <FormInput
              id={`note-${group.key}`}
              label={t('sales-pipeline.aiReview.decisionNote')}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('sales-pipeline.aiReview.decisionNotePlaceholder')}
              value={note}
            />
            <div className="sp-ai-review-actions">
              <Button disabled={busy} onClick={() => decideMany(decidable, 'approve')} size="sm">
                Schválit dávku ({decidable.length})
              </Button>
              <Button
                disabled={busy}
                onClick={() => decideMany(decidable, 'reject')}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Zamítnout dávku
              </Button>
            </div>
          </>
        )}
        {revertible.length > 0 && revertible.every((part) => canWrite(part.module)) && (
          <div className="sp-ai-review-revert">
            <Button
              disabled={busy}
              onClick={() => setConfirmRevert(!confirmRevert)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Vrátit vše
            </Button>
            <span className="text-fg-secondary text-xs">
              Obnoví původní údaje celé dávky. Když záznam mezitím změnil člověk, nic nepřepíše.
            </span>
            {confirmRevert && (
              <div className="sp-ai-review-confirm" role="alert">
                <p>
                  Vrátit všechny provedené změny této dávky? Nově založené příležitosti archivujeme, skladové pohyby
                  objednávek vyrovnáme protipohybem. Historie zůstane zachována.
                </p>
                <div className="sp-ai-review-actions">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setConfirmRevert(false);
                      run(
                        revertible.map((part) => ({
                          command: {
                            _tag: 'AiRevertBatch',
                            batchId: part.batch.id,
                            note: note.trim() === '' ? 'Vráceno na žádost schvalovatele' : note.trim(),
                          } as const,
                          module: part.module,
                        })),
                        'Celá dávka vrácena. Původní údaje obnoveny, historie zachována.',
                      );
                    }}
                    size="sm"
                  >
                    Potvrdit vrácení celé dávky
                  </Button>
                  <Button onClick={() => setConfirmRevert(false)} size="sm" theme="outlined" variant="secondary">
                    Zrušit
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {reverted?.revertedAt !== undefined && (
          <p className="text-fg-secondary text-xs">
            Vráceno {formatDateTime(DateTime.formatIso(reverted.revertedAt))} · {nameOf(reverted.revertedBy)}
          </p>
        )}
      </header>
      {group.parts.map((part) => (
        <div className="sp-ai-review-changes" key={part.batch.id}>
          <p className="text-fg-secondary text-xs font-medium">{moduleLabel[part.module]}</p>
          {part.changes.map((change) => (
            <ChangeCard
              busy={busy}
              canWrite={canWrite(part.module)}
              change={change}
              decide={decideOne(part.module)}
              key={change.id}
              targetLabel={targetLabel(part.module, change)}
              valueLabel={valueLabel}
            />
          ))}
        </div>
      ))}
    </section>
  );
};

const proposalOverview = (
  modules: Readonly<Record<ModuleKey, ModuleState>>,
  groups: readonly RunGroup[],
  filter: 'all' | 'pending',
) => {
  const { opportunities, orders } = modules;
  const loading = opportunities.status === 'loading' || orders.status === 'loading';
  const noAccess = opportunities.status !== 'ready' && orders.status !== 'ready' && !loading;
  const visibleGroups = groups.filter(
    (group) =>
      filter === 'all' || group.parts.some((part) => part.changes.some((change) => change.status === 'pending')),
  );
  const log = (['opportunities', 'orders'] as const)
    .flatMap((module) => {
      const state = modules[module];
      return state.status === 'ready' ? state.log.map((entry) => ({ entry, module })) : [];
    })
    .toSorted((left, right) => DateTime.Order(right.entry.at, left.entry.at));
  return { loading, log, noAccess, visibleGroups };
};

const AiApprovalLog = ({
  log,
  nameOf,
  onToggle,
  showFullLog,
}: {
  readonly log: ReturnType<typeof proposalOverview>['log'];
  readonly nameOf: (principalId: string | undefined) => string;
  readonly onToggle: () => void;
  readonly showFullLog: boolean;
}) => {
  const { t } = useModernI18n();
  return (
    <SectionCard title={t('sales-pipeline.aiReview.logTitle')}>
      {log.length === 0 ? (
        <p className="text-fg-secondary text-sm">Deník se naplní prvním návrhem AI.</p>
      ) : (
        <ol className="sp-ai-review-log">
          {log.slice(0, showFullLog ? log.length : 8).map(({ entry, module }) => (
            <li key={`${module}:${entry.id}`}>
              <div className="text-fg-secondary text-xs">
                {formatDateTime(DateTime.formatIso(entry.at))} · {moduleLabel[module]} ·{' '}
                {nameOf(entry.actorPrincipalId)} · {entry.actorKind === 'agent' ? 'AI návrh' : 'Rozhodnutí člověka'}
              </div>
              <p className="text-sm">{entry.message}</p>
              <span className="text-fg-secondary text-xs">{aiLogActionLabel[entry.action]}</span>
            </li>
          ))}
        </ol>
      )}
      {log.length > 8 && (
        <Button onClick={onToggle} size="sm" theme="outlined" variant="secondary">
          {showFullLog ? 'Zobrazit jen poslední události' : `Zobrazit celý deník (${log.length})`}
        </Button>
      )}
    </SectionCard>
  );
};

const AiApprovalsContent = ({ legalEntityId }: { readonly legalEntityId: string }) => {
  const { t } = useModernI18n();
  const { opportunities, orders, refresh } = useProposalModules(legalEntityId);
  const references = usePipelineReferences();
  const principalNames = usePrincipalNames();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [showFullLog, setShowFullLog] = useState(false);
  const modules = { opportunities, orders };
  const groups = groupRuns(modules);
  const employeeNames = new Map<string, string>(
    references.employees.status === 'ready'
      ? references.employees.items.map((employee) => [employee.id, employee.fullName])
      : [],
  );
  const customerNames = new Map<string, string>(
    references.customers.status === 'ready'
      ? references.customers.items.map((customer) => [customer.id, customer.name ?? 'Zákazník bez názvu'])
      : [],
  );
  const valueLabel = (field: string, value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (field === 'ownerEmployeeId') {
      return employeeNames.get(value) ?? 'Obchodník mimo seznam';
    }
    if (field === 'partyId') {
      return customerNames.get(value) ?? 'Zákazník mimo seznam';
    }
    return value;
  };
  const targetLabel = (module: ModuleKey, change: AiChange<unknown>) => {
    const state = modules[module];
    const partyId =
      state.status === 'ready' && change.target.id !== undefined ? state.partyOf.get(change.target.id) : undefined;
    const customer = partyId === undefined ? undefined : customerNames.get(partyId);
    return customer === undefined || change.target.label.includes(customer)
      ? change.target.label
      : `${change.target.label} · ${customer}`;
  };
  const nameOf = (principalId: string | undefined) => {
    if (principalId === undefined) {
      return 'neznámý účet';
    }
    const agent = groups.find((group) => group.agentPrincipalId === principalId);
    return agent?.agentLabel ?? principalNames.get(principalId) ?? `účet ${principalId.slice(0, 8)}…`;
  };
  const canWrite = (module: ModuleKey) => {
    const state = modules[module];
    return state.status === 'ready' && state.canWrite;
  };
  const run = (steps: readonly { readonly command: AiCommand; readonly module: ModuleKey }[], success: string) => {
    setBusy(true);
    setMessage('');
    void browserRuntime.runPromise(
      Effect.forEach(
        steps,
        (step) => {
          const state = modules[step.module];
          return sendCommand(step.module, step.command, state.status === 'ready' ? state.revision : 0);
        },
        { concurrency: 1, discard: true },
      ).pipe(
        Effect.match({
          onFailure: (reason) => `Akci se nepodařilo dokončit: ${reason}`,
          onSuccess: () => success,
        }),
        Effect.tap((text) =>
          Effect.sync(() => {
            setMessage(text);
            setBusy(false);
            refresh();
          }),
        ),
      ),
    );
  };

  const { loading, log, noAccess, visibleGroups } = proposalOverview(modules, groups, filter);

  return (
    <div className="flex flex-col gap-250">
      <Helmet>
        <title>AI změny ke schválení</title>
        <meta content="noindex, nofollow" name="robots" />
      </Helmet>
      <PageHeader
        actions={
          <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            Obnovit seznam
          </Button>
        }
        description="AI připraví návrh změn příležitostí a objednávek. Vy porovnáte údaje a rozhodnete. Bez vašeho souhlasu se nic nezmění."
        meta={<Badge variant="secondary">Úroveň C</Badge>}
        title={t('sales-pipeline.pages.ai.title')}
      />
      {loading ? <p className="text-fg-secondary text-sm">Načítám návrhy AI…</p> : null}
      {!loading && noAccess && (
        <EmptyState
          description="Schvalovat změny AI může uživatel s právem zápisu do příležitostí nebo objednávek. Zkuste seznam obnovit."
          title={t('sales-pipeline.aiReview.unavailableTitle')}
        />
      )}
      {!loading && !noAccess && (
        <div className="sp-ai-review">
          <div className="sp-ai-review-safety">
            <span aria-hidden className="icon-[mdi--shield-check-outline] size-250" />
            <p>
              <strong>Pod kontrolou člověka.</strong> Agent úrovně C smí příležitosti a objednávky pouze navrhovat.
              Přímý zápis mu systém odmítne. Každé rozhodnutí má autora, čas a výsledek v auditu. Provedenou dávku lze
              vrátit.
            </p>
          </div>
          {(opportunities.status === 'error' || orders.status === 'error') && (
            <p className="text-sm" role="alert">
              Část návrhů se nepodařilo načíst ({opportunities.status === 'error' ? 'Příležitosti' : 'Objednávky'}).
              Zkuste seznam obnovit.
            </p>
          )}
          <fieldset aria-label={t('sales-pipeline.aiReview.batchDisplayLabel')} className="sp-ai-review-actions">
            <Button
              aria-pressed={filter === 'pending'}
              onClick={() => setFilter('pending')}
              size="sm"
              theme={filter === 'pending' ? 'solid' : 'outlined'}
              variant={filter === 'pending' ? 'primary' : 'secondary'}
            >
              Ke schválení
            </Button>
            <Button
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
              size="sm"
              theme={filter === 'all' ? 'solid' : 'outlined'}
              variant={filter === 'all' ? 'primary' : 'secondary'}
            >
              Všechny dávky
            </Button>
          </fieldset>
          {message !== '' && <output className="sp-ai-review-feedback">{message}</output>}
          {visibleGroups.length === 0 ? (
            <EmptyState
              description={
                filter === 'pending'
                  ? 'Hotová rozhodnutí a možnost vrácení najdete ve Všech dávkách.'
                  : 'Připojte agenta s profilem C a požádejte ho o úpravu příležitosti nebo objednávky. Návrh se uloží sem, nikoli přímo do dat.'
              }
              title={filter === 'pending' ? 'Žádné změny nečekají na schválení' : 'Zatím nemáte návrhy AI'}
            />
          ) : (
            visibleGroups.map((group) => (
              <RunCard
                busy={busy}
                canWrite={canWrite}
                group={group}
                key={group.key}
                nameOf={nameOf}
                run={run}
                targetLabel={targetLabel}
                valueLabel={valueLabel}
              />
            ))
          )}
          <AiApprovalLog
            log={log}
            nameOf={nameOf}
            onToggle={() => setShowFullLog(!showFullLog)}
            showFullLog={showFullLog}
          />
        </div>
      )}
    </div>
  );
};

export const AiApprovalsPage = (props: Partial<ModulePageProps>) => (
  <FederatedI18nBoundary
    defaultNamespace="sales-pipeline"
    fallbackLanguage="en"
    resources={i18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <AiApprovalsContent legalEntityId={legalEntityOf(props)} />
  </FederatedI18nBoundary>
);

export default AiApprovalsPage;
