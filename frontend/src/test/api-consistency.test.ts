import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const pagesDir = path.resolve(__dirname, '../pages');

function readPage(filename: string): string {
  return fs.readFileSync(path.join(pagesDir, filename), 'utf-8');
}

describe('API consistency — no raw fetch/alert/reload, no old contract', () => {
  it('UploadPage.tsx uses jobs API and no raw fetch', () => {
    const content = readPage('UploadPage.tsx');
    expect(content).not.toMatch(/\bfetch\(/);
    expect(content).toMatch(/useCreateJob/);
  });

  it('pages do not reference the old /blueprints/upload contract', () => {
    for (const f of ['UploadPage.tsx', 'HistoryPage.tsx', 'JobDetailPage.tsx', 'BlueprintDetailPage.tsx', 'ColorLibraryPage.tsx']) {
      const content = readPage(f);
      expect(content).not.toMatch(/blueprints\/upload/);
      expect(content).not.toMatch(/grid_rows|grid_cols|board_bbox/);
    }
  });

  it('JobDetailPage.tsx has no alert or location.reload', () => {
    const content = readPage('JobDetailPage.tsx');
    expect(content).not.toMatch(/\balert\(/);
    expect(content).not.toMatch(/window\.location\.reload/);
  });
});
