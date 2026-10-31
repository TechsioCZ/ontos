// expect-count: 0
import { defineRead as registerRead } from '@app/core-runtime';
import * as Runtime from '@app/core-runtime';
import { makeRecordsServices, makeRecordsServices as transactionFactory } from './owner.ts';

declare const descriptor: never;
declare const pipeline: never;
declare const permissionResolver: never;

registerRead(descriptor, pipeline, makeRecordsServices, permissionResolver);
Runtime.defineRead(descriptor, pipeline, (transactionFactory), permissionResolver);
