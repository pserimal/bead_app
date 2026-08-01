import axios from 'axios';

const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
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
