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
  collectionCalls: [] as BoundaryCall<{ readonly name: string }>[],
  collectionFailuresRemaining: 0,
  definitionCapabilityAllowed: true,
  definitionCapabilityAttempts: 0,
  deleteDefinitionCalls: [] as BoundaryCall<{
    readonly collectionId: string;
    readonly confirmed: true;
    readonly expectedImpactCount: number;
    readonly expectedImpactRevision?: string;
    readonly expectedRevision: number;
    readonly propertyDefinitionId: string;
  }>[],
  deletionImpactCalls: [] as {
    readonly collectionId: string;
    readonly propertyDefinitionId: string;
  }[],
  duplicateDefinitionCalls: [] as BoundaryCall<{
    readonly collectionId: string;
    readonly copyValues?: boolean;
    readonly expectedRevision: number;
    readonly propertyDefinitionId: string;
  }>[],
  intrinsicCalls: [] as BoundaryCall<{
    readonly collectionId: string;
    readonly datatype: 'created_by' | 'created_time' | 'last_edited_time';
    readonly mandatory: boolean;
    readonly name: string;
  }>[],
  propertyMutationWorkspace: 'none' as 'deleted' | 'duplicated' | 'none',
  readCalls: [] as string[],
  readFailuresRemaining: 0,
  taskAttempts: 0,
  taskCalls: [] as BoundaryCall<{ readonly collectionId: string }>[],
  taskContentCalls: [] as BoundaryCall<{
    readonly canvas: Record<string, never>;
    readonly collectionId: string;
    readonly expectedRevision: number;
    readonly taskId: string;
    readonly title: string;
  }>[],
  taskFailuresRemaining: 1,
  toastCreate: rs.fn(),
  urlDefinitionCalls: [] as BoundaryCall<{
    readonly collectionId: string;
    readonly mandatory: boolean;
    readonly name: string;
  }>[],
  urlUpdateCalls: [] as BoundaryCall<{
    readonly collectionId: string;
    readonly expectedRevision: number;
    readonly propertyDefinitionId: string;
    readonly taskId: string;
    readonly value: string;
  }>[],
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
    'configurePrincipalTimeZonePreferenceAction',
    'createCheckboxPropertyDefinitionAction',
    'createDatePropertyDefinitionAction',
    'createIntrinsicPropertyDefinitionAction',
    'createEmailPropertyDefinitionAction',
    'createPhonePropertyDefinitionAction',
    'createTaskAction',
    'createTaskCollectionAction',
    'createTextPropertyDefinitionAction',
    'createUrlPropertyDefinitionAction',
    'filterTaskCheckboxValues',
    'getTaskCollection',
    'getTaskPropertyEditCapability',
    'getTaskPropertyDefinitionEditCapability',
    'getTaskPropertyWorkspace',
    'groupTaskDateValues',
    'queryIntrinsicTaskProperties',
    'queryTaskPropertyValues',
    'queryTaskUrlValues',
    'updateCheckboxPropertyValueAction',
    'updateDatePropertyValueAction',
    'updateEmailPropertyValueAction',
    'updatePhonePropertyValueAction',
    'updateTaskContentAction',
    'updateTextPropertyValueAction',
    'updateUrlPropertyValueAction',
  ]) {
    expect(errorsByEndpoint.get(endpoint)).toEqual([401, 403, 409, 428, 500]);
  }
});

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'en',
    supportedLanguages: ['en'],
    t: (key: string, options?: { readonly count?: number; readonly name?: string }) =>
      ({
        'ticketing.date.definitionCreate': 'Create Date property',
        'ticketing.date.definitionCreating': 'Creating Date property',
        'ticketing.date.definitionName': 'Date property name',
        'ticketing.date.empty': 'Empty',
        'ticketing.dateRange.definitionCreate': 'Create Date Range property',
        'ticketing.dateRange.definitionCreating': 'Creating Date Range property',
        'ticketing.dateRange.definitionName': 'Date Range property name',
        'ticketing.dateRange.endDate': 'End date',
        'ticketing.dateRange.save': 'Save range',
        'ticketing.dateRange.startDate': 'Start date',
        'ticketing.dateRange.timeSupport': 'Include time',
        'ticketing.email.definitionCreate': 'Create Email property',
        'ticketing.email.definitionCreating': 'Creating Email property',
        'ticketing.email.definitionName': 'Email property name',
        'ticketing.intrinsic.created_by.create': 'Add Created by property',
        'ticketing.intrinsic.created_by.creating': 'Adding Created by property',
        'ticketing.intrinsic.created_by.name': 'Created by',
        'ticketing.intrinsic.created_time.create': 'Add Created time property',
        'ticketing.intrinsic.created_time.creating': 'Adding Created time property',
        'ticketing.intrinsic.created_time.details': 'Details',
        'ticketing.intrinsic.created_time.name': 'Created time',
        'ticketing.intrinsic.inactive': 'inactive',
        'ticketing.intrinsic.last_edited_time.create': 'Add Last edited time property',
        'ticketing.intrinsic.last_edited_time.creating': 'Adding Last edited time property',
        'ticketing.intrinsic.last_edited_time.details': 'Details',
        'ticketing.intrinsic.last_edited_time.name': 'Last edited time',
        'ticketing.language.en': 'English',
        'ticketing.language.switcher': 'Language',
        'ticketing.phone.call': 'Call',
        'ticketing.phone.copy': 'Copy',
        'ticketing.phone.definitionCreate': 'Add Phone property',
        'ticketing.phone.definitionCreating': 'Adding Phone property',
        'ticketing.phone.definitionName': 'Phone property name',
        'ticketing.phone.invalid': 'Enter one control-free line of at most 256 characters.',
        'ticketing.phone.save': 'Save Phone',
        'ticketing.propertyActions.copyValuesHelp':
          'Copy every Task’s current value to the duplicate.',
        'ticketing.propertyActions.copyValuesLabel': 'Copy current values',
        'ticketing.propertyActions.delete': `Delete ${options?.name ?? 'field'}`,
        'ticketing.propertyActions.deleteConfirm': 'Delete field',
        'ticketing.propertyActions.deleteDescription':
          'This permanently removes the field from this collection.',
        'ticketing.propertyActions.deleteImpact': `Affected Tasks: ${options?.count ?? 0}.`,
        'ticketing.propertyActions.deleteImpactLoading': 'Checking affected Tasks…',
        'ticketing.propertyActions.deleting': 'Deleting field',
        'ticketing.propertyActions.duplicate': `Duplicate ${options?.name ?? 'field'}`,
        'ticketing.propertyActions.duplicateConfirm': 'Duplicate field',
        'ticketing.propertyActions.duplicateDescription':
          'The duplicate keeps this field’s configuration.',
        'ticketing.propertyActions.duplicating': 'Duplicating field',
        'ticketing.propertyDefinition.create': 'Create field',
        'ticketing.propertyDefinition.createFailedDescription': 'The field could not be created.',
        'ticketing.propertyDefinition.createFailedTitle': 'Field creation failed',
        'ticketing.propertyDefinition.creating': 'Creating field',
        'ticketing.propertyDefinition.heading': 'Add a field',
        'ticketing.propertyDefinition.mandatoryHelp': 'Tasks must have a value for this field.',
        'ticketing.propertyDefinition.mandatoryLabel': 'Mandatory',
        'ticketing.propertyDefinition.nameLabel': 'Field name',
        'ticketing.propertyDefinition.typeLabel': 'Field type',
        'ticketing.propertyDefinition.typePlaceholder': 'Select a field type',
        'ticketing.propertyDefinition.types.checkbox': 'Checkbox',
        'ticketing.propertyDefinition.types.created_by': 'Created by',
        'ticketing.propertyDefinition.types.created_time': 'Created time',
        'ticketing.propertyDefinition.types.date': 'Date',
        'ticketing.propertyDefinition.types.date_range': 'Date range',
        'ticketing.propertyDefinition.types.email': 'Email',
        'ticketing.propertyDefinition.types.last_edited_by': 'Last edited by',
        'ticketing.propertyDefinition.types.last_edited_time': 'Last edited time',
        'ticketing.propertyDefinition.types.number': 'Number',
        'ticketing.propertyDefinition.types.phone': 'Phone',
        'ticketing.propertyDefinition.types.text': 'Text',
        'ticketing.propertyDefinition.types.url': 'URL',
        'ticketing.role': 'Ticketing',
        'ticketing.taskCollection.create': 'Create Task Collection',
        'ticketing.taskCollection.createFailed': 'Task Collection creation failed',
        'ticketing.taskCollection.createRejected': 'Task Collection creation rejected',
        'ticketing.taskCollection.createRequestFailed': 'The Task Collection could not be created.',
        'ticketing.taskCollection.createdDescription': 'A blank Task is ready.',
        'ticketing.taskCollection.createdTitle': 'Task Collection created',
        'ticketing.taskCollection.creating': 'Creating Task Collection',
        'ticketing.taskCollection.name': 'Collection name',
        'ticketing.taskCollection.nameHelp': 'Set once when the collection is created.',
        'ticketing.taskCollection.openedTask': 'Opened Task',
        'ticketing.taskCollection.title': 'Title',
        'ticketing.taskCollection.titleSave': 'Save title',
        'ticketing.taskCollection.titleSaveFailedDescription': 'The Task title could not be saved.',
        'ticketing.taskCollection.titleSaveFailedTitle': 'Task title save failed',
        'ticketing.taskCollection.titleSavedDescription': 'The Task title was updated.',
        'ticketing.taskCollection.titleSavedTitle': 'Task title saved',
        'ticketing.taskCollection.titleSaving': 'Saving title',
        'ticketing.title': 'Ticketing',
        'ticketing.url.definitionCreate': 'Add URL property',
        'ticketing.url.definitionCreating': 'Adding URL property',
        'ticketing.url.definitionName': 'URL property name',
        'ticketing.url.open': 'Open URL',
        'ticketing.url.save': 'Save URL',
        'ticketing.url.saving': 'Saving URL',
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
      name: 'Support Requests',
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
      canvas: {},
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

  const urlWorkspace = (includeDuplicate: boolean) => ({
    collectionId,
    effectiveTimeZone: { source: 'browser', timeZone: 'Europe/Prague' },
    propertyDefinitions: [
      {
        datatype: 'url',
        hidden: false,
        mandatory: false,
        name: 'Reference URL',
        propertyDefinitionId: 'url-property-1',
        revision: 1,
      },
      ...(includeDuplicate
        ? [
            {
              datatype: 'url',
              hidden: false,
              mandatory: false,
              name: 'Reference URL Copy',
              propertyDefinitionId: 'url-property-copy',
              revision: 1,
            },
          ]
        : []),
    ],
    tasks: [
      {
        canvas: {},
        checkboxValues: [],
        dateRangeValues: [],
        dateValues: [],
        emailValues: [],
        numberValues: [],
        phoneValues: [],
        selectValues: [],
        statusValues: [],
        taskId,
        taskRevision: 1,
        title: '',
        urlValues: [
          {
            propertyDefinitionId: 'url-property-1',
            revision: 0,
            value: null,
          },
          ...(includeDuplicate
            ? [
                {
                  propertyDefinitionId: 'url-property-copy',
                  revision: 0,
                  value: null,
                },
              ]
            : []),
        ],
      },
    ],
  });

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
    getTaskPropertyDefinitionEditCapability: () => {
      mocks.definitionCapabilityAttempts += 1;
      return mocks.definitionCapabilityAllowed
        ? success({ canEditDefinitions: true })
        : failure({ httpStatus: 403, message: 'User cannot change the schema.', ok: false });
    },
    getTaskPropertyDeletionImpact: (
      requestedCollectionId: string,
      propertyDefinitionId: string,
    ) => {
      mocks.deletionImpactCalls.push({
        collectionId: requestedCollectionId,
        propertyDefinitionId,
      });
      return success({
        impactCount: 1,
        impactRevision: 'impact-1',
        propertyDefinitionId,
        revision: 1,
      });
    },
    getTaskPropertyEditCapability: () => {
      mocks.capabilityAttempts += 1;
      return mocks.capabilityAllowed
        ? success({ canEdit: true })
        : failure({ httpStatus: 403, message: 'Viewer is read-only.', ok: false });
    },
    getTaskPropertyWorkspace: () => {
      if (mocks.propertyMutationWorkspace === 'duplicated') {
        return success(urlWorkspace(true));
      }
      if (mocks.propertyMutationWorkspace === 'deleted') {
        return success(urlWorkspace(false));
      }
      return success({
        collectionId,
        effectiveTimeZone: { source: 'browser', timeZone: 'Europe/Prague' },
        propertyDefinitions: [
          {
            datatype: mocks.intrinsicCalls.at(-1)?.payload.datatype ?? 'created_time',
            hidden: false,
            mandatory: false,
            name: mocks.intrinsicCalls.at(-1)?.payload.name ?? 'Created time',
            propertyDefinitionId: 'intrinsic-time-1',
            revision: 1,
          },
          {
            datatype: 'created_time',
            hidden: true,
            mandatory: false,
            name: 'Hidden Created time',
            propertyDefinitionId: 'created-time-hidden',
            revision: 1,
          },
        ],
        tasks: [
          {
            canvas: {},
            checkboxValues: [],
            createdAt: aggregate.task.createdAt,
            dateRangeValues: [],
            dateValues: [],
            emailValues: [],
            lastEditedAt: aggregate.task.lastEditedAt,
            numberValues: [],
            phoneValues: [],
            selectValues: [],
            statusValues: [],
            taskId,
            taskRevision: 1,
            title: '',
            urlValues: [],
          },
        ],
      });
    },
    runCreateDatePropertyDefinitionAction: (payload: {
      readonly collectionId: string;
      readonly mandatory: boolean;
      readonly name: string;
    }) =>
      success({
        response: {
          definition: {
            datatype: 'date',
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name,
            propertyDefinitionId: 'date-property-1',
            revision: 1,
          },
        },
      }),
    runCreateDateRangePropertyDefinitionAction: (payload: {
      readonly collectionId: string;
      readonly mandatory: boolean;
      readonly name: string;
      readonly timeEnabled: boolean;
    }) =>
      success({
        response: {
          definition: {
            datatype: 'date_range',
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name,
            propertyDefinitionId: 'date-range-property-1',
            revision: 1,
            timeEnabled: payload.timeEnabled,
          },
        },
      }),
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
    runCreateIntrinsicPropertyDefinitionAction: (
      payload: {
        readonly collectionId: string;
        readonly datatype: 'created_by' | 'created_time' | 'last_edited_time';
        readonly mandatory: boolean;
        readonly name: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.intrinsicCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      return success({
        response: {
          definition: {
            datatype: payload.datatype,
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name,
            propertyDefinitionId: 'created-time-1',
            revision: 1,
          },
        },
      });
    },
    runCreatePhonePropertyDefinitionAction: (payload: {
      readonly collectionId: string;
      readonly mandatory: boolean;
      readonly name: string;
    }) =>
      success({
        response: {
          definition: {
            datatype: 'phone',
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name,
            propertyDefinitionId: 'phone-property-1',
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
      payload: { readonly name: string },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.collectionCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      if (mocks.collectionFailuresRemaining > 0) {
        mocks.collectionFailuresRemaining -= 1;
        return failure({
          errorTag: 'OperationExecutionFailed',
          httpStatus: 500,
          message: 'Controlled Collection failure',
          ok: false,
        });
      }
      return success({
        response: { collection: aggregate.collection, schema: aggregate.schema },
      });
    },
    runCreateUrlPropertyDefinitionAction: (
      payload: {
        readonly collectionId: string;
        readonly mandatory: boolean;
        readonly name: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.urlDefinitionCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      return success({
        response: {
          definition: {
            datatype: 'url',
            hidden: false,
            mandatory: payload.mandatory,
            name: payload.name.trim(),
            propertyDefinitionId: `url-property-${mocks.urlDefinitionCalls.length}`,
            revision: 1,
          },
        },
      });
    },
    runDeleteTaskPropertyDefinitionAction: (
      payload: {
        readonly collectionId: string;
        readonly confirmed: true;
        readonly expectedImpactCount: number;
        readonly expectedImpactRevision?: string;
        readonly expectedRevision: number;
        readonly propertyDefinitionId: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.deleteDefinitionCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      mocks.propertyMutationWorkspace = 'deleted';
      return success({
        response: {
          deletedPropertyDefinitionId: payload.propertyDefinitionId,
          impactCount: payload.expectedImpactCount,
        },
      });
    },
    runDuplicateTaskPropertyDefinitionAction: (
      payload: {
        readonly collectionId: string;
        readonly copyValues?: boolean;
        readonly expectedRevision: number;
        readonly propertyDefinitionId: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.duplicateDefinitionCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      mocks.propertyMutationWorkspace = 'duplicated';
      return success({
        response: {
          definition: {
            datatype: 'url',
            hidden: false,
            mandatory: false,
            name: 'Reference URL Copy',
            propertyDefinitionId: 'url-property-copy',
            revision: 1,
          },
        },
      });
    },
    runEffectRequest: (current: FakeEffect<unknown>) =>
      current.result.ok
        ? Promise.resolve(current.result.value)
        : Promise.reject(current.result.value),
    runUpdateTaskContentAction: (
      payload: {
        readonly canvas: Record<string, never>;
        readonly collectionId: string;
        readonly expectedRevision: number;
        readonly taskId: string;
        readonly title: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.taskContentCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      return success({
        response: {
          canvas: payload.canvas,
          changedComponents: ['title'],
          taskId: payload.taskId,
          taskRevision: payload.expectedRevision + 1,
          title: payload.title,
        },
      });
    },
    runUpdateUrlPropertyValueAction: (
      payload: {
        readonly collectionId: string;
        readonly expectedRevision: number;
        readonly propertyDefinitionId: string;
        readonly taskId: string;
        readonly value: string;
      },
      options: { readonly idempotencyKey?: string },
    ) => {
      mocks.urlUpdateCalls.push({ idempotencyKey: options.idempotencyKey, payload });
      return success({
        response: {
          taskRevision: 2,
          value: {
            propertyDefinitionId: payload.propertyDefinitionId,
            revision: 1,
            value: payload.value.trim(),
          },
        },
      });
    },
  };
});

beforeEach(() => {
  mocks.capabilityAllowed = true;
  mocks.capabilityAttempts = 0;
  mocks.definitionCapabilityAllowed = true;
  mocks.definitionCapabilityAttempts = 0;
  mocks.deleteDefinitionCalls.length = 0;
  mocks.deletionImpactCalls.length = 0;
  mocks.duplicateDefinitionCalls.length = 0;
  mocks.collectionCalls.length = 0;
  mocks.collectionFailuresRemaining = 0;
  mocks.intrinsicCalls.length = 0;
  mocks.readCalls.length = 0;
  mocks.readFailuresRemaining = 0;
  mocks.propertyMutationWorkspace = 'none';
  mocks.taskAttempts = 0;
  mocks.taskCalls.length = 0;
  mocks.taskContentCalls.length = 0;
  mocks.taskFailuresRemaining = 1;
  mocks.toastCreate.mockClear();
  mocks.urlDefinitionCalls.length = 0;
  mocks.urlUpdateCalls.length = 0;
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

const selectFieldType = async (value: string, label: string) => {
  const nativeTypeSelect = document.querySelector<HTMLSelectElement>(
    'select[name="task-property-datatype"]',
  );
  expect(nativeTypeSelect).not.toBeNull();
  fireEvent.change(nativeTypeSelect as HTMLSelectElement, { target: { value } });
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Field type' })).toHaveTextContent(label),
  );
};

const enterCollectionName = (name = 'Support Requests') => {
  fireEvent.change(screen.getByRole('textbox', { name: /Collection name/u }), {
    target: { value: name },
  });
};

test('uses one form-scoped idempotency key and rotates it after complete success', async () => {
  render(<TicketingExperience />);

  const createButton = screen.getByRole('button', { name: 'Create Task Collection' });
  expect(createButton).toBeDisabled();
  enterCollectionName();
  expect(createButton).toBeEnabled();
  fireEvent.click(createButton);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(1, {
    description: 'Controlled Task failure',
    title: 'Task Collection creation rejected',
    type: 'error',
  });
  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.collectionCalls[0]?.payload).toEqual({ name: 'Support Requests' });
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
  expect(screen.getByRole('heading', { name: 'Support Requests' })).toBeDefined();
  expect(openedTask.querySelector('input')?.getAttribute('value')).toBe('Support Requests');
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(2, {
    description: 'A blank Task is ready.',
    title: 'Task Collection created',
    type: 'success',
  });

  enterCollectionName();
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

test('starts a new idempotent attempt when a failed Collection name changes', async () => {
  mocks.collectionFailuresRemaining = 1;
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  const createButton = screen.getByRole('button', { name: 'Create Task Collection' });
  enterCollectionName();
  fireEvent.click(createButton);
  await waitFor(() => expect(mocks.collectionCalls).toHaveLength(1));
  await waitFor(() => expect(createButton).toBeEnabled());

  enterCollectionName('Billing Requests');
  fireEvent.click(createButton);
  await waitFor(() => expect(mocks.collectionCalls).toHaveLength(2));

  expect(mocks.collectionCalls.map(({ payload }) => payload)).toEqual([
    { name: 'Support Requests' },
    { name: 'Billing Requests' },
  ]);
  expect(mocks.collectionCalls[1]?.idempotencyKey).not.toBe(
    mocks.collectionCalls[0]?.idempotencyKey,
  );
});

test('shows the Collection name as an editable Task title and saves the change', async () => {
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });

  const titleInput = screen.getByRole('textbox', { name: 'Title' });
  expect(titleInput).toBeEnabled();
  expect(titleInput).toHaveValue('Support Requests');

  fireEvent.change(titleInput, { target: { value: 'Urgent Support' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));

  await waitFor(() => expect(mocks.taskContentCalls).toHaveLength(1));
  expect(mocks.taskContentCalls[0]?.payload).toEqual({
    canvas: {},
    collectionId: 'collection-1',
    expectedRevision: 1,
    taskId: 'task-1',
    title: 'Urgent Support',
  });
  expect(mocks.taskContentCalls[0]?.idempotencyKey).toEqual(expect.any(String));
  await waitFor(() => expect(titleInput).toHaveValue('Urgent Support'));
});

test('retries only the governed read after both Actions succeed', async () => {
  mocks.taskFailuresRemaining = 0;
  mocks.readFailuresRemaining = 1;
  render(<TicketingExperience />);

  const createButton = screen.getByRole('button', { name: 'Create Task Collection' });
  enterCollectionName();
  fireEvent.click(createButton);

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(mocks.collectionCalls).toHaveLength(1);
  expect(mocks.taskCalls).toHaveLength(1);
  expect(mocks.taskCalls[0]?.idempotencyKey).toBe(mocks.collectionCalls[0]?.idempotencyKey);
  expect(mocks.readCalls).toEqual(['collection-1']);
  expect(mocks.toastCreate).toHaveBeenNthCalledWith(1, {
    description: 'Controlled governed-read failure',
    title: 'Task Collection creation failed',
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

test('creates and renders an intrinsic property through the application path', async () => {
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await selectFieldType('created_time', 'Created time');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Created time' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  await waitFor(() => expect(mocks.intrinsicCalls).toHaveLength(1));
  await waitFor(() => expect(document.querySelector('time')).not.toBeNull());
  expect(document.querySelectorAll('time')).toHaveLength(2);
  expect(mocks.intrinsicCalls[0]?.payload).toEqual({
    collectionId: 'collection-1',
    datatype: 'created_time',
    mandatory: false,
    name: 'Created time',
  });
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-20T12:00:00.000Z');
  fireEvent.click(screen.getByText('Details'));
  expect(document.querySelector('details')?.hasAttribute('open')).toBe(true);
  expect(document.querySelectorAll('time')[1]?.textContent).toContain(':00:00');
});

test('creates a Last edited time definition through the existing UI-kit action path', async () => {
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await selectFieldType('last_edited_time', 'Last edited time');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Last edited time' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  await waitFor(() => expect(mocks.intrinsicCalls).toHaveLength(1));
  expect(mocks.intrinsicCalls[0]?.payload).toEqual({
    collectionId: 'collection-1',
    datatype: 'last_edited_time',
    mandatory: false,
    name: 'Last edited time',
  });
  await waitFor(() => expect(document.querySelectorAll('time')).toHaveLength(2));
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-20T12:00:00.000Z');
});

test('creates, edits, and opens a URL through the public Ticketing surface', async () => {
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });

  await selectFieldType('url', 'URL');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Reference URL' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mandatory' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Mandatory' })).toBeChecked());
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  await waitFor(() => expect(mocks.urlDefinitionCalls).toHaveLength(1));
  expect(mocks.toastCreate).toHaveBeenCalledTimes(1);
  const valueInput = await screen.findByRole('textbox', { name: /^Reference URL/u });
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Field name' })).toHaveValue(''));
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Backup URL' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));
  await screen.findByRole('textbox', { name: 'Backup URL' });

  const exactValue = 'HTTPS://Example.com/%7EExact?Q=One#Part';
  fireEvent.change(valueInput, { target: { value: exactValue } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save URL' })[0] as HTMLButtonElement);

  const open = await screen.findByRole('link', { name: 'Open URL' });
  expect(open.getAttribute('href')).toBe(exactValue);
  expect(mocks.urlDefinitionCalls.map(({ payload }) => payload)).toEqual([
    {
      collectionId: 'collection-1',
      mandatory: true,
      name: 'Reference URL',
    },
    {
      collectionId: 'collection-1',
      mandatory: false,
      name: 'Backup URL',
    },
  ]);
  expect(mocks.urlUpdateCalls[0]?.payload).toEqual({
    collectionId: 'collection-1',
    expectedRevision: 0,
    propertyDefinitionId: 'url-property-1',
    taskId: 'task-1',
    value: exactValue,
  });

  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Urgent Support' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  await waitFor(() => expect(mocks.taskContentCalls).toHaveLength(1));
  expect(mocks.taskContentCalls[0]?.payload.expectedRevision).toBe(2);
});

test('duplicates and deletes a rendered field through governed page actions', async () => {
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await selectFieldType('url', 'URL');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Reference URL' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));
  await screen.findByRole('textbox', { name: 'Reference URL' });

  expect(screen.getByRole('button', { name: 'Duplicate Reference URL' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Delete Reference URL' })).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Duplicate Reference URL' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Copy current values' }));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Copy current values' })).toBeChecked(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate field' }));

  await screen.findByRole('textbox', { name: 'Reference URL Copy' });
  expect(mocks.duplicateDefinitionCalls[0]?.payload).toEqual({
    collectionId: 'collection-1',
    copyValues: true,
    expectedRevision: 1,
    propertyDefinitionId: 'url-property-1',
  });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Duplicate Reference URL' })).toBeNull(),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Delete Reference URL Copy' }));
  expect(await screen.findByText('Affected Tasks: 1.')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));

  await waitFor(() => expect(mocks.deleteDefinitionCalls).toHaveLength(1));
  expect(mocks.deletionImpactCalls).toEqual([
    { collectionId: 'collection-1', propertyDefinitionId: 'url-property-copy' },
  ]);
  expect(mocks.deleteDefinitionCalls[0]?.payload).toEqual({
    collectionId: 'collection-1',
    confirmed: true,
    expectedImpactCount: 1,
    expectedImpactRevision: 'impact-1',
    expectedRevision: 1,
    propertyDefinitionId: 'url-property-copy',
  });
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Reference URL Copy' })).toBeNull(),
  );
});

test('wires a denied value-edit capability to read-only property editors', async () => {
  mocks.capabilityAllowed = false;
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await waitFor(() => expect(mocks.capabilityAttempts).toBe(1));

  await selectFieldType('email', 'Email');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Contact email' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  const email = await screen.findByRole('textbox', { name: 'Contact email' });
  expect(email).toHaveAttribute('readonly');

  await selectFieldType('date', 'Date');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Due date' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  const date = await screen.findByRole('button', { name: 'Due date: Empty' });
  expect(date).toBeDisabled();

  await selectFieldType('url', 'URL');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Reference URL' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  const url = await screen.findByRole('textbox', { name: 'Reference URL' });
  expect(url).toHaveAttribute('readonly');

  await selectFieldType('phone', 'Phone');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Direct line' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  const phone = await screen.findByRole('textbox', { name: 'Direct line' });
  expect(phone).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Save Phone' })).not.toBeInTheDocument();
});

test('keeps Date Range values editable while schema controls require definition permission', async () => {
  mocks.definitionCapabilityAllowed = false;
  mocks.taskFailuresRemaining = 0;
  render(<TicketingExperience />);

  enterCollectionName();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task Collection' }));
  await screen.findByRole('region', { name: 'Opened Task' });
  await waitFor(() => expect(mocks.definitionCapabilityAttempts).toBe(1));

  await selectFieldType('date_range', 'Date range');
  fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
    target: { value: 'Delivery window' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create field' }));

  expect(await screen.findByRole('checkbox', { name: 'Include time' })).toBeDisabled();
  expect(screen.getByRole('group', { name: 'Delivery window' })).not.toBeDisabled();
});
