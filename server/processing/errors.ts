/** Safe errors consumed by the job worker; provider response bodies are never exposed. */
export class ProcessingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}
