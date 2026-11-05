const iconCacheKey = "phone-shortcut-icons";

export function saveLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // 图标可以重新获取，空间不足时优先保留设备资料。
    if (key !== iconCacheKey && error instanceof DOMException && error.name === "QuotaExceededError"
      && localStorage.getItem(iconCacheKey) !== null) {
      localStorage.removeItem(iconCacheKey);
      try {
        localStorage.setItem(key, value);
        return;
      } catch { /* 回收缓存后仍失败时，显示保存错误。 */ }
    }
    throw "storageSaveFailed";
  }
}
