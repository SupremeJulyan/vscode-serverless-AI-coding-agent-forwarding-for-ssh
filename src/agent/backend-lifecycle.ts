/** Coordinates one workspace-bound Agent backend while leaving its transport and callbacks separate. */
export class BackendLifecycle<T extends { stop(): Promise<void> }> {
  private current?: { mountName: string; server: T };
  private pending?: Promise<T>;

  async ensure(mountName: string, create: () => Promise<T>): Promise<T> {
    if (this.pending) await this.pending.catch(() => undefined);
    if (this.current?.mountName === mountName) return this.current.server;
    if (this.current) await this.stop();
    const pending = create();
    this.pending = pending;
    try {
      const server = await pending;
      this.current = { mountName, server };
      return server;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async stop(): Promise<void> {
    await this.pending?.catch(() => undefined);
    const current = this.current;
    this.current = undefined;
    if (current) await current.server.stop();
  }

  get server(): T | undefined { return this.current?.server; }
  get mountName(): string | undefined { return this.current?.mountName; }
}
