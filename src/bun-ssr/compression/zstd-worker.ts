declare var self: Worker;

import { zstdCompressSync } from 'bun';

self.onmessage = async (event: MessageEvent<string>) => {
  const filePath = event.data;
  const content = await Bun.file(filePath).arrayBuffer();
  const contentUint8 = new Uint8Array(content);
  const compressed = zstdCompressSync(contentUint8);
  postMessage(compressed);
};
