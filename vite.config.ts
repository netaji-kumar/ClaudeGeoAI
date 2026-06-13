import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['esri-leaflet'],
    exclude: ['@esri/arcgis-rest-auth']
  },
  base: './',
  server: {
    host: true,
    port: 5173,
    fs: {
      strict: false,
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
    allowedHosts: [
      'localhost',
      '10.1.26.71',
      'moro00015053.dewa.gov.ae',
	  'knk',
	  '192.168.0.123'
    ]
  },
  root: process.cwd(),
  envDir: process.cwd(),
});