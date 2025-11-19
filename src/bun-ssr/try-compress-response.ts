import { Readable, Writable } from 'node:stream';
import zlib from 'node:zlib';
import type { ReadableStream, WritableStream } from 'node:stream/web';

const transformMap = {
  deflate: zlib.createDeflate,
  'deflate-raw': zlib.createDeflateRaw,
  gzip: zlib.createGzip,
  zstd: zlib.createZstdCompress,
};

class CompressionStream {
  readable: ReadableStream;
  writable: WritableStream;

  constructor(format: keyof typeof transformMap) {
    const handle = transformMap[format]();
    this.readable = Readable.toWeb(handle);
    this.writable = Writable.toWeb(handle);
  }
}

export function tryCompress(req: Request, res: Response) {
  if (res.body) {
    const canZstd = req.headers.get('accept-encoding')?.includes('zstd');
    if (canZstd) {
      const zstd = res.body.pipeThrough(new CompressionStream('zstd') as any);
      const headers = new Headers(res.headers);
      headers.set('Content-Encoding', 'zstd');
      return new Response(zstd, { headers });
    }

    const canGzip = req.headers.get('accept-encoding')?.includes('gzip');
    if (canGzip) {
      const gzip = res.body.pipeThrough(new CompressionStream('gzip') as any);
      const headers = new Headers(res.headers);
      headers.set('Content-Encoding', 'gzip');
      return new Response(gzip, { headers });
    }

    const canDeflate = req.headers.get('accept-encoding')?.includes('deflate');
    if (canDeflate) {
      const deflate = res.body.pipeThrough(
        new CompressionStream('deflate') as any
      );
      const headers = new Headers(res.headers);
      headers.set('Content-Encoding', 'deflate');
      return new Response(deflate, { headers });
    }

    const canDeflateRaw = req.headers
      .get('accept-encoding')
      ?.includes('deflate-raw');
    if (canDeflateRaw) {
      const deflateRaw = res.body.pipeThrough(
        new CompressionStream('deflate-raw') as any
      );
      const headers = new Headers(res.headers);
      headers.set('Content-Encoding', 'deflate-raw');
      return new Response(deflateRaw, { headers });
    }
  }

  return res;
}
