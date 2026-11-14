import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { MerchandiseNotImplemented } from './errors/merchandise-not-implemented.ts';

const problemStatus = {
  notImplemented: 503,
} as const;

export const MerchandiseNotImplementedProblemSchema = makeProblemDetailsSchema(
  'MerchandiseNotImplementedProblem',
  problemStatus.notImplemented,
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
    status: problemStatus.notImplemented,
    title: 'Merchandise operation unavailable',
    type: 'urn:ontos:merchandise:not-implemented',
  });
