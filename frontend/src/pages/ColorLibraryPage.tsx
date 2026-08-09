import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { getColors } from '../api/colors';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { ColorDto } from '../types/api';

// 007 决议：颜色库首版只读（seed 资源 + 快照，无写接口）
export default function ColorLibraryPage() {
  const [q, setQ] = useState('');
  // 全量拉取（291 色，3 页 × 100 合并）——列表直接展示全部，不做分页
  const { data, isLoading, error } = useQuery({
    queryKey: ['colors', 'all', q ?? ''],
    queryFn: async () => {
      const items: ColorDto[] = [];
      let page = 1;
      let total = 0;
      for (;;) {
        const res = await getColors({ q: q || undefined, pageSize: 100, page });
        items.push(...res.items);
        total = res.total;
        if (res.page >= res.totalPages) break;
        page += 1;
      }
      return { items, total };
    },
  });

  return (
    <div className="max-w-4xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>颜色库</h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            默认颜色库快照（只读）· 共 {data?.total ?? '—'} 色
          </p>
        </motion.div>

        <motion.div variants={staggerItem}>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value.toUpperCase())}
            placeholder="按编码前缀搜索，如 H1"
            className="px-4 py-2 rounded-lg w-full max-w-xs"
            style={{ border: '1px solid var(--color-border)', background: 'var(--color-card)' }}
          />
        </motion.div>

        {isLoading && <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>}
        {error && <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>}

        {data && (
          <motion.div variants={staggerItem} className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {data.items.map((c) => (
              <div key={c.code} className="p-3 rounded-xl flex items-center gap-3" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
                <span
                  className="shrink-0 rounded-full"
                  style={{ width: 28, height: 28, background: `#${c.hex}`, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }}
                />
                <div className="min-w-0">
                  <p className="font-mono" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{c.code}</p>
                  <p className="truncate" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                    {c.name} · #{c.hex}
                  </p>
                </div>
              </div>
            ))}
            {data.items.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>无匹配颜色</p>}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
