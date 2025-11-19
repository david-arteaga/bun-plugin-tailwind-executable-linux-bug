import { Environment } from '../environment';
import tailwindPlugin from 'bun-plugin-tailwind';
import path, { join } from 'path';
import type React from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { z } from 'zod';
import { fixDuplicateExportsInDirectory } from '../../scripts/build/fix-js-duplicate-exports';
import { bunStatic } from './bun-static';
import { compressFilesInDir } from './compress-files-in-dir';
import { tryCompress } from './try-compress-response';

type BundleJsByPagePathMap = Map<
  string,
  {
    urlPath: string;
    filePath: string;
    kind: 'entrypoint' | 'chunk';
  }[]
>;

// Store bundle outputs
interface BundleOutputs {
  /**
   * This maps an HTTP path to the corresponding bundled javascript entrypoint file
   */
  jsByPagePath: BundleJsByPagePathMap;
  cssByPagePath: Map<
    string,
    {
      urlPath: string;
      filePath: string;
    }[]
  >;
}

export type SsrRootProps = {
  cssFiles?: string[];
  jsFiles?: string[];
};

export type SsrBundle = Awaited<ReturnType<typeof generateSsrBundleHandlers>>;

const SSR_MANIFEST_FILENAME = 'manifest.bun-ssr.json';
const SSR_MANIFEST_VERSION = 1;

const ssrBundleManifestRouteSchema = z.object({
  path: z.string(),
  // serverEntryPoint: z.string(),
  assets: z.object({
    js: z.array(z.string()),
    css: z.array(z.string()),
  }),
});

const ssrBundleManifestSchema = z.object({
  version: z.literal(SSR_MANIFEST_VERSION),
  publicAssetPath: z.string(),
  routes: z.array(ssrBundleManifestRouteSchema),
});

type SsrBundleManifestRoute = z.infer<typeof ssrBundleManifestRouteSchema>;
type SsrBundleManifest = z.infer<typeof ssrBundleManifestSchema>;

export type BuiltSsrBundle = Awaited<ReturnType<typeof ssrBundle>>;

export type BunSsrRouteConfig = {
  path: string;
  // modulePath: string;
  SsrComponent: React.ElementType<SsrRootProps>;
  hydrateModulePath: string;
};

export const SSR_PROD_BUNDLE_DIR_PATH = 'dist-ssr';

