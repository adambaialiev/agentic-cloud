interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Small process-local abuse brake for login and enrollment endpoints. */
export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(windowMs, 60_000));
    this.cleanupTimer.unref();
  }

  check(key: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(now: number = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}
