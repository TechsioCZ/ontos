/**
 * A MicroVertical that exists only in this test composition. It contributes MCP tools through its contract and the
 * tool catalog artifact the contract pins, exactly like a real vertical; the Shell has no code for it.
 */
import { createHash } from 'node:crypto';

import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';

import { buildMcpCatalog, buildMcpModules } from '../../../api/mcp/catalog.ts';

export const FIXTURE_MODULE_ID = 'fixture.notes';
export const FIXTURE_APP_ID = 'fixture-notes';

/** The tool catalog artifact of the fixture release. */
export const fixtureToolCatalog = {
  definitions: {
    NoteText: { maxLength: 200, minLength: 1, type: 'string' },
  },
  tools: [
    {
      access: 'read',
      agentProposalOnly: false,
      destructive: false,
      id: `${FIXTURE_MODULE_ID}/read/records`,
      inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
      invoke: { path: '/reads/records' },
      name: 'fixture_notes__read_records',
      referenceAudiences: [],
      title: { cs: 'Přehled poznámek', en: 'Notes overview' },
    },
    {
      access: 'write',
      agentProposalOnly: false,
      destructive: false,
      id: `${FIXTURE_MODULE_ID}/command/AddNote`,
      inputSchema: {
        additionalProperties: false,
        properties: { expectedRevision: { minimum: 0, type: 'integer' }, text: { $ref: '#/$defs/NoteText' } },
        required: ['text'],
        type: 'object',
      },
      invoke: { commandTag: 'AddNote', path: `/${FIXTURE_APP_ID}/actions/apply-command` },
      name: 'fixture_notes__add_note',
      referenceAudiences: [],
      title: { cs: 'Přidat poznámku', en: 'Add a note' },
    },
    {
      access: 'write',
      agentProposalOnly: true,
      destructive: true,
      id: `${FIXTURE_MODULE_ID}/command/WipeNotes`,
      inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
      invoke: { commandTag: 'WipeNotes', path: `/${FIXTURE_APP_ID}/actions/apply-command` },
      name: 'fixture_notes__wipe_notes',
      referenceAudiences: [],
      title: { cs: 'Smazat všechny poznámky', en: 'Wipe all notes' },
    },
  ],
} as const;

export const FIXTURE_TOOL_CATALOG_TEXT = JSON.stringify(fixtureToolCatalog);
export const FIXTURE_RELEASE_ORIGIN = 'https://assets-fixture-notes.example';
export const FIXTURE_TOOL_CATALOG_URL = `${FIXTURE_RELEASE_ORIGIN}/.well-known/ontos-module-mcp-tools.json`;

const contribution = {
  approvals: true,
  description: { cs: 'Testovací poznámky.', en: 'Test notes.' },
  keywords: 'poznámka note',
  label: { cs: 'Poznámky', en: 'Notes' },
  page: '/poznamky',
  revision: { field: 'revision', fieldsByCommandPrefix: [], path: '/reads/records', query: {} },
  toolCatalog: {
    path: '/.well-known/ontos-module-mcp-tools.json',
    sha256: createHash('sha256').update(FIXTURE_TOOL_CATALOG_TEXT).digest('hex'),
    toolCount: fixtureToolCatalog.tools.length,
  },
};

/** The test composition: one fixture module whose deployment contract carries the contribution. */
export const fixtureComposition = {
  modules: [
    {
      contract: { sha256: '0'.repeat(64), url: `${FIXTURE_RELEASE_ORIGIN}/.well-known/ontos-module-manifest.json` },
      contractDocument: JSON.stringify({
        deployment: { appId: FIXTURE_APP_ID, buildMarker: 'fixture' },
        manifest: { publicSurface: { mcp: contribution } },
      }),
      deployment: { appId: FIXTURE_APP_ID, buildMarker: 'fixture' },
      moduleId: FIXTURE_MODULE_ID,
    },
    {
      // A composed module without an MCP contribution offers nothing.
      contract: {
        sha256: '0'.repeat(64),
        url: 'https://assets-fixture-silent.example/.well-known/ontos-module-manifest.json',
      },
      contractDocument: JSON.stringify({ manifest: { publicSurface: {} } }),
      deployment: { appId: 'fixture-silent', buildMarker: 'fixture' },
      moduleId: 'fixture.silent',
    },
  ],
  revision: 'f'.repeat(64),
};

/** The fixture composition's catalog with its tools already loaded. */
export const fixtureCatalog = () =>
  buildMcpCatalog(buildMcpModules(fixtureComposition), new Map([[FIXTURE_MODULE_ID, fixtureToolCatalog]]));

export const connectionDescription = (overrides: Partial<ConnectionDescription> = {}): ConnectionDescription => ({
  acting: { displayName: 'Jana Testerová', kind: 'human', principalId: 'principal-1' },
  client: {
    clientId: 'https://claude.ai/oauth/client',
    host: 'claude.ai',
    kind: 'cimd',
    logoUri: null,
    name: 'Claude',
  },
  compositionRevision: 'f'.repeat(64),
  delegatedBy: null,
  grantId: 'grant-1',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  legalName: 'Obchodní firma',
  modules: [{ label: FIXTURE_MODULE_ID, moduleId: FIXTURE_MODULE_ID, read: true, write: true }],
  profileId: 'profile-1',
  status: 'active',
  tenantId: 'tenant-1',
  writePolicy: 'direct',
  ...overrides,
});
