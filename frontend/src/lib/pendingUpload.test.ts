import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingCrop,
  clearPendingWizard,
  readPendingCrop,
  readPendingWizard,
  savePendingCrop,
  savePendingWizard,
} from './pendingUpload';

describe('pending wizard storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the resumable wizard snapshot without serializing a File', () => {
    savePendingWizard({
      step: 'materials',
      imageUrl: 'blob:stale-after-refresh',
      imageW: 1200,
      imageH: 800,
      crop: { x: 10, y: 20, w: 900, h: 600 },
      materialsBox: { x: 50, y: 500, w: 1000, h: 200 },
      rows: 3,
      cols: 8,
      jobName: '恢复测试',
      legendInventory: [{ code: 'A1', count: 4, confirmed: true, row: 0, col: 1 }],
    });

    expect(readPendingWizard()).toEqual({
      step: 'materials',
      imageUrl: 'blob:stale-after-refresh',
      imageW: 1200,
      imageH: 800,
      crop: { x: 10, y: 20, w: 900, h: 600 },
      materialsBox: { x: 50, y: 500, w: 1000, h: 200 },
      rows: 3,
      cols: 8,
      jobName: '恢复测试',
      legendInventory: [{ code: 'A1', count: 4, confirmed: true, row: 0, col: 1 }],
    });
  });

  it('keeps crop coordinates independently recoverable', () => {
    savePendingCrop({ imageW: 100, imageH: 80, crop: { x: 3, y: 4, w: 50, h: 40 }, rows: 5, cols: 6 });
    expect(readPendingCrop()).toEqual({ imageW: 100, imageH: 80, crop: { x: 3, y: 4, w: 50, h: 40 }, rows: 5, cols: 6 });
    clearPendingCrop();
    expect(readPendingCrop()).toBeNull();
  });

  it('clears wizard metadata after successful creation', () => {
    savePendingWizard({ step: 'upload', jobName: '待清理' });
    sessionStorage.setItem('pendingJobName', '待清理');
    clearPendingWizard();
    expect(readPendingWizard()).toBeNull();
    expect(sessionStorage.getItem('pendingJobName')).toBeNull();
  });
});
