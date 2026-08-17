// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import {
  CrmAuthenticationProblemSchema,
  CrmConflictProblemSchema,
  CrmInternalProblemSchema,
  CrmInvalidRequestProblemSchema,
  CrmNotFoundProblemSchema,
  CrmPreconditionRequiredProblemSchema,
  CrmUnavailableProblemSchema,
  crmApiContract,
  crmOperationContexts,
} from '../../shared/api.ts';

const expectedOperations = [
  'archiveContact',
  'archiveCustomer',
  'createContact',
  'createCustomer',
  'editContact',
  'editCustomer',
  'getContact',
  'getContactList',
  'getCustomerDetail',
  'getCustomerList',
  'lookupCustomerAres',
  'readiness',
  'unarchiveContact',
  'unarchiveCustomer',
] as const;

test('publishes the exact CRM contract-derived operation surface', async () => {
  assert.deepEqual(Object.keys(crmOperationContexts).toSorted(), expectedOperations);
  assert.deepEqual(crmApiContract, {
    apiPrefix: '/crm-api',
    basePath: '/crm-api/crm',
    ownerId: 'crm',
    readinessPath: '/crm-api/crm/readiness',
  });
  const client = await readFile(new URL('../../src/api/crm-client.ts', import.meta.url), 'utf-8');
  const exportedMethods = [
    ...client.matchAll(
      /export const (?<constant>\w+)\s*=|export const (?<functionName>\w+)\s*\(/gu,
    ),
  ]
    .map((match) => match.groups?.['constant'] ?? match.groups?.['functionName'])
    .filter(
      (name) => name !== undefined && name !== 'createCrmClient' && name !== 'getCrmReadiness',
    )
    .toSorted();
  assert.deepEqual(
    exportedMethods,
    expectedOperations.filter((name) => name !== 'readiness'),
  );
  assert.doesNotMatch(client, /\bfetch\s*\(/u);
  assert.match(client, /actionGateway\.invoke/u);
  assert.match(client, /readonly idempotencyKey: string/u);
  assert.match(client, /readonly correlationId: string/u);
  assert.match(client, /readonly traceId\?: string/u);
  const contract = await readFile(new URL('../../shared/api.ts', import.meta.url), 'utf-8');
  assert.match(
    contract,
    /createCustomer[\s\S]*?error: mutationErrors,[\s\S]*?editCustomer[\s\S]*?error: addressedMutationErrors,/u,
  );
});

test('uses status-matched, concrete Problem Details schemas', () => {
  const fixtures = [
    [CrmInvalidRequestProblemSchema, 'CrmInvalidRequestProblem', 400],
    [CrmAuthenticationProblemSchema, 'CrmAuthenticationProblem', 401],
    [CrmNotFoundProblemSchema, 'CrmNotFoundProblem', 404],
    [CrmConflictProblemSchema, 'CrmConflictProblem', 409],
    [CrmPreconditionRequiredProblemSchema, 'CrmPreconditionRequiredProblem', 428],
    [CrmUnavailableProblemSchema, 'CrmUnavailableProblem', 503],
    [CrmInternalProblemSchema, 'CrmInternalProblem', 500],
  ] as const;
  for (const [schema, tag, status] of fixtures) {
    const decoded = Schema.decodeUnknownSync(schema)({
      _tag: tag,
      detail: 'safe detail',
      ...(status === 503 ? { retryable: true } : {}),
      status,
      title: 'safe title',
      type: 'https://ontos.dev/problems/test',
    });
    assert.equal(decoded.status, status);
  }
});
