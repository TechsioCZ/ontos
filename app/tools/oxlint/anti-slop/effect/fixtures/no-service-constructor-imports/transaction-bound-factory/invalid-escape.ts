// expect-count: 1
import { defineRead } from '@app/core-runtime';
import { makeRecordsServices } from './owner.ts';

declare const descriptor: never;
declare const pipeline: never;
declare const permissionResolver: never;
declare const transaction: never;
declare const scope: never;

defineRead(descriptor, pipeline, makeRecordsServices, permissionResolver);
export const escaped = makeRecordsServices(transaction, scope, undefined);
