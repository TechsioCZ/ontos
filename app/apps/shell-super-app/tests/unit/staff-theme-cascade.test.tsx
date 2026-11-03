import runtimeHead, { Helmet } from '@modern-js/runtime/head';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'effect-rstest';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';

import { neutralStaffTheme, staffDocumentTheme } from '../../src/routes/staff-brand';

/**
 * The staff app writes the `<html>` theme twice: the layout as the neutral default, the signed-in frame as the
 * selected workspace. react-helmet-async merges those writes, so this proves the frame really wins after mount,
 * after a layout re-render and through a strict-mode double mount, using the real head implementation instead of
 * the mocked Helmet the layout tests use.
 */

const { HelmetProvider } = runtimeHead;

const akrosTenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const akrosCompanyId = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const demoTenantId = '70000000-0000-4000-8000-000000000020';
const demoShopCompanyId = '71000000-0000-4000-8000-000000000024';

const htmlElement = () => document.documentElement;

// Mirrors the document layout: the neutral default worn until a workspace frame says otherwise.
const NeutralLayout = ({ children }: { readonly children: ReactNode }) => (
  <>
    <Helmet htmlAttributes={{ className: 'light', 'data-theme': neutralStaffTheme }} />
    {children}
  </>
);

interface WorkspaceFrameProps {
  readonly legalEntityId?: string;
  readonly tenantId: string;
}

// Mirrors the signed-in frame's one head write, through the same helper the frame uses.
const WorkspaceFrame = ({ legalEntityId, tenantId }: WorkspaceFrameProps) => (
  <Helmet htmlAttributes={staffDocumentTheme(tenantId, legalEntityId)} />
);

const dashboard = ({ legalEntityId, tenantId }: WorkspaceFrameProps, strict = false) => {
  const tree = (
    <HelmetProvider>
      <NeutralLayout>
        <WorkspaceFrame {...(legalEntityId === undefined ? {} : { legalEntityId })} tenantId={tenantId} />
      </NeutralLayout>
    </HelmetProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
};

afterEach(() => {
  cleanup();
});

test('lets the selected frame keep the real AKROS theme over the neutral layout default', () => {
  render(dashboard({ legalEntityId: akrosCompanyId, tenantId: akrosTenantId }));

  expect(htmlElement().className).toBe('light');
  expect(htmlElement().dataset['theme']).toBe('akros');
});

test('keeps the AKROS theme when the layout re-renders after the frame', () => {
  const view = render(dashboard({ legalEntityId: akrosCompanyId, tenantId: akrosTenantId }));
  expect(htmlElement().dataset['theme']).toBe('akros');

  view.rerender(dashboard({ legalEntityId: akrosCompanyId, tenantId: akrosTenantId }));

  expect(htmlElement().className).toBe('light');
  expect(htmlElement().dataset['theme']).toBe('akros');
});

test('keeps the AKROS theme through a strict-mode double mount', () => {
  render(dashboard({ legalEntityId: akrosCompanyId, tenantId: akrosTenantId }, true));

  expect(htmlElement().dataset['theme']).toBe('akros');
});

test('leaves the pseudonymous demo workspace on the neutral business theme', () => {
  render(dashboard({ legalEntityId: demoShopCompanyId, tenantId: demoTenantId }));

  expect(htmlElement().className).toBe('light');
  expect(htmlElement().dataset['theme']).toBe('business');
});

test('the neutral layout default and the frame write the same html contract', () => {
  expect({ className: 'light', 'data-theme': neutralStaffTheme }).toEqual(staffDocumentTheme('tenant-without-brand'));
  expect(staffDocumentTheme(demoTenantId, demoShopCompanyId)).toEqual({
    className: 'light',
    'data-theme': 'business',
  });
  expect(staffDocumentTheme(akrosTenantId, akrosCompanyId)).toEqual({
    className: 'light',
    'data-theme': 'akros',
  });
});
