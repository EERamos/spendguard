/**
 * Serializes async critical sections inside a single process.
 *
 * SpendGuard uses it so "read spend, evaluate policy, reserve budget" is atomic:
 * two agents asking in parallel cannot both spend the last dollar of a budget.
 * With more than one server instance, replace it with a database transaction or lock.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
