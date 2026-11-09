import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'effect-rstest';
import type { DetailViewMode } from '../../src/detail-view-mode.ts';
import { DetailViewModeToggle } from '../../src/detail-view-mode-toggle.tsx';

afterEach(cleanup);

const labels = {
  groupLabel: 'Detail view',
  pageLabel: 'Full page',
  panelLabel: 'Side panel',
};

it('marks the active mode as pressed and switches to the other mode on click', () => {
  const changes: string[] = [];
  const record = (next: DetailViewMode) => {
    changes.push(next);
  };
  const { rerender } = render(<DetailViewModeToggle {...labels} onChange={record} value="page" />);
  const group = screen.getByRole('group', { name: 'Detail view' });
  expect(group.contains(screen.getByRole('button', { name: 'Full page' }))).toBe(true);
  expect(screen.getByRole('button', { name: 'Full page' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Side panel' }).getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(screen.getByRole('button', { name: 'Side panel' }));
  expect(changes).toEqual(['panel']);

  // Clicking the already active mode changes nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
  expect(changes).toEqual(['panel']);

  rerender(<DetailViewModeToggle {...labels} onChange={record} value="panel" />);
  expect(screen.getByRole('button', { name: 'Side panel' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Full page' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
  expect(changes).toEqual(['panel', 'page']);
});
