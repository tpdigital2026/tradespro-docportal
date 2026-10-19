/** Reads at most `cap` bytes of a request body, stopping (and cancelling the stream) the moment it would go over. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts, total);
}
