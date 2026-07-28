import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  useColorLibraries,
  useColorLibrary,
  useAddColorEntry,
  useUpdateColorEntry,
  useDeleteColorEntry,
} from '../hooks/useColorLibrary';
import { useToast } from '../components/ToastContext';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { staggerContainer, staggerItem } from '../lib/animations';

export default function ColorLibraryPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: libraries, isLoading } = useColorLibraries();
  const [selectedLibId, setSelectedLibId] = useState<number | null>(null);
  const { data: library } = useColorLibrary(selectedLibId);
  const addEntry = useAddColorEntry();
  const updateEntry = useUpdateColorEntry();
  const deleteEntry = useDeleteColorEntry();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({
    code: '',
    color_hex: '#000000',
    color_name: '',
    sort_order: 0,
  });
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  // Auto-select first library when data loads
  useEffect(() => {
    if (!selectedLibId && libraries && libraries.length > 0) {
      setSelectedLibId(libraries[0].id);
    }
  }, [libraries, selectedLibId]);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4">
        <div className="flex items-center justify-center py-20">
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <Spinner size="lg" />
            <p
              className="mt-4"
              style={{
                color: 'var(--color-text-muted)',
                fontSize: 'var(--text-sm)',
              }}
            >
              加载颜色库...
            </p>
          </motion.div>
        </div>
      </div>
    );
  }

  const resetForm = () => {
    setForm({ code: '', color_hex: '#000000', color_name: '', sort_order: 0 });
  };

  const handleSave = async () => {
    if (!selectedLibId) return;
    try {
      if (editId) {
        await updateEntry.mutateAsync({
          libraryId: selectedLibId,
          entryId: editId,
          entry: form,
        });
      } else {
        await addEntry.mutateAsync({
          libraryId: selectedLibId,
          entry: form,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['colorLibrary', selectedLibId] });
      setShowAdd(false);
      setEditId(null);
      resetForm();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const handleDelete = async () => {
    if (!selectedLibId || !confirmDelete) return;
    try {
      await deleteEntry.mutateAsync({
        libraryId: selectedLibId,
        entryId: confirmDelete,
      });
      queryClient.invalidateQueries({ queryKey: ['colorLibrary', selectedLibId] });
      setConfirmDelete(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const openAdd = () => {
    setEditId(null);
    resetForm();
    setShowAdd(true);
  };

  const openEdit = (entry: {
    id: number;
    code: string;
    color_hex: string;
    color_name: string | null;
    sort_order: number;
  }) => {
    setEditId(entry.id);
    setForm({
      code: entry.code,
      color_hex: entry.color_hex,
      color_name: entry.color_name || '',
      sort_order: entry.sort_order,
    });
    setShowAdd(true);
  };

  const closeModal = () => {
    setShowAdd(false);
    setEditId(null);
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6 md:mb-8 gap-3">
        <h1
          className="text-2xl md:text-3xl font-bold"
          style={{
            fontFamily: 'var(--font-display)',
            color: 'var(--color-text)',
          }}
          data-testid="page-heading"
        >
          颜色库管理
        </h1>
        <Button onClick={openAdd} className="shrink-0">+ 添加颜色</Button>
      </div>

      {libraries && libraries.length > 1 && (
        <div
          className="flex gap-2 mb-6 flex-wrap"
          data-testid="library-tabs"
        >
          {libraries.map((lib) => (
            <button
              key={lib.id}
              onClick={() => setSelectedLibId(lib.id)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-[var(--transition-fast)]"
              style={{
                backgroundColor:
                  selectedLibId === lib.id
                    ? 'var(--color-accent)'
                    : 'var(--color-bg-secondary)',
                color:
                  selectedLibId === lib.id
                    ? 'var(--color-text-inverse)'
                    : 'var(--color-text-secondary)',
                border:
                  selectedLibId === lib.id
                    ? '1px solid var(--color-accent)'
                    : '1px solid var(--color-border)',
              }}
              data-testid={`library-tab-${lib.id}`}
            >
              {lib.name}
            </button>
          ))}
        </div>
      )}

      <div
        className="rounded-xl overflow-x-auto"
        style={{
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
        data-testid="entries-table-wrapper"
      >
        <table className="w-full text-sm">
          <thead
            style={{
              backgroundColor: 'var(--color-bg-secondary)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <tr>
              <th
                className="text-left px-4 py-3 font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                颜色
              </th>
              <th
                className="text-left px-4 py-3 font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                编码
              </th>
              <th
                className="text-left px-4 py-3 font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                名称
              </th>
              <th
                className="text-left px-4 py-3 font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                Hex
              </th>
              <th
                className="text-right px-4 py-3 font-medium"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                操作
              </th>
            </tr>
          </thead>
          <motion.tbody
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {library?.entries?.map((entry) => (
              <motion.tr
                key={entry.id}
                variants={staggerItem}
                className="transition-colors duration-[var(--transition-fast)]"
                style={{
                  borderBottom: '1px solid var(--color-border)',
                }}
                whileHover={{
                  backgroundColor: 'var(--color-surface-hover)',
                }}
                data-testid={`entry-row-${entry.id}`}
              >
                <td className="px-4 py-3">
                  <span
                    className="inline-block w-6 h-6 rounded-full"
                    style={{
                      backgroundColor: entry.color_hex,
                      border: '2px solid var(--color-border-strong)',
                      boxShadow: 'var(--shadow-xs)',
                    }}
                    data-testid={`color-swatch-${entry.id}`}
                  />
                </td>
                <td
                  className="px-4 py-3 font-mono"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text)',
                  }}
                >
                  {entry.code}
                </td>
                <td
                  className="px-4 py-3"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {entry.color_name || '-'}
                </td>
                <td
                  className="px-4 py-3 font-mono"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {entry.color_hex}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openEdit(entry)}
                    className="mr-3 hover:underline transition-colors duration-[var(--transition-fast)]"
                    style={{ color: 'var(--color-accent)' }}
                    data-testid={`edit-btn-${entry.id}`}
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => setConfirmDelete(entry.id)}
                    className="hover:underline transition-colors duration-[var(--transition-fast)]"
                    style={{ color: 'var(--color-error)' }}
                    data-testid={`delete-btn-${entry.id}`}
                  >
                    删除
                  </button>
                </td>
              </motion.tr>
            ))}
          </motion.tbody>
        </table>

        {library?.entries?.length === 0 && (
          <motion.div
            className="py-12 text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            data-testid="empty-state"
          >
            <div
              className="text-4xl mb-3"
              role="img"
              aria-label="空状态图标"
            >
              🎨
            </div>
            <p
              style={{
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-display)',
                fontSize: 'var(--text-lg)',
              }}
            >
              暂无颜色条目
            </p>
            <p
              className="mt-1"
              style={{
                color: 'var(--color-text-muted)',
                fontSize: 'var(--text-sm)',
              }}
            >
              点击上方按钮添加颜色
            </p>
          </motion.div>
        )}
      </div>

      {showAdd && (
        <Modal title={editId ? '编辑颜色' : '添加颜色'} onClose={closeModal}>
          <div className="space-y-4" data-testid="color-form">
            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                编码
              </label>
              <input
                value={form.code}
                onChange={(e) =>
                  setForm({ ...form, code: e.target.value.toUpperCase() })
                }
                placeholder="如 H2"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-all duration-[var(--transition-fast)]"
                style={{
                  border: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-text)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                  e.currentTarget.style.boxShadow = '0 0 0 2px rgba(199, 91, 57, 0.15)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
                data-testid="input-code"
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                名称
              </label>
              <input
                value={form.color_name}
                onChange={(e) =>
                  setForm({ ...form, color_name: e.target.value })
                }
                placeholder="如 红色"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-all duration-[var(--transition-fast)]"
                style={{
                  border: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-text)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                  e.currentTarget.style.boxShadow = '0 0 0 2px rgba(199, 91, 57, 0.15)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
                data-testid="input-name"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label
                  className="block text-sm font-medium mb-1.5"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Hex颜色
                </label>
                <input
                  value={form.color_hex}
                  onChange={(e) =>
                    setForm({ ...form, color_hex: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-all duration-[var(--transition-fast)]"
                  style={{
                    border: '1px solid var(--color-border)',
                    backgroundColor: 'var(--color-surface)',
                    color: 'var(--color-text)',
                    fontFamily: 'var(--font-mono)',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                    e.currentTarget.style.boxShadow = '0 0 0 2px rgba(199, 91, 57, 0.15)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                  data-testid="input-hex"
                />
              </div>
              <input
                type="color"
                value={form.color_hex}
                onChange={(e) =>
                  setForm({ ...form, color_hex: e.target.value })
                }
                className="w-10 h-10 mt-6 rounded cursor-pointer"
                style={{ border: '1px solid var(--color-border-strong)' }}
                data-testid="input-color-picker"
              />
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button variant="ghost" onClick={closeModal}>
                取消
              </Button>
              <Button onClick={handleSave} data-testid="save-btn">
                保存
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="确认删除" onClose={() => setConfirmDelete(null)}>
          <div data-testid="delete-confirm">
            <p
              className="text-sm mb-5"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              确定要删除这个颜色吗？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={handleDelete}
                data-testid="confirm-delete-btn"
              >
                删除
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
