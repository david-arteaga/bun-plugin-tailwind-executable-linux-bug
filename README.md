### To Repro

- `docker build . --platform=linux/amd64 -t tailwind-bun-test`
- `docker run --rm --platform=linux/amd64 tailwind-bun-test`

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
