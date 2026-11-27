import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Option } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  admitSourceProcessingSubjectAction,
  handleAdmitSourceProcessingSubject,
} from '../../src/actions/admit-source-processing-subject.action.ts';
import {
  endSourceProcessingAuthorizationAction,
  handleEndSourceProcessingAuthorization,
} from '../../src/actions/end-source-processing-authorization.action.ts';
import { sourceProcessingIdentityKey } from '../../shared/domain/privacy-source-processing-authorization.ts';
import type { SourceProcessingAuthorization } from '../../shared/domain/privacy-source-processing-authorization.ts';
import type { PrivacySubjectRecord } from '../../shared/domain/privacy-subject.ts';
import type { SourceProcessingAdmissionRow } from '../../src/persistence/source-processing-authorization-repository.ts';
import { makeStandingSourceFixture } from '../support/standing-source-fixture.ts';

const ids = {
  legalEntityId: '30000000-0000-4000-8000-000000000002',
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId: '30000000-0000-4000-8000-000000000001',
};
const base = makeStandingSourceFixture(ids);
const fixture = {
  ...base,
  authorization: {
    ...base.authorization,
    grants: [
      ...base.authorization.grants,
      {
        allowTargetless: true,
        consumerModuleId: 'integration.symmy' as const,
        operation: 'CUSTOMER_SOURCE_INTAKE',
        targetKinds: [],
      },
    ],
  },
};
const scope = {
  authMethod: 'api_key' as const,
  correlationId: 'source-processing-action-test',
  legalEntityId: ids.legalEntityId,
  principalId: ids.principalId,
  tenantId: ids.tenantId,
};
const customer = (recordId: string) => ({ ...fixture.route, recordId });

type AdmitContext = Parameters<typeof handleAdmitSourceProcessingSubject>[1];
type AdmitServices = AdmitContext['services'];
type EndContext = Parameters<typeof handleEndSourceProcessingAuthorization>[1];

/** In-memory owner ledgers: one subject row per subject and one admission row per source record. */
const ledgers = (authorization: SourceProcessingAuthorization) => {
  const subjects = new Map<string, PrivacySubjectRecord>();
  const admissions = new Map<string, SourceProcessingAdmissionRow>();
  let issued = 0;
  const services: AdmitServices = {
    authorizations: {
      activeForRoute: () => Effect.succeed(authorization.lifecycle === 'ACTIVE' ? [authorization] : []),
      admit: (input) =>
        Effect.suspend(() => {
          for (const { role, source } of input.sources) {
            const key = sourceProcessingIdentityKey(source);
            const prior = admissions.get(key);
            admissions.set(key, {
              firstAdmittedAt: prior?.firstAdmittedAt ?? input.admittedAt,
              lastAdmittedAt: input.admittedAt,
              role,
              subjectId: input.subjectId,
            });
          }
          const subject =
            input.membershipRoot === undefined
              ? input.sources.find(({ role }) => role === 'SUBJECT')
              : input.sources[0];
          const row = subject === undefined ? undefined : admissions.get(sourceProcessingIdentityKey(subject.source));
          return row === undefined ? Effect.die('The subject source was not admitted') : Effect.succeed(row);
        }),
      sourceSubjectId: (source) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            [...subjects.values()].find(
              (record) =>
                record.subject.kind === 'SOURCE_ASSERTED' &&
                sourceProcessingIdentityKey(record.subject.source) === sourceProcessingIdentityKey(source),
            )?.subjectRef.resourceId,
          ),
        ),
    },
    createSubject: (_privacyScope, input) =>
      Effect.sync(() => {
        const current = subjects.get(input.subject.subjectRef.resourceId) ?? input.subject;
        subjects.set(current.subjectRef.resourceId, current);
        return current;
      }),
    nextSubjectId: Effect.sync(() => {
      issued += 1;
      return `30000000-0000-4000-8000-${String(issued).padStart(12, '0')}`;
    }),
    profileSource: () => Effect.succeed(Option.none()),
  };
  return { admissions, services, subjects };
};

const collectorFields = (
  descriptor: Pick<
    typeof admitSourceProcessingSubjectAction.descriptor,
    'accessEvidencePolicy' | 'auditEvidenceSchema' | 'domainEvents'
  >,
) => {
  const collector = createActionCollector(
    descriptor.domainEvents,
    'privacy.core',
    descriptor.accessEvidencePolicy,
    descriptor.auditEvidenceSchema,
  );
  return {
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: 'test-composition',
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
  };
};

const admitContext = (
  services: AdmitServices,
  actionInvocationId: string,
  principalId = ids.principalId,
): AdmitContext => ({
  ...collectorFields(admitSourceProcessingSubjectAction.descriptor),
  actionInvocationId,
  scope: { ...scope, principalId },
  services,
});

