import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  accessCarrierIssue,
  decodeAccessActor,
  declaredAccessCarrier,
} from '../../src/authorization/access-declaration.ts';
import type { AccessActorInput } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const actionOwner = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'commerce-order.order.approve',
  moduleKey: 'commerce-order',
  role: 'action',
});

const pageOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'commerce-order.order.home',
  moduleKey: 'commerce-order',
  role: 'page',
});

const validActor: AccessActorInput = {
  callers: ['commerce-order', 'commerce-customer-context'],
  reason: 'The order approval consumer acts for the buyer of the approved order',
  subject: 'identity',
};

const declaration = {
  key: 'commerce-order.order.note',
  kind: 'action',
  modes: ['run'],
  placement: { group: 'orders', level: 'basic' },
  risk: 'routine',
  selectors: [],
} as const;

it('decodes a module actor as a frozen declaration with its callers and subject (D5)', () => {
  const decoded = decodeAccessActor(validActor, actionOwner);
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isSuccess(decoded)) {
    expect(decoded.success.callers).toEqual(['commerce-order', 'commerce-customer-context']);
    expect(decoded.success.subject).toBe('identity');
    expect(Object.isFrozen(decoded.success)).toBe(true);
  }
});

it('refuses an actor with no caller, a repeated caller, or a malformed app id (D5)', () => {
  for (const callers of [[], ['commerce-order', 'commerce-order'], ['Commerce Order']]) {
    const decoded = decodeAccessActor({ ...validActor, callers }, actionOwner);
    expect(Result.isFailure(decoded)).toBe(true);
  }
});

it('refuses a subject other than rights or identity, and a reason that is empty', () => {
  const badSubject = decodeAccessActor({ ...validActor, subject: 'agent' }, actionOwner);
  const emptyReason = decodeAccessActor({ ...validActor, reason: '' }, actionOwner);
  expect(Result.isFailure(badSubject)).toBe(true);
  expect(Result.isFailure(emptyReason)).toBe(true);
});

it('declares an actor only on an Action or a governed read, never on a page (D5)', () => {
  const decoded = decodeAccessActor(validActor, pageOwner);
  expect(Result.isFailure(decoded)).toBe(true);
  expect(accessCarrierIssue({ accessActor: validActor, entrypoint: pageOwner })).toContain('accessActor');
});

it('requires an accessDeclaration on the same carrier for the rights subject (D5)', () => {
  const issue = accessCarrierIssue({
    accessActor: { ...validActor, subject: 'rights' },
    entrypoint: actionOwner,
  });
  expect(issue).toContain('requires accessDeclaration');
  expect(
    accessCarrierIssue({
      accessActor: { ...validActor, subject: 'rights' },
      accessDeclaration: declaration,
      entrypoint: actionOwner,
    }),
  ).toBeUndefined();
});

it('lets an identity actor stand as the protected carrier with or without a declaration (D5)', () => {
  expect(accessCarrierIssue({ accessActor: validActor, entrypoint: actionOwner })).toBeUndefined();
  const carriers = declaredAccessCarrier({ accessActor: validActor, entrypoint: actionOwner });
  expect(carriers.accessActor?.subject).toBe('identity');
  expect(carriers.accessDeclaration).toBeUndefined();
});

it('keeps an existing accessDeclaration beside a module actor, never replacing it (D5)', () => {
  const carriers = declaredAccessCarrier({
    accessActor: { ...validActor, subject: 'rights' },
    accessDeclaration: declaration,
    entrypoint: actionOwner,
  });
  expect(carriers.accessDeclaration?.key).toBe('commerce-order.order.note');
  expect(carriers.accessActor?.callers).toEqual(['commerce-order', 'commerce-customer-context']);
});

const workloadActor: AccessActorInput = {
  ...validActor,
  subjectWorkloads: ['commerce.storefront-client'],
};

it('admits a workload subject on an identity actor that names its workload keys', () => {
  const decoded = decodeAccessActor(workloadActor, actionOwner);
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isSuccess(decoded)) {
    expect(decoded.success.subjectWorkloads).toEqual(['commerce.storefront-client']);
  }
  expect(accessCarrierIssue({ accessActor: workloadActor, entrypoint: actionOwner })).toBeUndefined();
});

it('leaves subjectWorkloads absent on an actor that names none, so no workload subject is admitted', () => {
  const decoded = decodeAccessActor(validActor, actionOwner);
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isSuccess(decoded)) {
    expect('subjectWorkloads' in decoded.success).toBe(false);
  }
});

it('admits subjectWorkloads on a rights actor: a workload is admitted by its binding, a person by its rights', () => {
  const issue = accessCarrierIssue({
    accessActor: { ...workloadActor, subject: 'rights' },
    accessDeclaration: declaration,
    entrypoint: actionOwner,
  });
  expect(issue).toBeUndefined();
  const decoded = decodeAccessActor({ ...workloadActor, subject: 'rights' }, actionOwner);
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isSuccess(decoded)) {
    expect(decoded.success.subject).toBe('rights');
    expect(decoded.success.subjectWorkloads).toEqual(['commerce.storefront-client']);
  }
});

it('refuses a subjectWorkloads key that is not a workload key, and an empty or repeated list', () => {
  for (const subjectWorkloads of [
    ['Commerce Storefront'],
    ['storefront'],
    [],
    ['commerce.storefront-client', 'commerce.storefront-client'],
  ]) {
    const decoded = decodeAccessActor({ ...validActor, subjectWorkloads }, actionOwner);
    expect(Result.isFailure(decoded)).toBe(true);
  }
});
