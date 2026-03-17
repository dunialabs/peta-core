export class SingleflightRegistry {
  private inflight = new Map<string, { promise: Promise<unknown>; observerCount: number }>();

  async execute<T>(
    key: string,
    factory: () => Promise<T>,
  ): Promise<{ result: T; isLeader: boolean }> {
    const existing = this.inflight.get(key);
    if (existing) {
      existing.observerCount += 1;
      const result = (await existing.promise) as T;
      return { result, isLeader: false };
    }

    const promise = (async () => factory())();
    this.inflight.set(key, { promise, observerCount: 0 });

    try {
      const result = await promise;
      return { result, isLeader: true };
    } finally {
      const current = this.inflight.get(key);
      if (current?.promise === promise) {
        this.inflight.delete(key);
      }
    }
  }

  recordObserver(key: string): void {
    const existing = this.inflight.get(key);
    if (!existing) {
      return;
    }

    existing.observerCount += 1;
  }

  getObserverCount(key: string): number {
    return this.inflight.get(key)?.observerCount ?? 0;
  }
}
