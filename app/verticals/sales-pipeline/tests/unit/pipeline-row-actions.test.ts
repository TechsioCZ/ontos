import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  collapseRowActions,
  RowActionsMenu,
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
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  beforeAll(() => {
    rstest.stubGlobal('React', React);
  });

  it('collapses several actions into one menu only on a narrow screen', () => {
    const actions = tableActions([]);
    expect(collapseRowActions(true, actions)).toBe(true);
    expect(collapseRowActions(false, actions)).toBe(false);
    // A read-only role has just the detail action: one icon fits next to the title, so it stays a button.
    expect(collapseRowActions(true, actions.slice(0, 1))).toBe(false);
  });

  it('keeps every action reachable in the menu, with the same labels and per-row availability', () => {
    const actions = tableActions([]);
    expect(rowActionMenuItems(actions, openRow)).toEqual([
      { disabled: false, icon: 'icon-[mdi--open-in-new]', label: 'Otevřít detail', type: 'action', value: 'detail' },
      { disabled: false, icon: 'icon-[mdi--pencil-outline]', label: 'Upravit', type: 'action', value: 'edit' },
      { disabled: false, icon: 'icon-[mdi--swap-horizontal]', label: 'Změnit fázi', type: 'action', value: 'stage' },
      {
        disabled: false,
        icon: 'icon-[mdi--account-arrow-right-outline]',
        label: 'Přiřadit obchodníka',
        type: 'action',
        value: 'owner',
      },
      { disabled: true, icon: 'icon-[mdi--archive-outline]', label: 'Archivovat', type: 'action', value: 'archive' },
    ]);
    expect(rowActionMenuItems(actions, wonRow).map((item) => ('disabled' in item ? item.disabled : undefined))).toEqual(
      [false, true, false, true, false],
    );
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

  it('renders one labelled menu button that names the opportunity and no technical id', () => {
    const html = renderToStaticMarkup(
      createElement(RowActionsMenu<Row>, {
        actions: tableActions([]),
        label: `Akce: ${openRow.title}`,
        row: openRow,
      }),
    );
    expect(html).toContain('aria-label="Akce: Servis tiskáren Brno"');
    expect(html.match(/<button/gu)?.length).toBe(1);
    expect(html).toContain('icon-[mdi--dots-vertical]');
    expect(html).not.toContain(openRow.id);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it('wires the opportunities table to the menu on a narrow screen and keeps the icon buttons otherwise', () => {
    const page = readFileSync(
      new URL('../../src/routes/[lang]/prodej/prilezitosti/page.tsx', import.meta.url),
      'utf-8',
    );
    expect(page).toContain('collapseRowActions(');
    expect(page).toContain('<RowActionsMenu');
    expect(page).toContain(': { rowActions }');
    // The menu button names the opportunity it acts on.
    expect(page).toContain("t('sales-pipeline.table.actionsLabel')");
    expect(page).toContain('row.original.title');
  });
});
