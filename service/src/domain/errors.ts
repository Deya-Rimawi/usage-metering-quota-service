/** An expected failure with an HTTP-meaningful shape. The http layer maps it to `{error:{code,message,details}}`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Missing or invalid API key') => new AppError(401, 'unauthorized', msg);
export const forbidden = (code: string, msg: string) => new AppError(403, code, msg);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const invalid = (code: string, msg: string) => new AppError(422, code, msg);
