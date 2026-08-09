import { beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '../api/client';
import { createJob, getJobEvents, getJobs } from '../api/jobs';
import { getBlueprint, getBlueprints } from '../api/blueprints';
import { getColor, getColors } from '../api/colors';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const mockedClient = vi.mocked(apiClient);

describe('API wrappers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes create-job fields into multipart form data', async () => {
    const job = { id: 'job-1' };
    mockedClient.post.mockResolvedValueOnce({ data: job });
    const image = new File(['image'], 'board.png', { type: 'image/png' });

    await expect(createJob({
      image,
      cropBoxX: 10,
      cropBoxY: 20,
      cropBoxWidth: 100,
      cropBoxHeight: 200,
      rows: 12,
      cols: 24,
      codes: '',
    })).resolves.toBe(job);

    expect(mockedClient.post).toHaveBeenCalledWith('/jobs', expect.any(FormData), {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const formData = mockedClient.post.mock.calls[0][1] as FormData;
    expect(formData.get('image')).toBe(image);
    expect(formData.get('cropBoxX')).toBe('10');
    expect(formData.get('cropBoxY')).toBe('20');
    expect(formData.get('cropBoxWidth')).toBe('100');
    expect(formData.get('cropBoxHeight')).toBe('200');
    expect(formData.get('rows')).toBe('12');
    expect(formData.get('cols')).toBe('24');
    expect(formData.get('codes')).toBeNull();
  });

  it('passes job list filters and pagination', async () => {
    const response = { items: [], page: 2, pageSize: 12, total: 0, totalPages: 0 };
    mockedClient.get.mockResolvedValueOnce({ data: response });

    await expect(getJobs({ status: 'PROCESSING', page: 2, pageSize: 12 })).resolves.toBe(response);
    expect(mockedClient.get).toHaveBeenCalledWith('/jobs', {
      params: { status: 'PROCESSING', page: 2, pageSize: 12 },
    });
  });

  it('uses documented defaults for job events', async () => {
    mockedClient.get.mockResolvedValueOnce({ data: {} });

    await getJobEvents('job-1');

    expect(mockedClient.get).toHaveBeenCalledWith('/jobs/job-1/events', {
      params: { pageSize: 50, sortDir: 'desc' },
    });
  });

  it('passes custom event ordering and page size', async () => {
    mockedClient.get.mockResolvedValueOnce({ data: {} });

    await getJobEvents('job-1', 10, 'asc');

    expect(mockedClient.get).toHaveBeenCalledWith('/jobs/job-1/events', {
      params: { pageSize: 10, sortDir: 'asc' },
    });
  });

  it('builds blueprint list and detail URLs', async () => {
    mockedClient.get
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { id: 'blueprint-1' } });

    await getBlueprints(3, 20);
    await getBlueprint('blueprint-1');

    expect(mockedClient.get).toHaveBeenNthCalledWith(1, '/blueprints', {
      params: { page: 3, pageSize: 20 },
    });
    expect(mockedClient.get).toHaveBeenNthCalledWith(2, '/blueprints/blueprint-1');
  });

  it('passes color search and pagination', async () => {
    mockedClient.get
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } });

    await getColors();
    await getColors({ q: 'H1', page: 2, pageSize: 100 });

    expect(mockedClient.get).toHaveBeenNthCalledWith(1, '/colors', { params: {} });
    expect(mockedClient.get).toHaveBeenNthCalledWith(2, '/colors', {
      params: { q: 'H1', page: 2, pageSize: 100 },
    });
  });

  it('builds a color detail URL', async () => {
    const color = { code: 'H1', name: 'White', hex: 'FDFBFF' };
    mockedClient.get.mockResolvedValueOnce({ data: color });

    await expect(getColor('H1')).resolves.toBe(color);
    expect(mockedClient.get).toHaveBeenCalledWith('/colors/H1');
  });
});
