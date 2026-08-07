import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

/* 不用 StrictMode：开发模式双渲染会破坏原生事件监听器的闭包引用 */
createRoot(document.getElementById('root')!).render(
  <App />,
)
