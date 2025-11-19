#!/usr/bin/env bun
import { build } from 'bun';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { formatFileSize } from './build-utils';

console.log('\n🚀 Starting build process for single file executable...\n');

const start = performance.now();

const outfile = 'server';

if (existsSync(outfile)) {
  console.log(`🗑️ Cleaning previous build at ${outfile}`);
  await rm(outfile, { force: true });
}

const result = await build({
  entrypoints: ['src/index.tsx'],

  compile: {
    outfile,
    // target: 'bun-darwin-arm64',
    target: 'bun-linux-x64',
    // target: 'bun-linux-arm64',
  },

  minify: true,
  sourcemap: true,

  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});

// Print the results
const end = performance.now();

const outputTable = result.outputs.map((output) => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}));

console.table(outputTable);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);

console.log(`\n🚀 Build output: ${outfile}\n`);
