import { useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import type { CellResponse } from '../types';

interface CellEditorProps {
  cell: CellResponse | null;
  colorEntries: { code: string; color_hex: string; color_name: string | null }[];
  onSave: (cellId: number, newCode: string) => void;
  onClose: () => void;
}

export default function CellEditor({ cell, colorEntries, onSave, onClose }: CellEditorProps) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  if (!cell) return null;

  const filtered = colorEntries.filter(e =>
    e.code.toLowerCase().includes(search.toLowerCase()) ||
    (e.color_name?.toLowerCase() || '').includes(search.toLowerCase())
  );

  const handleSave = () => {
    if (selected) {
      onSave(cell.id, selected);
      onClose();
    }
  };

  return (
    <Modal title="修改豆子颜色" onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-slate-600">
          位置: 第{cell.row_idx + 1}行, 第{cell.col_idx + 1}列
        </div>
        <div className="text-sm">
          当前编码: <span className="font-mono font-bold text-indigo-600">{cell.bead_code || '无'}</span>
        </div>

        {/* Preview */}
        {selected && (
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
            <span className="text-sm text-slate-500">新选择:</span>
            <span
              className="w-5 h-5 rounded-full border"
              style={{ backgroundColor: colorEntries.find(e => e.code === selected)?.color_hex || '#ccc' }}
            />
            <span className="font-mono font-bold">{selected}</span>
          </div>
        )}

        {/* Search */}
        <input
          type="text"
          placeholder="搜索编码或颜色名..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
        />

        {/* Color list */}
        <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg">
          {filtered.map(entry => (
            <button
              key={entry.code}
              onClick={() => setSelected(entry.code)}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 transition-colors ${
                selected === entry.code ? 'bg-indigo-50 ring-1 ring-indigo-300' : ''
              }`}
            >
              <span className="w-4 h-4 rounded-full border" style={{ backgroundColor: entry.color_hex }} />
              <span className="font-mono">{entry.code}</span>
              <span className="text-slate-500">{entry.color_name || '-'}</span>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={!selected}>保存</Button>
        </div>
      </div>
    </Modal>
  );
}
