// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import {
  ProjectsAuthenticationProblemSchema,
  ProjectsConflictProblemSchema,
  ProjectsInternalProblemSchema,
  ProjectsInvalidRequestProblemSchema,
  ProjectsNotFoundProblemSchema,
  ProjectsPreconditionRequiredProblemSchema,
  ProjectsUnavailableProblemSchema,
  projectsApiContract,
  projectsOperationContexts,
} from '../../shared/api.ts';
import type { Customer as PublicCustomer } from '../../shared/api.ts';
import {
  CustomerDetailAuthenticationProblemSchema,
  CustomerDetailForbiddenProblemSchema,
  CustomerDetailInternalProblemSchema,
  CustomerDetailInvalidProblemSchema,
  CustomerDetailNotFoundProblemSchema,
  CustomerDetailResponseSchema,
  CustomerDetailUnavailableProblemSchema,
} from '../../shared/apis/customer-detail.ts';
import {
  CustomerListAuthenticationProblemSchema,
  CustomerListForbiddenProblemSchema,
  CustomerListInternalProblemSchema,
  CustomerListInvalidProblemSchema,
  CustomerListResponseSchema,
  CustomerListUnavailableProblemSchema,
} from '../../shared/apis/customer-list.ts';
import { customerDetailRead } from '../../src/api/customer-detail.read.ts';
import { customerListRead } from '../../src/api/customer-list.read.ts';

const customer = {
  archivedAt: null,
  createdAt: '2026-08-14T10:00:00.000Z',
  customerId: 'c2000000-0000-4000-8000-000000000001',
  dic: 'CZ00123456',
  dissolvedOn: '2026-08-17',
  establishedOn: '2020-01-02',
  ico: '00123456',
  legalFormCode: '112',
  name: 'Acme',
  updatedAt: '2026-08-14T10:00:00.000Z',
} as const satisfies PublicCustomer;

interface ProblemFixture {
  _tag: string;
  detail: string;
  retryable?: boolean;
  status: number;
  title: string;
  type: string;
}

const assertProblemSchemaStatus = <Value extends { readonly status: number }>(
  decode: (input: ProblemFixture) => Value,
  tag: string,
  status: number,
  retryable: boolean,
) => {
  const problem: ProblemFixture = {
    _tag: tag,
    detail: 'safe detail',
    status,
    title: 'safe title',
    type: 'https://ontos.dev/problems/test',
  };
  if (retryable) {
    problem.retryable = true;
  }
  const decoded = decode(problem);
  assert.equal(decoded.status, status);
};

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

