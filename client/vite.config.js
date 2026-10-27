import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_DEV_API_PROXY_TARGET || 'http://127.0.0.1:5000';
  const productionApiOrigin = env.VITE_API_BASE_URL;

  if (mode === 'production') {
    let apiUrl;
    try {
      apiUrl = new URL(productionApiOrigin);
    } catch {
      throw new Error('Set VITE_API_BASE_URL to the HTTPS origin of the production API before building.');
    }
    const apiHostname = apiUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (apiUrl.protocol !== 'https:' || apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash || apiUrl.username || apiUrl.password
      || apiHostname === 'localhost' || apiHostname.endsWith('.localhost')
      || apiHostname === '127.0.0.1' || apiHostname === '0.0.0.0' || apiHostname === '::1') {
      throw new Error('VITE_API_BASE_URL must be a non-local HTTPS API origin without a path, credentials, query, or fragment.');
    }
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
  };
});