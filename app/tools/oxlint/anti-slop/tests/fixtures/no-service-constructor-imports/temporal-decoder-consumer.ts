import { makeDecodedEvidence as makeOwnerEvidence } from './temporal-data-decoder.ts';
import { makeDecodedEvidence as makeEffectEvidence } from './temporal-decoder-effect.ts';
import { makeDecodedEvidence as makeUnknownEvidence } from './temporal-decoder-unknown.ts';
import { makeDecodedEvidence as makeEffectTransformEvidence } from './temporal-decoder-effect-transform.ts';
import { makeDecodedEvidence as makeExecutableTransformEvidence } from './temporal-decoder-executable-transform.ts';
import { makeDecodedEvidence as makeFakeDateTimeEvidence } from './temporal-decoder-fake-datetime.ts';

void [makeOwnerEvidence, makeEffectEvidence, makeUnknownEvidence, makeEffectTransformEvidence,
  makeExecutableTransformEvidence, makeFakeDateTimeEvidence];
