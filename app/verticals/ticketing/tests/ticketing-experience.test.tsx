import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpApi } from '@modern-js/plugin-bff/effect-client';
import { afterEach, beforeEach, expect, rs, test } from '@rstest/core';
import type { ReactNode } from 'react';
import { ticketingApi } from '../shared/api';
import { TicketingExperience } from '../src/pages/ticketing-experience';

interface BoundaryCall<TPayload> {
  readonly idempotencyKey?: string;
  readonly payload: TPayload;
}

interface FakeEffectResult<T> {
  readonly ok: boolean;
  readonly value: T;
}

interface FakeEffect<T> {
  readonly pipe: (
    ...operators: readonly ((effect: FakeEffect<unknown>) => FakeEffect<unknown>)[]
  ) => FakeEffect<T>;
  readonly result: FakeEffectResult<T>;
}

const mocks = rs.hoisted(() => ({
  capabilityAllowed: true,
  capabilityAttempts: 0,
  collectionCalls: [] as BoundaryCall<Record<string, never>>[],
  readCalls: [] as string[],
  readFailuresRemaining: 0,
  taskAttempts: 0,
  taskCalls: [] as BoundaryCall<{ readonly collectionId: string }>[],
  taskFailuresRemaining: 1,
  toastCreate: rs.fn(),
}));

test('Ticketing API publishes the CoreSDK failure status classes', () => {
  const errorsByEndpoint = new Map<string, readonly number[]>();

  HttpApi.reflect(ticketingApi, {
    onEndpoint({ endpoint, errors }) {
      errorsByEndpoint.set(
        endpoint.name,
        [...errors.keys()].toSorted((left, right) => left - right),
      );
    },
    onGroup() {},
  });

  for (const endpoint of [
    'createCheckboxPropertyDefinitionAction',
    'createTaskAction',
    'createTaskCollectionAction',
    'filterTaskCheckboxValues',
    'getTaskCollection',
    'getTaskPropertyEditCapability',
    'getTaskPropertyWorkspace',
    'updateCheckboxPropertyValueAction',
  ]) {
    expect(errorsByEndpoint.get(endpoint)).toEqual([401, 403, 409, 428, 500]);
  }
});

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'en',
    supportedLanguages: ['en'],
    t: (key: string) =>
      ({
        'ticketing.email.definitionCreate': 'Create Email property',
        'ticketing.email.definitionCreating': 'Creating Email property',
        'ticketing.email.definitionName': 'Email property name',
        'ticketing.language.en': 'English',
        'ticketing.language.switcher': 'Language',
        'ticketing.role': 'Ticketing',
        'ticketing.taskCollection.create': 'Create Task',
        'ticketing.taskCollection.createFailed': 'Task creation failed',
        'ticketing.taskCollection.createRejected': 'Task creation rejected',
        'ticketing.taskCollection.createRequestFailed': 'The Task could not be created.',
        'ticketing.taskCollection.createdDescription': 'A blank Task is ready.',
        'ticketing.taskCollection.createdTitle': 'Task created',
        'ticketing.taskCollection.creating': 'Creating Task',
        'ticketing.taskCollection.openedTask': 'Opened Task',
        'ticketing.taskCollection.title': 'Title',
        'ticketing.title': 'Ticketing',
      })[key] ?? key,
  }),
}));

rs.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Link: ({ children }: { readonly children: ReactNode }) => <a href="/en">{children}</a>,
}));

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

rs.mock('../src/ultramodern-build', () => ({
  ultramodernUiMarker: { appId: 'ticketing', build: 'test', version: 'test' },
}));

rs.mock('../src/api/ticketing-client', () => {
  const effect = <T,>(result: FakeEffectResult<T>): FakeEffect<T> => {
    const createdEffect: FakeEffect<T> = {
      pipe(...operators) {
        let current: FakeEffect<unknown> = createdEffect;
        for (const operator of operators) {
          current = operator(current);
        }
        return current as FakeEffect<T>;
      },
      result,
    };
    return createdEffect;
  };
  const success = <T,>(value: T) => effect({ ok: true, value });
  const failure = <T,>(value: T) => effect({ ok: false, value });

  const collectionId = 'collection-1';
  const taskId = 'task-1';
  const aggregate = {
    collection: {
      collectionId,
      createdAt: '2026-07-20T12:00:00.000Z',
      schemaId: 'schema-1',
    },
    schema: {
      collectionId,
      propertyDefinitions: [
        {
          datatype: 'title',
          mandatory: false,
          name: 'Title',
          propertyDefinitionId: 'property-1',
        },
      ],
      schemaId: 'schema-1',
    },
    task: {
      collectionId,
      createdAt: '2026-07-20T12:00:00.000Z',
      createdByPrincipalId: 'principal-1',
      lastEditedAt: '2026-07-20T12:00:00.000Z',
      lastEditedByPrincipalId: 'principal-1',
      revision: 1,
      taskId,
      title: '',
    },
  };

  return {
    Effect: {
      flatMap:
        (next: (value: unknown) => FakeEffect<unknown>) => (current: FakeEffect<unknown>) => {
          if (current.result.ok) {
            return next(current.result.value);
          }
          return current;
        },
      match:
        ({
          onFailure,
          onSuccess,
        }: {
          readonly onFailure: (error: unknown) => void;
          readonly onSuccess: (value: unknown) => void;
        }) =>
        (current: FakeEffect<unknown>) => {
          if (current.result.ok) {
            onSuccess(current.result.value);
          } else {
            onFailure(current.result.value);
          }
          return success(null);
        },
    },
    getTaskCollection: (requestedCollectionId: string) => {
      mocks.readCalls.push(requestedCollectionId);
      if (mocks.readFailuresRemaining > 0) {
        mocks.readFailuresRemaining -= 1;
        return failure(new Error('Controlled governed-read failure'));
      }
      return success(aggregate);
    },
    getTaskPropertyEditCapability: () => {
      mocks.capabilityAttempts += 1;
      return mocks.capabilityAllowed
        ? success({ canEdit: true })
        : failure({ httpStatus: 403, message: 'Viewer is read-only.', ok: false });
    },
    runCreateEmailPropertyDefinitionAction: (payload: {
      readonly collectionId: string;
      readonly mandatory: boolean;
      readonly name: string;
    }) =>
      success({
        response: {
          definition: {
            datatype: 'email',
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name,
            propertyDefinitionId: 'email-property-1',
            revision: 1,
          },
        },
      }),
    runCreateTaskAction: (
      payload: { readonly collectionId: string },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.taskAttempts += 1;
      mocks.taskCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      if (mocks.taskFailuresRemaining > 0) {
        mocks.taskFailuresRemaining -= 1;
        return failure({
          errorTag: 'OperationExecutionFailed',
          httpStatus: 500,
          message: 'Controlled Task failure',
          ok: false,
        });
      }
      return success({ response: { task: aggregate.task } });
    },
    runCreateTaskCollectionAction: (
      payload: Record<string, never>,
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.collectionCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      return success({
        response: { collection: aggregate.collection, schema: aggregate.schema },
      });
    },
    runEffectRequest: (current: FakeEffect<unknown>) =>
      current.result.ok
        ? Promise.resolve(current.result.value)
        : Promise.reject(current.result.value),
  };
});

