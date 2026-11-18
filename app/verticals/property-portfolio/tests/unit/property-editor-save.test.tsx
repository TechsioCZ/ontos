// @rstest-environment happy-dom
// The new-property form as the user sees the editor state: typing changes only the draft, nothing is sent until its
// Save runs, and that one save sends exactly one command. The generated clients run for real: the Shell's gateway
// issuer and the property owner's Action and records endpoints answer in process through their HttpApi contracts.
import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { PropertyEditor } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';
import { usePropertyEditor } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const employeeId = '75000000-0000-4000-8000-000000000001';
const employees = [
  { active: true, fullName: 'Jana Nováková', id: Schema.decodeUnknownSync(EmployeeIdSchema)(employeeId) },
];
const registerRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 4,
  units: [],
});
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  resourceRef: {
    moduleId: 'property.portfolio',
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'property.portfolio.property',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  revision: 5,
});

/** Every command and records read the property owner received, in order. */
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerActionApi = ApplyCommandActionApi.prefix('/property-portfolio-api');
const OwnerRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'property-portfolio': '/property-portfolio-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.sync(() => registerRecords)),
    ),
  ),
);

const rendered: PropertyEditor[] = [];
const Harness = ({ onRender }: { readonly onRender: (editor: PropertyEditor) => void }) => {
  const editor = usePropertyEditor(registerRecords, employees, () => {});
  onRender(editor);
  return null;
};

/** Mounts the harness and returns the unmount; every React update runs inside `act`. */
const mountHarness = (): (() => void) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Harness
        onRender={(editor) => {
          rendered.push(editor);
        }}
      />,
    );
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
};

const current = (): PropertyEditor => {
  const latest = rendered.at(-1);
  if (latest === undefined) {
    throw new Error('the editor is not mounted');
  }
  return latest;
};

/** Runs editor calls inside `act` so their state updates land before the next step. */
const perform = (action: (editor: PropertyEditor) => void) =>
  Effect.sync(() => {
    act(() => {
      action(current());
    });
  });

beforeEach(() => {
  commands.length = 0;

  rendered.length = 0;
});

it.layer(network, { excludeTestServices: true })('the new-property form', (suite) => {
  suite.effect('the Save of the new-property form sends exactly one command', () =>
    Effect.gen(function* saveSendsOnce() {
      yield* pinTestDocument;
      const unmount = mountHarness();
      yield* perform((editor) => {
        editor.begin();
        editor.change('code', 'NEW-02');
        editor.change('name', 'Druhá budova');
        editor.change('address', 'Hlavní 2');
        editor.change('propertyType', 'Komerční');
        editor.changeResponsibleEmployees([employeeId]);
      });
      yield* perform((editor) => editor.createDraft.save());
      yield* Effect.sleep('100 millis');
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        command: {
          _tag: 'CreateProperty',
          address: 'Hlavní 2',
          code: 'NEW-02',
          name: 'Druhá budova',
          propertyType: 'Komerční',
          responsibleEmployeeIds: [employeeId],
        },
        expectedRevision: 4,
      });
      unmount();
    }),
  );
});
