/**
 * 工作图片的对象 URL 缓存（模块级单例）。
 *
 * 每次进页面都 `URL.createObjectURL` 会生成全新 blob URL——浏览器把它当作
 * 全新资源重新解码大图，导致切页时"一瞬间图片没加载出来 + 卡顿"。
 * 这里按签名缓存 URL 与 File：同一张工作图在 上传页/裁剪页/物料页 之间
 * 复用同一 blob URL，命中浏览器已解码位图缓存，二次渲染近乎瞬时。
 */

type CacheEntry = {
  signature: string;
  url: string;
  file: File;
};

const cache = new Map<string, CacheEntry>();

/** 单图工作流：'upload' 是上传→裁剪→物料共享的工作图；补录模式按 blueprintId。 */
function signatureOf(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** 返回该 key 当前缓存的 File（可用于跳过 IndexedDB/网络读取）。 */
export function getCachedImageFile(key: string): File | undefined {
  return cache.get(key)?.file;
}

/**
 * 为 file 取（或建）一个稳定的对象 URL。
 * 命中缓存时不生成新 URL、不 revoke 旧值，img 同 src 直接命中已解码缓存。
 */
export function cacheImageFile(key: string, file: File): string {
  const existing = cache.get(key);
  if (existing && existing.signature === signatureOf(file)) return existing.url;
  const url = URL.createObjectURL(file);
  // 替换旧条目：延迟 revoke，给正在卸载的页面留出卸载 img 的时间
  if (existing) {
    const oldUrl = existing.url;
    window.setTimeout(() => URL.revokeObjectURL(oldUrl), 30_000);
  }
  cache.set(key, { signature: signatureOf(file), url, file });
  return url;
}

/** 直接取已缓存的 URL（不新建）；未命中返回 undefined。 */
export function getCachedImageUrl(key: string): string | undefined {
  return cache.get(key)?.url;
}

export function clearImageCache(key?: string): void {
  const keys = key ? [key] : [...cache.keys()];
  for (const k of keys) {
    const entry = cache.get(k);
    if (entry) {
      const url = entry.url;
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      cache.delete(k);
    }
  }
}
