import { readdirSync, statSync, writeFileSync } from 'fs';
import os from 'node:os';
import pLimit from 'p-limit';
import { resolve } from 'path';
import { compressWithWorker } from './compression/compress-with-worker';

if (import.meta.main) {
  let distDir = process.argv[2];
  if (!distDir) {
    console.error(
      'Please provide a dist directory: bun run compress.ts <distDir>'
    );
    process.exit(1);
  }
  distDir = resolve(process.cwd(), distDir);
  await compressFilesInDir(distDir);
}

export async function compressFilesInDir(distDir: string) {
  const cpuCores = os.cpus().length;
  const limit = pLimit(cpuCores);

  console.log('Compressing files in directory', distDir, '...');
  const start = performance.now();

  const stat = await statSync(distDir);
  if (!stat.isDirectory()) {
    console.error(
      'Please provide a valid dist directory. Not a directory: ' + distDir
    );
    process.exit(1);
  }
  const files = readdirSync(distDir, { recursive: true });

  // Resolve worker paths - Bun Workers accept file paths
  const gzipWorkerUrl = import.meta.resolve('./compression/gzip-worker.ts');
  const zstdWorkerUrl = import.meta.resolve('./compression/zstd-worker.ts');
  const brotliWorkerUrl = import.meta.resolve('./compression/brotli-worker.ts');

  // Extract pathname from file:// URL or use as-is if already a path
  const gzipWorkerPath = new URL(gzipWorkerUrl).pathname;
  const zstdWorkerPath = new URL(zstdWorkerUrl).pathname;
  const brotliWorkerPath = new URL(brotliWorkerUrl).pathname;

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        if (typeof file !== 'string') return;

        const filePath = resolve(distDir, file);

        // Only compress JS, CSS, HTML, JSON, SVG, ICO
        if (/\.(js|css|html|json|svg|ico)$/.test(file)) {
          const originalSize = Bun.file(filePath).size;

          await Promise.all([
            (async () => {
              const gzipCompressed = await compressWithWorker(
                gzipWorkerPath,
                filePath
              );
              if (gzipCompressed.length < originalSize) {
                writeFileSync(filePath + '.gz', gzipCompressed);
                console.log(
                  `${file}: ✅ Gzip compressed (${(
                    (gzipCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}% of original size)`
                );
              } else {
                console.log(
                  `${file}: ⚠️ Skipped gzip (compressed size >= original, ${(
                    (gzipCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}%)`
                );
              }
            })(),
            (async () => {
              const zstdCompressed = await compressWithWorker(
                zstdWorkerPath,
                filePath
              );
              if (zstdCompressed.length < originalSize) {
                writeFileSync(filePath + '.zst', zstdCompressed);
                console.log(
                  `${file}: ✅ Zstd compressed (${(
                    (zstdCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}% of original size)`
                );
              } else {
                console.log(
                  `${file}: ⚠️ Skipped zstd (compressed size >= original, ${(
                    (zstdCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}%)`
                );
              }
            })(),
            (async () => {
              const brotliCompressed = await compressWithWorker(
                brotliWorkerPath,
                filePath
              );
              if (brotliCompressed.length < originalSize) {
                writeFileSync(filePath + '.br', brotliCompressed);
                console.log(
                  `${file}: ✅ Brotli compressed (${(
                    (brotliCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}% of original size)`
                );
              } else {
                console.log(
                  `${file}: ⚠️ Skipped brotli (compressed size >= original, ${(
                    (brotliCompressed.length / originalSize) *
                    100
                  ).toFixed(1)}%)`
                );
              }
            })(),
          ]);
        }
      })
    )
  );

  const end = performance.now();
  console.log(`✅ Compressed files in ${((end - start) / 1000).toFixed(2)}s`);
}
