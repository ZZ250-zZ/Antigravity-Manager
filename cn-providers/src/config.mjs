/**
 * Sidecar 配置：端口与日志级别来自环境变量。
 */
export const config = {
  port: parseInt(process.env.CN_PROVIDERS_PORT || '8046', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
};
