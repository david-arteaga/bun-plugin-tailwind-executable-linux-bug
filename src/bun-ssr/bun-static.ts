import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function bunStatic(
  routePath: string,
  dir: string,
  {
    headers: headersFn,
    strategy = 'ram',
    spaMode = false,
  }: {
    headers?: HeadersInit | ((fileName: string) => HeadersInit);
    strategy?: 'ram' | 'disk';

    /**
     * This will add a "/*" catch-all route that serves the index.html file if an index.html file exists in the directory
     */
    spaMode?: boolean;
  } = {}
) {
  const files = (await recursiveFilesInDir(dir)).map((name) => ({ name }));

  const compressionExtensions = ['gz', 'br', 'zst'] as const;
  // if a file name ends with a compression extension, add the full file name
  const filesGroupedByNameWithoutCompressionExtension: Map<
    string,
    {
      path: string;
      compression?: 'gz' | 'br' | 'zst';
    }[]
  > = new Map();

  for (const file of files) {
    const compressionExtension = compressionExtensions.find((ext) =>
      file.name.endsWith(`.${ext}`)
    );

    const nameWithoutCompression = compressionExtension
      ? file.name.slice(
          0,
          -(compressionExtension.length + 1) // +1 for the dot
        )
      : file.name;
    let existing = filesGroupedByNameWithoutCompressionExtension.get(
      nameWithoutCompression
    );
    if (!existing) {
      existing = [];
      filesGroupedByNameWithoutCompressionExtension.set(
        nameWithoutCompression,
        existing
      );
    }
    existing.push({
      path: join(dir, file.name),
      compression: compressionExtension,
    });
  }

  const groupedFiles = Array.from(
    filesGroupedByNameWithoutCompressionExtension.entries()
  ).map(([name, files]) => ({
    name,
    path: join(dir, name),
    files,
  }));

  const routes = Object.fromEntries(
    await Promise.all(
      groupedFiles.map(async (file) => {
        let route = (routePath + '/' + file.name).replace(/\/\//g, '/');
        if (route === '/index.html') {
          if (spaMode) {
            route = '/*';
          } else {
            route = '/';
          }
        }

        const brotliFile = file.files.find((file) => file.compression === 'br');
        const hasBrotli = !!brotliFile;
        const gzipFile = file.files.find((file) => file.compression === 'gz');
        const hasGzip = !!gzipFile;
        const zstdFile = file.files.find((file) => file.compression === 'zst');
        const hasZstd = !!zstdFile;

        const hasCompressedVariants = file.files.some(
          (file) => file.compression
        );

        const bunFile = Bun.file(file.path);
        const bunFileContentLength = bunFile.size.toString();

        const userHeaders = !headersFn
          ? undefined
          : typeof headersFn === 'function'
          ? headersFn(file.path)
          : headersFn;

        type BunRequestHandler =
          | Response
          | ((req: Request) => Response)
          | ((req: Request) => Promise<Response>);

        let handler: BunRequestHandler;

        const contentType = bunFile.type;

        if (hasCompressedVariants) {
          handler = await (async () => {
            switch (strategy) {
              case 'ram': {
                // pre-load the bytes into RAM

                const brotliBunFile = brotliFile
                  ? Bun.file(brotliFile.path)
                  : undefined;
                const brotliFileBytes = brotliFile
                  ? await Bun.file(brotliFile.path).bytes()
                  : undefined;
                const brotliFileContentLength = brotliBunFile
                  ? brotliBunFile.size.toString()
                  : undefined;

                const zstdBunFile = zstdFile
                  ? Bun.file(zstdFile.path)
                  : undefined;
                const zstdFileBytes = zstdFile
                  ? await Bun.file(zstdFile.path).bytes()
                  : undefined;
                const zstdFileContentLength = zstdBunFile
                  ? zstdBunFile.size.toString()
                  : undefined;

                const gzipBunFile = gzipFile
                  ? Bun.file(gzipFile.path)
                  : undefined;
                const gzipFileBytes = gzipFile
                  ? await Bun.file(gzipFile.path).bytes()
                  : undefined;
                const gzipFileContentLength = gzipBunFile
                  ? gzipBunFile.size.toString()
                  : undefined;

                const bunFileBytes = await bunFile.bytes();

                return async (req) => {
                  const acceptEncoding = req.headers.get('accept-encoding');

                  if (hasBrotli && acceptEncoding?.includes('br')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Encoding', 'br');
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Length', brotliFileContentLength!);
                    return new Response(brotliFileBytes, { headers });
                  }
                  if (hasZstd && acceptEncoding?.includes('zstd')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Encoding', 'zstd');
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Length', zstdFileContentLength!);
                    return new Response(zstdFileBytes, { headers });
                  }
                  if (hasGzip && acceptEncoding?.includes('gzip')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Encoding', 'gzip');
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Length', gzipFileContentLength!);
                    return new Response(gzipFileBytes, { headers });
                  }

                  return new Response(bunFileBytes, { headers: userHeaders });
                };
              }
              case 'disk': {
                const brotliBunFile = brotliFile
                  ? Bun.file(brotliFile.path)
                  : undefined;
                const brotliSize = brotliBunFile?.size.toString();

                const zstdBunFile = zstdFile
                  ? Bun.file(zstdFile.path)
                  : undefined;
                const zstdSize = zstdBunFile?.size.toString();

                const gzipBunFile = gzipFile
                  ? Bun.file(gzipFile.path)
                  : undefined;
                const gzipSize = gzipBunFile?.size.toString();

                return (req) => {
                  const acceptEncoding = req.headers.get('accept-encoding');

                  console.log('request for file', req.url, {
                    acceptEncoding,
                    hasBrotli,
                    hasZstd,
                    hasGzip,
                  });

                  if (hasBrotli && acceptEncoding?.includes('br')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Encoding', 'br');
                    headers.set('Content-Length', brotliSize!);
                    return new Response(brotliBunFile, { headers });
                  }
                  if (hasZstd && acceptEncoding?.includes('zstd')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Encoding', 'zstd');
                    headers.set('Content-Length', zstdSize!);
                    return new Response(zstdBunFile, { headers });
                  }
                  if (hasGzip && acceptEncoding?.includes('gzip')) {
                    const headers = new Headers(userHeaders);
                    headers.set('Content-Type', contentType);
                    headers.set('Content-Encoding', 'gzip');
                    headers.set('Content-Length', gzipSize!);
                    return new Response(gzipBunFile, { headers });
                  }

                  const headers = new Headers(userHeaders);
                  headers.set('Content-Type', contentType);
                  headers.set('Content-Length', bunFileContentLength);
                  return new Response(bunFile, { headers });
                };
              }
              default: {
                strategy satisfies never;
                throw new Error(`Invalid strategy: ${strategy}`);
              }
            }
          })();
        } else {
          const headers = new Headers(userHeaders);
          headers.set('Content-Type', contentType);
          headers.set('Content-Length', bunFileContentLength);

          handler = await (async () => {
            switch (strategy) {
              case 'ram': {
                const bytes = await bunFile.bytes();
                return new Response(bytes, { headers });
              }
              case 'disk': {
                return new Response(bunFile, { headers });
              }
              default: {
                strategy satisfies never;
                throw new Error(`Invalid strategy: ${strategy}`);
              }
            }
          })();
        }

        return [route, handler] as const;
      })
    )
  );

  return routes;
}

/**
 * Returns a list of file paths relative to the dir passed in
 */
async function recursiveFilesInDir(dir: string): Promise<string[]> {
  const inThisDir = await readdir(dir, { withFileTypes: true });

  const files = inThisDir.filter((it) => it.isFile());
  const nestedDirs = inThisDir.filter((it) => it.isDirectory());

  const nestedDirsFiles = await Promise.all(
    nestedDirs.map(async ({ name: nestedDir }) => {
      const dirFiles = await recursiveFilesInDir(join(dir, nestedDir));
      return dirFiles.map((dirFile) => join(nestedDir, dirFile));
    })
  );

  return [
    ...files.map((it) => it.name),
    ...nestedDirsFiles.flatMap((it) => it),
  ];
}
