// New York Stock Exchange trading hours (regular session only, 9:30-16:00 New York time).
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);   // 13:00 close

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

// New York calendar date, minutes after midnight and weekday for a time (ms)
export function nyParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, weekday: p.weekday };
}

export const isTradingDay = (date, weekday) => !['Sat', 'Sun'].includes(weekday) && !HOLIDAYS.has(date);
const closeMinutes = (date) => (EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60);

// UTC ms of a New York wall-clock time on a date (handles summer/winter time)
export function nyTime(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60) + 5 * 3600000;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(guess);
    const diff = (Date.UTC(...p.date.split('-').map((v, k) => (k === 1 ? v - 1 : +v)), 0, p.minutes) - Date.UTC(y, m - 1, d, 0, minutes)) ;
    guess -= diff;
  }
  return guess;
}

export function session(ms) {
  const p = nyParts(ms);
  const trading = isTradingDay(p.date, p.weekday);
  const open = trading ? nyTime(p.date, 9 * 60 + 30) : null, close = trading ? nyTime(p.date, closeMinutes(p.date)) : null;
  return { date: p.date, trading, open, close, isOpen: trading && ms >= open && ms < close };
}

// The first regular session that starts at or after a time, or the one in progress at that time.
// News published at 18:00 on Tuesday belongs to Wednesday's session; news at 11:00 on Tuesday to Tuesday's.
export function sessionFor(ms) {
  let t = ms;
  for (let i = 0; i < 10; i++) {
    const s = session(t);
    if (s.trading && t < s.close) return s;
    const p = nyParts(t);
    t = nyTime(p.date, 0) + 36 * 3600000;    // jump into the next calendar day
    t = nyTime(nyParts(t).date, 0);
  }
  throw new Error('no trading session found');
}
