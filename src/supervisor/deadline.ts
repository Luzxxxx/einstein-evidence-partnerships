/** Stable cancellation capability for a deadline whose current native timer may change. */
export type DeadlineTimer = Readonly<{ cancel(): void }>;
export type DeadlineTimerOptions = {
  deadlineAt: number;
  deadlineMonotonicAt: number;
  now: () => number;
  monotonicNow: () => number;
  action: () => void;
};

/**
 * Hard budgets expire on either clock, so OS wall-clock rollback cannot extend
 * physical duration. An early native callback waits only for the remaining
 * budget; it must not restart the original 40/120/180-second delay.
 */
export function deadlineTimer(options: DeadlineTimerOptions): DeadlineTimer {
  let cancelled = false, current: NodeJS.Timeout | undefined;
  const remaining = () => {
    const wall = options.now(), mono = options.monotonicNow();
    if (![wall, mono, options.deadlineAt, options.deadlineMonotonicAt].every(Number.isFinite))
      throw new Error('INVALID_DEADLINE_CLOCK');
    return Math.min(options.deadlineAt - wall, options.deadlineMonotonicAt - mono);
  };
  const schedule = () => {
    current = setTimeout(() => {
      current = undefined;
      if (cancelled) return;
      if (remaining() > 0) { schedule(); return; }
      cancelled = true; options.action();
    }, Math.max(1, Math.ceil(remaining())));
    current.unref();
  };
  schedule();
  return Object.freeze({ cancel() { cancelled = true; clearTimeout(current); current = undefined; } });
}
