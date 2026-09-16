import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'antd/dist/reset.css'
import './index.css'
import './App.css'
import { setupExternalLinks } from './externalLinks'
import { ThemeProvider } from './themeContext'
import { UpdateProvider } from './updateContext'
import { SyncProgressProvider } from './syncProgressContext'
import App from './App.tsx'

dayjs.locale('zh-cn')
setupExternalLinks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <UpdateProvider>
          {/* 同步进度：全应用共享一份轮询（悬浮卡 / 数据概览面板 / 页内提示都读它） */}
          <SyncProgressProvider>
            <App />
          </SyncProgressProvider>
        </UpdateProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
