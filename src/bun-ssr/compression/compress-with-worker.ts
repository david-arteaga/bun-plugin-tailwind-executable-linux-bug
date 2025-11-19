export async function compressWithWorker(
  workerPath: string,
  filePath: string
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);

    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker timeout'));
    }, 30000); // 30 second timeout

    worker.onmessage = (event: MessageEvent<Uint8Array>) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };

    worker.onerror = (error) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(error);
    };

    worker.postMessage(filePath);
  });
}
