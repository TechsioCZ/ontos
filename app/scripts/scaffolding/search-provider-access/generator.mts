import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planSearchProviderAccessScaffold } from './scaffold.mts';
import type {
  SearchProviderAccessScaffoldConfig,
  SearchProviderAccessScaffoldResult,
} from '../shared.mts';

export default createCodesmithGenerator<
  SearchProviderAccessScaffoldConfig,
  SearchProviderAccessScaffoldResult
>(planSearchProviderAccessScaffold);
