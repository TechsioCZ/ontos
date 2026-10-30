import { makeEntityId, makeEntityId as makeCheckedId } from './branded-string-constructor.ts';
import { makeEntityId as makeUnknownId } from './branded-constructor-unknown.ts';
import { makeEntityId as makeExecutableCheckId } from './branded-constructor-executable-check.ts';
import { makeEntityId as makeContextId } from './branded-constructor-context.ts';
import { makeEntityId as makeFakeId } from './branded-constructor-fake-make.ts';
import { makeEntityId as makeExecutableInputId } from './branded-constructor-executable-input.ts';
import { makeEntityId as makeUncheckedId } from './branded-constructor-unchecked.ts';

void [makeEntityId, makeCheckedId, makeUnknownId, makeExecutableCheckId, makeContextId, makeFakeId,
  makeExecutableInputId, makeUncheckedId];
