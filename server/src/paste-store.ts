import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function getImageDir(): string {
  return process.env.PASTE_IMAGE_DIR || path.resolve(__dirname, '../../data/pasted-images');
}

export async function saveImage(sessionId: string, base64: string, mimeType: string): Promise<string> {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported MIME type: ${mimeType}`);

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('Invalid base64 data');
  }
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length === 0 || buffer.length > MAX_SIZE) {
    throw new Error(`Invalid image size: ${buffer.length} bytes`);
  }

  const dir = getImageDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${sessionId}_${Date.now()}.${ext}`;
  const filePath = path.resolve(dir, filename);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}
