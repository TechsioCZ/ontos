import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf-8');

test('properties Effect BFF routes createUnit through CoreSDK registration', () => {
  const bff = read('verticals/properties/api/effect/index.ts');

  assert.match(bff, /runAction/u);
  assert.match(bff, /createUnitActionRegistration/u);
  assert.match(bff, /transport:\s*\{\s*headers\s*\}/u);
  assert.doesNotMatch(bff, /resolveVerticalGatewayToken/u);
  assert.doesNotMatch(bff, /createUnitHandler/u);
});

test('CoreSDK owns trusted context, idempotency, audit, placeholder gates, and transaction execution', () => {
  const coreSDK = read('packages/core-runtime/src/core-sdk.ts');

  assert.match(coreSDK, /resolveVerticalGatewayToken/u);
  assert.match(coreSDK, /x-ontos-operation-context/u);
  assert.match(coreSDK, /idempotency-key/u);
  assert.match(coreSDK, /actionInvocations/u);
  assert.match(coreSDK, /action\.received/u);
  assert.match(coreSDK, /authorizeWithSpiceDbPlaceholder/u);
  assert.match(coreSDK, /evaluatePolicyPlaceholder/u);
  assert.match(coreSDK, /db\.transaction/u);
  assert.match(coreSDK, /const \{ descriptor, handler \} = registration/u);
  assert.match(coreSDK, /handler\(payload,\s*\{\s*context:\s*policyCheckedContext,\s*tx/u);
  assert.match(coreSDK, /persistDomainRejection/u);
  assert.match(coreSDK, /persistExecutionFailure/u);
  assert.match(coreSDK, /dataAccessEvents/u);
});

test('OperationContext carries CoreSDK enrichment objects', () => {
  const context = read('packages/core-runtime/src/operation-context.ts');

  assert.match(context, /actionInvocation\?/u);
  assert.match(context, /auditEvents\?/u);
  assert.match(context, /authorizationChecks\?/u);
  assert.match(context, /policyChecks\?/u);
  assert.match(context, /dataAccessEvents\?/u);
});

test('properties HTTP contract maps CoreSDK typed errors to safe statuses', () => {
  const api = read('verticals/properties/shared/effect/api.ts');
  const bff = read('verticals/properties/api/effect/index.ts');

  assert.match(api, /OperationContextAuthRequired/u);
  assert.match(api, /OperationIdempotencyKeyRequired/u);
  assert.match(api, /OperationIdempotencyConflict/u);
  assert.match(api, /OperationDomainRejected/u);
  assert.match(api, /taggedMessageSchema/u);
  assert.match(api, /401/u);
  assert.match(api, /428/u);
  assert.match(api, /HttpApiSchema\.status\(409\)/u);
  assert.match(api, /OperationExecutionFailed/u);
  assert.match(api, /500/u);
  assert.match(api, /Schema\.Union/u);
  assert.match(api, /unitCreateHeadersSchema/u);
  assert.match(api, /'idempotency-key'/u);
  assert.match(bff, /coreSDKErrorToHttpError/u);
});

test('createUnit descriptor and client provide required operation metadata', () => {
  const action = read('verticals/properties/src/actions/create-unit.action.ts');
  const handler = read('verticals/properties/src/actions/create-unit.handler.ts');
  const registration = read('verticals/properties/src/actions/create-unit.registration.ts');
  const client = read('verticals/properties/src/effect/properties-client.ts');
  const button = read('verticals/properties/src/components/create-unit-button.tsx');

  assert.match(action, /actionKey:\s*'property\.registry\.createUnit'/u);
  assert.match(action, /auditProfile:\s*'standard'/u);
  assert.match(action, /idempotency:\s*'required'/u);
  assert.match(handler, /services\.tx\.insert\(unit\)/u);
  assert.match(handler, /name:\s*'New unit'/u);
  assert.match(registration, /satisfies ActionRegistration/u);
  assert.match(client, /'idempotency-key'/u);
  assert.match(button, /crypto\.randomUUID/u);
});
