import axios from 'axios';

// In local development call Spring directly. The backend explicitly allows
// the :5173 origin, and this avoids Vite/Windows localhost proxy failures.
// Production keeps the same-origin /api/v1 path.
const isLocalDev = import.meta.env.MODE === 'development' && typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || (isLocalDev ? 'http://localhost:8080/api/v1' : '/api/v1');

const apiClient = axios.create({
  baseURL: apiBaseUrl,
  timeout: 120000,
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // 007 契约错误形状 { code, message, details, traceId }
    const body = error.response?.data;
    const message = body?.message || error.message || 'Network error';
    const err = new Error(message) as Error & { code?: string; status?: number };
    err.code = body?.code || 'NETWORK_ERROR';
    err.status = error.response?.status;
    return Promise.reject(err);
  },
);

export default apiClient;
