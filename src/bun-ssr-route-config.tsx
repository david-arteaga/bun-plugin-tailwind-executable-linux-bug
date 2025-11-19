import type { BunSsrRouteConfig } from './bun-ssr/bundling';
import { SSR } from './ssr';

export const bunSsrRoutesConfig: BunSsrRouteConfig[] = [
  {
    path: '/ssr',
    SsrComponent: SSR,
    hydrateModulePath: 'src/ssr.hydrate.tsx',
  },
  // {
  //   path: '/',
  //   // modulePath: 'src/pages/landing.ssr.tsx',
  //   SsrComponent: LandingSsr,
  //   hydrateModulePath: 'src/pages/landing.hydrate.tsx',
  // },
  // {
  //   path: '/tos',
  //   // modulePath: 'src/pages/tos.ssr.tsx',
  //   SsrComponent: TosSsr,
  //   hydrateModulePath: 'src/pages/tos.hydrate.tsx',
  // },
];
