/** Compact elapsed time for run and Goal timers, retaining seconds at every scale. */
export function formatTuiDuration(rawSeconds: number): string {
  const totalSeconds = Number.isFinite(rawSeconds) ? Math.max(0, Math.floor(rawSeconds)) : 0;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}min${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${totalMinutes % 60}min${seconds}s`;
}
