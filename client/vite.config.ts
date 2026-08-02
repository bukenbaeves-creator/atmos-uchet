import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: { usePolling: true }, // надёжный hot reload при bind-mount в Docker/OneDrive
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Разбиваем vendor-библиотеки на отдельные чанки: меньше пиковая память при
        // сборке (важно для окружений с малой RAM) и меньше единый бандл.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // Тяжёлую графику (recharts + d3) — в отдельный чанк; остальное — vendor.
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) return 'charts';
          return 'vendor';
        },
      },
    },
  },
});
