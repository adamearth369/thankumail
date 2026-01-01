import { z } from 'zod';
import { insertGiftSchema, gifts } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
  alreadyClaimed: z.object({
    message: z.string(),
  }),
};

export const api = {
  gifts: {
    create: {
      method: 'POST' as const,
      path: '/api/gifts',
      input: insertGiftSchema,
      responses: {
        201: z.custom<typeof gifts.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/gifts/:publicId',
      responses: {
        200: z.custom<typeof gifts.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    claim: {
      method: 'POST' as const,
      path: '/api/gifts/:publicId/claim',
      responses: {
        200: z.custom<typeof gifts.$inferSelect>(),
        404: errorSchemas.notFound,
        400: errorSchemas.alreadyClaimed,
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
