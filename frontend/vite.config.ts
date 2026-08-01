import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  test: {
    // 本机存在全局 NODE_ENV=production 时 vitest 不会自动改为 test，
    // 导致 React development build 空导出、React.act 缺失。强制覆盖。
    env: {
      NODE_ENV: 'test',
    },
  },
})
