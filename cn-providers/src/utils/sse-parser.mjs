/**
 * text/event-stream 解析：按行处理 `data:`，识别 `[DONE]`，通过回调输出事件。
 */

/**
 * @param {ReadableStream<Uint8Array> | import('node:stream').Readable} readableStream
 * @param {{ onEvent?: (data: unknown) => void; onDone?: () => void; onError?: (err: Error) => void }} handlers
 * @returns {Promise<void>}
 */
export function parseSSEStream(readableStream, { onEvent, onDone, onError }) {
  return run();

  async function run() {
    let doneCalled = false;
    const safeDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      onDone?.();
    };

    try {
      // Node Readable（无 getReader）
      if (readableStream && typeof readableStream.on === 'function') {
        await parseNodeReadable(/** @type {import('node:stream').Readable} */ (readableStream), safeDone);
        safeDone();
        return;
      }

      if (!readableStream || typeof readableStream.getReader !== 'function') {
        throw new TypeError('parseSSEStream: 需要 Web ReadableStream 或 Node Readable');
      }

      const reader = readableStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (handleLine(line.trimEnd(), safeDone)) {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer) {
        for (const part of buffer.split('\n')) {
          if (handleLine(part.trimEnd(), safeDone)) {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }
      safeDone();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      onError?.(e);
    }
  }

  /**
   * @param {import('node:stream').Readable} stream
   * @param {() => void} safeDone
   */
  function parseNodeReadable(stream, safeDone) {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += decoder.decode(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
          { stream: true },
        );
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (handleLine(line.trimEnd(), safeDone)) {
            stream.destroy();
            resolve();
            return;
          }
        }
      });
      stream.on('end', () => {
        if (buffer) {
          for (const part of buffer.split('\n')) {
            if (handleLine(part.trimEnd(), safeDone)) {
              resolve();
              return;
            }
          }
        }
        resolve();
      });
      stream.on('error', reject);
    });
  }

  /**
   * @returns {boolean} 是否应结束（已触发 onDone）
   */
  function handleLine(line, safeDone) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return false;
    const payload = trimmed.slice(5).trimStart();
    if (payload === '[DONE]') {
      safeDone();
      return true;
    }
    if (!payload) return false;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      data = payload;
    }
    onEvent?.(data);
    return false;
  }
}
