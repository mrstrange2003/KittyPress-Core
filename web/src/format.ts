export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 0.05) return "under 0.1s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** Whole percents, except just below 100, which stays 99.9 so a few leftover bytes aren't called 100%. */
export function formatPercent(pct: number, packed = 0): string {
  const abs = Math.abs(pct);
  // 99.5 and up would round to "100" with no decimals, which overstates a file that still has bytes left.
  if (packed > 0 && abs >= 99.5 && abs < 100) return (Math.floor(abs * 10) / 10).toFixed(1);
  if (abs >= 10) return abs.toFixed(0);
  return abs.toFixed(1);
}

/** Share of the original that was removed, as a percent. Negative means the result grew. */
export function percentSmaller(original: number, packed: number): number {
  if (original <= 0) return 0;
  return (100 * (original - packed)) / original;
}

export function savedLabel(original: number, packed: number, method: number): string {
  if (method === 0) return "stored as-is";
  if (original === 0) return "empty";
  const pct = percentSmaller(original, packed);
  const shown = formatPercent(pct, packed);
  if (pct >= 0) return `${shown}% smaller`;
  return `${shown}% larger`;
}
