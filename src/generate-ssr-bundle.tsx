import { $ } from 'bun';
import { bunSsrRoutesConfig } from './bun-ssr-route-config';
import { ssrBundle } from './bun-ssr/bundling';

// Bun.build seems to have a global module resolution cache which causes issues with the bun dev server
const USE_SEPARATE_PROCESS = false;

export async function generateSsrBundle(
  useSeparateProcess = USE_SEPARATE_PROCESS
) {
  let bundleDirPath: string;
  if (useSeparateProcess) {
    try {
      const thisFile = new URL(import.meta.url).pathname;
      bundleDirPath = await (await $`bun run ${thisFile}`.text())
        .trim()
        .split('\n')
        .at(-1)!;
    } catch (error) {
      console.error('Error getting bundle dir path in separate process', error);
      throw error;
    }
  } else {
    bundleDirPath = await ssrBundle({
      routes: bunSsrRoutesConfig,
      bundleDistContainerDir: 'node_modules',
    });
  }

  return bundleDirPath;
}

if (import.meta.main) {
  console.log('Running in main');
  console.log(await generateSsrBundle(false));
  process.exit(0);
}
