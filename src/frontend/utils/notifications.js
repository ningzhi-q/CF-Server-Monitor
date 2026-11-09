// 与后端设置一致；0 关闭，2–30 为离线分钟阈值，旧布尔值 true 为 5 分钟。
export const OFFLINE_NOTIFY_MINUTES_MIN = 2;
export const OFFLINE_NOTIFY_MINUTES_MAX = 30;

export function isValidOfflineNotifyMinutes(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !value.trim()) return false;
  const minutes = Number(value);
  return Number.isInteger(minutes) && (
    minutes === 0 || (minutes >= OFFLINE_NOTIFY_MINUTES_MIN && minutes <= OFFLINE_NOTIFY_MINUTES_MAX)
  );
}

export function normalizeTgNotifySetting(value) {
  if (value === true || value === 'true') return '5';
  return isValidOfflineNotifyMinutes(value) ? String(Number(value)) : '0';
}
