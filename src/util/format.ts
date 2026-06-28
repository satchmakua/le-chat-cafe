/** Render a timestamp as a retro `[HH:MM]` (24h, zero-padded, local time). */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}]`;
}
