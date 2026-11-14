import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectAction, isProposableActionDeclaration } from '../action-http/scaffold.mts';
import { toCamelCase, toPascalCase } from '../shared.mts';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const ownerActions = [
  ['workforce', ['update-employee']],
  ['tagging', ['update-tag', 'delete-tag', 'assign-tag', 'unassign-tag']],
  ['sales-insights', ['update-metric', 'assign-metric', 'change-metric-state']],
  [
    'merchandise',
    [
      'manage-catalog',
      'manage-markets',
      'cleanup-demo',
      'change-product-images',
      'record-stock-movement',
      'change-order-status',
      'place-storefront-order',
      'propose-order-changes',
      'review-order-changes',
    ],
  ],
] as const;
const decodeModule = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

it.effect(
  'publishes seventeen real narrow URLs with their own native registration and identical public payload schema',
  () =>
    Effect.gen(function* publishedOwnerArtifacts() {
      let checked = 0;
      for (const [owner, actions] of ownerActions) {
        for (const action of actions) {
          const ownerPath = path.join(appRoot, 'verticals', owner);
          const type = toPascalCase(action);
          const value = `${toCamelCase(action)}Action`;
          const inspected = yield* inspectAction(path.join(ownerPath, 'src/actions', `${action}.action.ts`), value);
          const publicPath = path.join(ownerPath, 'shared/actions', `${action}.ts`);
          const publicModule = yield* Effect.promise<unknown>(() => import(pathToFileURL(publicPath).href));
          const exports = yield* decodeModule(publicModule);
          const publicPayload = exports[`${type}PayloadSchema`];
          expect(Schema.isSchema(publicPayload), `${owner}/${action}`).toBe(true);
          if (Schema.isSchema(publicPayload)) {
            expect(publicPayload.ast).toEqual(inspected.descriptor.payloadSchema.ast);
          }
          const read = (relative: string) => Effect.promise(() => readFile(path.join(ownerPath, relative), 'utf-8'));
          const contract = yield* read(`shared/apis/${action}-action.ts`);
          const server = yield* read(`api/${action}-action-server.ts`);
          const client = yield* read(`src/api/${action}-action-client.ts`);
          expect(inspected.descriptor.actionKey).toBe(`demo.${owner}.${action}`);
          expect(contract).toContain(`'/${owner}/actions/${action}'`);
          expect(server).toContain(`registration: ${value},`);
          expect(server).not.toContain('Match.');
          expect(server).not.toContain('registrationFor');
          expect(client).toContain(`client.${toCamelCase(action)}Action.execute(`);
          expect(client).toContain('readonly referenceCredentials?: Redacted.Redacted;');
          if (isProposableActionDeclaration(inspected.descriptor.accessDeclaration)) {
            expect(contract).toContain(`success: [ActionProposalAcceptedSchema, ${type}ResultSchema]`);
            expect(server).toContain("successContract: 'result-or-proposal'");
          }
          checked += 1;
        }
      }
      expect(checked).toBe(17);
    }),
);

it.effect(
  'keeps each closed apply-command server bound only to its actual registration and preserves proposal responses',
  () =>
    Effect.gen(function* noHiddenBroadDispatch() {
      for (const [owner] of ownerActions) {
        const ownerPath = path.join(appRoot, 'verticals', owner);
        const server = yield* Effect.promise(() =>
          readFile(path.join(ownerPath, 'api/apply-command-action-server.ts'), 'utf-8'),
        );
        const client = yield* Effect.promise(() =>
          readFile(path.join(ownerPath, 'src/api/apply-command-action-client.ts'), 'utf-8'),
        );
        expect(server).toContain('registration: applyCommandAction,');
        expect(server.match(/from '\.\.\/src\/actions\//gu)).toHaveLength(1);
        expect(server).not.toContain('Match.');
        expect(client).not.toContain('Schema.decodeUnknownEffect');
      }
    }),
);
