import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { MeterError } from './errors.js';
import { registerRoutes } from './http/routes.js';

export interface BuildAppOptions {
  pool: Pool;
}

export async function buildApp({ pool }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Every MeterError maps to a stable { code, message, details } envelope.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof MeterError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    // Fastify schema/body parse errors, etc.
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return reply.code(error.statusCode).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
        },
      });
    }
    app.log.error(error);
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'internal error' },
    });
  });

  await registerRoutes(app, { pool });

  return app;
}
