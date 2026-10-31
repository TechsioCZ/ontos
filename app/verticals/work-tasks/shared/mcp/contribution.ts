/** MCP tools of Work Tasks: what agents may read and change, in Czech and English. */
import { OntosMcpHidden, defineOntosMcpContribution } from '@app/core-runtime';

export const workTasksMcpContribution = defineOntosMcpContribution({
  approvalReview: { read: 'agent-review' },
  approvals: true,
  commandFieldLabels: {
    description: 'Popis',
    dueDate: 'Termín',
    ownerPrincipalRef: 'Řešitel',
    partyId: 'Zákazník',
    responsiblePrincipalRef: 'Odpovědná osoba',
    state: 'Stav',
    taskRef: 'Úkol',
    title: 'Název',
  },
  commands: {
    AddTaskComment: { title: { cs: 'Přidat komentář k úkolu', en: 'Add a task comment' } },
    AssignTask: { title: { cs: 'Přiřadit úkol', en: 'Assign a task' } },
    BulkAssignTasks: {
      title: { cs: 'Hromadně přiřadit úkoly', en: 'Assign tasks in bulk' },
    },
    BulkChangeTaskState: { title: { cs: 'Hromadně změnit stav úkolů', en: 'Change task states in bulk' } },
    ChangeTaskState: { title: { cs: 'Změnit stav úkolu', en: 'Change a task state' } },
    CreateProject: { title: { cs: 'Vytvořit projekt', en: 'Create a project' } },
    CreateTask: { title: { cs: 'Vytvořit úkol', en: 'Create a task' } },
    SetTaskArchived: { title: { cs: 'Skrýt nebo zobrazit úkol', en: 'Archive or restore a task' } },
    UpdateProject: { title: { cs: 'Upravit projekt', en: 'Update a project' } },
    UpdateTask: { title: { cs: 'Upravit úkol', en: 'Update a task' } },
  },
  description: {
    cs: 'Úkoly, projekty, přiřazení, stavy a komentáře.',
    en: 'Tasks, projects, assignments, states and comments.',
  },
  keywords: 'úkol úkoly projekt termín přiřazení stav komentář práce todo task project assignment deadline',
  label: { cs: 'Úkoly a projekty', en: 'Tasks and projects' },
  page: '/ukoly',
  reads: {
    'agent-review': OntosMcpHidden,
    records: { title: { cs: 'Přehled úkolů a projektů', en: 'Tasks and projects overview' } },
  },
  revision: { read: 'records' },
});
