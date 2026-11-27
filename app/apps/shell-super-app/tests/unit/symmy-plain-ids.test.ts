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
        Schema.Struct({
          parameters: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, schema: Schema.Json }))),
          requestBody: Schema.optionalKey(Schema.Json),
          responses: Schema.Json,
        }),
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

interface Property {
  readonly name: string;
  readonly path: string;
  readonly schema: Json;
}

/** Every property that `node` describes, however deeply, with the JSON path it sits at. */
const propertiesIn = (node: Json, path: string, seen: ReadonlySet<string>): readonly Property[] => {
  if (Array.isArray(node)) {
    return node.flatMap((child: Json, index) => propertiesIn(child, `${path}/${index}`, seen));
  }
  const pointer = asPointer(node);
  if (Option.isSome(pointer)) {
    const name = pointer.value.$ref.replace('#/components/schemas/', '');
    return seen.has(name)
      ? []
      : propertiesIn(document.components.schemas[name] ?? null, `${path}/${name}`, new Set([...seen, name]));
  }
  const entries = asObject(node);
  if (Option.isNone(entries)) {
    return [];
  }
  const own = Object.entries(Option.getOrElse(asObject(entries.value['properties']), () => ({}))).map(
    ([name, schema]) => ({ name, path: `${path}/${name}`, schema }),
  );
  return [
    ...own,
    ...Object.entries(entries.value).flatMap(([key, child]) => propertiesIn(child, `${path}/${key}`, seen)),
  ];
};

/** The parts of an owner reference a Symmy caller never states or reads. */
const ownerParts = new Set(['moduleId', 'ownerModuleId', 'resourceType', 'tenantId']);

/** A property that is such a part, or a `…Ref` or `…Refs` object that names its target by `resourceId`. */
const isOwnerPart = ({ name, schema }: Pick<Property, 'name' | 'schema'>) =>
  ownerParts.has(name) ||
  (/Refs?$/u.test(name) && propertiesIn(schema, name, new Set()).some((nested) => nested.name === 'resourceId'));

const ownerPartsIn = (node: Json, path: string) =>
  propertiesIn(node, path, new Set())
    .filter(isOwnerPart)
    .map((property) => property.path);

/** Group assignment has no public body yet: it takes an internal fixture or plan, whose shapes are the owners'. */
const internalBodies = new Set<string>([SYMMY_ROUTES.customerGroupCustomersBatch.path]);

const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ method, operation, path })),
);

describe('Symmy plain ids', () => {
  it('describes every Symmy route', () => {
    expect(operations.length).toBeGreaterThanOrEqual(Object.keys(SYMMY_ROUTES).length);
  });

  it('has no owner reference or part of one in any parameter, request or response', () => {
    const found = operations.flatMap(({ method, operation, path }) => {
      const label = `${method.toUpperCase()} ${path}`;
      const body = internalBodies.has(path) ? undefined : operation.requestBody;
      return [
        ...(operation.parameters ?? []).filter(isOwnerPart).map(({ name }) => `${label} parameter ${name}`),
        ...ownerPartsIn(body ?? null, `${label} request`),
        ...ownerPartsIn(operation.responses, `${label} response`),
      ];
    });
    expect(found).toEqual([]);
  });
});
