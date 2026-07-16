function normalizedPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function remainingPercent(usedPercent) {
  const used = normalizedPercent(usedPercent);
  return used === null ? null : 100 - used;
}

export function remainingUsageColor(percentRemaining) {
  const remaining = normalizedPercent(percentRemaining);
  if (remaining === null) return '#3a3f4b';
  if (remaining <= 15) return '#e74c3c';
  if (remaining <= 40) return '#f7c744';
  return '#27ae60';
}

export function remainingUsageSweep(percentRemaining) {
  const remaining = normalizedPercent(percentRemaining);
  return remaining === null ? 0 : Math.round(3.6 * remaining);
}
