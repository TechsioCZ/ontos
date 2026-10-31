import { createHash } from 'node:crypto';

import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import {
  ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
  OntosMcpHidden,
  OntosMcpToolCatalogJsonSchema,
} from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
import type { OntosMcpContributionInput } from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
import {
  deriveOntosMcpContribution,
  mcpToolName,
  OntosMcpContributionDerivationError,
} from '../ontos-mcp-contribution.mts';
import type { DeriveOntosMcpContributionInput } from '../ontos-mcp-contribution.mts';

const title = { cs: 'Změnit rezervaci', en: 'Change booking' };
const READ_PATH = '/reads/state';
const ACTION_KEY = 'booking.assign-code';
const authored = {
  approvals: true,
  description: title,
  keywords: 'rezervace booking',
  label: title,
  reads: {},
} satisfies OntosMcpContributionInput;

const derive = (overrides: Partial<DeriveOntosMcpContributionInput>) =>
  deriveOntosMcpContribution({
    actions: [],
    api: {},
    appId: 'booking-app',
    authored,
    moduleId: 'booking',
    ...overrides,
  });

const catalogOf = (overrides: Partial<DeriveOntosMcpContributionInput>) => {
  const derived = derive(overrides);
  if (derived === undefined) {
    expect.unreachable('Expected an authored contribution');
  }
  return { ...derived, catalog: Schema.decodeSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog) };
};

const readPayload = Schema.Struct({ search: Schema.String });
const readApi = (payload: Schema.Top) =>
  HttpApi.make('BookingApi').add(
    HttpApiGroup.make('booking').add(
      HttpApiEndpoint.post('state', READ_PATH, { payload, success: Schema.Void }),
      HttpApiEndpoint.post('internal', '/internal/state', { payload, success: Schema.Void }),
    ),
  );

it('keeps catalog bytes, digest, command matching and optional contribution metadata', () => {
  const namedPayload = Schema.Struct({ code: Schema.String });
  const commandPayload = Schema.Struct({
    command: Schema.Union([
      Schema.Struct({ _tag: Schema.Literal('CancelBooking'), note: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal('KeepBooking') }),
    ]),
    expectedRevision: Schema.optionalKey(Schema.Int),
  });
  const result = catalogOf({
    actions: [
      { descriptor: { actionKey: ACTION_KEY, payloadSchema: namedPayload } },
      { descriptor: { actionKey: 'booking.execute', payloadSchema: commandPayload } },
    ],
    api: { BookingApi: readApi(readPayload) },
    authored: {
      ...authored,
      actions: { 'assign-code': { destructive: false, title } },
      agentAdministrationPage: '/agents',
      approvalReview: { privateRecords: true, read: 'state' },
      approvalsPage: { label: title, path: '/approvals' },
      commandFieldLabels: { note: 'Poznámka' },
      commands: {
        CancelBooking: { description: title, liveRight: 'canCancel', referenceAudiences: ['party-registry'], title },
        KeepBooking: OntosMcpHidden,
      },
      legalEntityWriteRelations: ['booking_admin'],
      ownProposalEngine: true,
      page: '/bookings',
      reads: { state: { title } },
      recordLinks: [],
      revision: { read: 'state' },
    },
  });
  const commandProperties = { note: { type: 'string' } };
  const expectedCatalog = Schema.encodeSync(OntosMcpToolCatalogJsonSchema)({
    definitions: {},
    tools: [
      {
        access: 'read',
        agentProposalOnly: false,
        destructive: false,
        id: 'booking/read/state',
        inputSchema: Schema.decodeUnknownSync(Schema.JsonObject)(Schema.toJsonSchemaDocument(readPayload).schema),
        invoke: { path: READ_PATH },
        name: 'booking_app__read_state',
        referenceAudiences: [],
        title,
      },
      {
        access: 'write',
        agentProposalOnly: false,
        description: title,
        destructive: true,
        id: 'booking/command/CancelBooking',
        inputSchema: {
          additionalProperties: true,
          properties: {
            ...commandProperties,
            expectedRevision: {
              description: 'Revize pro kontrolu souběžných změn; když chybí, OntOS ji načte sám. / Optional revision.',
              minimum: 0,
              type: 'integer',
            },
          },
          required: ['note'],
          type: 'object',
        },
        invoke: { commandTag: 'CancelBooking', path: '/booking-app/actions/execute' },
        liveRight: 'canCancel',
        name: 'booking_app__cancel_booking',
        referenceAudiences: ['party-registry'],
        title,
      },
      {
        access: 'write',
        agentProposalOnly: false,
        destructive: false,
        id: 'booking/action/assign-code',
        inputSchema: Schema.decodeUnknownSync(Schema.JsonObject)(Schema.toJsonSchemaDocument(namedPayload).schema),
        invoke: { path: '/booking-app/actions/assign-code' },
        name: 'booking_app__assign_code',
        referenceAudiences: [],
        title,
      },
    ],
  });
  expect(result.toolCatalog).toBe(expectedCatalog);
  expect(result.contribution).toEqual({
    agentAdministrationPage: '/agents',
    approvalReview: { path: READ_PATH, privateRecords: true },
    approvals: true,
    approvalsPage: { label: title, path: '/approvals' },
    commandFieldLabels: { note: 'Poznámka' },
    description: title,
    keywords: authored.keywords,
    label: title,
    legalEntityWriteRelations: ['booking_admin'],
    ownProposalEngine: true,
    page: '/bookings',
    recordLinks: [],
    revision: { field: 'revision', fieldsByCommandPrefix: [], path: READ_PATH, query: {} },
    toolCatalog: {
      path: ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
      sha256: createHash('sha256').update(expectedCatalog).digest('hex'),
      toolCount: 3,
    },
  });
});

