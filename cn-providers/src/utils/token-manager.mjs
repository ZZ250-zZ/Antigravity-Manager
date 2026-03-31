/**
 * 按 provider + refreshToken 缓存 access_token，过期前刷新；可多账号并存。
 */

/** 提前刷新余量（秒），避免边界时刻 401 */
const EXPIRY_SKEW_SEC = 60;

export class TokenManager {
  constructor() {
    /** @type {Map<string, { accessToken: string; expiresAt: number }>} */
    this.cache = new Map();
  }

  /**
   * @param {{ refreshToken: (rt: string) => Promise<{ accessToken: string; expiresIn?: number }> }} provider
   * @param {string} refreshToken
   */
  async getToken(provider, refreshToken) {
    // 用 provider.name 区分多厂商；勿使用 `${provider}`（会得到 [object Object]）
    const key = `${provider.name ?? 'provider'}:${refreshToken}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken;
    }
    const result = await provider.refreshToken(refreshToken);
    const ttlSec = Math.max(0, (result.expiresIn || 3600) - EXPIRY_SKEW_SEC);
    this.cache.set(key, {
      accessToken: result.accessToken,
      expiresAt: Date.now() + ttlSec * 1000,
    });
    return result.accessToken;
  }
}
