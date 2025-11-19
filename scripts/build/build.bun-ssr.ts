import { bunSsrRoutesConfig } from '@/bun-ssr-route-config';
import { SSR_PROD_BUNDLE_DIR_PATH, ssrBundle } from '@/bun-ssr/bundling';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const start = performance.now();

const outdir = SSR_PROD_BUNDLE_DIR_PATH;

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const bundleDirPath = await ssrBundle({
  routes: bunSsrRoutesConfig,
  bundleDistContainerDir: 'project-root',
  minify: true,
  sourcemap: 'external',
  compress: true,
  splitting: true,
});

const end = performance.now();
console.log('SSR bundles built successfully at', bundleDirPath);
console.log('Time taken:', (end - start).toFixed(2), 'ms');
