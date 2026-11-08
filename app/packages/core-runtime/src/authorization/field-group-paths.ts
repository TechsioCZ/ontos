import { Match, Schema, SchemaAST } from 'effect';

import type { AccessFieldGroup } from './access-declaration.ts';

/** Any schema; only its AST is read. */
interface SchemaWithAst {
  readonly ast: SchemaAST.AST;
}

/** How one governed path ends in one branch of a schema: the property it names, optional or not. */
const PathEndSchema = Schema.Literals(['optional', 'required']);
type PathEnd = typeof PathEndSchema.Type;

/** An index signature or an unknown value accepts any key, and never requires it. */
const ANY_KEY: readonly PathEnd[] = Object.freeze(['optional']);

/**
 * Every property one governed path names in a schema (O17, O58). The path addresses the schema root
 * and an array applies it to each element, exactly as the read projection and the field-write check
 * address a value, so `items.value` names `value` inside every element of `items`. A union, a class
 * or a generic declaration is followed into each of its members; a branch without the path names
 * nothing, and an index signature or an unknown value accepts any key as optional.
 */
const pathEnds = (ast: SchemaAST.AST, segments: readonly string[]): readonly PathEnd[] => {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return [];
  }
  return Match.value(ast).pipe(
    Match.tags({
      Any: () => ANY_KEY,
      Arrays: ({ elements, rest }): readonly PathEnd[] =>
        [...elements, ...rest].flatMap((element) => pathEnds(element, segments)),
      Declaration: ({ typeParameters }): readonly PathEnd[] =>
        typeParameters.flatMap((parameter) => pathEnds(parameter, segments)),
      Objects: ({ indexSignatures, propertySignatures }): readonly PathEnd[] => {
        const property = propertySignatures.find(({ name }) => name === head);
        if (property === undefined) {
          return indexSignatures.length > 0 ? ANY_KEY : [];
        }
        if (tail.length === 0) {
          return [SchemaAST.isOptional(property.type) ? 'optional' : 'required'];
        }
        return pathEnds(property.type, tail);
      },
      Suspend: ({ thunk }): readonly PathEnd[] => pathEnds(thunk(), segments),
      Union: ({ types }): readonly PathEnd[] => types.flatMap((member) => pathEnds(member, segments)),
      Unknown: () => ANY_KEY,
    }),
    Match.orElse((): readonly PathEnd[] => []),
  );
};

/** Both sides a value crosses: the decoded type the owner returns and the encoded wire shape. */
const pathEndsOnBothSides = (schema: SchemaWithAst, segments: readonly string[]): readonly PathEnd[] => [
  ...pathEnds(SchemaAST.toType(schema.ast), segments),
  ...pathEnds(SchemaAST.toEncoded(schema.ast), segments),
];

/**
 * A `field_read` group removes its paths from the result of a caller who lacks it (O17, O58), so the
 * result schema must name each path and declare it optional wherever it occurs. A required governed
 * property would make the redacted record fail the result and HTTP success schemas: the caller would
 * get a server error instead of the record without that field.
 */
export const fieldReadGroupSchemaIssue = (
  groups: readonly AccessFieldGroup[],
  resultSchema: SchemaWithAst,
): string | undefined => {
  for (const group of groups) {
    for (const field of group.fields) {
      const ends = pathEndsOnBothSides(resultSchema, field.split('.'));
      if (ends.length === 0) {
        return `field group ${group.key} governs ${field}, but the result schema has no such property`;
      }
      if (ends.includes('required')) {
        return `field group ${group.key} governs ${field}, but the result schema requires it: a caller without ${group.key} receives the record without ${field}, so declare it with Schema.optionalKey in the result schema (O17, O58)`;
      }
    }
  }
  return undefined;
};

/**
 * A `field_write` group refuses a payload that writes one of its paths (O58, O74), so each path must
 * name a payload property: a path the payload never carries would leave the field ungoverned.
 */
export const fieldWriteGroupSchemaIssue = (
  groups: readonly AccessFieldGroup[],
  payloadSchema: SchemaWithAst,
): string | undefined => {
  for (const group of groups) {
    for (const field of group.fields) {
      if (pathEndsOnBothSides(payloadSchema, field.split('.')).length === 0) {
        return `field group ${group.key} governs ${field}, but the payload schema has no such property`;
      }
    }
  }
  return undefined;
};
