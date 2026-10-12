import { TZ, CUTOFF_HOUR } from './config.js';

const pad = n => String(n).padStart(2, '0');

function etParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

export function etDateString(date) {
  const p = etParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function etWeekday(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
}

// Wall-clock time in Eastern -> the real instant. Handles EST/EDT.
export function etToUtc(y, m, d, h) {
  const target = Date.UTC(y, m - 1, d, h);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess = guess + (target - wallAsUtc);
  }
  return new Date(guess);
}

// Every 6:00 am ET boundary b with after < b <= now, ascending.
export function cutoffsBetween(after, now) {
  const out = [];
  const start = etParts(new Date(after.getTime() - 36 * 3600 * 1000));
  const day = new Date(Date.UTC(start.y, start.m - 1, start.d));
  for (let i = 0; i < 400; i++) {
    const b = etToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), CUTOFF_HOUR);
    if (b > now) break;
    if (b > after) out.push(b);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}
