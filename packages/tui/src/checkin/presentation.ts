import {
  SigninDayStatus,
  getCurrentSigninStreak,
  type SigninPanel,
} from '@mavis/shared/daily-signin';
import type { TuiDailyCheckinOutcome } from './application.js';

export function formatTuiDailyCheckinOutcome(outcome: TuiDailyCheckinOutcome): string {
  const progress = formatProgress(outcome.panel);
  if (outcome.status === 'claimed') {
    return `Checked in: Cycle day ${outcome.dayNo}, +${outcome.points} Credits\n${progress}`;
  }
  if (outcome.status === 'already-claimed') {
    return `Already checked in today.\n${progress}`;
  }
  return `Daily check-in is unavailable right now.\n${progress}`;
}

function formatProgress(panel: SigninPanel): string {
  const streak = getCurrentSigninStreak(panel.days);
  const days = [...panel.days]
    .sort((left, right) => left.day_no - right.day_no)
    .map((day) => (day.status === SigninDayStatus.Claimed ? '✓' : '·'))
    .join(' ');
  return [streak > 0 ? `${streak}-day streak this cycle` : undefined, `This cycle: ${days}`]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
