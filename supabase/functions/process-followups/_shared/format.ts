// Shared number-formatting helpers used across Edge Functions.

export function formatCompactNumber(n: number | null): string {
  if (n === null) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

export function formatPrice(n: number): string {
  if (n === 0) return "0";
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(2);
}

export function formatPercent(n: number | null): string {
  if (n === null) return "n/a";
  const arrow = n >= 0 ? "🔺" : "🔻";
  return `${arrow} ${n.toFixed(1)}%`;
}
