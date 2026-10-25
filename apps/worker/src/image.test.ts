import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('worker image (FND-06)', () => {
  const dockerfile = read('../../../infra/docker/worker.Dockerfile');
  const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> };

  it('installs the same playwright-core the code is tested with', () => {
    const arg = /ARG PLAYWRIGHT_VERSION=(\S+)/.exec(dockerfile)?.[1];
    expect(arg).toBe(pkg.dependencies['playwright-core']);
  });

  it('ships the bundled fonts, the files volume and keeps playwright-core out of the bundle', () => {
    expect(dockerfile).toContain('packages/print/fonts');
    expect(dockerfile).toContain('HMIS_FONT_DIR=/app/fonts');
    expect(dockerfile).toContain('HMIS_FILES_DIR=/data/files');
    expect(read('../build.mjs')).toContain("'playwright-core'");
  });
});
