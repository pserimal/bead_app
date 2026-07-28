import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const pagesDir = path.resolve(__dirname, '../pages');

function readPage(filename: string): string {
  return fs.readFileSync(path.join(pagesDir, filename), 'utf-8');
}

describe('API consistency — no raw fetch/alert/reload', () => {
  it('UploadPage.tsx uses apiClient instead of raw fetch', () => {
    const content = readPage('UploadPage.tsx');
    expect(content).not.toMatch(/\bfetch\(/);
    expect(content).toMatch(/import apiClient/);
    expect(content).toMatch(/apiClient[\s\S]*\.\w+\(/);
  });

  it('ColorLibraryPage.tsx uses toast instead of alert', () => {
    const content = readPage('ColorLibraryPage.tsx');
    expect(content).not.toMatch(/\balert\(/);
    expect(content).toMatch(/import.*useToast/);
    expect(content).toMatch(/toast\(/);
  });

  it('HistoryPage.tsx uses refetch instead of window.location.reload', () => {
    const content = readPage('HistoryPage.tsx');
    expect(content).not.toMatch(/window\.location\.reload/);
    expect(content).toMatch(/\brefetch\b/);
  });
});
