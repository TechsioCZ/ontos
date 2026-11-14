import { Data } from 'effect';

export class DemoAccountInvalid extends Data.TaggedError('DemoAccountInvalid')<{ readonly reason: string }> {}
