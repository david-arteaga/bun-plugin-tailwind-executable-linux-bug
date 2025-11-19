import { serve } from 'bun';
import index from './index.html';
import { renderToReadableStream } from 'react-dom/server';
import { SSR } from './ssr';

// this import causes the bug
import bunPluginTailwind from 'bun-plugin-tailwind';

const RUN_SSR_BUILD = false;

if (RUN_SSR_BUILD) {
  // you can see a full setup in the full-ssr-repro branch
  await Bun.build({
    entrypoints: ['src/ssr.hydrate.tsx'],
    outdir: 'dist-ssr',
    plugins: [bunPluginTailwind],
    target: 'browser',
    sourcemap: 'linked',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  });
}

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    '/*': index,

    '/ssr': async (req) => {
      const stream = await renderToReadableStream(<SSR />);
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/html',
        },
      });
    },

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
