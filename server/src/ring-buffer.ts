export class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  push(data: string | Buffer): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.size -= removed.length;
    }
    // 单个 chunk 仍超容量时，从头部截断只保留末尾
    if (this.size > this.maxBytes && this.chunks.length === 1) {
      const overflow = this.size - this.maxBytes;
      this.chunks[0] = this.chunks[0].subarray(overflow);
      this.size = this.maxBytes;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}
