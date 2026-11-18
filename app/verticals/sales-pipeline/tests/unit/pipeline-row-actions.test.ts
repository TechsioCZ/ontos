import { describe, expect, it } from 'effect-rstest';
import {
  collapseRowActions,
  rowActionMenuItems,
  runRowAction,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-row-actions.tsx';
import type { RowAction } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-row-actions.tsx';

interface Row {
  readonly id: string;
  readonly open: boolean;
  readonly title: string;
}

const openRow: Row = { id: '0196a8a0-0000-7000-8000-0000000000a1', open: true, title: 'Servis tiskáren Brno' };
const wonRow: Row = { id: '0196a8a0-0000-7000-8000-0000000000a2', open: false, title: 'Licence Microsoft 365' };

const record =
  (ran: string[], id: string) =>
  (row: Row): void => {
    ran.push(`${id}:${row.title}`);
  };

// Mirrors the opportunities table: detail always, edit/owner only while open, archive only once closed.
const tableActions = (ran: string[]): RowAction<Row>[] => [
  {
    icon: 'icon-[mdi--open-in-new]',
    id: 'detail',
    label: 'Otevřít detail',
    onAction: record(ran, 'detail'),
  },
  {
    disabled: (row) => !row.open,
    icon: 'icon-[mdi--pencil-outline]',
    id: 'edit',
    label: 'Upravit',
    onAction: record(ran, 'edit'),
  },
  {
    icon: 'icon-[mdi--swap-horizontal]',
    id: 'stage',
    label: 'Změnit fázi',
    onAction: record(ran, 'stage'),
  },
  {
    disabled: (row) => !row.open,
    icon: 'icon-[mdi--account-arrow-right-outline]',
    id: 'owner',
    label: 'Přiřadit obchodníka',
    onAction: record(ran, 'owner'),
  },
  {
    disabled: (row) => row.open,
    icon: 'icon-[mdi--archive-outline]',
    id: 'archive',
    label: 'Archivovat',
    onAction: record(ran, 'archive'),
  },
];

describe('opportunity row actions on a narrow screen', () => {
  it('collapses several actions into one menu only on a narrow screen', () => {
    const actions = tableActions([]);
    expect(collapseRowActions(true, actions)).toBe(true);
    expect(collapseRowActions(false, actions)).toBe(false);
    // A read-only role has just the detail action: one icon fits next to the title, so it stays a button.
    expect(collapseRowActions(true, actions.slice(0, 1))).toBe(false);
  });

  it('keeps row-specific disabled actions unavailable in the menu', () => {
    const actions = tableActions([]);
    const enabledChoices = (row: Row) =>
      rowActionMenuItems(actions, row).flatMap((item) =>
        item.type === 'action' && item.disabled !== true ? [item.value] : [],
      );
    expect(enabledChoices(openRow)).toEqual(['detail', 'edit', 'stage', 'owner']);
    expect(enabledChoices(wonRow)).toEqual(['detail', 'stage', 'archive']);
  });

  it('leaves out an action hidden for the row', () => {
    const actions: RowAction<Row>[] = [
      ...tableActions([]),
      {
        hidden: (row) => row.open,
        icon: 'icon-[mdi--delete-outline]',
        id: 'remove',
        label: 'Smazat',
        onAction: () => {},
      },
    ];
    expect(rowActionMenuItems(actions, openRow).map((item) => ('value' in item ? item.value : ''))).not.toContain(
      'remove',
    );
    expect(rowActionMenuItems(actions, wonRow).map((item) => ('value' in item ? item.value : ''))).toContain('remove');
  });

  it('runs the chosen action on its own row and ignores a blocked, hidden or unknown choice', () => {
    const ran: string[] = [];
    const actions: RowAction<Row>[] = [
      ...tableActions(ran),
      {
        hidden: () => true,
        icon: 'icon-[mdi--delete-outline]',
        id: 'remove',
        label: 'Smazat',
        onAction: record(ran, 'remove'),
      },
    ];
    runRowAction(actions, openRow, 'stage');
    runRowAction(actions, wonRow, 'archive');
    runRowAction(actions, openRow, 'archive');
    runRowAction(actions, wonRow, 'edit');
    runRowAction(actions, openRow, 'remove');
    runRowAction(actions, openRow, 'unknown');
    expect(ran).toEqual(['stage:Servis tiskáren Brno', 'archive:Licence Microsoft 365']);
  });
});
