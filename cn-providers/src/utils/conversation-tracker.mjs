/**
 * 仅追踪本 sidecar 创建的会话，便于结束时调用上游删除。
 */
export class ConversationTracker {
  constructor() {
    /** @type {Map<string, { providerName: string; deleteFunc: () => Promise<void>; createdAt: number }>} */
    this.myConversations = new Map();
  }

  /**
   * @param {string} convId
   * @param {string} providerName
   * @param {() => Promise<void>} deleteFunc
   */
  record(convId, providerName, deleteFunc) {
    this.myConversations.set(convId, {
      providerName,
      deleteFunc,
      createdAt: Date.now(),
    });
  }

  /** @param {string} convId */
  async cleanup(convId) {
    const info = this.myConversations.get(convId);
    if (!info) return;
    try {
      await info.deleteFunc();
      this.myConversations.delete(convId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ConversationTracker] 清理失败 ${convId}:`, msg);
    }
  }

  async cleanupAll() {
    for (const id of this.myConversations.keys()) {
      await this.cleanup(id);
    }
  }
}
