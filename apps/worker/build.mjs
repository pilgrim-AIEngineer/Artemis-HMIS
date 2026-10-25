// Bundles the worker (and workspace packages) into dist/ so the image needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', migrate: '../../packages/db/src/migrate-cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // pg's optional native binding is never used.
  external: ['pg-native'],
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __hmisCreateRequire } from 'node:module'; const require = __hmisCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
