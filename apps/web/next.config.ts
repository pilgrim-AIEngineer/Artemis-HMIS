import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// docs/01 §9. Pages get the full nonce CSP from src/proxy.ts; this baseline also covers API
// routes and static files.
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=(self)' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@hmis/db', '@hmis/print', '@hmis/shared', '@hmis/ui'],
  serverExternalPackages: ['pg', 'pino', '@node-rs/argon2'],
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: securityHeaders },
      // Later entries win: print pages may be framed by our own pages only (hidden print frame).
      {
        source: '/print/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
          },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ]),
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
