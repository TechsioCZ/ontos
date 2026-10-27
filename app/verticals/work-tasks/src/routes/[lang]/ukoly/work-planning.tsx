import { EmptyState, SectionCard, SidePanel, surfaceTileClassName } from '@app/admin-ui';
import { assignmentLabel, principalKey } from '../../../../shared/assignment.ts';
import { assignmentOptions, selectedPrincipal } from './assignment-options.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Option, Schema } from 'effect';
import { useRef, useState } from 'react';
import type { WorkCommand } from '../../../../shared/actions/apply-command.ts';
import { PlanningCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { ProjectStateSchema } from '../../../../shared/apis/records.ts';
import type { AssignmentPrincipal, RecordsResponse, WorkProject } from '../../../../shared/apis/records.ts';
import { formatDueDate, isOpenTask, selectOption, todayIsoDate } from './tasks-model.ts';
import { ChangeHistory } from './change-history.tsx';

const states = { ACTIVE: 'Aktivní', DONE: 'Dokončený', PAUSED: 'Pozastavený', PLANNED: 'Plánovaný' } as const;
const hoursFormatter = new Intl.NumberFormat('cs-CZ');
type MilestoneDraft = WorkProject['milestones'][number] & { readonly editorKey: number };
type Draft = Pick<WorkProject, 'plannedEnd' | 'plannedStart' | 'state' | 'title'> & {
  readonly milestones: readonly MilestoneDraft[];
  readonly responsiblePrincipalRef: string;
};
type Outcome = { readonly ok: true } | { readonly message: string; readonly ok: false };
type Apply = (command: WorkCommand, onDone: (outcome: Outcome) => void) => void;

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

const ProjectEditor = ({
  actorName,
  close,
  onApply,
  principalNames,
  principals,
  project,
}: {
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly close: () => void;
  readonly onApply: Apply;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly principals: readonly AssignmentPrincipal[];
  readonly project: WorkProject | undefined;
}) => {
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
  const [draft, setDraft] = useState(() => initial(project));
  const nextMilestoneKey = useRef(draft.milestones.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const patch = (value: Partial<Draft>) => setDraft((current) => ({ ...current, ...value }));
  const save = () => {
    const input = {
      _tag: project === undefined ? 'CreateProject' : 'UpdateProject',
      ...draft,
      milestones: draft.milestones.map(({ completed, dueDate, title }) => ({ completed, dueDate, title })),
      responsiblePrincipalRef:
        selectedPrincipal(principals, draft.responsiblePrincipalRef) ??
        (project?.responsiblePrincipalRef !== undefined &&
        principalKey(project.responsiblePrincipalRef) === draft.responsiblePrincipalRef
          ? project.responsiblePrincipalRef
          : undefined),
    };
    if (project !== undefined) {
      Object.assign(input, { id: project.id });
    }
    const command = Schema.decodeUnknownOption(PlanningCommandSchema)(input);
    if (
      Option.isNone(command) ||
      draft.plannedStart > draft.plannedEnd ||
      draft.milestones.some(
        (milestone) => milestone.dueDate < draft.plannedStart || milestone.dueDate > draft.plannedEnd,
      )
    ) {
      setError('Vyplňte název, odpovědnou osobu a platné období. Milníky musí ležet v období projektu.');
      return;
    }
    setBusy(true);
    setError(undefined);
    onApply(command.value, (outcome) => {
      setBusy(false);
      if (outcome.ok) {
        close();
      } else {
        setError(outcome.message);
      }
    });
  };
  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={close} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button disabled={busy} isLoading={busy} onClick={save} variant="primary">
            Uložit projekt
          </Button>
        </>
      }
      closeOnInteractOutside={false}
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
        {error !== undefined && <StatusText status="error">{error}</StatusText>}
        <FormInput
          disabled={busy}
          id="project-title"
          label="Název projektu"
          maxLength={200}
          onChange={(event) => patch({ title: event.target.value })}
          required
          value={draft.title}
        />
        <FormInput
          disabled={busy}
          id="project-start"
          label="Plánovaný začátek"
          onChange={(event) => patch({ plannedStart: event.target.value })}
          required
          type="date"
          value={draft.plannedStart}
        />
        <FormInput
          disabled={busy}
          id="project-end"
          label="Plánovaný konec"
          onChange={(event) => patch({ plannedEnd: event.target.value })}
          required
          type="date"
          value={draft.plannedEnd}
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
        <Select
          disabled={busy}
          items={assignmentOptions(principals)}
          label="Odpovědná osoba"
          onValueChange={({ value }) => patch({ responsiblePrincipalRef: value[0] ?? '' })}
          value={draft.responsiblePrincipalRef === '' ? [] : [draft.responsiblePrincipalRef]}
        />
        <Select
          disabled={busy}
          items={Object.entries(states).map(([value, label]) => selectOption(label, value))}
          label="Stav"
          onValueChange={({ value }) => {
            const [next] = value;
            const decoded = Schema.decodeUnknownOption(ProjectStateSchema)(next);
            if (Option.isSome(decoded)) {
              patch({ state: decoded.value });
            }
          }}
          value={[draft.state]}
        />
        <div className="flex items-center justify-between gap-100">
          <h3 className="font-semibold">Milníky</h3>
          <Button
            disabled={busy || draft.milestones.length >= 50}
            onClick={() => {
              const editorKey = nextMilestoneKey.current;
              nextMilestoneKey.current += 1;
              patch({
                milestones: [
                  ...draft.milestones,
                  { completed: false, dueDate: draft.plannedEnd, editorKey, title: '' },
                ],
              });
            }}
            size="sm"
            variant="secondary"
          >
            Přidat milník
          </Button>
        </div>
        {draft.milestones.length === 0 && (
          <p className="text-sm text-fg-secondary">Milníky zatím nejsou naplánované.</p>
        )}
        {draft.milestones.map((milestone, index) => (
          <div className={`${surfaceTileClassName} flex flex-col gap-100 p-150`} key={milestone.editorKey}>
            <FormInput
              disabled={busy}
              label="Název milníku"
              maxLength={200}
              onChange={(event) =>
                patch({
                  milestones: draft.milestones.map((item, i) =>
                    i === index ? { ...item, title: event.target.value } : item,
                  ),
                })
              }
              value={milestone.title}
            />
            <FormInput
              disabled={busy}
              label="Termín milníku"
              onChange={(event) =>
                patch({
                  milestones: draft.milestones.map((item, i) =>
                    i === index ? { ...item, dueDate: event.target.value } : item,
                  ),
                })
              }
              type="date"
              value={milestone.dueDate}
            />
            <label className="flex items-center gap-100">
              <input
                checked={milestone.completed}
                disabled={busy}
                onChange={(event) =>
                  patch({
                    milestones: draft.milestones.map((item, i) =>
                      i === index ? { ...item, completed: event.target.checked } : item,
                    ),
                  })
                }
                type="checkbox"
              />
              Dokončeno
            </label>
            <Button
              disabled={busy}
              onClick={() => patch({ milestones: draft.milestones.filter((_, i) => i !== index) })}
              size="sm"
              variant="secondary"
            >
              Odebrat milník
            </Button>
          </div>
        ))}
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
  );
};

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
  const [editor, setEditor] = useState<{ readonly project?: WorkProject }>();
  const [from, setFrom] = useState(`${todayIsoDate().slice(0, 7)}-01`);
  const [to, setTo] = useState(`${todayIsoDate().slice(0, 7)}-31`);
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
            <Button onClick={() => setEditor({})} size="sm" variant="primary">
              Nový projekt
            </Button>
          )
        }
        title="Projekty"
      >
        <p className="text-sm text-fg-secondary">
          Od přípravy po dokončení: odpovědná osoba, plánované období a milníky na jednom místě.
        </p>
        {projects.length === 0 ? (
          <EmptyState description="Založte projekt a přiřaďte k němu související úkoly." title="Zatím žádné projekty" />
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
                      <Button onClick={() => setEditor({ project })} size="sm" theme="outlined" variant="secondary">
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
                          <button className="text-left underline" onClick={() => onOpenTask(task)} type="button">
                            {task.title}
                          </button>
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
      <SectionCard title="Plánované kapacity">
        <p className="text-sm text-fg-secondary">
          Součet odhadů otevřených úkolů podle řešitele a termínu. Nejde o docházku ani mzdový výpočet. Úkoly bez
          termínu či řešitele nejsou v součtu.
        </p>
        <div className="flex flex-wrap gap-150">
          <FormInput
            id="capacity-from"
            label="Od"
            onChange={(event) => setFrom(event.target.value)}
            type="date"
            value={from}
          />
          <FormInput
            id="capacity-to"
            label="Do"
            onChange={(event) => setTo(event.target.value)}
            type="date"
            value={to}
          />
        </div>
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
                title="V tomto období nejsou přiřazené úkoly"
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
          principalNames={principalNames}
          principals={principals}
          project={editor.project}
        />
      )}
    </div>
  );
};
