import { EmptyState, SectionCard, SidePanel, surfaceTileClassName } from '@app/admin-ui';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Schema } from 'effect';
import { useState } from 'react';
import type { WorkCommand } from '../../../../shared/actions/apply-command.ts';
import { PlanningCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type { RecordsResponse, WorkProject } from '../../../../shared/apis/records.ts';
import { formatDueDate, isOpenTask, selectOption, todayIsoDate } from './tasks-model.ts';
import { ChangeHistory } from './change-history.tsx';

const states = { PLANNED: 'Plánovaný', ACTIVE: 'Aktivní', PAUSED: 'Pozastavený', DONE: 'Dokončený' } as const;
type Draft = {
  title: string;
  plannedStart: string;
  plannedEnd: string;
  responsibleEmployeeId: string;
  state: WorkProject['state'];
  milestones: { title: string; dueDate: string; completed: boolean }[];
};
type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };
type Apply = (command: WorkCommand, onDone: (outcome: Outcome) => void) => void;

const initial = (project: WorkProject | undefined): Draft => ({
  title: project?.title ?? '',
  plannedStart: project?.plannedStart ?? todayIsoDate(),
  plannedEnd: project?.plannedEnd ?? todayIsoDate(),
  responsibleEmployeeId: project?.responsibleEmployeeId ?? '',
  state: project?.state ?? 'PLANNED',
  milestones: (project?.milestones ?? []).map((milestone) => ({ ...milestone })),
});

const projectFieldLabels: Record<string, string> = {
  milestones: 'Milníky',
  plannedEnd: 'Plánovaný konec',
  plannedStart: 'Plánovaný začátek',
  responsibleEmployeeId: 'Odpovědná osoba',
  state: 'Stav',
  title: 'Název projektu',
};

