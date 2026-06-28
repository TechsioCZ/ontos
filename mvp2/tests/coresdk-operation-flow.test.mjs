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

test('CoreSDK owns trusted context, idempotency, audit, policy gates, and transaction execution', () => {
  const coreSDK = read('packages/core-runtime/src/core-sdk.ts');
  const policy = read('packages/core-runtime/src/policy.ts');
  const authorization = read('packages/core-runtime/src/spicedb-authorization.ts');

  assert.match(coreSDK, /resolveVerticalGatewayToken/u);
  assert.match(coreSDK, /x-ontos-operation-context/u);
  assert.match(coreSDK, /idempotency-key/u);
  assert.match(coreSDK, /actionInvocations/u);
  assert.match(coreSDK, /action\.received/u);
  assert.match(coreSDK, /authorizeWithSpiceDb/u);
  assert.match(coreSDK, /OperationAuthorizationDenied/u);
  assert.match(authorization, /@authzed\/authzed-node/u);
  assert.match(authorization, /objectType:\s*input\.subjectObjectType/u);
  assert.match(coreSDK, /evaluateActionPolicies/u);
  assert.match(coreSDK, /policyChecks:\s*registration\.policyChecks\s*\?\?\s*\[\]/u);
  assert.match(coreSDK, /OperationPolicyDenied/u);
  assert.match(policy, /PolicyCheck<TData>/u);
  assert.match(coreSDK, /db\.transaction/u);
  assert.match(coreSDK, /const \{ descriptor, handler \} = registration/u);
  assert.match(coreSDK, /handler\(payload,\s*\{/u);
  assert.match(coreSDK, /addOutboxMessage:\s*\(message\)\s*=>/u);
  assert.match(coreSDK, /persistDomainRejection/u);
  assert.match(coreSDK, /persistExecutionFailure/u);
  assert.match(coreSDK, /persistAutomaticDomainEvent/u);
  assert.match(coreSDK, /persistOutboxMessages/u);
  assert.match(coreSDK, /handlerOutboxMessages/u);
  assert.doesNotMatch(coreSDK, /dataAccessEvents/u);
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
  assert.match(api, /OperationAuthorizationDenied/u);
  assert.match(api, /OperationIdempotencyKeyRequired/u);
  assert.match(api, /OperationIdempotencyConflict/u);
  assert.match(api, /OperationDomainRejected/u);
  assert.match(api, /taggedMessageSchema/u);
  assert.match(api, /401/u);
  assert.match(api, /403/u);
  assert.match(api, /428/u);
  assert.match(api, /HttpApiSchema\.status\(409\)/u);
  assert.match(api, /OperationExecutionFailed/u);
  assert.match(api, /500/u);
  assert.match(api, /Schema\.Union/u);
  assert.match(api, /unitCreateHeadersSchema/u);
  assert.match(api, /'idempotency-key'/u);
  assert.match(bff, /OperationAuthorizationDenied/u);
  assert.match(bff, /coreSDKErrorToHttpError/u);
});

test('createUnit descriptor and client provide required operation metadata', () => {
  const action = read('verticals/properties/src/actions/create-unit.action.ts');
  const handler = read('verticals/properties/src/actions/create-unit.handler.ts');
  const message = read('verticals/properties/src/outbox/properties-unit-created.message.ts');
  const eventContract = read('packages/shared-contracts/src/properties-events.ts');
  const policy = read('verticals/properties/src/actions/create-unit.policy.ts');
  const registration = read('verticals/properties/src/actions/create-unit.registration.ts');
  const client = read('verticals/properties/src/effect/properties-client.ts');
  const button = read('verticals/properties/src/components/create-unit-button.tsx');

  assert.match(action, /actionKey:\s*'property\.registry\.createUnit'/u);
  assert.match(action, /auditProfile:\s*'standard'/u);
  assert.match(action, /eventType:\s*propertiesUnitCreatedTopic/u);
  assert.match(action, /subjectResourceId:\s*\(_input,\s*response\)\s*=>\s*response\.unitId/u);
  assert.match(action, /subjectResourceType:\s*'property\.unit'/u);
  assert.match(action, /idempotency:\s*'required'/u);
  assert.match(handler, /services\.tx\s*\n\s*\.insert\(unit\)/u);
  assert.match(handler, /name:\s*input/u);
  assert.match(handler, /returning\(\{\s*unitId:\s*unit\.unitId/u);
  assert.match(handler, /services\.context\.addOutboxMessage\?\.\(/u);
  assert.match(handler, /propertiesUnitCreatedOutboxMessage/u);
  assert.match(handler, /unitId:\s*inserted\.unitId/u);
  assert.match(eventContract, /propertiesUnitCreatedTopic = 'properties\.unit\.created'/u);
  assert.match(eventContract, /PropertiesUnitCreatedPayload/u);
  assert.match(message, /@mvp2\/shared-contracts\/properties-events/u);
  assert.match(message, /defineOutboxMessage\(\s*propertiesUnitCreatedTopic,?\s*\)/u);
  assert.match(policy, /rejectCreateUnitNameStartingWithNewPolicy/u);
  assert.match(policy, /startsWith\('New'\)/u);
  assert.match(policy, /rejectCreateUnitNameEndingWithUnitPolicy/u);
  assert.match(policy, /endsWith\('unit'\)/u);
  assert.match(registration, /satisfies ActionRegistration/u);
  assert.match(registration, /rejectCreateUnitNameStartingWithNewPolicy/u);
  assert.match(registration, /rejectCreateUnitNameEndingWithUnitPolicy/u);
  assert.match(client, /readonly unitId:\s*string/u);
  assert.match(client, /'idempotency-key'/u);
  assert.match(client, /payload:\s*options\.unitName/u);
  assert.match(button, /crypto\.randomUUID/u);
  assert.match(button, /unitName\s*=\s*'xNew unitx'/u);
  assert.match(button, /catch\s*\(error\)/u);
});

test('readUnits records a Core data access event for each read action', () => {
  const action = read('verticals/properties/src/actions/read-units.action.ts');
  const handler = read('verticals/properties/src/actions/read-units.handler.ts');
  const registration = read('verticals/properties/src/actions/read-units.registration.ts');
  const api = read('verticals/properties/shared/effect/api.ts');
  const bff = read('verticals/properties/api/effect/index.ts');

  assert.match(action, /actionKey:\s*'property\.registry\.readUnits'/u);
  assert.match(action, /idempotency:\s*'optional'/u);
  assert.match(action, /provider:\s*'spicedb'/u);
  assert.match(action, /permission:\s*'read'/u);
  assert.match(action, /resourceObjectType:\s*'resource_type'/u);
  assert.match(action, /resourceObjectId:\s*'property\.unit'/u);
  assert.match(registration, /policyChecks:\s*\[\]/u);
  assert.match(handler, /@mvp2\/core-runtime\/db\/schema/u);
  assert.match(handler, /services\.tx\s*\n\s*\.select/u);
  assert.match(handler, /services\.tx\.insert\(dataAccessEvents\)/u);
  assert.match(
    handler,
    /actionInvocationId:\s*services\.context\.actionInvocation\?\.actionInvocationId/u,
  );
  assert.match(handler, /accessKind:\s*'list'/u);
  assert.match(handler, /targetResourceType:\s*'property\.unit'/u);
  assert.match(handler, /resultCount:\s*rows\.length/u);
  assert.match(api, /HttpApiEndpoint\.post\('readUnits'/u);
  assert.match(bff, /readUnitsActionRegistration/u);
  assert.match(bff, /runAction/u);
});
