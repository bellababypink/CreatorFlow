export class HttpError extends Error {
    constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}
export function safeError(error: unknown): string {
    if (error instanceof HttpError)
        return error.message;
    return 'The operation could not be completed. Please try again.';
}
