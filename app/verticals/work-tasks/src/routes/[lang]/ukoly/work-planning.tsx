import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import {
  EmptyState,
  SaveBar,
  SectionCard,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome, SaveState } from '@app/admin-ui';
import {
  CheckboxField,
  Field,
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { assignmentLabel, principalKey } from '../../../../shared/assignment.ts';
import { assignmentOptions, selectedPrincipal } from './assignment-options.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useState } from 'react';
import type { WorkCommand } from '../../../../shared/actions/apply-command.ts';
import { PlanningCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type { AssignmentPrincipal, RecordsResponse, WorkProject } from '../../../../shared/apis/records.ts';
import { formatDueDate, isOpenTask, selectOption, todayIsoDate } from './tasks-model.ts';
import { ChangeHistory } from './change-history.tsx';
import { pendingProposal, planAnswer, PlanCommittedSchema, PlanProposedSchema } from './planning-proposal.ts';
import type { PlanOutcome } from './planning-proposal.ts';

const states = { ACTIVE: 'Aktivní', DONE: 'Dokončený', PAUSED: 'Pozastavený', PLANNED: 'Plánovaný' } as const;
const hoursFormatter = new Intl.NumberFormat('cs-CZ');
/** A milestone's `editorKey`: it keys the row for React, and no control shows it. */
const RowIdentity = (_props: FormReact.FieldComponentProps<number>) => null;
const CreateProjectSchema = PlanningCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.CreateProject;

/**
 * The plan of one project as the panel edits it. The title, the period and the milestones are the CreateProject
 * payload's own; the responsible person and the state hold what their lists show. Uložit sends the plan through the
 * panel's one save, so the form itself only holds it.
 */
const projectForm = FormReact.make(
  fromPayload(CreateProjectSchema.mapFields(Struct.pick(['plannedEnd', 'plannedStart', 'title'])))
    .addField(
      Field.makeArrayField(
        'milestones',
        // The row's identity on screen, so removing a milestone never hands its inputs to the next one.
        Schema.Struct({ ...CreateProjectSchema.fields.milestones.value.fields, editorKey: Schema.Number }),
      ),
    )
    .addField('responsiblePrincipalRef', Schema.String)
    .addField('state', Schema.String),
  {
    fields: {
      milestones: { completed: CheckboxField, dueDate: TextField, editorKey: RowIdentity, title: TextField },
      plannedEnd: TextField,
      plannedStart: TextField,
      responsiblePrincipalRef: SelectTemplateField,
      state: SelectTemplateField,
      title: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type Draft = typeof projectForm.schema.Encoded;
type Apply = (command: WorkCommand, onDone: (outcome: PlanOutcome) => void) => void;
/** A plan of one project (or of the new one) that waits for approval, with the message that says so. */
interface ProposedPlan {
  readonly command: typeof PlanningCommandSchema.Type;
  readonly message: string;
}

/**
 * Which proposals a panel sees: those made against this version of the project (or for a new one). Once the project
 * changes, for example because the proposal was approved, an older proposal no longer holds the plan back.
 */
const proposalKey = (project: WorkProject | undefined) =>
  project === undefined ? 'new' : `${project.id}@${DateTime.toEpochMillis(project.updatedAt)}`;

/** Display identity follows content; identical text rows are distinguished only within their own group. */
const milestoneDisplayItems = (milestones: WorkProject['milestones']) => {
  const occurrences = new Map<string, number>();
  return milestones.map((milestone) => {
    const { completed, dueDate, title } = milestone;
    const content = `${completed ? '1' : '0'}:${dueDate.length}:${dueDate}:${title.length}:${title}`;
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { key: `${content}:${occurrence}`, milestone };
  });
};

const initial = (project: WorkProject | undefined): Draft => ({
  milestones: (project?.milestones ?? []).map((milestone, editorKey) => ({ ...milestone, editorKey })),
  plannedEnd: project?.plannedEnd ?? todayIsoDate(),
  plannedStart: project?.plannedStart ?? todayIsoDate(),
  responsiblePrincipalRef:
    project?.responsiblePrincipalRef === undefined ? '' : principalKey(project.responsiblePrincipalRef),
  state: project?.state ?? 'PLANNED',
  title: project?.title ?? '',
});

const projectFieldLabels = {
  milestones: 'Milníky',
  plannedEnd: 'Plánovaný konec',
  plannedStart: 'Plánovaný začátek',
  responsiblePrincipalRef: 'Odpovědná osoba',
  state: 'Stav',
  title: 'Název projektu',
};

/** Two plans are the same when every typed field and milestone matches; the editor keys are only for rendering. */
const sameDraft = (left: Draft, right: Draft) =>
  left.title === right.title &&
  left.plannedStart === right.plannedStart &&
  left.plannedEnd === right.plannedEnd &&
  left.state === right.state &&
  left.responsiblePrincipalRef === right.responsiblePrincipalRef &&
  left.milestones.length === right.milestones.length &&
  left.milestones.every(
    (milestone, index) =>
      milestone.title === right.milestones[index]?.title &&
      milestone.dueDate === right.milestones[index]?.dueDate &&
      milestone.completed === right.milestones[index]?.completed,
  );

// The period rule: the project ends after it starts, and every milestone falls inside it.
const periodOk = (value: Draft) =>
  value.plannedStart <= value.plannedEnd &&
  value.milestones.every(
    (milestone) => milestone.dueDate >= value.plannedStart && milestone.dueDate <= value.plannedEnd,
  );

// A project plan carries no revision, so a revision conflict cannot happen here.
const handleNoReloadLatest = constVoid;

/**
 * Rendered inside FormRoot, which renders its children only once this panel initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so the values are read only after `onReady`.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

export const ProjectEditor = ({
  actorName,
  close,
  onApply,
  onProposed,
  principalNames,
  principals,
  project,
  proposed,
}: {
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly close: () => void;
  readonly onApply: Apply;
  readonly onProposed: (plan: ProposedPlan) => void;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly principals: readonly AssignmentPrincipal[];
  readonly project: WorkProject | undefined;
  readonly proposed: Option.Option<ProposedPlan>;
}) => {
  const { language, t } = useModernI18n();
  const historyValue = (field: string, value: string | undefined): string => {
    if (value === undefined) {
      return '—';
    }
    if (field === 'state') {
      return Object.entries(states).find(([state]) => state === value)?.[1] ?? value;
    }
    if (field === 'plannedStart' || field === 'plannedEnd') {
      return formatDueDate(value);
    }
    if (field === 'responsiblePrincipalRef') {
      return principalNames.get(value) ?? 'Účet mimo seznam';
    }
    if (field === 'milestones') {
      return value.replaceAll(/\d{4}-\d{2}-\d{2}/gu, (date) => formatDueDate(date));
    }
    return value;
  };
  const opened = initial(project);
  const [ready, setReady] = useState(false);
  const draft = Option.getOrElse(
    Option.filter(useAtomValue(projectForm.values), () => ready),
    () => opened,
  );
  const setValues = useAtomSet(projectForm.setValues);
  const [failure, setFailure] = useState<string>();
  const planOf = (value: Draft) => {
    const input = {
      _tag: project === undefined ? 'CreateProject' : 'UpdateProject',
      ...value,
      milestones: value.milestones.map(({ completed, dueDate, title }) => ({ completed, dueDate, title })),
      responsiblePrincipalRef:
        selectedPrincipal(principals, value.responsiblePrincipalRef) ??
        (project?.responsiblePrincipalRef !== undefined &&
        principalKey(project.responsiblePrincipalRef) === value.responsiblePrincipalRef
          ? project.responsiblePrincipalRef
          : undefined),
    };
    if (project !== undefined) {
      Object.assign(input, { id: project.id });
    }
    return Schema.decodeUnknownOption(PlanningCommandSchema)(input);
  };
  const record = useDraftSave<Draft, never>({
    equals: sameDraft,
    isValid: (value) => Option.isSome(planOf(value)) && periodOk(value),
    runtime: browserRuntime,
    // Save sends the whole plan once; the answer decides whether the panel closes, parks the plan or shows why not.
    save: (value) =>
      Effect.callback<SaveOutcome>((resume) => {
        const sent = planOf(value);
        if (Option.isNone(sent)) {
          resume(Effect.succeed('failed'));
          return;
        }
        setFailure(undefined);
        onApply(sent.value, (outcome) => {
          const answer = planAnswer(outcome);
          if (Schema.is(PlanCommittedSchema)(answer)) {
            close();
            resume(Effect.succeed('saved'));
            return;
          }
          if (Schema.is(PlanProposedSchema)(answer)) {
            onProposed({ command: sent.value, message: answer.message });
            resume(Effect.succeed('proposed'));
            return;
          }
          setFailure(answer.message);
          resume(Effect.succeed('failed'));
        });
      }),
    value: draft,
  });
  const busy = record.status === 'saving';
  // The exact plan already waits for approval: it is shown as pending and cannot be sent again.
  const pendingPlan = pendingProposal(proposed, planOf(draft));
  const status: SaveState = Option.isSome(pendingPlan) ? 'proposed' : record.status;
  // Nothing in this panel is sent except by its Save button; every way out asks first while the draft is unsaved.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setValues(record.confirmed),
  });
  const labels = saveLabelsFor(language);
  const handleSave = record.save;
  const requiredLabel = requiredLabelFor(language);
  // The title, the period and the milestones are checked by the payload's own schemas; their messages read as one.
  const translateMessage = (message: string) => t(message, { defaultValue: t('work-tasks.planning.invalidPlan') });
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" disabled={busy} onClick={() => guard.request(close)} severity="secondary">
              Zrušit
            </Button>
            <SaveBar
              error={failure}
              labels={labels}
              onReloadLatest={handleNoReloadLatest}
              onSave={handleSave}
              status={status}
            />
          </>
        }
        guard={guard}
        onOpenChange={(open) => {
          if (!open && !busy) {
            close();
          }
        }}
        open
        resizeLabel="Změnit šířku panelu"
        size="lg"
        title={project === undefined ? 'Nový projekt' : 'Upravit projekt'}
      >
        <div className="flex flex-col gap-200 py-200">
          {record.status === 'invalid' && (
            <StatusText status="error">{t('work-tasks.planning.invalidPlan')}</StatusText>
          )}
          {Option.isSome(pendingPlan) && <output aria-live="polite">{pendingPlan.value.message}</output>}
          <FormRoot
            blocked={busy}
            className="flex flex-col gap-200"
            defaultValues={opened}
            form={projectForm}
            translateMessage={translateMessage}
          >
            <FormReady onReady={setReady} />
            <projectForm.title
              id="project-title"
              label={t('work-tasks.planning.projectTitle')}
              maxLength={200}
              required
              requiredLabel={requiredLabel}
            />
            <projectForm.plannedStart
              id="project-start"
              label={t('work-tasks.planning.plannedStart')}
              required
              requiredLabel={requiredLabel}
              type="date"
            />
            <projectForm.plannedEnd
              id="project-end"
              label={t('work-tasks.planning.plannedEnd')}
              required
              requiredLabel={requiredLabel}
              type="date"
            />
            {project !== undefined && (
              <p className="text-sm text-fg-secondary">
                {assignmentLabel(
                  project.responsiblePrincipalRef,
                  principalNames,
                  project.assignmentNeedsReassignment,
                  project.assignmentWithoutLogin,
                )}
              </p>
            )}
            {/* A plan needs a responsible person, so the list offers no "none". */}
            <projectForm.responsiblePrincipalRef
              items={assignmentOptions(principals)}
              label={t('work-tasks.planning.responsiblePerson')}
            />
            <projectForm.state
              items={Object.entries(states).map(([value, label]) => selectOption(label, value))}
              label={t('work-tasks.pages.records.columns.state')}
            />
            <projectForm.milestones>
              {({ append, items }) => (
                <>
                  <div className="flex items-center justify-between gap-100">
                    <h3 className="font-semibold">Milníky</h3>
                    <Button
                      disabled={busy || items.length >= 50}
                      onClick={() =>
                        append({
                          completed: false,
                          dueDate: draft.plannedEnd,
                          editorKey: Math.max(-1, ...items.map((item) => item.editorKey)) + 1,
                          title: '',
                        })
                      }
                      severity="secondary"
                      size="sm"
                      type="button"
                    >
                      Přidat milník
                    </Button>
                  </div>
                  {items.length === 0 && <p className="text-sm text-fg-secondary">Milníky zatím nejsou naplánované.</p>}
                  {items.map((milestone, index) => (
                    <projectForm.milestones.Item index={index} key={milestone.editorKey}>
                      {({ remove }) => (
                        <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
                          <projectForm.milestones.title
                            label={t('work-tasks.planning.milestoneTitle')}
                            maxLength={200}
                          />
                          <projectForm.milestones.dueDate
                            label={t('work-tasks.planning.milestoneDueDate')}
                            type="date"
                          />
                          <projectForm.milestones.completed label="Dokončeno" />
                          <Button disabled={busy} onClick={remove} severity="secondary" size="sm" type="button">
                            Odebrat milník
                          </Button>
                        </div>
                      )}
                    </projectForm.milestones.Item>
                  ))}
                </>
              )}
            </projectForm.milestones>
          </FormRoot>
          <p className="text-sm text-fg-secondary">
            Úkoly přiřadíte v jejich detailu. Změny projektu zůstávají uložené po obnovení stránky.
          </p>
          {project !== undefined && (
            <ChangeHistory
              actorName={actorName}
              createdAt={project.createdAt}
              entries={project.history}
              fieldLabel={(field) => Object.entries(projectFieldLabels).find(([name]) => name === field)?.[1] ?? field}
              formatValue={historyValue}
              updatedAt={project.updatedAt}
            />
          )}
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** The period of the capacity table: it narrows what the table counts and is never submitted. */
const capacityForm = FormReact.make(FormBuilder.empty.addField('from', Schema.String).addField('to', Schema.String), {
  fields: { from: TextField, to: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

export const WorkPlanning = ({
  actorName,
  onApply,
  onOpenTask,
  principalNames,
  principals,
  records,
}: {
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly onApply: Apply;
  readonly onOpenTask: (task: RecordsResponse['items'][number]) => void;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly principals: readonly AssignmentPrincipal[];
  readonly records: RecordsResponse;
}) => {
  const { t } = useModernI18n();
  const [editor, setEditor] = useState<{ readonly project?: WorkProject }>();
  // Plans parked for approval, by project version; reopening the panel does not offer the same plan again.
  const [proposals, setProposals] = useState<ReadonlyMap<string, ProposedPlan>>(new Map());
  const month = todayIsoDate().slice(0, 7);
  const period = { from: `${month}-01`, to: `${month}-31` };
  const { from, to } = Option.getOrElse(useAtomValue(capacityForm.values), () => period);
  const projects = records.projects ?? [];
  const name = (id: string) => principalNames.get(id) ?? 'Účet mimo seznam';
  const inPeriod = records.items.filter(
    (task) => isOpenTask(task) && task.dueDate !== undefined && task.dueDate >= from && task.dueDate <= to,
  );
  const ids = [
    ...new Set(
      inPeriod.flatMap((task) => (task.ownerPrincipalRef === undefined ? [] : [principalKey(task.ownerPrincipalRef)])),
    ),
  ];
  const rows = ids.map((id) => {
    const tasks = inPeriod.filter(
      (task) => task.ownerPrincipalRef !== undefined && principalKey(task.ownerPrincipalRef) === id,
    );
    return {
      count: tasks.length,
      hours: tasks.reduce((sum, task) => sum + (task.plannedHours ?? 0), 0),
      id,
      name: name(id),
      unknown: tasks.filter((task) => task.plannedHours === undefined).length,
    };
  });
  return (
    <div className="flex flex-col gap-250">
      <SectionCard
        actions={
          records.canWrite && (
            <Button onClick={() => setEditor({})} severity="primary" size="sm">
              Nový projekt
            </Button>
          )
        }
        title={t('work-tasks.planning.projects')}
      >
        <p className="text-sm text-fg-secondary">
          Od přípravy po dokončení: odpovědná osoba, plánované období a milníky na jednom místě.
        </p>
        {projects.length === 0 ? (
          <EmptyState
            description="Založte projekt a přiřaďte k němu související úkoly."
            title={t('work-tasks.planning.noProjects')}
          />
        ) : (
          projects.map((project) => {
            const tasks = records.items.filter((task) => task.projectId === project.id);
            return (
              <article className={`${surfaceTileClassName} flex flex-col gap-150 p-200`} key={project.id}>
                <div className="flex flex-wrap items-start justify-between gap-150">
                  <div>
                    <h3 className="font-semibold">{project.title}</h3>
                    <p className="text-sm text-fg-secondary">
                      {assignmentLabel(
                        project.responsiblePrincipalRef,
                        principalNames,
                        project.assignmentNeedsReassignment,
                        project.assignmentWithoutLogin,
                      )}{' '}
                      · {formatDueDate(project.plannedStart)} – {formatDueDate(project.plannedEnd)}
                    </p>
                  </div>
                  <div className="flex items-center gap-150">
                    <span>{states[project.state]}</span>
                    {records.canWrite && (
                      <Button
                        appearance="outline"
                        onClick={() => setEditor({ project })}
                        severity="secondary"
                        size="sm"
                      >
                        Upravit projekt
                      </Button>
                    )}
                  </div>
                </div>
                {project.milestones.length > 0 && (
                  <ul className="flex flex-col gap-100">
                    {milestoneDisplayItems(project.milestones).map(({ key, milestone }) => (
                      <li key={key}>
                        {milestone.completed ? 'Dokončeno: ' : 'Milník: '}
                        {milestone.title} · {formatDueDate(milestone.dueDate)}
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <h4 className="font-medium">Související úkoly ({tasks.length})</h4>
                  {tasks.length === 0 ? (
                    <p className="text-sm text-fg-secondary">Žádné přiřazené úkoly.</p>
                  ) : (
                    <ul>
                      {tasks.map((task) => (
                        <li key={task.ref.resourceId}>
                          <Button
                            className="text-left underline"
                            composition
                            onClick={() => onOpenTask(task)}
                            size="current"
                            type="button"
                            unstyled
                          >
                            {task.title}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            );
          })
        )}
      </SectionCard>
      <SectionCard title={t('work-tasks.planning.plannedCapacity')}>
        <p className="text-sm text-fg-secondary">
          Součet odhadů otevřených úkolů podle řešitele a termínu. Nejde o docházku ani mzdový výpočet. Úkoly bez
          termínu či řešitele nejsou v součtu.
        </p>
        <FormRoot className="flex flex-wrap gap-150" defaultValues={period} form={capacityForm} translateMessage={t}>
          <capacityForm.from id="capacity-from" label={t('work-tasks.planning.from')} type="date" />
          <capacityForm.to id="capacity-to" label={t('work-tasks.planning.to')} type="date" />
        </FormRoot>
        {from > to ? (
          <StatusText status="error">Konec období musí být po jeho začátku.</StatusText>
        ) : (
          <DataTable
            columns={[
              { accessorKey: 'name', header: 'Řešitel' },
              { accessorKey: 'count', header: 'Otevřené úkoly' },
              {
                accessorKey: 'hours',
                cell: (info) =>
                  info.row.original.unknown === info.row.original.count
                    ? 'Bez odhadu'
                    : `${hoursFormatter.format(info.row.original.hours)} h`,
                header: 'Plánované hodiny',
              },
              { accessorKey: 'unknown', header: 'Úkoly bez odhadu' },
            ]}
            data={rows}
            getRowId={(row) => row.id}
            renderEmpty={() => (
              <EmptyState
                description="Vyberte jiné období nebo doplňte řešitele a termín v detailu úkolu."
                title={t('work-tasks.planning.noAssignedTasks')}
              />
            )}
          />
        )}
      </SectionCard>
      {editor !== undefined && (
        <ProjectEditor
          actorName={actorName}
          close={() => setEditor(undefined)}
          key={editor.project?.id ?? 'new'}
          onApply={onApply}
          onProposed={(plan) => setProposals((current) => new Map([...current, [proposalKey(editor.project), plan]]))}
          principalNames={principalNames}
          principals={principals}
          project={editor.project}
          proposed={Option.fromUndefinedOr(proposals.get(proposalKey(editor.project)))}
        />
      )}
    </div>
  );
};
