import type { ActiveHoursConfig } from './types.js';

export function getCurrentTime(timezone?: string): { hours: number; minutes: number } {
  const now = new Date();
  if (!timezone) {
    return { hours: now.getHours(), minutes: now.getMinutes() };
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hours = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minutes = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { hours, minutes };
}

export function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [h, m] = timeStr.split(':');
  return { hours: Number(h), minutes: Number(m) };
}

export function timeToMinutes(t: { hours: number; minutes: number }): number {
  return t.hours * 60 + t.minutes;
}

/** Check if current time is within the active hours window. Returns true if no activeHours configured. */
export function isWithinActiveHours(
  activeHours: ActiveHoursConfig | undefined,
  timezone?: string,
): boolean {
  if (!activeHours) return true;
  const current = timeToMinutes(getCurrentTime(timezone));
  const start = timeToMinutes(parseTime(activeHours.start));
  const end = timeToMinutes(parseTime(activeHours.end));
  if (start <= end) {
    return current >= start && current < end;
  }
  // Midnight-spanning: e.g. 22:00-06:00
  return current >= start || current < end;
}
