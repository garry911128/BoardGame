import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(() => {
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@kindred/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      },
    },
    server: {
      port: 5173,
      host: true,   // 監聽所有網路介面，包含 VPN IP
      // Convex 後端走 WebSocket 直連 VITE_CONVEX_URL，不再需要 /socket.io proxy。
      // 卡圖改由 vite 靜態伺服 client/public/assets（build 時由 assets.zip 解壓），
      // 不再需要 /assets proxy。
    },
  }
})
