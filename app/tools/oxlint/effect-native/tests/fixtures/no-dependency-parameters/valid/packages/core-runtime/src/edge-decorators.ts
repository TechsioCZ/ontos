// Decorated classes must parse without crashing, and data parameters must stay silent.
interface ContactRow {
  readonly id: string;
}
declare function Injectable(): ClassDecorator;
declare function Inject(): ParameterDecorator;

@Injectable()
export class RowPresenter {
  constructor(@Inject() private readonly row: ContactRow) {}
  @Injectable()
  render(row: ContactRow, label: string) {
    return `${row.id}${label}`;
  }
}
