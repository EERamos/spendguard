/** Error returned by (or while talking to) the Reap API. `code` is Reap's `error.code` when present. */
export class ReapApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReapApiError';
  }

  static fromResponse(status: number, body: unknown): ReapApiError {
    const err = (body as { error?: { code?: string; message?: string; detail?: unknown } } | undefined)?.error;
    return new ReapApiError(status, err?.code ?? `HTTP_${status}`, err?.message ?? 'Reap request failed', err?.detail);
  }
}
