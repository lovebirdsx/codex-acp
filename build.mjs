import { build } from 'esbuild';
import { writeFile } from 'fs/promises';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['@openai/codex'],
  // Polyfill `require` for CJS modules bundled into ESM output
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

// Mark dist/ as ESM so Node treats the bundle as a module when packaged beside
// app.asar (staging copies only dist/, not the vendor-root package.json).
await writeFile('dist/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
