import pino from 'pino';

/**
 * Structured JSON logger (docs/01 §8). Never log patient data: log IDs only (AGENTS.md rule 15).
 * Common PHI-bearing keys are redacted as a safety net, not as a licence to log them.
 */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    name,
    level,
    base: { service: name },
    redact: {
      paths: [
        'password',
        'pin',
        '*.password',
        '*.pin',
        'name',
        '*.name',
        'mobile',
        '*.mobile',
        'phone',
        '*.phone',
        'address',
        '*.address',
        'headers.cookie',
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