export async function ssrBundle({
  routes,

  // using dir in node_modules so bun doesn't hot reload in a loop in dev
  bundleDistContainerDir = Environment.isDev()
    ? 'node_modules'
    : 'project-root',

  minify = !Environment.isDev(),
  sourcemap = Environment.isDev() ? 'linked' : 'external',
  compress = !Environment.isDev(),
  splitting = true,
}: {
  /**
   * The routes to bundle
   */
  routes: BunSsrRouteConfig[];

  /**
   * The directory in which to store the bundle
   */
  bundleDistContainerDir?: 'node_modules' | 'project-root';

  /**
   * Whether to minify the bundle
   */
  minify?: boolean;

  /**
   * Whether to generate source maps
   */
  sourcemap?: 'linked' | 'external' | false;

  /**
   * Whether to compress the bundle
   */
  compress?: boolean;

  /**
   * Whether to enable code splitting
   */
  splitting?: boolean;
}) {
  if (routes.length === 0) {
    console.warn('No ssr routes to bundle');
    return '';
  }
  /**
   * This is the HTTP path from which bundled assets are expected to be served
   */
  const PUBLIC_ASSET_PATH = '/dist/client/';

  /**
   * This is the dir in which a bundle dir will be created using a hash based on the module and hydration module paths for the pages that are bundled
   */
  const BUNDLE_DIST_CONTAINER_DIR = join(
    process.cwd(),
    {
      node_modules: './node_modules/.dist-ssr',
      'project-root': SSR_PROD_BUNDLE_DIR_PATH,
    }[bundleDistContainerDir] satisfies string
  );

  const bundleDistDir = join(BUNDLE_DIST_CONTAINER_DIR);
  const clientDistDir = join(bundleDistDir, 'client');
  const serverDistDir = join(bundleDistDir, 'server');

  const bundleOutputs: BundleOutputs = {
    jsByPagePath: new Map(),
    cssByPagePath: new Map(),
  };

  /**
   * Bundle the client-side hydration code
   */
  async function bundleClient() {
    console.log('📦 Bundling client code...');
    const start = performance.now();

    // const { default: tailwindPlugin } = await import('bun-plugin-tailwind');

    const result = await Bun.build({
      entrypoints: routes.map((page) => page.hydrateModulePath),
      outdir: clientDistDir,
      target: 'browser',
      format: 'esm',
      splitting,
      minify,
      sourcemap,
      naming: {
        entry: '[name]-[hash].[ext]',
        chunk: '[name]-[hash].[ext]',
        asset: '[name]-[hash].[ext]',
      },
      plugins: [tailwindPlugin],
      publicPath: PUBLIC_ASSET_PATH,
      env: 'BUN_PUBLIC_*',
    });

    if (!result.success) {
      console.error('❌ Client build failed:', result.logs);
      throw new Error('Client bundle failed');
    }

    // Fix duplicate exports in the built files
    console.log('🔧 Fixing duplicate exports in client bundle...');
    await fixDuplicateExportsInDirectory(clientDistDir);

    // Clear previous outputs
    bundleOutputs.jsByPagePath.clear();
    bundleOutputs.cssByPagePath.clear();

    // Process outputs
    for (const output of result.outputs) {
      const basename = path.basename(output.path);
      let relativePath = PUBLIC_ASSET_PATH + basename;

      if (output.kind === 'entry-point') {
        const expectedName = path.parse(path.basename(output.path)).name;
        const basenameWithoutHash = expectedName.replace(`-${output.hash}`, '');
        const pageForBasename = routes.find(
          (page) =>
            path.parse(path.basename(page.hydrateModulePath)).name ===
            basenameWithoutHash
        );
        if (!pageForBasename) {
          throw new Error(`Page for basename ${basenameWithoutHash} not found`);
        }
        bundleOutputs.jsByPagePath.set(pageForBasename.path, [
          {
            urlPath: relativePath,
            filePath: output.path,
            kind: 'entrypoint',
          },
        ]);
      }

      // For css outputs, map them to the corresponding page path for later hydration
      if (output.path.endsWith('.css')) {
        // copy css file to another file name which is just `<hash>.css` file name
        // this is just so duplicate css files are not served on different paths if it's the same content
        // this is because Bun's bundler bundles all the css for a given entrypoint into a single file, and doesn't do "code splitting" like it does for js, but for css
        // so since we only have a single index.css + globals.css files, the resulting bundled css files are expected to be the same
        // and this is just a quick way to avoid serving the same content twice
        const hash = output.hash;
        const newFilename = `${hash}.css`;
        relativePath = PUBLIC_ASSET_PATH + newFilename;
        const newFilePath = join(clientDistDir, newFilename);
        await Bun.write(newFilePath, output);

        // Try to associate the css file with a page based on naming convention
        const expectedName = path.parse(path.basename(output.path)).name;
        const basenameWithoutHash = expectedName.replace(`-${output.hash}`, '');
        const pageForBasename = routes.find(
          (page) =>
            path.parse(path.basename(page.hydrateModulePath)).name ===
            basenameWithoutHash
        );
        if (pageForBasename) {
          // Either initialize or append to the array
          const arr =
            bundleOutputs.cssByPagePath.get(pageForBasename.path) ?? [];
          arr.push({
            urlPath: relativePath,
            filePath: output.path,
          });
          bundleOutputs.cssByPagePath.set(pageForBasename.path, arr);
        }
      }

      let contentType = output.type;
      if (output.path.endsWith('.css')) {
        contentType = 'text/css;charset=utf-8';
      }
    }

    // Resolve JavaScript dependencies for code splitting
    await resolveJsDependencies({
      clientDistDir,
      publicAssetPath: PUBLIC_ASSET_PATH,
      jsByPagePath: bundleOutputs.jsByPagePath,
    });

    const availableCssFiles = result.outputs.filter((it) =>
      it.path.endsWith('.css')
    );
    if (availableCssFiles.length === 1) {
      console.log(
        '🔍 Only one CSS file available. Adding it to all pages without any CSS files...'
      );
      const cssFile = availableCssFiles[0]!;
      routes.forEach((page) => {
        const cssFilesForPage = bundleOutputs.cssByPagePath.get(page.path);
        if (cssFilesForPage && cssFilesForPage.length > 0) return;
        const urlPath = PUBLIC_ASSET_PATH + `${cssFile.hash}.css`; // using only the hash because above we copy all css files to a filename with the hash only
        const filePath = cssFile.path;
        console.log(
          `🔍 Adding CSS file ${urlPath} -> ${filePath} to page ${page.path} because it has no CSS files...`
        );
        bundleOutputs.cssByPagePath.set(page.path, [
          {
            urlPath,
            filePath,
          },
        ]);
      });
    }

    const end = performance.now();
    console.log(`✅ Client bundle completed in ${(end - start).toFixed(2)}ms`);
  }

  /**
   * Bundle the server-side rendering code
   */
  // async function bundleServer() {
  //   console.log('📦 Bundling server code...');
  //   const start = performance.now();

  //   const result = await Bun.build({
  //     entrypoints: routes.map((page) => page.modulePath),
  //     outdir: serverDistDir,

  //     // compile: {
  //     //   outfile: serverBundleOutfile,
  //     // },

  //     target: 'bun',
  //     format: 'esm',
  //     // external: ['*'], // everything that is not a relative path (so everything in node_modules) should be external
  //     splitting: false,
  //     packages: 'external',

  //     plugins: [tailwindPlugin],
  //     publicPath: PUBLIC_ASSET_PATH,
  //   });

  //   if (!result.success) {
  //     console.error('❌ Server build failed:', result.logs);
  //     throw new Error('Server bundle failed');
  //   }

  //   const end = performance.now();
  //   console.log(`✅ Server bundle completed in ${(end - start).toFixed(2)}ms`);
  // }

  const allStart = performance.now();
  // Bundle both client and server
  // await Promise.all([bundleClient(), bundleServer()]);
  await Promise.all([bundleClient()]);
  const allEnd = performance.now();
  console.log(
    `✅ All bundles for ${routes
      .map((page) => page.path)
      .join(', ')} completed in ${(allEnd - allStart).toFixed(2)}ms`
  );

  const serverBundleOutfileByPath = new Map<string, string>();
  // for (const page of routes) {
  //   const expectedOutputFilename = path.parse(page.modulePath).name;
  //   const serverEntrypointFilePath = join(
  //     serverDistDir,
  //     `${expectedOutputFilename}.js`
  //   );
  //   if (!(await Bun.file(serverEntrypointFilePath).exists())) {
  //     throw new Error(
  //       `Server SSR entrypoint file for path ${page.path} not found at ${serverEntrypointFilePath}`
  //     );
  //   }
  //   serverBundleOutfileByPath.set(page.path, serverEntrypointFilePath);
  // }

  if (compress) {
    await compressFilesInDir(clientDistDir);
  }

  const manifest: SsrBundleManifest = {
    version: SSR_MANIFEST_VERSION,
    publicAssetPath: PUBLIC_ASSET_PATH,
    routes: routes.map((page) => {
      // const serverEntryPoint = serverBundleOutfileByPath.get(page.path);
      // if (!serverEntryPoint) {
      //   throw new Error(
      //     `Server bundle outfile for path ${page.path} not found`
      //   );
      // }

      const pageJsPaths = bundleOutputs.jsByPagePath.get(page.path);
      if (!pageJsPaths) {
        throw new Error(`Entrypoint path for path ${page.path} not found`);
      }

      const pageCssPaths = bundleOutputs.cssByPagePath.get(page.path);
      if (!pageCssPaths) {
        throw new Error(`CSS paths for path ${page.path} not found`);
      }

      return {
        path: page.path,
        // serverEntryPoint: path.relative(bundleDistDir, serverEntryPoint),
        assets: {
          js: pageJsPaths.map((jsPath) => jsPath.urlPath),
          css: pageCssPaths.map((cssPath) => cssPath.urlPath),
        },
      } satisfies SsrBundleManifestRoute;
    }),
  };

  const manifestPath = join(bundleDistDir, SSR_MANIFEST_FILENAME);
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  return bundleDistDir;
}