beforeEach(() => {
  mocks.capabilityAllowed = true;
  mocks.capabilityAttempts = 0;
  mocks.collectionCalls.length = 0;
  mocks.readCalls.length = 0;
  mocks.readFailuresRemaining = 0;
  mocks.taskAttempts = 0;
  mocks.taskCalls.length = 0;
  mocks.taskFailuresRemaining = 1;
  mocks.toastCreate.mockClear();
  rs.stubGlobal(
    'fetch',
    rs.fn(() =>
      Promise.resolve(
        Response.json({ verticalGatewayTokens: { ticketing: 'test-gateway-token' } }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

test('uses one form-scoped idempotency key and rotates it after complete success', async () => {
  render(<TicketingExperience />);

  const createButton = screen.getByRole('button', { name: 'Create Task' });
  fireEvent.click(createButton);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(1, {
    description: 'Controlled Task failure',
    title: 'Task creation rejected',
    type: 'error',
  });
  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.collectionCalls[0]?.idempotencyKey).toEqual(expect.any(String));
  expect(mocks.taskCalls).toHaveLength(1);
  expect(mocks.taskCalls[0]?.idempotencyKey).toBe(mocks.collectionCalls[0]?.idempotencyKey);
  expect(mocks.taskCalls[0]?.payload.collectionId).toBe('collection-1');
  expect(createButton.hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('region', { name: 'Opened Task' })).toBeNull();

  fireEvent.click(createButton);

  const openedTask = await screen.findByRole('region', { name: 'Opened Task' });
  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(2));

  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.taskCalls).toHaveLength(2);
  expect(mocks.taskCalls[1]?.idempotencyKey).toBe(mocks.taskCalls[0]?.idempotencyKey);
  expect(mocks.taskCalls.map(({ payload }) => payload.collectionId)).toEqual([
    'collection-1',
    'collection-1',
  ]);
  expect(mocks.readCalls).toEqual(['collection-1']);
  expect(openedTask.querySelector('input')?.getAttribute('value')).toBe('');
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(2, {
    description: 'A blank Task is ready.',
    title: 'Task created',
    type: 'success',
  });

  fireEvent.click(createButton);
  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(3));

  expect(mocks.collectionCalls).toHaveLength(2);
  expect(mocks.taskCalls).toHaveLength(3);
  expect(mocks.collectionCalls[1]?.idempotencyKey).toEqual(expect.any(String));
  expect(mocks.collectionCalls[1]?.idempotencyKey).not.toBe(
    mocks.collectionCalls[0]?.idempotencyKey,
  );
  expect(mocks.taskCalls[2]?.idempotencyKey).toBe(mocks.collectionCalls[1]?.idempotencyKey);
  expect(mocks.readCalls).toEqual(['collection-1', 'collection-1']);
});

test('retries only the governed read after both Actions succeed', async () => {
  mocks.taskFailuresRemaining = 0;
  mocks.readFailuresRemaining = 1;
  render(<TicketingExperience />);

  const createButton = screen.getByRole('button', { name: 'Create Task' });
  fireEvent.click(createButton);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.taskCalls).toHaveLength(1);
  expect(mocks.taskCalls[0]?.idempotencyKey).toBe(mocks.collectionCalls[0]?.idempotencyKey);
  expect(mocks.readCalls).toEqual(['collection-1']);
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(1, {
    description: 'Controlled governed-read failure',
    title: 'Task creation failed',
    type: 'error',
  });
  await waitFor(() => expect(createButton.hasAttribute('disabled')).toBe(false));

  fireEvent.click(createButton);
  await screen.findByRole('region', { name: 'Opened Task' });
  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(2));

  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.taskCalls).toHaveLength(1);
  expect(mocks.readCalls).toEqual(['collection-1', 'collection-1']);
});

test('wires a denied value-edit capability to a read-only Email editor', async () => {
  mocks.capabilityAllowed = false;
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await waitFor(() => expect(mocks.capabilityAttempts).toBe(1));

  fireEvent.change(screen.getByRole('textbox', { name: 'Email property name' }), {
    target: { value: 'Contact email' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create Email property' }));

  const email = await screen.findByRole('textbox', { name: 'Contact email' });
  expect((email as HTMLInputElement).readOnly).toBe(true);
});
