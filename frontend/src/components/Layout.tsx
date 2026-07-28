import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { staggerContainer, staggerItem } from '../lib/animations';

interface LayoutProps {
  children: ReactNode;
}

const navItems = [
  { path: '/', label: '上传图纸' },
  { path: '/blueprints', label: '图纸列表' },
  { path: '/colors', label: '颜色库' },
];

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      <motion.nav
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        style={{
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
          boxShadow: '0 1px 3px rgba(61, 43, 31, 0.06)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 flex items-center h-14 gap-6">
          <Link
            to="/"
            className="shrink-0"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-xl)',
              fontWeight: 700,
              color: 'var(--color-accent)',
              letterSpacing: 'var(--tracking-tight)',
            }}
          >
            拼豆助手
          </Link>

          <motion.div
            className="hidden lg:flex items-center gap-6"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {navItems.map(item => (
              <motion.div key={item.path} variants={staggerItem}>
                <Link
                  to={item.path}
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontWeight: 500,
                    color:
                      location.pathname === item.path
                        ? 'var(--color-accent)'
                        : 'var(--color-text-secondary)',
                    transition: 'color 0.2s ease',
                  }}
                  className="hover:opacity-80"
                >
                  {item.label}
                </Link>
              </motion.div>
            ))}
          </motion.div>

          <div className="flex-1 lg:hidden" />
          <motion.button
            onClick={() => setMenuOpen(!menuOpen)}
            className="lg:hidden p-2 rounded-lg transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
            whileHover={{ backgroundColor: 'var(--color-surface-hover)' }}
            whileTap={{ scale: 0.95 }}
            aria-label={menuOpen ? '关闭菜单' : '打开菜单'}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </motion.button>
        </div>

        <AnimatePresence>
          {menuOpen && (
            <motion.div
              className="lg:hidden overflow-hidden"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', transition: { duration: 0.3, ease: 'easeOut' } }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: 'easeIn' } }}
              style={{
                borderTop: '1px solid var(--color-border)',
                background: 'var(--color-surface)',
              }}
            >
              <div className="px-4 py-2 space-y-1">
                {navItems.map(item => (
                  <motion.div
                    key={item.path}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <Link
                      to={item.path}
                      onClick={() => setMenuOpen(false)}
                      className="block px-3 py-2 rounded-lg transition-colors"
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 500,
                        color:
                          location.pathname === item.path
                            ? 'var(--color-accent)'
                            : 'var(--color-text-secondary)',
                        background:
                          location.pathname === item.path
                            ? 'var(--color-surface-hover)'
                            : 'transparent',
                      }}
                    >
                      {item.label}
                    </Link>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.nav>
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
}
