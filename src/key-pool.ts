import { createHash } from "node:crypto";

export type PoolState = "ready" | "cooldown" | "disabled";

export interface PoolEntry<T> {
  readonly id: string;
  readonly value: T;
  state: PoolState;
  availableAt: number;
}

export function parseKeys(contents: string): string[] {
  return [
    ...new Set(
      contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    ),
  ];
}

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export class KeyPool<T> {
  readonly entries: PoolEntry<T>[];
  private cursor = 0;

  constructor(values: Array<{ id: string; value: T }>, private readonly now = Date.now) {
    if (values.length === 0) {
      throw new Error("At least one Tavily API key is required");
    }

    this.entries = values.map(({ id, value }) => ({
      id,
      value,
      state: "ready",
      availableAt: 0,
    }));
  }

  add(values: Array<{ id: string; value: T }>): number {
    const existing = new Set(this.entries.map((entry) => entry.id));
    let added = 0;
    for (const { id, value } of values) {
      if (existing.has(id)) {
        continue;
      }
      existing.add(id);
      this.entries.push({ id, value, state: "ready", availableAt: 0 });
      added += 1;
    }
    return added;
  }

  next(excluded: ReadonlySet<string> = new Set()): PoolEntry<T> | undefined {
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.cursor + offset) % this.entries.length;
      const entry = this.entries[index];
      if (!entry || excluded.has(entry.id) || !this.isReady(entry)) {
        continue;
      }

      this.cursor = (index + 1) % this.entries.length;
      return entry;
    }

    return undefined;
  }

  markReady(entry: PoolEntry<T>): void {
    if (entry.state === "disabled") {
      return;
    }
    entry.state = "ready";
    entry.availableAt = 0;
  }

  markCooldown(entry: PoolEntry<T>, durationMs: number): void {
    if (entry.state === "disabled") {
      return;
    }
    entry.state = "cooldown";
    entry.availableAt = Math.max(entry.availableAt, this.now() + Math.max(0, durationMs));
  }

  markDisabled(entry: PoolEntry<T>): void {
    entry.state = "disabled";
    entry.availableAt = Number.POSITIVE_INFINITY;
  }

  retryAfterMs(): number | undefined {
    const currentTime = this.now();
    const waits = this.entries
      .filter((entry) => entry.state === "cooldown")
      .map((entry) => Math.max(0, entry.availableAt - currentTime));

    return waits.length > 0 ? Math.min(...waits) : undefined;
  }

  private isReady(entry: PoolEntry<T>): boolean {
    if (entry.state === "cooldown" && entry.availableAt <= this.now()) {
      this.markReady(entry);
    }

    return entry.state === "ready";
  }
}
