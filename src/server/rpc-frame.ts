export const OMP_MAX_FRAME_BYTES = 1_048_576;
export const OMP_MAX_REASSEMBLED_BYTES = 67_108_864;
const MAX_CHUNK_COUNT = 65_536;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RpcFrame = Record<string, unknown> & { type: string };

interface ChunkState {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

export class RpcFrameDecoder {
  private activeChunk: ChunkState | null = null;

  constructor(
    private readonly maxFrameBytes = OMP_MAX_FRAME_BYTES,
    private readonly maxReassembledBytes = OMP_MAX_REASSEMBLED_BYTES,
  ) {}

  decodeLine(line: string): RpcFrame[] {
    if (Buffer.byteLength(line, "utf-8") > this.maxFrameBytes) {
      this.activeChunk = null;
      throw new Error("RPC physical frame exceeded the negotiated limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.activeChunk = null;
      throw new Error("RPC emitted malformed JSON");
    }
    if (!isRpcFrame(value)) {
      this.activeChunk = null;
      throw new Error("RPC frame must be a JSON object with a type");
    }
    if (value.type !== "rpc_chunk") {
      if (this.activeChunk) {
        this.activeChunk = null;
        throw new Error("RPC chunk sequence was interrupted by another frame");
      }
      return [value];
    }
    return this.decodeChunk(value);
  }

  assertComplete(): void {
    if (this.activeChunk) {
      this.activeChunk = null;
      throw new Error("RPC stream ended with a partial chunk sequence");
    }
  }

  reset(): void {
    this.activeChunk = null;
  }

  private decodeChunk(frame: RpcFrame): RpcFrame[] {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      typeof data !== "string"
    ) {
      this.activeChunk = null;
      throw new Error("RPC chunk metadata is invalid");
    }
    const chunkIndex = index as number;
    const chunkCount = count as number;
    const expectedBytes = byteLength as number;
    if (
      chunkIndex < 0 ||
      chunkCount < 1 ||
      chunkCount > MAX_CHUNK_COUNT ||
      chunkIndex >= chunkCount ||
      expectedBytes < 1 ||
      expectedBytes > this.maxReassembledBytes ||
      !BASE64_PATTERN.test(data)
    ) {
      this.activeChunk = null;
      throw new Error("RPC chunk bounds or base64 encoding is invalid");
    }
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) {
      this.activeChunk = null;
      throw new Error("RPC chunk base64 encoding is not canonical");
    }

    if (!this.activeChunk) {
      if (chunkIndex !== 0) {
        throw new Error("RPC chunk sequence did not start at index zero");
      }
      this.activeChunk = {
        chunkId,
        count: chunkCount,
        byteLength: expectedBytes,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }
    const active = this.activeChunk;
    if (
      active.chunkId !== chunkId ||
      active.count !== chunkCount ||
      active.byteLength !== expectedBytes ||
      active.nextIndex !== chunkIndex
    ) {
      this.activeChunk = null;
      throw new Error("RPC chunk sequence was interleaved, reordered, or mutated");
    }
    active.chunks.push(decoded);
    active.receivedBytes += decoded.length;
    active.nextIndex += 1;
    if (active.receivedBytes > active.byteLength || active.receivedBytes > this.maxReassembledBytes) {
      this.activeChunk = null;
      throw new Error("RPC chunk sequence exceeded its declared byte length");
    }
    if (active.nextIndex < active.count) {
      return [];
    }
    this.activeChunk = null;
    if (active.receivedBytes !== active.byteLength) {
      throw new Error("RPC chunk sequence did not match its declared byte length");
    }
    const bytes = Buffer.concat(active.chunks, active.receivedBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("RPC chunk sequence was not valid UTF-8");
    }
    let reassembled: unknown;
    try {
      reassembled = JSON.parse(text);
    } catch {
      throw new Error("RPC chunk sequence did not reassemble to valid JSON");
    }
    if (!isRpcFrame(reassembled) || reassembled.type === "rpc_chunk") {
      throw new Error("RPC chunk sequence reassembled to an invalid logical frame");
    }
    return [reassembled];
  }
}

function isRpcFrame(value: unknown): value is RpcFrame {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
