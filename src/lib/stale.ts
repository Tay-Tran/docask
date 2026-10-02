export const STALE_AFTER_MS = 2 * 60 * 1000;

/** True when a row has been "processing" for longer than the stale threshold. */
export function isStale(createdAt: string | number | Date, now: number = Date.now()): boolean {
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && now - t > STALE_AFTER_MS;
}
