import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { MerchandiseNotImplemented } from './errors/merchandise-not-implemented.ts';

export const MerchandiseNotImplementedProblemSchema = makeProblemDetailsSchema(
  'MerchandiseNotImplementedProblem',
  503,
  {
    code: Schema.Literal('merchandise_not_implemented'),
  },
);

export const mapMerchandiseNotImplementedProblem = (
  _failure: MerchandiseNotImplemented,
): typeof MerchandiseNotImplementedProblemSchema.Type =>
  MerchandiseNotImplementedProblemSchema.make({
    code: 'merchandise_not_implemented',
    detail: 'This merchandise operation is temporarily unavailable.',
    status: 503,
    title: 'Merchandise operation unavailable',
    type: 'urn:ontos:merchandise:not-implemented',
  });
