## Summary

This repo is a minimal reproduction of a bug I'm seeing with bun-plugin-tailwind when building a single-file executable and running it within a Docker container.
The bug is not present when the single-file executable is run directly on a host machine (I've tested both linux-x86 annd mac-arm64 targets).

The bug shows up when `'bun-plugin-tailwind'` is imported anywhere in the project.

I ran into this bug when setting up react SSR with Bun. A full setup is available in the `full-ssr-repro` branch (which actually also contains a couple of other issues I'm seeing with the Bun bundler).

### To Repro

- `docker build . --platform=linux/amd64 -t bun-plugin-tailwind-executable-linux-bug`
- `docker run --rm --platform=linux/amd64 bun-plugin-tailwind-executable-linux-bug`

You'll get this error:

```
26214 |         );
26215 |       }
26216 |       throw new Error(`Failed to load native binding`);
26217 |     }
26218 |     module.exports = nativeBinding;
26219 |     module.exports.Scanner = nativeBinding.Scanner;
                   ^
TypeError: Attempted to assign to readonly property.
      at ../../crates/node/index.js (node_modules/bun-plugin-tailwind/index.mjs:26219:12)
      at <anonymous> (node_modules/bun-plugin-tailwind/index.mjs:21:46)
      at node_modules/bun-plugin-tailwind/index.mjs:40922:28

Bun v1.3.2 (Linux x64 baseline)
```
