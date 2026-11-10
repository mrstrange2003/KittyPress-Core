import { createArchive, extractArchive, KittyError, listArchive } from "../../engine/src/index.ts";
import type { ExtractedFile, InFile, Level, RequestMessage, ResponseMessage } from "./protocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage: (message: ResponseMessage, transfer?: Transferable[]) => void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  try {
    if (message.op === "compress") compress(message.id, message.files, message.level);
    else extract(message.id, message.buffer);
  } catch (err) {
    reply({ id: message.id, type: "error", message: errorText(err) });
  }
};

function compress(id: number, files: InFile[], level: Level): void {
  const started = performance.now();
  let lastSent = 0;
  let lastLabel = "";
  const archive = createArchive(
    files.map((file) => ({
      path: file.path,
      kind: file.kind,
      modified: file.modified,
      data: file.kind === "file" ? new Uint8Array(file.buffer ?? new ArrayBuffer(0)) : undefined,
    })),
    {
      level,
      onProgress: (done, total, path) => {
        const now = performance.now();
        if (path !== lastLabel || now - lastSent > 100 || done === total) {
          lastSent = now;
          lastLabel = path;
          reply({ id, type: "progress", done, total, label: path });
        }
      },
    },
  );
  const entries = listArchive(archive).map(({ crc32: _crc, ...entry }) => entry);
  const bytes = ownBuffer(archive);
  const buffer = bytes.buffer as ArrayBuffer;
  reply({ id, type: "compressed", buffer, entries, seconds: (performance.now() - started) / 1000 }, [buffer]);
}

function extract(id: number, buffer: ArrayBuffer): void {
  const started = performance.now();
  let lastSent = 0;
  const extracted = extractArchive(new Uint8Array(buffer), {
    onProgress: (done, total, path) => {
      const now = performance.now();
      if (now - lastSent > 100 || done === total) {
        lastSent = now;
        reply({ id, type: "progress", done, total, label: path });
      }
    },
  });

  // Stored files are views into the archive buffer. Copy before transferring, or every
  // file would detach that one shared buffer and the others would arrive empty.
  const entries: ExtractedFile[] = [];
  const transfers: ArrayBuffer[] = [];
  for (const entry of extracted) {
    const copy = entry.kind === "file" ? new Uint8Array(entry.data) : new Uint8Array(0);
    const buffer = copy.buffer as ArrayBuffer;
    const { data: _data, crc32: _crc, ...info } = entry;
    entries.push({ ...info, buffer });
    transfers.push(buffer);
  }
  reply({ id, type: "extracted", entries, seconds: (performance.now() - started) / 1000 }, transfers);
}

function ownBuffer(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  return bytes.slice();
}

function reply(message: ResponseMessage, transfers: ArrayBuffer[] = []): void {
  ctx.postMessage(message, transfers);
}

function errorText(err: unknown): string {
  if (err instanceof KittyError || err instanceof Error) return err.message;
  return "Something went wrong while processing the files.";
}
