#!/usr/bin/env bun
import { resolveJsDependencies } from '@/bun-ssr/bundling';
import { compressFilesInDir } from '@/bun-ssr/compress-files-in-dir';
import { build } from 'bun';
import bunPluginTailwind from 'bun-plugin-tailwind';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import path from 'path';
import { formatFileSize, parseBunBuildArgs } from './build-utils';
import { fixDuplicateExportsInDirectory } from './fix-js-duplicate-exports';

// Print help text if requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Common Options:
  --outdir <path>          Output directory (default: "dist")
  --minify                 Enable minification (or --minify.whitespace, --minify.syntax, etc)
  --source-map <type>      Sourcemap type: none|linked|inline|external
  --target <target>        Build target: browser|bun|node
  --format <format>        Output format: esm|cjs|iife
  --splitting              Enable code splitting
  --packages <type>        Package handling: bundle|external
  --public-path <path>     Public path for assets
  --env <mode>             Environment handling: inline|disable|prefix*
  --conditions <list>      Package.json export conditions (comma separated)
  --external <list>        External packages (comma separated)
  --banner <text>          Add banner text to output
  --footer <text>          Add footer text to output
  --define <obj>           Define global constants (e.g. --define.VERSION=1.0.0)
  --help, -h               Show this help message

Example:
  bun run build.ts --outdir=dist --minify --source-map=linked --external=react,react-dom
`);
  process.exit(0);
}

console.log('\n🚀 Starting build process for browser frontend build...\n');

// Parse CLI arguments with our magical parser
const cliConfig = parseBunBuildArgs();
const outdir = cliConfig.outdir || path.join(process.cwd(), 'dist');

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();

// Scan for all HTML files in the project
const entrypoints = cliConfig.entrypoints
  ? [cliConfig.entrypoints as unknown as string]
  : [...new Bun.Glob('**.html').scanSync('src')]
      .map((a) => path.resolve('src', a))
      .filter((dir) => !dir.includes('node_modules'));
console.log(
  `📄 Found ${entrypoints.length} HTML ${
    entrypoints.length === 1 ? 'file' : 'files'
  } to process:`,
  ...entrypoints
);

// Build all the HTML files
const result = await build({
  outdir,
  plugins: [bunPluginTailwind],
  minify: true,
  target: 'browser',
  sourcemap: 'linked',
  splitting: true,
  publicPath: '/',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  env: 'BUN_PUBLIC_*',
  ...cliConfig, // Merge in any CLI-provided options

  entrypoints,
});

// Print the results
const end = performance.now();

const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);

if (!result.success) {
  console.error('❌ Build failed:', result.logs);
  process.exit(1);
}

// Fix duplicate exports in the built files
console.log('\n🔧 Fixing duplicate exports in built files...');
await fixDuplicateExportsInDirectory(outdir);

const jsEntrypoints = result.outputs.filter(
  (it) => it.kind === 'entry-point' && it.path.endsWith('.js')
);

if (jsEntrypoints.length > 1) {
  throw new Error(
    'Multiple JS entrypoints found. Cannot fix code splitting bug automatically.'
  );
}

const jsEntrypoint = jsEntrypoints[0];
const jsEntrypointFilename = path.basename(jsEntrypoint.path);

// Get the chunks the entrypoint immediately imports (so that we can add them to the HTML file)
const jsByPagePath = await resolveJsDependencies({
  clientDistDir: outdir,
  publicAssetPath: cliConfig.publicPath || '/',
  jsByPagePath: new Map([
    [
      jsEntrypointFilename,
      [
        {
          urlPath: path.join(cliConfig.publicPath || '/', jsEntrypointFilename),
          filePath: jsEntrypoint.path,
          kind: 'entrypoint',
        },
      ],
    ],
  ]),
});

const immediatelyImportedJsFileUrlPaths = jsByPagePath
  .get(jsEntrypointFilename)!
  .map((it) => it.urlPath)
  .filter((it) => !it.includes(jsEntrypointFilename));

const scriptTags = immediatelyImportedJsFileUrlPaths
  .map((it) => /*html*/ `<script type="module" src="${it}"></script>`)
  .join('');

const allJsFileNames = result.outputs
  .filter((it) => it.kind === 'chunk' && it.path.endsWith('.js'))
  .map((it) => path.basename(it.path));

const allHtmlFiles = result.outputs.filter(
  (it) => it.kind === 'entry-point' && it.path.endsWith('.html')
);

// Fix the code splitting bug for the HTML files + add the script tags for the immediately imported JS files
await Promise.all(
  allHtmlFiles.map(async (it) => {
    let content = await it.text();
    const referencedJsFileNames = allJsFileNames.filter((jsFileName) =>
      content.includes(jsFileName)
    );
    if (referencedJsFileNames.length === 0) return;
    if (referencedJsFileNames.length > 1) {
      throw new Error(
        `Multiple JS files referenced in the same HTML file: ${
          it.path
        }. Cannot fix code splitting bug automatically. Referenced JS files: ${referencedJsFileNames.join(
          ', '
        )}`
      );
    }
    const referencedJsFileName = referencedJsFileNames[0];
    const isEntrypoint = referencedJsFileName === jsEntrypointFilename;
    if (isEntrypoint) return;
    console.log(
      `Fixing code splitting bug for ${it.path} by replacing ${referencedJsFileName} with ${jsEntrypointFilename} because ${referencedJsFileName} is not the entrypoint`
    );
    content = content.replace(referencedJsFileName, jsEntrypointFilename);

    content = content.replace(`</head>`, `${scriptTags}</head>`);

    console.log('Will write to file', it.path, '...');
    await Bun.write(it.path, content);
    console.log('Wrote to file', it.path);
  })
);

// Write the HTML files without a hash so they can be properly statically served
const htmlFilesWithHash = result.outputs.filter(
  (it) =>
    it.kind === 'entry-point' &&
    it.path.endsWith('.html') &&
    (it.hash ? it.path.includes(it.hash) : false)
);

if (htmlFilesWithHash.length > 0) {
  console.log(
    'Writing HTML files without a hash...',
    htmlFilesWithHash.length,
    'files'
  );

  await Promise.all(
    htmlFilesWithHash.map(async (it) => {
      const pathWithoutHash = it.path.replace(`-${it.hash}`, '');

      console.log('Will write to file', pathWithoutHash, '...');
      await Bun.write(pathWithoutHash, await it.text());
      console.log('Wrote to file', pathWithoutHash);
    })
  );

  console.log('Wrote HTML files without a hash');
}

console.log('Compressing files in directory', outdir, '...');
await compressFilesInDir(outdir);
console.log('Compressed files in directory', outdir);

const outputTable = result.outputs.map((output) => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}));

console.table(outputTable);
