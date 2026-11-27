// expect-count: 1
// A field binding rendered directly gets no effect-form state: it must go through FormReact.make.
import { TextField } from '@app/core-runtime/ui/form';

export const Loose = () => <TextField field={undefined as never} props={{ label: 'Name' }} />;
