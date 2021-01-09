const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?(z|[+-]\d\d:\d\d)?$/i;

export interface DateTimeRecognizer {
  isDate(s: string): boolean;
  isTime(s: string): boolean;
  isDateTime(s: string): boolean;
}

const DATE_TIME_SEP = /t|\s/i;

export class DefaultDateTimeRecognizer implements DateTimeRecognizer {
  isDate(s: string): boolean {
    const matches = s.match(DATE);
    if (!matches) return false;
    const m = +matches[2];
    const d = +matches[3];
    return m >= 1 && m <= 12 && d >= 1 && d <= DAYS[m];
  }
  isTime(str: string): boolean {
    const matches = str.match(TIME);
    if (!matches) return false;
    const h = +matches[1];
    const m = +matches[2];
    const s = +matches[3];
    return h < 24 && m < 60 && s < 60;
  }
  isDateTime(s: string): boolean {
    const dateTime = s.split(DATE_TIME_SEP);
    return dateTime.length === 2 && this.isDate(dateTime[0]) && this.isTime(dateTime[1]);
  }
}
