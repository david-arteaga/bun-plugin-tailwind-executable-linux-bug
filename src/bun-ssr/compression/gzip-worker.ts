declare var self: Worker;

import { gzipSync } from 'bun';

self.onmessage = async (event: MessageEvent<string>) => {
  const filePath = event.data;
  const content = await Bun.file(filePath).arrayBuffer();
  const contentUint8 = new Uint8Array(content);
  const compressed = gzipSync(contentUint8);
  postMessage(compressed);
};
