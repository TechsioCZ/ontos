import { expect, it } from 'effect-rstest';

import { reportedViewer } from '../../src/services/persistence.service.ts';

const salesperson = {
  assign: false,
  principalId: '70000000-0000-4000-8000-000000000101',
  readAll: false,
  readAssigned: false,
  salespersonId: 'sp-1',
  writeAll: false,
  writeAssigned: true,
};
const manager = { ...salesperson, assign: true, readAll: true, writeAll: true };
const readOnly = {
  authMethod: 'oauth_connection',
  connection: {
    clientId: 'c',
    clientName: 'Claude',
    grantId: '11111111-1111-4111-8111-111111111111',
    modules: 'all',
    writePolicy: 'read_only',
  },
} as const;

it('a read-only MCP connection reports no CRM write ability but keeps read reach', () => {
  expect(reportedViewer(manager, readOnly)).toMatchObject({ assign: false, readAll: true, writeAll: false });
  expect(reportedViewer(salesperson, readOnly)).toMatchObject({ readAssigned: true, writeAssigned: false });
  expect(reportedViewer(manager, { authMethod: 'session' })).toBe(manager);
  expect(
    reportedViewer(manager, {
      authMethod: 'oauth_connection',
      connection: {
        ...readOnly.connection,
        modules: [{ access: 'write', moduleId: 'demo.crm' }],
        writePolicy: 'direct',
      },
    }),
  ).toBe(manager);
});
