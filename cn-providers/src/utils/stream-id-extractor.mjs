/**
 * 通用 SSE 流 ID 提取器
 *
 * 解决问题：wreq-js 的 ReadableStream.tee() + cancel()/releaseLock()
 * 在 Windows 上会导致进程崩溃或 backpressure 挂死。
 *
 * 方案：用 TransformStream 做 passthrough，数据流经时提取 ID，
 * 所有数据原样转发给消费者，不需要 tee() 分流。
 *
 * @param {ReadableStream<Uint8Array>} sourceStream 原始 SSE 流
 * @param {(parsedObj: Record<string, unknown>) => string | null} extractFn
 *   从解析后的 SSE data JSON 中提取 ID 的函数，返回 string 表示找到，null 继续找
 * @returns {{ stream: ReadableStream<Uint8Array>, idPromise: Promise<string> }}
 */
export function createIdExtractingPassthrough(sourceStream, extractFn) {
  const decoder = new TextDecoder();
  let buffer = '';
  let foundId = '';
  let resolveId;

  const idPromise = new Promise((resolve) => {
    resolveId = resolve;
  });

  const passthrough = new TransformStream({
    transform(chunk, controller) {
      // 原样转发所有数据
      controller.enqueue(chunk);

      // ID 已找到则不再解析
      if (foundId) return;

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '').trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trimStart();
        if (payload === '[DONE]' || !payload) continue;
        try {
          const obj = JSON.parse(payload);
          const id = extractFn(obj);
          if (id) {
            foundId = id;
            resolveId(id);
            return;
          }
        } catch { /* ignore parse errors */ }
      }
    },
    flush() {
      // 流结束但仍未找到 ID，返回空字符串
      if (!foundId) resolveId('');
    },
  });

  return {
    stream: sourceStream.pipeThrough(passthrough),
    idPromise,
  };
}
