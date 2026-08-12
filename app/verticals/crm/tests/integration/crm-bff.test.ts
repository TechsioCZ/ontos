/* eslint-disable max-lines, no-await-in-loop, no-promise-executor-return, node/no-process-env, promise/avoid-new, promise/no-multiple-resolved, promise/prefer-await-to-callbacks, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/no-await-expression-member -- One deliberately sequential strict HTTP fixture switches fake runtime outcomes while exercising every generated CRM group and Node's callback-only server lifecycle. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ActionPermissionDenied,
  ActionPermissionCheckError,
  ActionRequestHashConflict,
  ActionRuntime,
  OperationContextDenied,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPolicyDenied,
  ReadRuntime,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { changeCustomerPrimaryContactActionApiLive } from '../../api/change-customer-primary-contact-action-server.ts';
import { contactDetailReadApiLive } from '../../api/contact-detail-read-server.ts';
import { createContactActionApiLive } from '../../api/create-contact-action-server.ts';
import { createCustomerActionApiLive } from '../../api/create-customer-action-server.ts';
import { createDealActionApiLive } from '../../api/create-deal-action-server.ts';
import { customerDetailReadApiLive } from '../../api/customer-detail-read-server.ts';
import { customerDirectoryReadApiLive } from '../../api/customer-directory-read-server.ts';
import { customerTimelineReadApiLive } from '../../api/customer-timeline-read-server.ts';
import { dealDetailReadApiLive } from '../../api/deal-detail-read-server.ts';
import { dealWorkspaceReadApiLive } from '../../api/deal-workspace-read-server.ts';
import { deleteContactActionApiLive } from '../../api/delete-contact-action-server.ts';
import { deleteCustomerActionApiLive } from '../../api/delete-customer-action-server.ts';
import { deleteDealActionApiLive } from '../../api/delete-deal-action-server.ts';
import { editContactActionApiLive } from '../../api/edit-contact-action-server.ts';
import { editCustomerActionApiLive } from '../../api/edit-customer-action-server.ts';
import { editDealActionApiLive } from '../../api/edit-deal-action-server.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { crmApi } from '../../shared/api.ts';
import {
  CreateContactConflict,
  CreateContactNotFound,
  CreateContactRejected,
  CreateContactUnavailable,
} from '../../src/actions/create-contact.action.ts';
import {
  CreateDealConflict,
  CreateDealNotFound,
  CreateDealRejected,
  CreateDealUnavailable,
} from '../../src/actions/create-deal.action.ts';
import {
  DeleteDealConflict,
  DeleteDealNotFound,
  DeleteDealRejected,
  DeleteDealUnavailable,
} from '../../src/actions/delete-deal.action.ts';
import {
  EditDealConflict,
  EditDealNotFound,
  EditDealRejected,
  EditDealUnavailable,
} from '../../src/actions/edit-deal.action.ts';
import { executeContactDetailWithAuthorization } from '../../src/api/contact-detail-client.ts';
import { executeCreateContactActionWithAuthorization } from '../../src/api/create-contact-action-client.ts';
import { executeCreateDealActionWithAuthorization } from '../../src/api/create-deal-action-client.ts';
import { executeCustomerDirectoryWithAuthorization } from '../../src/api/customer-directory-client.ts';
import { executeDealDetailWithAuthorization } from '../../src/api/deal-detail-client.ts';
import { executeDealWorkspaceWithAuthorization } from '../../src/api/deal-workspace-client.ts';
import { executeDeleteDealActionWithAuthorization } from '../../src/api/delete-deal-action-client.ts';
import { executeEditDealActionWithAuthorization } from '../../src/api/edit-deal-action-client.ts';

type ActionMode =
  | 'conflict'
  | 'defect'
  | 'denied'
  | 'hash_conflict'
  | 'not_found'
  | 'permission_unavailable'
  | 'rejected'
  | 'success'
  | 'unavailable';
type ReadMode =
  | 'conflict'
  | 'defect'
  | 'denied'
  | 'not_found'
  | 'rejected'
  | 'success'
  | 'unavailable';

const contactId = '20000000-0000-4000-8000-000000000001';
const customerId = '10000000-0000-4000-8000-000000000001';
const contact = {
  contactId,
  createdAt: '2026-08-11T10:00:00.000Z',
  customerId,
  customerLabel: 'Acme',
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  firstName: 'Ada',
  isPrimaryContact: false,
  jobTitle: 'Engineer',
  lastName: 'Lovelace',
  phone: null,
  updatedAt: '2026-08-11T10:00:00.000Z',
  version: 1,
} as const;
const dealId = '70000000-0000-4000-8000-000000000001';
const deal = {
  contactId,
  contactLabel: contact.displayName,
  createdAt: '2026-08-12T10:00:00.000Z',
  currency: 'CZK',
  customerId,
  customerLabel: 'Acme',
  dealId,
  description: null,
  expectedCloseDate: null,
  expectedValue: 1000,
  status: 'New' as const,
  title: 'Annual agreement',
  updatedAt: '2026-08-12T10:00:00.000Z',
  version: 1,
} as const;
const deletedDeal = {
  customerId,
  customerLabel: deal.customerLabel,
  dealId,
  deletedAt: '2026-08-12T11:00:00.000Z',
  version: 2,
} as const;

type DealActionKey = 'crm.core.create-deal' | 'crm.core.delete-deal' | 'crm.core.edit-deal';
type DealDomainErrorMode = 'conflict' | 'not_found' | 'rejected' | 'unavailable';

const dealDomainErrorFactories = {
  'crm.core.create-deal': {
    conflict: () => new CreateDealConflict({ code: 'action_conflict', reason: 'Test conflict' }),
    not_found: () =>
      new CreateDealNotFound({ code: 'action_target_not_found', reason: 'Test absence' }),
    rejected: () =>
      new CreateDealRejected({ code: 'action_semantically_rejected', reason: 'Test rejection' }),
    unavailable: () =>
      new CreateDealUnavailable({
        code: 'deal_persistence_unavailable',
        reason: 'Test unavailable',
      }),
  },
  'crm.core.delete-deal': {
    conflict: () => new DeleteDealConflict({ code: 'action_conflict', reason: 'Test conflict' }),
    not_found: () =>
      new DeleteDealNotFound({ code: 'action_target_not_found', reason: 'Test absence' }),
    rejected: () =>
      new DeleteDealRejected({ code: 'action_semantically_rejected', reason: 'Test rejection' }),
    unavailable: () =>
      new DeleteDealUnavailable({
        code: 'deal_persistence_unavailable',
        reason: 'Test unavailable',
      }),
  },
  'crm.core.edit-deal': {
    conflict: () => new EditDealConflict({ code: 'action_conflict', reason: 'Test conflict' }),
    not_found: () =>
      new EditDealNotFound({ code: 'action_target_not_found', reason: 'Test absence' }),
    rejected: () =>
      new EditDealRejected({ code: 'action_semantically_rejected', reason: 'Test rejection' }),
    unavailable: () =>
      new EditDealUnavailable({
        code: 'deal_persistence_unavailable',
        reason: 'Test unavailable',
      }),
  },
} satisfies Record<DealActionKey, Record<DealDomainErrorMode, () => unknown>>;

const dealDomainError = (actionKey: DealActionKey, mode: DealDomainErrorMode) =>
  dealDomainErrorFactories[actionKey][mode]();

const foundationLive = HttpApiBuilder.group(crmApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }),
  ),
);

const makeAuthorizationFixture = async () => {
  const issuer = 'https://shell.crm-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'crm-bff-test',
    use: 'sig',
  };
  const issue = (principal: TrustedPrincipalContext) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'crm-bff-test', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience('crm')
      .setSubject(principal.principalId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(privateKey);
  };
  return { issue, issuer, jwks: JSON.stringify({ keys: [publicJwk] }) };
};

const responseJson = (response: Response) => response.json() as Promise<Record<string, unknown>>;

test('serves strict CRM Action/read problems and decodes generated Effect clients', async () => {
  const authorizationFixture = await makeAuthorizationFixture();
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  process.env['ONTOS_GATEWAY_ISSUER'] = authorizationFixture.issuer;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = authorizationFixture.jwks;
  let actionMode: ActionMode = 'success';
  let actionSubject: 'contact' | 'deal' = 'contact';
  let readMode: ReadMode = 'success';
  let lastActionPayload: unknown;
  const actionRuntime = {
    resolveActionCommit: () => Effect.die('Unused test seam'),
    runAction: (input: {
      readonly payload: unknown;
      readonly registration: { readonly descriptor: { readonly actionKey: string } };
    }) => {
      lastActionPayload = input.payload;
      const dealActionKey = input.registration.descriptor.actionKey as DealActionKey;
      // eslint-disable-next-line default-case -- The closed test mode union makes this switch exhaustive.
      switch (actionMode) {
        case 'conflict': {
          return Effect.fail(
            actionSubject === 'contact'
              ? new CreateContactConflict({ code: 'action_conflict', reason: 'Test conflict' })
              : dealDomainError(dealActionKey, 'conflict'),
          );
        }
        case 'defect': {
          return Effect.die(new Error('secret database detail'));
        }
        case 'denied': {
          return Effect.fail(
            new ActionPermissionDenied({
              code: 'action_permission_denied',
              reason: 'Test denial',
            }),
          );
        }
        case 'hash_conflict': {
          return Effect.fail(
            new ActionRequestHashConflict({
              code: 'action_request_hash_conflict',
              reason: 'Test idempotency hash conflict',
            }),
          );
        }
        case 'not_found': {
          return Effect.fail(
            actionSubject === 'contact'
              ? new CreateContactNotFound({
                  code: 'action_target_not_found',
                  reason: 'Test absence',
                })
              : dealDomainError(dealActionKey, 'not_found'),
          );
        }
        case 'permission_unavailable': {
          return Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'Test permission check unavailable',
            }),
          );
        }
        case 'rejected': {
          return Effect.fail(
            actionSubject === 'contact'
              ? new CreateContactRejected({
                  code: 'action_semantically_rejected',
                  reason: 'Test rejection',
                })
              : dealDomainError(dealActionKey, 'rejected'),
          );
        }
        case 'success': {
          if (actionSubject === 'contact') {
            return Effect.succeed(contact);
          }
          return Effect.succeed(dealActionKey === 'crm.core.delete-deal' ? deletedDeal : deal);
        }
        case 'unavailable': {
          return Effect.fail(
            actionSubject === 'contact'
              ? new CreateContactUnavailable({
                  code: 'contact_persistence_unavailable',
                  reason: 'Test unavailable',
                })
              : dealDomainError(dealActionKey, 'unavailable'),
          );
        }
      }
    },
  };
  const readRuntime = {
    runRead: (input: {
      readonly principal: TrustedPrincipalContext;
      readonly registration: { readonly descriptor: { readonly readKey: string } };
    }) => {
      if (input.principal.legalEntityId === undefined) {
        return Effect.fail(
          new OperationContextDenied({
            code: 'operation_context_denied',
            reason: 'Selected Legal Entity required',
          }),
        );
      }
      // eslint-disable-next-line default-case -- The closed test mode union makes this switch exhaustive.
      switch (readMode) {
        case 'defect': {
          return Effect.die(new Error('secret read database detail'));
        }
        case 'denied': {
          return Effect.fail(
            new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Test denial' }),
          );
        }
        case 'conflict': {
          return Effect.fail(
            new ReadPolicyDenied({
              code: 'read_policy_denied',
              httpStatus: 409,
              policyReasonCode: 'test_conflict',
              reason: 'Test read conflict',
            }),
          );
        }
        case 'not_found': {
          return Effect.fail(
            new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Test absence' }),
          );
        }
        case 'rejected': {
          return Effect.fail(
            new ReadPolicyDenied({
              code: 'read_policy_denied',
              httpStatus: 422,
              policyReasonCode: 'test_rejected',
              reason: 'Test read rejection',
            }),
          );
        }
        case 'unavailable': {
          return Effect.fail(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Test unavailable',
            }),
          );
        }
        case 'success': {
          switch (input.registration.descriptor.readKey) {
            case 'crm.core.api.contact-detail': {
              return Effect.succeed({
                fields: [{ label: 'Customer', value: 'Acme' }],
                title: contact.displayName,
              });
            }
            case 'crm.core.api.customer-directory.contact-detail': {
              return Effect.succeed({ contact, operation: 'contact_detail' as const });
            }
            case 'crm.core.api.customer-directory.contacts': {
              return Effect.succeed({
                customerId,
                customerLabel: 'Acme',
                items: [contact],
                nextCursor: null,
                operation: 'contacts' as const,
              });
            }
            case 'crm.core.api.deal-detail': {
              return Effect.succeed({
                fields: [
                  { label: 'Customer', value: deal.customerLabel },
                  { label: 'Status', value: deal.status },
                ],
                title: deal.title,
              });
            }
            case 'crm.core.api.deal-workspace.detail': {
              return Effect.succeed({ deal, operation: 'detail' as const });
            }
            case 'crm.core.api.deal-workspace.list': {
              return Effect.succeed({
                items: [deal],
                nextCursor: null,
                operation: 'list' as const,
              });
            }
            default: {
              return Effect.die('Unexpected read registration in Contact BFF test');
            }
          }
        }
      }
    },
  };
  const layer = HttpApiBuilder.layer(crmApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLive,
        changeCustomerPrimaryContactActionApiLive,
        contactDetailReadApiLive,
        createContactActionApiLive,
        createCustomerActionApiLive,
        createDealActionApiLive,
        customerDetailReadApiLive,
        customerDirectoryReadApiLive,
        customerTimelineReadApiLive,
        dealDetailReadApiLive,
        dealWorkspaceReadApiLive,
        deleteContactActionApiLive,
        deleteCustomerActionApiLive,
        deleteDealActionApiLive,
        editContactActionApiLive,
        editCustomerActionApiLive,
        editDealActionApiLive,
      ),
    ),
    Layer.provide(Layer.succeed(ReadRuntime, readRuntime as never)),
    Layer.provide(Layer.succeed(ActionRuntime, actionRuntime as never)),
  );
  const bff = defineEffectBff({ api: crmApi as never, layer: layer as never });
  const handler = bff.createHandler();
  const principal = {
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:crm-bff-test',
    authMethod: 'session' as const,
    legalEntityId: '40000000-0000-4000-8000-000000000001',
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId: '60000000-0000-4000-8000-000000000001',
  };
  const authorization = `Bearer ${await authorizationFixture.issue(principal)}`;
  const request = (
    path: string,
    payload: unknown,
    bearer = authorization,
    correlationId: null | string = randomUUID(),
  ) =>
    handler.handler(
      new Request(`http://crm-bff.test${path}`, {
        body: JSON.stringify(payload),
        headers: {
          authorization: bearer,
          'content-type': 'application/json',
          ...(correlationId === null ? {} : { 'x-correlation-id': correlationId }),
          'x-idempotency-key': randomUUID(),
        },
        method: 'POST',
      }),
    );

  let server: ReturnType<typeof createServer> | undefined;
  try {
    const invalid = await request('/actions/create-contact', {
      customerId: 'not-a-uuid',
      firstName: 'Ada',
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await request(
      '/actions/create-contact',
      { customerId, firstName: 'Ada' },
      '',
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer');

    const extraProperty = await request('/actions/create-contact', {
      customerId,
      firstName: 'Ada',
      isPrimaryContact: true,
    });
    assert.equal(extraProperty.status, 200);
    assert.deepEqual(lastActionPayload, { customerId, firstName: 'Ada' });

    for (const [mode, status] of [
      ['denied', 403],
      ['not_found', 404],
      ['conflict', 409],
      ['rejected', 422],
      ['unavailable', 503],
      ['defect', 500],
    ] as const) {
      actionMode = mode;
      const response = await request('/actions/create-contact', { customerId, firstName: 'Ada' });
      assert.equal(response.status, status);
      const body = await responseJson(response);
      assert.doesNotMatch(JSON.stringify(body), /secret|database detail/iu);
      if (status === 503) {
        assert.equal(body['retryable'], true);
      }
    }

    actionMode = 'success';
    for (const [payload, expected] of [
      [{ customerId, limit: 10, operation: 'contacts' }, 'contacts'],
      [{ contactId, operation: 'contact_detail' }, 'contact_detail'],
    ] as const) {
      const response = await request('/reads/customer-directory', payload);
      assert.equal(response.status, 200);
      assert.equal((await responseJson(response))['operation'], expected);
    }
    const resourceDetail = await request('/reads/contact-detail', {
      moduleId: 'crm.core',
      resourceId: contactId,
      resourceType: 'crm.core.contact',
    });
    assert.equal(resourceDetail.status, 200);
    assert.equal((await responseJson(resourceDetail))['title'], 'Ada Lovelace');

    actionSubject = 'deal';
    const dealActions = [
      {
        path: '/actions/create-deal',
        payload: {
          currency: 'CZK',
          customerId,
          expectedValue: 1000,
          title: 'Annual agreement',
        },
      },
      {
        path: '/actions/edit-deal',
        payload: {
          currency: 'EUR',
          customerId,
          dealId,
          expectedValue: 1100,
          expectedVersion: 1,
          title: 'Edited agreement',
        },
      },
      { path: '/actions/delete-deal', payload: { dealId, expectedVersion: 1 } },
    ] as const;
    for (const invalidDealAction of [
      {
        path: '/actions/create-deal',
        payload: {
          currency: 'ZZZ',
          customerId,
          expectedValue: 1000,
          title: 'Annual agreement',
        },
      },
      {
        path: '/actions/edit-deal',
        payload: {
          currency: 'EUR',
          customerId,
          dealId: 'invalid',
          expectedValue: 1100,
          expectedVersion: 1,
          title: 'Edited agreement',
        },
      },
      { path: '/actions/delete-deal', payload: { dealId: 'invalid', expectedVersion: 1 } },
    ]) {
      assert.equal((await request(invalidDealAction.path, invalidDealAction.payload)).status, 400);
    }
    const createdDeal = await request('/actions/create-deal', {
      currency: 'CZK',
      customerId,
      expectedValue: 1000,
      status: 'Won',
      title: 'Annual agreement',
    });
    assert.equal(createdDeal.status, 200);
    assert.deepEqual(lastActionPayload, {
      currency: 'CZK',
      customerId,
      expectedValue: 1000,
      title: 'Annual agreement',
    });
    for (const action of dealActions) {
      const unauthenticatedDeal = await request(action.path, action.payload, '');
      assert.equal(unauthenticatedDeal.status, 401);
      assert.equal(unauthenticatedDeal.headers.get('www-authenticate'), 'Bearer');
      for (const [mode, status] of [
        ['denied', 403],
        ['not_found', 404],
        ['conflict', 409],
        ['hash_conflict', 409],
        ['rejected', 422],
        ['unavailable', 503],
        ['permission_unavailable', 503],
        ['defect', 500],
      ] as const) {
        actionMode = mode;
        const response = await request(action.path, action.payload);
        assert.equal(response.status, status, `${action.path} ${mode}`);
        const body = await responseJson(response);
        assert.doesNotMatch(JSON.stringify(body), /secret|database detail/iu);
        if (status === 503) {
          assert.equal(body['retryable'], true);
        }
      }
    }
    actionMode = 'success';
    for (const action of dealActions) {
      assert.equal((await request(action.path, action.payload)).status, 200);
    }
    for (const [payload, expected] of [
      [{ customerId, limit: 10, operation: 'list' }, 'list'],
      [{ dealId, operation: 'detail' }, 'detail'],
    ] as const) {
      const response = await request('/reads/deal-workspace', payload);
      assert.equal(response.status, 200);
      assert.equal((await responseJson(response))['operation'], expected);
    }
    const dealResourceDetail = await request('/reads/deal-detail', {
      moduleId: 'crm.core',
      resourceId: dealId,
      resourceType: 'crm.core.deal',
    });
    assert.equal(dealResourceDetail.status, 200);
    assert.equal((await responseJson(dealResourceDetail))['title'], deal.title);

    const dealReadRequests = [
      {
        path: '/reads/deal-workspace',
        payload: { dealId, operation: 'detail' },
      },
      {
        path: '/reads/deal-detail',
        payload: { moduleId: 'crm.core', resourceId: dealId, resourceType: 'crm.core.deal' },
      },
    ] as const;
    for (const read of dealReadRequests) {
      assert.equal((await request(read.path, read.payload, authorization, null)).status, 400);
      const unauthenticatedDealRead = await request(read.path, read.payload, '');
      assert.equal(unauthenticatedDealRead.status, 401);
      assert.equal(unauthenticatedDealRead.headers.get('www-authenticate'), 'Bearer');
      for (const [mode, status] of [
        ['denied', 403],
        ['not_found', 404],
        ['conflict', 409],
        ['rejected', 422],
        ['unavailable', 503],
        ['defect', 500],
      ] as const) {
        readMode = mode;
        const response = await request(read.path, read.payload);
        assert.equal(response.status, status, `${read.path} ${mode}`);
        const body = await responseJson(response);
        assert.doesNotMatch(JSON.stringify(body), /secret|database detail/iu);
        if (status === 503) {
          assert.equal(body['retryable'], true);
        }
      }
    }
    readMode = 'success';

    const noLegalEntity = { ...principal, legalEntityId: undefined };
    const noLegalEntityAuthorization = `Bearer ${await authorizationFixture.issue(noLegalEntity)}`;
    assert.equal(
      (
        await request(
          '/reads/customer-directory',
          { customerId, limit: 10, operation: 'contacts' },
          noLegalEntityAuthorization,
        )
      ).status,
      403,
    );
    for (const read of dealReadRequests) {
      assert.equal(
        (await request(read.path, read.payload, noLegalEntityAuthorization)).status,
        403,
      );
    }
    for (const [mode, status] of [
      ['denied', 403],
      ['not_found', 404],
      ['unavailable', 503],
      ['defect', 500],
    ] as const) {
      readMode = mode;
      const response = await request('/reads/contact-detail', {
        moduleId: 'crm.core',
        resourceId: contactId,
        resourceType: 'crm.core.contact',
      });
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /secret|database detail/iu);
    }

    readMode = 'success';
    actionSubject = 'contact';
    server = createServer(async (incoming, outgoing) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(',') : value);
        }
      }
      const response = await handler.handler(
        new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
          headers,
          method: incoming.method,
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const clientResult = await Effect.runPromise(
      executeCreateContactActionWithAuthorization({ customerId, firstName: 'Ada' }, authorization, {
        baseUrl,
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    assert.deepEqual(clientResult, contact);

    actionMode = 'conflict';
    const decodedConflict = await Effect.runPromise(
      Effect.flip(
        executeCreateContactActionWithAuthorization(
          { customerId, firstName: 'Ada' },
          authorization,
          {
            baseUrl: `http://127.0.0.1:${address.port}`,
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    );
    assert.equal(
      (decodedConflict as { readonly _tag?: string })._tag,
      'CreateContactConflictProblem',
    );

    readMode = 'success';
    const decodedContacts = await Effect.runPromise(
      executeCustomerDirectoryWithAuthorization(
        { customerId, limit: 10, operation: 'contacts' },
        authorization,
        randomUUID(),
        baseUrl,
      ),
    );
    assert.equal(decodedContacts.operation, 'contacts');
    assert.deepEqual(decodedContacts.items, [contact]);
    const decodedResourceDetail = await Effect.runPromise(
      executeContactDetailWithAuthorization(
        { moduleId: 'crm.core', resourceId: contactId, resourceType: 'crm.core.contact' },
        authorization,
        randomUUID(),
        baseUrl,
      ),
    );
    assert.equal(decodedResourceDetail.title, contact.displayName);

    actionSubject = 'deal';
    actionMode = 'success';
    assert.deepEqual(
      await Effect.runPromise(
        executeCreateDealActionWithAuthorization(
          {
            contactId,
            currency: 'CZK',
            customerId,
            expectedValue: 1000,
            title: 'Annual agreement',
          },
          authorization,
          {
            baseUrl,
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
          },
        ),
      ),
      deal,
    );
    assert.deepEqual(
      await Effect.runPromise(
        executeEditDealActionWithAuthorization(
          {
            currency: 'EUR',
            customerId,
            dealId,
            expectedValue: 1100,
            expectedVersion: 1,
            title: 'Edited agreement',
          },
          authorization,
          {
            baseUrl,
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
          },
        ),
      ),
      deal,
    );
    assert.deepEqual(
      await Effect.runPromise(
        executeDeleteDealActionWithAuthorization({ dealId, expectedVersion: 1 }, authorization, {
          baseUrl,
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
      deletedDeal,
    );
    actionMode = 'conflict';
    const decodedDealConflict = await Effect.runPromise(
      Effect.flip(
        executeCreateDealActionWithAuthorization(
          {
            currency: 'CZK',
            customerId,
            expectedValue: 1000,
            title: 'Annual agreement',
          },
          authorization,
          {
            baseUrl,
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    );
    assert.equal(
      (decodedDealConflict as { readonly _tag?: string })._tag,
      'CreateDealConflictProblem',
    );
    assert.deepEqual(
      await Effect.runPromise(
        executeDealWorkspaceWithAuthorization(
          { customerId, limit: 10, operation: 'list' },
          authorization,
          randomUUID(),
          baseUrl,
        ),
      ),
      { items: [deal], nextCursor: null, operation: 'list' },
    );
    assert.equal(
      (
        await Effect.runPromise(
          executeDealDetailWithAuthorization(
            { moduleId: 'crm.core', resourceId: dealId, resourceType: 'crm.core.deal' },
            authorization,
            randomUUID(),
            baseUrl,
          ),
        )
      ).title,
      deal.title,
    );
    actionSubject = 'contact';

    readMode = 'not_found';
    const decodedReadNotFound = await Effect.runPromise(
      Effect.flip(
        executeCustomerDirectoryWithAuthorization(
          { contactId, operation: 'contact_detail' },
          authorization,
          randomUUID(),
          baseUrl,
        ),
      ),
    );
    assert.equal(
      (decodedReadNotFound as { readonly _tag?: string })._tag,
      'CustomerDirectoryNotFoundProblem',
    );

    readMode = 'unavailable';
    const decodedReadUnavailable = await Effect.runPromise(
      Effect.flip(
        executeContactDetailWithAuthorization(
          { moduleId: 'crm.core', resourceId: contactId, resourceType: 'crm.core.contact' },
          authorization,
          randomUUID(),
          baseUrl,
        ),
      ),
    );
    assert.equal(
      (decodedReadUnavailable as { readonly _tag?: string })._tag,
      'ContactDetailUnavailableProblem',
    );
    assert.equal((decodedReadUnavailable as { readonly retryable?: boolean }).retryable, true);
  } finally {
    await handler.dispose();
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    if (previousIssuer === undefined) {
      delete process.env['ONTOS_GATEWAY_ISSUER'];
    } else {
      process.env['ONTOS_GATEWAY_ISSUER'] = previousIssuer;
    }
    if (previousJwks === undefined) {
      delete process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
    } else {
      process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = previousJwks;
    }
  }
});
