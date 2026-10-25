import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// docs/01 §9. A strict script/style CSP (nonces) is added with the auth work; these are safe now.
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
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
  serverExternalPackages: ['pg', 'pino'],
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
