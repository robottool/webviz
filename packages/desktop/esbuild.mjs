// Bundle the Electron main + the hub (+ ws + @webviz/* ) into one CommonJS file.
// Bundling sidesteps pnpm-workspace node_modules resolution inside the packaged
// app: only `electron` stays external (provided by the runtime), and ws's
// optional native speedups are left external so ws falls back to pure JS.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'build/main.cjs',
  // `electron` is resolved from the Electron runtime, not bundled. ws's optional
  // C++ addons aren't installed; keeping them external lets ws try/catch-require
  // and degrade to its JS implementation at runtime.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
