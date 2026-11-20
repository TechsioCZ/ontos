import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
import { Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { customerSourceRouteEnrollment } from '../../src/persistence/customer-source-route-persistence.ts';

// INTERNAL_CONTRACT only: these values are not a claim about any external system's identifiers.
const writer = '44444444-4444-4444-8444-444444444444';
const otherWriter = '45444444-4444-4444-8444-444444444444';
const reader = 'aaaaaaaa-6666-4666-8666-66666666666a';
const otherReader = 'bbbbbbbb-6666-4666-8666-66666666666b';

const holder = (
  kind: WorkloadBindingHolder['kind'],
  principalId: string,
  companyRegistration: NonNullable<WorkloadBindingHolder['companyRegistration']>,
): WorkloadBindingHolder => ({ apiKey: false, companyRegistration, kind, principalId });
const enrolledWriter = Option.some({ principalId: writer });
/** The writer the routine is handed for these source-write holders. */
const writerOf = (writers: readonly WorkloadBindingHolder[], enrolled = enrolledWriter) =>
  customerSourceRouteEnrollment({ readers: [], requestedReaders: [], writer: enrolled, writers })
    .enrolledWriterPrincipalId;

it("counts the route's writer and readers where Core's company gate admits them in the route's legal entity", () => {
  expect(
    customerSourceRouteEnrollment({
      readers: [
        // A reader reads directly: a registration of any of its active bindings admits it.
        holder('integration', reader, 'other_binding'),
        holder('integration', otherReader, 'binding'),
      ],
      // Core answers ids in lower case; the route may name them in any case.
      requestedReaders: [reader.toUpperCase(), otherReader],
      writer: enrolledWriter,
      writers: [holder('system', writer, 'binding')],
    }),
  ).toEqual({ enrolledReaderPrincipalIds: [reader.toUpperCase(), otherReader], enrolledWriterPrincipalId: writer });
});

it('counts no writer the company gate refuses in the legal entity, so the routine answers PRINCIPAL_INELIGIBLE', () => {
  // The writer runs source writes as a verified gateway workload: only its source-write binding's own registration
  // admits it, never one of another of its bindings.
  expect(writerOf([holder('system', writer, 'other_binding')])).toBeNull();
  expect(writerOf([holder('system', writer, 'none')])).toBeNull();
  // Another holder's registration never stands in for the enrolled writer.
  expect(writerOf([holder('system', otherWriter, 'binding')])).toBeNull();
  expect(writerOf([holder('system', writer, 'binding')], Option.none())).toBeNull();
});

it('counts no reader the company gate refuses in the legal entity, nor a principal of another kind', () => {
  expect(
    customerSourceRouteEnrollment({
      readers: [holder('integration', reader, 'none'), holder('system', otherReader, 'binding')],
      requestedReaders: [reader, otherReader, writer],
      writer: enrolledWriter,
      writers: [holder('system', writer, 'binding')],
    }).enrolledReaderPrincipalIds,
  ).toEqual([]);
});
