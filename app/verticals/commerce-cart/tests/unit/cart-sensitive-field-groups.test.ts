import { SchemaAST } from 'effect';
import type { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { FinalCartCandidateSchema } from '../../../../packages/commerce-cart-finalization-contracts/src/apis/final-cart-candidate.ts';
import { OpenSelectionPopulationResponseSchema } from '../../../../packages/commerce-cart-contracts/src/apis/open-selection-population.ts';
import { PreapprovalCartObservationResponseSchema } from '../../shared/apis/preapproval-cart-observation.ts';
import { finalCartCandidateRead } from '../../src/api/final-cart-candidate.read.ts';
import { openSelectionPopulationRead } from '../../src/api/open-selection-population.read.ts';
import { preapprovalCartObservationRead } from '../../src/api/preapproval-cart-observation.read.ts';

/**
 * Whether the terminal property a result path names is optional in its schema (O17, O74). A field
 * grant is expressible only over an optional path: the runtime redacts by removing the governed
 * property and the transport then encodes the answer with the read's result schema, so a required
 * governed property would fail the encode (500) instead of returning a redacted 200.
 */
const terminalOptionality = (schema: Schema.Constraint, path: readonly string[]): boolean | 'missing' => {
  const walk = (ast: SchemaAST.AST, segments: readonly string[]): boolean | 'missing' => {
    const [head, ...tail] = segments;
    if (head === undefined) {
      return true;
    }
    if (SchemaAST.isUnion(ast)) {
      const results = ast.types.map((member) => walk(member, segments));
      if (results.some((result) => result === true)) {
        return true;
      }
      return results.every((result) => result === 'missing') ? 'missing' : false;
    }
    if (SchemaAST.isSuspend(ast)) {
      return walk(ast.thunk(), segments);
    }
    if (SchemaAST.isArrays(ast)) {
      const results = [...ast.elements, ...ast.rest].map((element) => walk(element, segments));
      if (results.some((result) => result === true)) {
        return true;
      }
      return results.every((result) => result === 'missing') ? 'missing' : false;
    }
    if (!SchemaAST.isObjects(ast)) {
      return 'missing';
    }
    const property = ast.propertySignatures.find((signature) => signature.name === head);
    if (property === undefined) {
      return 'missing';
    }
    return tail.length === 0 ? property.type.context?.isOptional === true : walk(property.type, tail);
  };
  return walk(schema.ast, path);
};

/** The platform's own money-leaf vocabulary; a name outside it is not a governed monetary amount. */
const MONEY_LEAF_SEGMENTS = new Set([
  'finalPreTaxAmount',
  'floorDelta',
  'lineTotal',
  'monetaryAmount',
  'preRoundedPreTaxAmount',
  'pricingNetCommercialTotal',
  'publishedPreTaxAmount',
  'quotedResult',
  'rawPreTaxAmount',
  'total',
  'unitPrice',
]);

/** Every leaf result path whose last segment names money; the empty list proves none is present. */
const moneyPathsOf = (schema: Schema.Constraint): readonly string[] => {
  const found = new Set<string>();
  const walk = (ast: SchemaAST.AST, prefix: readonly string[]): void => {
    if (SchemaAST.isUnion(ast)) {
      for (const member of ast.types) {
        walk(member, prefix);
      }
      return;
    }
    if (SchemaAST.isSuspend(ast)) {
      walk(ast.thunk(), prefix);
      return;
    }
    if (SchemaAST.isArrays(ast)) {
      for (const element of [...ast.elements, ...ast.rest]) {
        walk(element, prefix);
      }
      return;
    }
    if (SchemaAST.isObjects(ast)) {
      for (const property of ast.propertySignatures) {
        walk(property.type, [...prefix, String(property.name)]);
      }
      return;
    }
    const leaf = prefix.join('.');
    const lastSegment = prefix.at(-1) ?? '';
    if (MONEY_LEAF_SEGMENTS.has(lastSegment)) {
      found.add(leaf);
    }
  };
  walk(schema.ast, []);
  return [...found];
};

/** Every read in this module, with its declared result schema. */
const cartReads = [
  { read: openSelectionPopulationRead, schema: OpenSelectionPopulationResponseSchema },
  { read: preapprovalCartObservationRead, schema: PreapprovalCartObservationResponseSchema },
] as const;

describe('commerce.cart sensitive field groups', () => {
  it('protects the final-candidate read and declares no field group over a response with no money path (A1)', () => {
    // A1: the exact final-cart candidate is a sensitive read, not an authenticated-principal one.
    expect(finalCartCandidateRead.descriptor.entrypoint.authorization.kind).toBe('protected');
    expect(finalCartCandidateRead.descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.cart.final-candidate.read',
      kind: 'read',
      modes: ['run'],
      risk: 'sensitive',
      selectors: [],
    });
    // A1 proposed a `financial_amounts` group, but the imported final-cart contract carries no
    // resolved money: `pricing` is the Pricing *request* (currency and quantities), and its only
    // `amount` leaves are package unit counts. Declaring a guessed path would guard nothing, so the
    // read declares none; this assertion fails the moment the contract gains a real money leaf.
    expect(finalCartCandidateRead.descriptor.accessFieldGroups).toBeUndefined();
    expect(moneyPathsOf(FinalCartCandidateSchema)).toEqual([]);
  });

  it('declares the calling modules and identity subject of each Cart read (accessActor)', () => {
    expect(finalCartCandidateRead.descriptor.accessActor).toMatchObject({
      callers: ['commerce-customer-context', 'commerce-order', 'pricing'],
      subject: 'identity',
    });
    expect(openSelectionPopulationRead.descriptor.accessActor).toMatchObject({
      callers: ['catalog'],
      subject: 'identity',
    });
    expect(preapprovalCartObservationRead.descriptor.accessActor).toMatchObject({
      callers: ['commerce-customer-context'],
      subject: 'identity',
    });
  });

  it('declares no field_read group over a required wire field (O17, O74)', () => {
    // A field grant is only expressible over an optional result path. The cart activity identity the
    // A1 review named is required by the shared wire contracts, so the whole sensitive read is the
    // gate and no group is declared. This guard fails the moment a declared group governs a required
    // path, or a path the schema does not carry.
    for (const { read, schema } of cartReads) {
      for (const group of read.descriptor.accessFieldGroups ?? []) {
        expect(group.kind).toBe('field_read');
        for (const field of group.fields) {
          expect(terminalOptionality(schema, field.split('.')), `${read.descriptor.readKey}: ${field}`).toBe(true);
        }
      }
    }
  });

  it('withdraws every field_read group A1 reviewed until its path becomes optional', () => {
    for (const { read } of cartReads) {
      expect(read.descriptor.accessFieldGroups).toBeUndefined();
    }
  });

  it('keeps each read declaration key distinct from any group key it would declare', () => {
    for (const { read } of cartReads) {
      expect(read.descriptor.accessDeclaration?.kind).toBe('read');
      expect(read.descriptor.accessDeclaration?.modes).toEqual(['run']);
      expect(read.descriptor.accessDeclaration?.selectors).toEqual([]);
    }
  });
});
