import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { Option, Schema } from 'effect';
import { HttpApi, OpenApi } from 'effect/http-api';
import { describe, expect, it } from 'effect-rstest';

import { SymmyIngressGroup } from '../../shared/api.ts';

type Json = typeof Schema.Json.Type;

const DocumentSchema = Schema.fromJsonString(
  Schema.Struct({
    components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Json) }),
    paths: Schema.Record(
      Schema.String,
      Schema.Record(
        Schema.String,
        Schema.Struct({ requestBody: Schema.optionalKey(Schema.Json), responses: Schema.Json }),
      ),
    ),
  }),
);
/** The Shell document leaves Symmy out, so the group is described on its own. */
const document = Schema.decodeUnknownSync(DocumentSchema)(
  JSON.stringify(OpenApi.fromApi(HttpApi.make('symmy').add(SymmyIngressGroup.annotate(OpenApi.Exclude, false)))),
);

const asObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const asPointer = Schema.decodeUnknownOption(Schema.Struct({ $ref: Schema.String }));

/** The JSON paths below `node` that describe an owner reference object: a module id beside a resource type. */
const ownerRefsIn = (node: Json, path: string, seen: ReadonlySet<string>): readonly string[] => {
  if (Array.isArray(node)) {
    return node.flatMap((child: Json, index) => ownerRefsIn(child, `${path}/${index}`, seen));
  }
  const pointer = asPointer(node);
  if (Option.isSome(pointer)) {
    const name = pointer.value.$ref.replace('#/components/schemas/', '');
    return seen.has(name)
      ? []
      : ownerRefsIn(document.components.schemas[name] ?? null, `${path}/${name}`, new Set([...seen, name]));
  }
  const entries = asObject(node);
  if (Option.isNone(entries)) {
    return [];
  }
  const properties = asObject(entries.value['properties']);
  const own =
    Option.isSome(properties) && 'moduleId' in properties.value && 'resourceType' in properties.value ? [path] : [];
  return [
    ...own,
    ...Object.entries(entries.value).flatMap(([key, child]) => ownerRefsIn(child, `${path}/${key}`, seen)),
  ];
};

/** Group assignment has no public body yet: it takes an internal fixture or plan, whose shapes are the owners'. */
const internalBodies = new Set<string>([SYMMY_ROUTES.customerGroupCustomersBatch.path]);

const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ method, operation, path })),
);

describe('Symmy plain ids', () => {
  it('describes every Symmy route', () => {
    expect(operations.length).toBeGreaterThanOrEqual(Object.keys(SYMMY_ROUTES).length);
  });

  it('has no owner reference object in any request or response', () => {
    const found = operations.flatMap(({ method, operation, path }) => {
      const label = `${method.toUpperCase()} ${path}`;
      const body = internalBodies.has(path) ? undefined : operation.requestBody;
      return [
        ...ownerRefsIn(body ?? null, `${label} request`, new Set()),
        ...ownerRefsIn(operation.responses, `${label} response`, new Set()),
      ];
    });
    expect(found).toEqual([]);
  });
});