test('publishes the exact Projects contract-derived operation surface', async () => {
  assert.deepEqual(Object.keys(projectsOperationContexts).toSorted(), expectedOperations);
  assert.deepEqual(projectsApiContract, {
    apiPrefix: '/projects-api',
    basePath: '/projects-api/projects',
    ownerId: 'projects',
    readinessPath: '/projects-api/projects/readiness',
  });
  const client = await readFile(
    new URL('../../src/api/projects-client.ts', import.meta.url),
    'utf-8',
  );
  const exportedMethods = [
    ...client.matchAll(
      /export const (?<constant>\w+)\s*=|export const (?<functionName>\w+)\s*\(/gu,
    ),
  ]
    .map((match) => match.groups?.['constant'] ?? match.groups?.['functionName'])
    .filter(
      (name) =>
        name !== undefined && name !== 'createProjectsClient' && name !== 'getProjectsReadiness',
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
    [ProjectsInvalidRequestProblemSchema, 'ProjectsInvalidRequestProblem', 400],
    [ProjectsAuthenticationProblemSchema, 'ProjectsAuthenticationProblem', 401],
    [ProjectsNotFoundProblemSchema, 'ProjectsNotFoundProblem', 404],
    [ProjectsPreconditionRequiredProblemSchema, 'ProjectsPreconditionRequiredProblem', 428],
    [ProjectsUnavailableProblemSchema, 'ProjectsUnavailableProblem', 503],
    [ProjectsInternalProblemSchema, 'ProjectsInternalProblem', 500],
  ] as const;
  for (const [schema, tag, status] of fixtures) {
    assertProblemSchemaStatus(Schema.decodeUnknownSync(schema), tag, status, status === 503);
  }
  for (const code of ['projects_conflict', 'projects_customer_ico_conflict'] as const) {
    const conflict = Schema.decodeUnknownSync(ProjectsConflictProblemSchema)({
      _tag: 'ProjectsConflictProblem',
      code,
      detail: 'safe detail',
      status: 409,
      title: 'safe title',
      type: 'https://ontos.dev/problems/test',
    });
    assert.equal(conflict.code, code);
  }
});

test('keeps Customer detail and list descriptors and generated clients stable', async () => {
  assert.deepEqual(
    {
      accessKind: customerDetailRead.descriptor.accessKind,
      entrypoint: customerDetailRead.descriptor.entrypoint,
      evidencePolicy: customerDetailRead.descriptor.evidencePolicy,
      legalEntityScope: customerDetailRead.descriptor.legalEntityScope,
      owningModuleKey: customerDetailRead.descriptor.owningModuleKey,
      permissionTarget: customerDetailRead.descriptor.permissionTarget,
      policies: customerDetailRead.descriptor.policies,
      readKey: customerDetailRead.descriptor.readKey,
      schemaVersion: customerDetailRead.descriptor.schemaVersion,
    },
    {
      accessKind: 'detail',
      entrypoint: {
        access: 'read',
        entrypointKey: 'projects.core.api.customer-detail',
        moduleKey: 'projects.core',
        role: 'api',
        scope: 'tenant',
      },
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'projects.core.api.customer-detail.evidence.v1',
      },
      legalEntityScope: 'optional',
      owningModuleKey: 'projects.core',
      permissionTarget: 'tenant',
      policies: [],
      readKey: 'projects.core.api.customer-detail',
      schemaVersion: '1',
    },
  );
  assert.deepEqual(
    {
      accessKind: customerListRead.descriptor.accessKind,
      entrypoint: customerListRead.descriptor.entrypoint,
      evidencePolicy: customerListRead.descriptor.evidencePolicy,
      legalEntityScope: customerListRead.descriptor.legalEntityScope,
      owningModuleKey: customerListRead.descriptor.owningModuleKey,
      permissionTarget: customerListRead.descriptor.permissionTarget,
      policies: customerListRead.descriptor.policies,
      readKey: customerListRead.descriptor.readKey,
      schemaVersion: customerListRead.descriptor.schemaVersion,
    },
    {
      accessKind: 'list',
      entrypoint: {
        access: 'read',
        entrypointKey: 'projects.core.api.customer-list',
        moduleKey: 'projects.core',
        role: 'api',
        scope: 'tenant',
      },
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'projects.core.api.customer-list.evidence.v1',
      },
      legalEntityScope: 'optional',
      owningModuleKey: 'projects.core',
      permissionTarget: 'tenant',
      policies: [],
      readKey: 'projects.core.api.customer-list',
      schemaVersion: '1',
    },
  );
  assert.equal(customerDetailRead.descriptor.resultSchema, CustomerDetailResponseSchema);
  assert.equal(customerListRead.descriptor.resultSchema, CustomerListResponseSchema);

  const [detailClient, listClient, publicApi] = await Promise.all([
    readFile(new URL('../../src/api/customer-detail-client.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../src/api/customer-list-client.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../shared/api.ts', import.meta.url), 'utf-8'),
  ]);
  assert.match(detailClient, /makeEffectHttpApiClient\(CustomerDetailApi,/u);
  assert.match(listClient, /makeEffectHttpApiClient\(CustomerListApi,/u);
  assert.match(detailClient, /operationGateway\.invoke/u);
  assert.match(listClient, /operationGateway\.invoke/u);
  assert.doesNotMatch(detailClient, /\bfetch\s*\(/u);
  assert.doesNotMatch(listClient, /\bfetch\s*\(/u);
  assert.match(publicApi, /export type \{ CustomerDetailRequest, CustomerDetailResponse \}/u);
  assert.match(publicApi, /export type \{ CustomerListRequest, CustomerListResponse \}/u);
  assert.match(
    publicApi,
    /export type \{[\s\S]*?Customer,[\s\S]*?\} from '.\/apis\/customer-detail\.ts';/u,
  );
  assert.match(
    publicApi,
    /\.addHttpApi\(CustomerDetailApi\)[\s\S]*?\.addHttpApi\(CustomerListApi\)/u,
  );
});

test('decodes complete and nullable Customers through the public detail and list schemas', () => {
  const nullableCustomer = {
    ...customer,
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
  };
  assert.deepEqual(Schema.decodeUnknownSync(CustomerDetailResponseSchema)(customer), customer);
  assert.deepEqual(
    Schema.decodeUnknownSync(CustomerDetailResponseSchema)(nullableCustomer),
    nullableCustomer,
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(CustomerListResponseSchema)({
      items: [customer, nullableCustomer],
      nextOffset: null,
    }),
    { items: [customer, nullableCustomer], nextOffset: null },
  );
});

test('keeps Customer read Problem Details unions status-matched and typed', () => {
  const fixtures = [
    [CustomerDetailInvalidProblemSchema, 'CustomerDetailInvalidProblem', 400, false],
    [CustomerDetailAuthenticationProblemSchema, 'CustomerDetailAuthenticationProblem', 401, false],
    [CustomerDetailForbiddenProblemSchema, 'CustomerDetailForbiddenProblem', 403, false],
    [CustomerDetailNotFoundProblemSchema, 'CustomerDetailNotFoundProblem', 404, false],
    [CustomerDetailUnavailableProblemSchema, 'CustomerDetailUnavailableProblem', 503, true],
    [CustomerDetailInternalProblemSchema, 'CustomerDetailInternalProblem', 500, false],
    [CustomerListInvalidProblemSchema, 'CustomerListInvalidProblem', 400, false],
    [CustomerListAuthenticationProblemSchema, 'CustomerListAuthenticationProblem', 401, false],
    [CustomerListForbiddenProblemSchema, 'CustomerListForbiddenProblem', 403, false],
    [CustomerListUnavailableProblemSchema, 'CustomerListUnavailableProblem', 503, true],
    [CustomerListInternalProblemSchema, 'CustomerListInternalProblem', 500, false],
  ] as const;
  for (const [schema, tag, status, retryable] of fixtures) {
    assertProblemSchemaStatus(Schema.decodeUnknownSync(schema), tag, status, retryable);
  }
});
