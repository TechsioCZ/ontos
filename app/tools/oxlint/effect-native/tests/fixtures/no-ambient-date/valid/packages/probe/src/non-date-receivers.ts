const report = { getDate: () => "label", getTime: () => 42, toISOString: () => "identifier" };
export const values = [report.getDate(), report.getTime(), report.toISOString()];
interface CalendarService { getDate(): string }
export const render = (service: CalendarService) => service.getDate();
export const unknownReceiver = (service: { getTime(): number }) => service.getTime();
let ClockConstructor = Date;
ClockConstructor = class LocalDate {} as DateConstructor;
export const local = new ClockConstructor();