describe('source processing subject admission', () => {
  it.effect('gives each customer its own subject and keeps a replay on the same subject', () =>
    Effect.gen(function* admit() {
      const { admissions, services, subjects } = ledgers(fixture.authorization);
      const run = (payload: Parameters<typeof handleAdmitSourceProcessingSubject>[0], invocation: string) =>
        handleAdmitSourceProcessingSubject(payload, admitContext(services, invocation));
      const contact = customer('contact:one');
      const one = yield* run(
        { childSources: [contact], source: customer('client:one') },
        '30000000-0000-4000-8000-0000000000a1',
      );
      const two = yield* run(
        { childSources: [], source: customer('client:two') },
        '30000000-0000-4000-8000-0000000000a2',
      );
      const replay = yield* run(
        { childSources: [contact], source: customer('client:one') },
        '30000000-0000-4000-8000-0000000000a3',
      );
      expect(one.subjectRef.resourceId).not.toBe(two.subjectRef.resourceId);
      expect(replay.subjectRef).toEqual(one.subjectRef);
      expect(one.authorizationRef).toEqual(fixture.authorization.authorizationRef);
      expect(subjects.size).toBe(2);
      expect(admissions.get(sourceProcessingIdentityKey(contact))).toMatchObject({
        role: 'CHILD',
        subjectId: one.subjectRef.resourceId,
      });
      expect([...subjects.values()].every((record) => record.subject.kind === 'SOURCE_ASSERTED')).toBe(true);
    }),
  );
  it.effect('a renewed grant keeps the same root subject, and a membership requires its owner-bound profile', () =>
    Effect.gen(function* renew() {
      const authorization: SourceProcessingAuthorization = {
        ...fixture.authorization,
        grants: fixture.authorization.grants.map((grant) =>
          grant.consumerModuleId === 'integration.symmy'
            ? { ...grant, targetKinds: ['RETAIL_CUSTOMER_PROFILE'] }
            : grant,
        ),
        source: {
          ...fixture.authorization.source,
          recordTypes: [...fixture.authorization.source.recordTypes, 'CUSTOMER_GROUP_MEMBERSHIP'],
        },
      };
      const { admissions, services, subjects } = ledgers(authorization);
      const root = customer('customer:one');
      const ctx = admitContext(services, '30000000-0000-4000-8000-0000000000a1');
      const first = yield* handleAdmitSourceProcessingSubject({ childSources: [], source: root }, ctx);
      const renewed = {
        ...services,
        authorizations: {
          ...services.authorizations,
          activeForRoute: () =>
            Effect.succeed([
              {
                ...authorization,
                authorizationRef: {
                  ...authorization.authorizationRef,
                  resourceId: '30000000-0000-4000-8000-0000000000c0',
                },
              },
            ]),
        },
      };
      // The new authorization has no admissions, but the root subject still exists.
      admissions.clear();
      const readmitted = yield* handleAdmitSourceProcessingSubject(
        { childSources: [], source: root },
        admitContext(renewed, '30000000-0000-4000-8000-0000000000a2'),
      );
      expect(readmitted.subjectRef).toEqual(first.subjectRef);
      expect(readmitted.authorizationRef).not.toEqual(first.authorizationRef);
      const member = {
        childSources: [],
        membershipProfile: {
          kind: 'RETAIL_CUSTOMER_PROFILE' as const,
          resourceId: '30000000-0000-4000-8000-0000000000a4',
        },
        source: { ...root, recordId: 'member:one', recordType: 'CUSTOMER_GROUP_MEMBERSHIP' },
      };
      expect(Exit.isFailure(yield* Effect.exit(handleAdmitSourceProcessingSubject(member, ctx)))).toBe(true);
      const admitted = yield* handleAdmitSourceProcessingSubject(
        member,
        admitContext(
          { ...renewed, profileSource: () => Effect.succeed(Option.some(root)) },
          '30000000-0000-4000-8000-0000000000a3',
        ),
      );
      expect(admitted.subjectRef).toEqual(first.subjectRef);
      expect(admissions.get(sourceProcessingIdentityKey(member.source))?.role).toBe('CHILD');
      expect(subjects.size).toBe(1);
    }),
  );
  it.effect('refuses an ended authorization, an unlisted principal and a foreign route', () =>
    Effect.gen(function* refuse() {
      const ended = ledgers(fixture.ended);
      const active = ledgers(fixture.authorization);
      const outcomes = [
        yield* Effect.exit(
          handleAdmitSourceProcessingSubject(
            { childSources: [], source: customer('client:one') },
            admitContext(ended.services, '30000000-0000-4000-8000-0000000000b1'),
          ),
        ),
        yield* Effect.exit(
          handleAdmitSourceProcessingSubject(
            { childSources: [], source: customer('client:one') },
            admitContext(
              active.services,
              '30000000-0000-4000-8000-0000000000b2',
              '30000000-0000-4000-8000-000000000099',
            ),
          ),
        ),
        yield* Effect.exit(
          handleAdmitSourceProcessingSubject(
            { childSources: [], source: { ...customer('client:one'), recordType: 'supplier' } },
            admitContext(active.services, '30000000-0000-4000-8000-0000000000b3'),
          ),
        ),
      ];
      expect(outcomes.every(Exit.isFailure)).toBe(true);
      expect(active.subjects.size + ended.subjects.size).toBe(0);
    }),
  );
});

describe('ending a source processing authorization', () => {
  it.effect('records the end once and refuses a stale or repeated end', () =>
    Effect.gen(function* end() {
      let stored: SourceProcessingAuthorization = fixture.authorization;
      const services: EndContext['services'] = {
        end: (next) =>
          Effect.sync(() => {
            stored = next;
            return next;
          }),
        get: () => Effect.sync(() => Option.some(stored)),
      };
      const run = (expectedRevision: number) =>
        handleEndSourceProcessingAuthorization(
          {
            authorizationId: fixture.authorization.authorizationRef.resourceId,
            expectedRevision,
            reason: 'Symmy integration removed',
          },
          {
            ...collectorFields(endSourceProcessingAuthorizationAction.descriptor),
            actionInvocationId: '30000000-0000-4000-8000-0000000000c1',
            scope,
            services,
          },
        );
      const ended = yield* run(1);
      expect(ended).toMatchObject({ endReason: 'Symmy integration removed', lifecycle: 'ENDED', revision: 2 });
      expect(ended.endedAt).not.toBeNull();
      expect(Exit.isFailure(yield* Effect.exit(run(1)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(run(2)))).toBe(true);
    }),
  );
});