it('takes the first duplicate read slug, ignores other routes and omits absent optional fields', () => {
  const result = catalogOf({
    api: { first: readApi(readPayload), second: readApi(Schema.Struct({ different: Schema.Boolean })) },
    authored: { ...authored, ownProposalEngine: false, reads: { state: { title } } },
  });
  expect(result.catalog.tools).toHaveLength(1);
  expect(result.catalog.tools[0]?.inputSchema).toEqual(Schema.toJsonSchemaDocument(readPayload).schema);
  expect(result.catalog.tools[0]).not.toHaveProperty('description');
  expect(result.catalog.tools[0]).not.toHaveProperty('liveRight');
  expect(result.contribution).not.toHaveProperty('ownProposalEngine');
  expect(result.contribution).not.toHaveProperty('revision');
});

it('does not inspect registrations when MCP is not authored', () => {
  const unauthored = (mcp?: OntosMcpContributionInput) => derive({ actions: [null], authored: mcp });
  expect(unauthored()).toBeUndefined();
});

it.each([null, [], {}, { descriptor: null }, { descriptor: { actionKey: 3 } }])(
  'rejects a malformed Action registration %j with the same named error',
  (action) => {
    expect(() => derive({ actions: [action] })).toThrow(OntosMcpContributionDerivationError);
    expect(() => derive({ actions: [action] })).toThrow('manifest Actions must be Action registrations');
  },
);

it.each([{}, { payloadSchema: {} }, { payloadSchema: null }])(
  'rejects an Action without an executable payload Schema %j',
  (descriptor) => {
    expect(() => derive({ actions: [{ descriptor: { actionKey: ACTION_KEY, ...descriptor } }] })).toThrow(
      'Action booking.assign-code has no payload Schema',
    );
  },
);

it('accepts an executable payload Schema but rejects missing and unknown contributions', () => {
  const actions = [{ descriptor: { actionKey: ACTION_KEY, payloadSchema: readPayload } }];
  expect(() => derive({ actions })).toThrow('booking: MCP actions not contributed or hidden: assign-code');
  expect(() => derive({ authored: { ...authored, reads: { unknown: { title } } } })).toThrow(
    'booking: MCP reads do not exist in the module: unknown',
  );
  const result = catalogOf({ actions, authored: { ...authored, actions: { 'assign-code': { title } } } });
  expect(result.catalog.tools[0]?.id).toBe('booking/action/assign-code');
});

it('merges identical definitions and rejects conflicting definitions without changing the error', () => {
  const payloadSchema = Schema.Struct({ value: Schema.String }).annotate({ identifier: 'SharedMcpPayload' });
  const actions = [
    { descriptor: { actionKey: 'booking.first', payloadSchema } },
    { descriptor: { actionKey: 'booking.second', payloadSchema } },
  ];
  const contribution = { ...authored, actions: { first: { title }, second: { title } } };
  expect(catalogOf({ actions, authored: contribution }).catalog.definitions).toHaveProperty('SharedMcpPayload');
  const incompatible = Schema.Struct({ value: Schema.Boolean }).annotate({ identifier: 'SharedMcpPayload' });
  expect(() =>
    derive({
      actions: [actions[0], { descriptor: { actionKey: 'booking.second', payloadSchema: incompatible } }],
      authored: contribution,
    }),
  ).toThrow('booking action second: JSON Schema definition SharedMcpPayload differs between two schemas of the module');
});

it('rejects duplicate tool ids and normalized tool names', () => {
  const action = { descriptor: { actionKey: ACTION_KEY, payloadSchema: readPayload } };
  expect(() =>
    derive({ actions: [action, action], authored: { ...authored, actions: { 'assign-code': { title } } } }),
  ).toThrow('booking: duplicate MCP tool id booking/action/assign-code');
  expect(() =>
    derive({
      actions: [action, { descriptor: { actionKey: 'booking.assign_code', payloadSchema: readPayload } }],
      authored: { ...authored, actions: { assign_code: { title }, 'assign-code': { title } } },
    }),
  ).toThrow('booking: duplicate MCP tool name booking_app__assign_code');
});

it('retains native schema failures for invalid serialized contribution fields', () => {
  expect(() => derive({ authored: { ...authored, page: 'not-a-shell-page' } })).toThrow(Schema.SchemaError);
});

it('keeps the normalization and hash suffix of long tool names', () => {
  expect(mcpToolName('Booking.App', 'CancelBooking')).toBe('booking_app__cancel_booking');
  const appId = 'a'.repeat(50);
  const suffix = 'b'.repeat(50);
  const full = `${appId}__${suffix}`;
  expect(mcpToolName(appId, suffix)).toBe(
    `${full.slice(0, 55)}_${createHash('sha256').update(full).digest('hex').slice(0, 8)}`,
  );
  expect(mcpToolName(appId, suffix)).toHaveLength(64);
});
