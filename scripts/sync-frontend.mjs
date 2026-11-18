import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

// Keep Tauri's embedded frontend tree small and deterministic. In particular,
// never point frontendDist at the repository root: that would make
// generate_context! walk src-tauri/target and hash build artifacts on every
// Rust compile.
rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'src'), { recursive: true });
mkdirSync(resolve(dist, 'src', 'assets'), { recursive: true });
cpSync(resolve(root, 'index.html'), resolve(dist, 'index.html'));
cpSync(resolve(root, 'src', 'favicon.svg'), resolve(dist, 'src', 'favicon.svg'));
cpSync(resolve(root, 'src', 'assets', 'db-studio-icon.png'), resolve(dist, 'src', 'assets', 'db-studio-icon.png'));
for (const stylesheet of readdirSync(resolve(root, 'src')).filter(name => name.endsWith('.css')).sort()) {
  cpSync(resolve(root, 'src', stylesheet), resolve(dist, 'src', stylesheet));
}

await build({
  entryPoints: [resolve(root, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // Preserve dynamic imports so the XLSX runtime is loaded only when needed.
  // All chunks remain local assets embedded by Tauri's frontendDist.
  outdir: resolve(dist, 'src'),
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
});
