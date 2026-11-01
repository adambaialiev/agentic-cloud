/**
 * Instant stored on persisted documents (`createdAt` / `updatedAt`).
 *
 * This replaces the Firestore `Timestamp` the codebase used before the SQLite
 * migration. The seconds/nanoseconds split and every method below keep the
 * exact semantics of that class, because the split is observable: documents
 * already on disk were encoded from it, callers sort on `.seconds`, and
 * `sqlite-db` round-trips values through `toMillis()` / `fromDate()`.
 */
export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;

  constructor(seconds: number, nanoseconds: number = 0) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }

  static fromDate(date: Date): Timestamp {
    return Timestamp.fromMillis(date.getTime());
  }

  static fromMillis(ms: number): Timestamp {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }

  isEqual(other: Timestamp): boolean {
    return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
  }

  /**
   * Documents are persisted as JSON, so a Timestamp that reaches disk without
   * going through `sqlite-db`'s tagged encoding still round-trips its fields.
   */
  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }
}
