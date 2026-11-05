import { v1 } from '@authzed/authzed-node';
import { Match, Option, Predicate, Schema } from 'effect';

import type {
  AccessCaveat,
  AccessCaveatContext,
  AccessRelationship,
  AccessRelationshipSubject,
  CaveatContextValue,
} from './relationship.ts';
import { ACCESS_CAVEAT_NAMES } from './relationship.ts';

const NANOS_PER_SECOND = 1_000_000_000;
const CaveatListSchema = Schema.Array(Schema.String);
const isCaveatList = Schema.is(CaveatListSchema);

type CaveatValue = v1.PbStruct['fields'][string];
type CaveatListValue = Extract<CaveatValue['kind'], { readonly oneofKind: 'listValue' }>['listValue'];
type CaveatStructObject = Parameters<typeof v1.createStructFromObject>[0];

const stringListOf = (listValue: CaveatListValue): Option.Option<readonly string[]> => {
  const values: string[] = [];
  for (const entry of listValue.values) {
    if (entry.kind.oneofKind !== 'stringValue') {
      return Option.none();
    }
    values.push(entry.kind.stringValue);
  }
  return Option.some(values);
};

const caveatValueOf = (value: CaveatValue): Option.Option<CaveatContextValue> =>
  Match.value(value.kind).pipe(
    Match.when({ oneofKind: 'numberValue' }, ({ numberValue }) => Option.some<CaveatContextValue>(numberValue)),
    Match.when({ oneofKind: 'stringValue' }, ({ stringValue }) => Option.some<CaveatContextValue>(stringValue)),
    Match.when({ oneofKind: 'listValue' }, ({ listValue }) => stringListOf(listValue)),
    Match.orElse((): Option.Option<CaveatContextValue> => Option.none()),
  );

const caveatContextOf = (context: v1.PbStruct): Option.Option<AccessCaveatContext> => {
  const fields: [string, CaveatContextValue][] = [];
  for (const [key, value] of Object.entries(context.fields)) {
    const decoded = caveatValueOf(value);
    if (Option.isNone(decoded)) {
      return Option.none();
    }
    fields.push([key, decoded.value]);
  }
  return Option.some(Object.fromEntries(fields));
};

const caveatNameOf = (text: string): AccessCaveat['name'] | undefined =>
  ACCESS_CAVEAT_NAMES.find((name) => name === text);

const caveatOf = (caveat: v1.ContextualizedCaveat): Option.Option<AccessCaveat> => {
  const name = caveatNameOf(caveat.caveatName);
  const { context } = caveat;
  return name === undefined || context === undefined
    ? Option.none()
    : Option.map(caveatContextOf(context), (decoded) => ({ context: decoded, name }));
};

/** Protobuf Struct values, built from the plain caveat parameters Core stores. */
const structureOf = (context: AccessCaveatContext): CaveatStructObject => {
  const fields: CaveatStructObject = {};
  for (const [key, value] of Object.entries(context)) {
    fields[key] = isCaveatList(value) ? value.filter(Predicate.isString) : value;
  }
  return fields;
};

const objectReference = (objectType: string, objectId: string): v1.ObjectReference =>
  v1.ObjectReference.create({ objectId, objectType });

const subjectReference = (subject: AccessRelationshipSubject): v1.SubjectReference =>
  v1.SubjectReference.create({
    object: objectReference(subject.objectType, subject.objectId),
    optionalRelation: subject.relation ?? '',
  });

/** The engine relationship Core writes for an intended tuple. */
export const toSpiceDbRelationship = (relationship: AccessRelationship): v1.Relationship => {
  const written = v1.Relationship.create({
    relation: relationship.relation,
    resource: objectReference(relationship.resourceType, relationship.resourceId),
    subject: subjectReference(relationship.subject),
  });
  const { caveat, expiresAtEpochSeconds } = relationship;
  if (caveat !== undefined) {
    written.optionalCaveat = v1.ContextualizedCaveat.create({
      caveatName: caveat.name,
      context: v1.createStructFromObject(structureOf(caveat.context)),
    });
  }
  if (expiresAtEpochSeconds !== undefined) {
    written.optionalExpiresAt = { nanos: 0, seconds: String(expiresAtEpochSeconds) };
  }
  return written;
};

const subjectOf = (subject: v1.SubjectReference): AccessRelationshipSubject | undefined => {
  const { object, optionalRelation } = subject;
  if (object === undefined) {
    return undefined;
  }
  const reference = { objectId: object.objectId, objectType: object.objectType };
  return optionalRelation === undefined || optionalRelation.length === 0
    ? reference
    : { ...reference, relation: optionalRelation };
};

const epochSecondsOf = (relationship: v1.Relationship): number | undefined => {
  const expiresAt = relationship.optionalExpiresAt;
  if (expiresAt === undefined || expiresAt === null) {
    return undefined;
  }
  const seconds = Math.floor(Number(expiresAt.seconds) + expiresAt.nanos / NANOS_PER_SECOND);
  return seconds > 0 ? seconds : undefined;
};

/**
 * The inverse, so a verification compares what the engine actually stores with intent.
 *
 * A managed tuple whose caveat Core cannot decode still has a readable identity. It is returned
 * marked `undecodable` instead of being dropped: silently ignoring it would leave a tuple outside
 * intent that verification never reports and no reconcile ever removes (D13).
 */
export const fromSpiceDbRelationship = (relationship: v1.Relationship): Option.Option<AccessRelationship> => {
  const { optionalCaveat, relation, resource } = relationship;
  const subject = relationship.subject === undefined ? undefined : subjectOf(relationship.subject);
  if (resource === undefined || subject === undefined || relation.length === 0) {
    return Option.none();
  }
  const base: AccessRelationship = {
    relation,
    resourceId: resource.objectId,
    resourceType: resource.objectType,
    subject,
  };
  const expiresAtEpochSeconds = epochSecondsOf(relationship);
  const withExpiration = (current: AccessRelationship): AccessRelationship =>
    expiresAtEpochSeconds === undefined ? current : { ...current, expiresAtEpochSeconds };
  if (optionalCaveat === undefined) {
    return Option.some(withExpiration(base));
  }
  return Option.match(caveatOf(optionalCaveat), {
    // The identity is known and the content is not, so the tuple is drift the compiler removes.
    onNone: () => Option.some<AccessRelationship>({ ...base, undecodable: true }),
    onSome: (decoded) => Option.some<AccessRelationship>(withExpiration({ ...base, caveat: decoded })),
  });
};
