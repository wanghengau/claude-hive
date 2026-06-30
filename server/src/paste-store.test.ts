import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveImage, getImageDir } from './paste-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('paste-store', () => {
  let testDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-store-test-'));
    origEnv = process.env.PASTE_IMAGE_DIR;
    process.env.PASTE_IMAGE_DIR = testDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PASTE_IMAGE_DIR;
    else process.env.PASTE_IMAGE_DIR = origEnv;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns correct image directory', () => {
    expect(getImageDir()).toBe(testDir);
  });

  it('saves PNG image and returns absolute path', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-abc', base64, 'image/png');
    expect(result).toMatch(/^\/.*\.png$/);
    expect(fs.existsSync(result)).toBe(true);
    const stat = fs.statSync(result);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('creates directory if not exists', async () => {
    const nested = path.join(testDir, 'nested', 'dir');
    process.env.PASTE_IMAGE_DIR = nested;
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-xyz', base64, 'image/png');
    expect(fs.existsSync(result)).toBe(true);
  });

  it('uses correct extension for jpeg', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-1', base64, 'image/jpeg');
    expect(result).toMatch(/\.jpg$/);
  });

  it('throws for unsupported MIME type', async () => {
    const base64 = 'AAAA';
    await expect(saveImage('session-1', base64, 'image/bmp')).rejects.toThrow('Unsupported MIME');
  });

  it('throws for invalid base64', async () => {
    await expect(saveImage('session-1', 'not-valid-base64!!!', 'image/png')).rejects.toThrow();
  });
});
