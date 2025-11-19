import { serve } from 'bun';
import { join } from 'node:path';
import { bunSsrRoutesConfig } from './bun-ssr-route-config';
import {
  generateSsrBundleHandlers,
  SSR_PROD_BUNDLE_DIR_PATH,
} from './bun-ssr/bundling';
import { Environment } from './environment';
import { generateSsrBundle } from './generate-ssr-bundle';
import index from './index.html';

// don't bundle SSR in production since it should already be bundled
const SHOULD_GENERATE_SSR_BUNDLE = !Environment.isProduction();

const ssrBundleHandlers = await loadSsrBundleHandlers();

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    '/*': index,

    ...ssrBundleHandlers.routeHandlers,

    '/api/hello': {
      async GET(req) {
        return Response.json({
          message: 'Hello, world!',
          method: 'GET',
        });
      },
      async PUT(req) {
        return Response.json({
          message: 'Hello, world!',
          method: 'PUT',
        });
      },
    },

    '/api/hello/:name': async (req) => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== 'production' && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);

async function loadSsrBundleHandlers() {
  console.log('Loading SSR bundle handlers...');

  const start = performance.now();

  const bundleDirPath = SHOULD_GENERATE_SSR_BUNDLE
    ? await generateSsrBundle()
    : join(process.cwd(), SSR_PROD_BUNDLE_DIR_PATH);

  console.log('Bundle dir path:', bundleDirPath);

  const ssrBundleHandlers = await generateSsrBundleHandlers({
    bundleDirPath,

    compressSsrResponse: true,

    routes: bunSsrRoutesConfig,
  });

  const end = performance.now();
  console.log(`✅ SSR bundles loaded in ${(end - start).toFixed(2)}ms`);

  if (Environment.isDev()) {
    console.log(
      'SSR bundle route handler paths:',
      Object.keys(ssrBundleHandlers.routeHandlers)
    );
  }

  return ssrBundleHandlers;
}