const ProjectEditor = ({
  project,
  employees,
  apply,
  actorName,
  close,
}: {
  readonly project: WorkProject | undefined;
  readonly employees: readonly Employee[];
  readonly apply: Apply;
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly close: () => void;
}) => {
  const historyValue = (field: string, value: string | undefined): string => {
    if (value === undefined) return '—';
    if (field === 'state') return Object.entries(states).find(([state]) => state === value)?.[1] ?? value;
    if (field === 'plannedStart' || field === 'plannedEnd') return formatDueDate(value);
    if (field === 'responsibleEmployeeId')
      return employees.find((person) => person.id === value)?.fullName ?? 'zaměstnanec mimo seznam';
    if (field === 'milestones') return value.replace(/(\d{4}-\d{2}-\d{2})/g, (date) => formatDueDate(date));
    return value;
  };
  const [draft, setDraft] = useState(() => initial(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const patch = (value: Partial<Draft>) => setDraft((current) => ({ ...current, ...value }));
  const save = () => {
    const command = Schema.decodeUnknownOption(PlanningCommandSchema)({
      _tag: project === undefined ? 'CreateProject' : 'UpdateProject',
      ...draft,
      ...(project === undefined ? {} : { id: project.id }),
    });
    if (
      command._tag === 'None' ||
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
    apply(command.value, (outcome) => {
      setBusy(false);
      if (outcome.ok) close();
      else setError(outcome.message);
    });
  };
  return (
    <SidePanel
      open
      title={project === undefined ? 'Nový projekt' : 'Upravit projekt'}
      size="lg"
      resizeLabel="Změnit šířku panelu"
      closeOnInteractOutside={false}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
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
    >
      <div className="flex flex-col gap-200 py-200">
        {error !== undefined && <StatusText status="error">{error}</StatusText>}
        <FormInput
          id="project-title"
          label="Název projektu"
          required
          maxLength={200}
          value={draft.title}
          onChange={(event) => patch({ title: event.target.value })}
          disabled={busy}
        />
        <FormInput
          id="project-start"
          label="Plánovaný začátek"
          type="date"
          required
          value={draft.plannedStart}
          onChange={(event) => patch({ plannedStart: event.target.value })}
          disabled={busy}
        />
        <FormInput
          id="project-end"
          label="Plánovaný konec"
          type="date"
          required
          value={draft.plannedEnd}
          onChange={(event) => patch({ plannedEnd: event.target.value })}
          disabled={busy}
        />
        <Select
          label="Odpovědná osoba"
          items={employees.filter((person) => person.active).map((person) => selectOption(person.fullName, person.id))}
          value={draft.responsibleEmployeeId === '' ? [] : [draft.responsibleEmployeeId]}
          disabled={busy}
          onValueChange={({ value }) => patch({ responsibleEmployeeId: value[0] ?? '' })}
        />
        <Select
          label="Stav"
          items={Object.entries(states).map(([value, label]) => selectOption(label, value))}
          value={[draft.state]}
          disabled={busy}
          onValueChange={({ value }) => {
            const next = value[0];
            if (next !== undefined && next in states) patch({ state: next as Draft['state'] });
          }}
        />
        <div className="flex items-center justify-between gap-100">
          <h3 className="font-semibold">Milníky</h3>
          <Button
            disabled={busy || draft.milestones.length >= 50}
            size="sm"
            variant="secondary"
            onClick={() =>
              patch({ milestones: [...draft.milestones, { title: '', dueDate: draft.plannedEnd, completed: false }] })
            }
          >
            Přidat milník
          </Button>
        </div>
        {draft.milestones.length === 0 && (
          <p className="text-sm text-fg-secondary">Milníky zatím nejsou naplánované.</p>
        )}
        {draft.milestones.map((milestone, index) => (
          <div key={index} className={`${surfaceTileClassName} flex flex-col gap-100 p-150`}>
            <FormInput
              label="Název milníku"
              value={milestone.title}
              disabled={busy}
              maxLength={200}
              onChange={(event) =>
                patch({
                  milestones: draft.milestones.map((item, i) =>
                    i === index ? { ...item, title: event.target.value } : item,
                  ),
                })
              }
            />
            <FormInput
              label="Termín milníku"
              type="date"
              value={milestone.dueDate}
              disabled={busy}
              onChange={(event) =>
                patch({
                  milestones: draft.milestones.map((item, i) =>
                    i === index ? { ...item, dueDate: event.target.value } : item,
                  ),
                })
              }
            />
            <label className="flex items-center gap-100">
              <input
                type="checkbox"
                checked={milestone.completed}
                disabled={busy}
                onChange={(event) =>
                  patch({
                    milestones: draft.milestones.map((item, i) =>
                      i === index ? { ...item, completed: event.target.checked } : item,
                    ),
                  })
                }
              />
              Dokončeno
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => patch({ milestones: draft.milestones.filter((_, i) => i !== index) })}
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
            fieldLabel={(field) => projectFieldLabels[field] ?? field}
            formatValue={historyValue}
            updatedAt={project.updatedAt}
          />
        )}
      </div>
    </SidePanel>
  );
};

export const WorkPlanning = ({
  records,
  employees,
  apply,
  actorName,
  openTask,
}: {
  readonly records: RecordsResponse;
  readonly employees: readonly Employee[];
  readonly apply: Apply;
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly openTask: (task: RecordsResponse['items'][number]) => void;
}) => {
  const [editor, setEditor] = useState<{ project: WorkProject | undefined }>();
  const [from, setFrom] = useState(`${todayIsoDate().slice(0, 7)}-01`);
  const [to, setTo] = useState(`${todayIsoDate().slice(0, 7)}-31`);
  const projects = records.projects ?? [];
  const name = (id: string) => employees.find((person) => person.id === id)?.fullName ?? 'Neznámý řešitel';
  const inPeriod = records.items.filter(
    (task) => isOpenTask(task) && task.dueDate !== undefined && task.dueDate >= from && task.dueDate <= to,
  );
  const ids = [
    ...new Set(inPeriod.flatMap((task) => (task.assigneeEmployeeId === undefined ? [] : [task.assigneeEmployeeId]))),
  ];
  const rows = ids.map((id) => {
    const tasks = inPeriod.filter((task) => task.assigneeEmployeeId === id);
    return {
      id,
      name: name(id),
      count: tasks.length,
      hours: tasks.reduce((sum, task) => sum + (task.plannedHours ?? 0), 0),
      unknown: tasks.filter((task) => task.plannedHours === undefined).length,
    };
  });
  return (
    <div className="flex flex-col gap-250">
      <SectionCard
        title="Projekty"
        actions={
          records.canWrite && (
            <Button size="sm" variant="primary" onClick={() => setEditor({ project: undefined })}>
              Nový projekt
            </Button>
          )
        }
      >
        <p className="text-sm text-fg-secondary">
          Od přípravy po dokončení: odpovědná osoba, plánované období a milníky na jednom místě.
        </p>
        {projects.length === 0 ? (
          <EmptyState title="Zatím žádné projekty" description="Založte projekt a přiřaďte k němu související úkoly." />
        ) : (
          projects.map((project) => {
            const tasks = records.items.filter((task) => task.projectId === project.id);
            return (
              <article key={project.id} className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
                <div className="flex flex-wrap items-start justify-between gap-150">
                  <div>
                    <h3 className="font-semibold">{project.title}</h3>
                    <p className="text-sm text-fg-secondary">
                      {name(project.responsibleEmployeeId)} · {formatDueDate(project.plannedStart)} –{' '}
                      {formatDueDate(project.plannedEnd)}
                    </p>
                  </div>
                  <div className="flex items-center gap-150">
                    <span>{states[project.state]}</span>
                    {records.canWrite && (
                      <Button size="sm" variant="secondary" theme="outlined" onClick={() => setEditor({ project })}>
                        Upravit projekt
                      </Button>
                    )}
                  </div>
                </div>
                {project.milestones.length > 0 && (
                  <ul className="flex flex-col gap-100">
                    {project.milestones.map((milestone, index) => (
                      <li key={index}>
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
                          <button type="button" className="text-left underline" onClick={() => openTask(task)}>
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
            type="date"
            label="Od"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <FormInput
            id="capacity-to"
            type="date"
            label="Do"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {from > to ? (
          <StatusText status="error">Konec období musí být po jeho začátku.</StatusText>
        ) : (
          <DataTable
            data={rows}
            getRowId={(row) => row.id}
            columns={[
              { accessorKey: 'name', header: 'Řešitel' },
              { accessorKey: 'count', header: 'Otevřené úkoly' },
              {
                accessorKey: 'hours',
                header: 'Plánované hodiny',
                cell: (info) =>
                  info.row.original.unknown === info.row.original.count
                    ? 'Bez odhadu'
                    : `${new Intl.NumberFormat('cs-CZ').format(info.row.original.hours)} h`,
              },
              { accessorKey: 'unknown', header: 'Úkoly bez odhadu' },
            ]}
            renderEmpty={() => (
              <EmptyState
                title="V tomto období nejsou přiřazené úkoly"
                description="Vyberte jiné období nebo doplňte řešitele a termín v detailu úkolu."
              />
            )}
          />
        )}
      </SectionCard>
      {editor !== undefined && (
        <ProjectEditor
          key={editor.project?.id ?? 'new'}
          project={editor.project}
          employees={employees}
          apply={apply}
          actorName={actorName}
          close={() => setEditor(undefined)}
        />
      )}
    </div>
  );
};
