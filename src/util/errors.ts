/** Error with a stable machine-readable code and an HTTP status the API layer can map. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