export async function generateSsrBundleHandlers({
  bundleDirPath,

  compressSsrResponse,

  routes,
}: {
  /**
   * This is the dir that includes a manifest.bun-ssr.json file with the necessary data to generate the SSR bundle handlers
   */
  bundleDirPath: string;

  compressSsrResponse?: boolean;

  routes: BunSsrRouteConfig[];
}) {
  if (routes.length === 0) {
    console.warn('No ssr routes to generate handlers for');
    return {
      routeHandlers: {},
    };
  }

  const IS_PRODUCTION = Environment.isProduction();

  const manifestPath = join(bundleDirPath, SSR_MANIFEST_FILENAME);
  const manifestFile = Bun.file(manifestPath);
  const manifestExists = await manifestFile.exists();
  if (!manifestExists) {
    throw new Error(
      `SSR manifest file not found at ${manifestPath}. Did you run the bundle step?`
    );
  }

  const manifestJson = await manifestFile.json();
  const manifest = ssrBundleManifestSchema.parse(manifestJson);

  const clientDistDir = join(bundleDirPath, 'client');

  const getRouteHandler = async (route: SsrBundleManifestRoute) => {
    // const serverBundleOutfile = join(bundleDirPath, route.serverEntryPoint);
    // const importPath = !IS_PRODUCTION
    //   ? `${serverBundleOutfile}?t=${Date.now()}`
    //   : serverBundleOutfile;
    // const { SSR }: { SSR: React.ComponentType<SsrRootProps> } = await import(
    //   importPath
    // );
    const SsrComponent = routes.find(
      (it) => it.path === route.path
    )?.SsrComponent;

    if (!SsrComponent) {
      throw new Error(
        `SSR export in module for path ${route.path} was not found`
      );
    }
    if (typeof SsrComponent !== 'function') {
      throw new Error(
        `SSR export in module for path ${route.path} was not a function`
      );
    }

    const compressFn = compressSsrResponse
      ? tryCompress
      : (req: Request, res: Response) => res;

    return async function (req: Request): Promise<Response> {
      console.log('[SSR] Request for route', route.path);
      try {
        const html = await renderToReadableStream(
          <SsrComponent cssFiles={route.assets.css} jsFiles={route.assets.js} />
        );

        const response = new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });

        return compressFn(req, response);
      } catch (error) {
        console.error('❌ SSR render error:', error);

        if (!IS_PRODUCTION) {
          // Return a rendered error in plain HTML, showing the error message
          // This should be safe for dev only; do not leak stack in production
          let errorHtml =
            '<!DOCTYPE html><html><body><h1>Server-side rendering error</h1>';
          errorHtml += `<p>${
            error instanceof Error ? error.message : String(error)
          }</p>`;
          if (error instanceof Error && error.stack) {
            errorHtml += `<pre>${error.stack}</pre>`;
          }
          errorHtml += '</body></html>';
          return new Response(errorHtml, {
            status: 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        return new Response(
          '<!DOCTYPE html><html><body><h1>It looks like something went wrong :(</h1></body></html>',
          {
            status: 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }
        );
      }
    };
  };

  const ssrRouteHandlers = Object.fromEntries(
    await Promise.all(
      manifest.routes.map(async (route) => [
        route.path,
        await getRouteHandler(route),
      ])
    )
  );

  const staticAssetHandlers = await bunStatic(
    manifest.publicAssetPath,
    clientDistDir
  );

  return {
    routeHandlers: {
      ...ssrRouteHandlers,
      ...staticAssetHandlers,
    },
  };
}

/**
 * Resolves JavaScript dependencies for code-split chunks.
 * Reads bundled files to find which chunks are referenced by entrypoints,
 * then recursively adds all dependencies to jsByPagePath.
 */
export async function resolveJsDependencies({
  clientDistDir,
  publicAssetPath,
  jsByPagePath,
}: {
  clientDistDir: string;
  publicAssetPath: string;
  jsByPagePath: BundleJsByPagePathMap;
}) {
  console.log(
    '🔍 Resolving JavaScript dependencies using files in',
    clientDistDir,
    'for assets',
    Array.from(jsByPagePath.keys())
  );

  // Step 1: Get all JS files in the client dist directory
  const glob = new Bun.Glob('**/*.js');
  const clientJsDistFiles = await Array.fromAsync(
    glob.scan({ cwd: clientDistDir })
  );

  // Create a map of basename to full file path
  const jsFilesByBasename = new Map<string, string>();
  for (const file of clientJsDistFiles) {
    const basename = path.basename(file);
    const fullPath = path.join(clientDistDir, file);
    jsFilesByBasename.set(basename, fullPath);
  }

  // Step 2: Build reference map - which files reference which other files
  const referenceMap = new Map<string, Set<string>>();

  const fileContentByBasename = new Map<string, string>(
    await Promise.all(
      Array.from(jsFilesByBasename.entries()).map(
        async ([basename, filePath]) =>
          [basename, await Bun.file(filePath).text()] as const
      )
    )
  );
  for (const [basename, content] of fileContentByBasename) {
    const references = new Set<string>();

    // Search for references like "/dist/client/filename-hash.js"
    for (const [otherBasename] of jsFilesByBasename) {
      if (otherBasename !== basename) {
        const searchPattern = path.join(publicAssetPath, otherBasename);
        // console.log(`🔍 Searching for ${searchPattern} in ${basename}`);
        const referencesFile = content.includes(searchPattern);
        const dynamicallyImportsFile =
          content.includes(`import('${searchPattern}')`) ||
          content.includes(`import("${searchPattern}")`);
        if (referencesFile && !dynamicallyImportsFile) {
          references.add(otherBasename);
        }
      }
    }

    referenceMap.set(basename, references);
  }

  // Step 3: For each entrypoint, recursively collect all dependencies
  for (const [pagePath, jsFiles] of jsByPagePath) {
    const allDeps = new Set<string>();

    // Recursive function to collect dependencies
    function collectDeps(basename: string) {
      const refs = referenceMap.get(basename);
      if (!refs) {
        return;
      }

      for (const ref of refs) {
        if (!allDeps.has(ref)) {
          allDeps.add(ref);
          collectDeps(ref); // Recurse to find transitive dependencies
        }
      }
    }

    // Start from the entrypoint
    const entrypoint = jsFiles.find((f) => f.kind === 'entrypoint');
    if (!entrypoint) {
      console.warn(`No entrypoint found for page ${pagePath}`);
      continue;
    }

    const entrypointBasename = path.basename(entrypoint.urlPath);
    collectDeps(entrypointBasename);

    // Add all dependencies to the jsByPagePath array
    for (const depBasename of allDeps) {
      const depUrlPath = publicAssetPath + depBasename;
      const depFilePath = jsFilesByBasename.get(depBasename);

      if (depFilePath) {
        // Check if it's not already in the array (de-duplicate)
        if (!jsFiles.some((f) => f.urlPath === depUrlPath)) {
          jsFiles.push({
            urlPath: depUrlPath,
            filePath: depFilePath,
            kind: 'chunk',
          });
        }
      }
    }
  }

  return jsByPagePath;
}
