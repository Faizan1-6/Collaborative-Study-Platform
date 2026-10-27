
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget =
    env.VITE_DEV_API_PROXY_TARGET || 'http://127.0.0.1:5000';
  const productionApiOrigin = env.VITE_API_BASE_URL;

  if (mode === 'production' && productionApiOrigin) {
    let apiUrl;

    try {
      apiUrl = new URL(productionApiOrigin);
    } catch {
      throw new Error(
        'VITE_API_BASE_URL must be a valid HTTPS API origin.'
      );
    }

    const hostname = apiUrl.hostname.toLowerCase();

    if (
      apiUrl.protocol !== 'https:' ||
      apiUrl.pathname !== '/' ||
      apiUrl.search ||
      apiUrl.hash ||
      apiUrl.username ||
      apiUrl.password ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]'
    ) {
      throw new Error(
        'VITE_API_BASE_URL must be a non-local HTTPS origin.'
      );
    }
  }

  return {
    base: '/Collaborative-Study-Platform/',
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
