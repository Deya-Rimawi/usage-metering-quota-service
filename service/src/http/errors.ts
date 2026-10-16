import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../domain/errors';

/** One error shape for every failure: `{ error: { code, message, details? } }`. */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(422).send({
        error: { code: 'validation_error', message: 'Request validation failed', details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) },
      });
    }
    // Safety net: Postgres class 22 = invalid data the schemas did not catch (bad cast, out of range, NUL).
    if (typeof err.code === 'string' && err.code.startsWith('22')) {
      req.log.warn({ pgCode: err.code }, 'rejected invalid input');
      return reply.code(422).send({ error: { code: 'invalid_input', message: 'A value in the request is not valid' } });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests; slow down' } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }));
}
