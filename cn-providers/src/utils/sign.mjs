/**
 * 智谱等接口使用的 MD5 签名与无横线 UUID。
 */
import { createHash, randomUUID } from 'crypto';

const ZHIPU_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

export function generateZhipuSign() {
  const ts = Date.now().toString();
  const nonce = randomUUID().replace(/-/g, '');
  const sign = createHash('md5')
    .update(`${ts}-${nonce}-${ZHIPU_SECRET}`)
    .digest('hex');
  return { sign, nonce, ts };
}

export function uuid() {
  return randomUUID().replace(/-/g, '');
}
