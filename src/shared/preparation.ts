/** Shares an in-flight preparation and reuses successful work until invalidated. */
export class Preparation<T> {
  private cached?: Promise<T>;
  private running = false;
  get(prepare: () => Promise<T>, force = false): Promise<T> {
    if (this.cached && (this.running || !force)) return this.cached;
    this.running = true;
    const pending = Promise.resolve().then(prepare).catch(error => {
      if (this.cached === pending) this.cached = undefined;
      throw error;
    }).finally(() => { if (this.cached === pending || !this.cached) this.running = false; });
    this.cached = pending;
    return pending;
  }
  async invalidate(): Promise<void> {
    await this.cached?.catch(() => undefined);
    this.cached = undefined;
    this.running = false;
  }
}
