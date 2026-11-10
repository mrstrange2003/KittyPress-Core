import type { ExtractedFile, InFile, Level, ListedEntry, ResponseMessage } from "./protocol.ts";

export interface Progress {
  done: number;
  total: number;
  label: string;
}

export interface CompressJobResult {
  buffer: ArrayBuffer;
  entries: ListedEntry[];
  seconds: number;
}

export interface ExtractJobResult {
  entries: ExtractedFile[];
  seconds: number;
}

interface Pending {
  id: number;
  resolve: (message: ResponseMessage) => void;
  reject: (error: Error) => void;
  onProgress: (progress: Progress) => void;
}

let worker: Worker | undefined;
let pending: Pending | undefined;
let nextId = 0;

function spawn(): Worker {
  const created = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  created.onmessage = (event: MessageEvent<ResponseMessage>) => {
    const message = event.data;
    if (!pending || message.id !== pending.id) return;
    if (message.type === "progress") {
      pending.onProgress(message);
      return;
    }
    const current = pending;
    pending = undefined;
    if (message.type === "error") current.reject(new Error(message.message));
    else current.resolve(message);
  };
  created.onerror = (event) => {
    pending?.reject(new Error(event.message || "The compressor stopped unexpectedly."));
    pending = undefined;
  };
  return created;
}

/** Stops the current job. The promise it returned rejects with AbortError. */
export function cancelJob(): void {
  const current = pending;
  pending = undefined;
  worker?.terminate();
  worker = undefined;
  if (current) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    current.reject(error);
  }
}

export function compressJob(
  files: InFile[],
  level: Level,
  onProgress: (progress: Progress) => void,
): Promise<CompressJobResult> {
  const transfers = files.flatMap((file) => (file.buffer ? [file.buffer] : []));
  return send({ op: "compress", files, level }, transfers, onProgress).then((message) => {
    if (message.type !== "compressed") throw new Error("Unexpected reply from the compressor.");
    return { buffer: message.buffer, entries: message.entries, seconds: message.seconds };
  });
}

export function extractJob(
  buffer: ArrayBuffer,
  onProgress: (progress: Progress) => void,
): Promise<ExtractJobResult> {
  return send({ op: "extract", buffer }, [buffer], onProgress).then((message) => {
    if (message.type !== "extracted") throw new Error("Unexpected reply from the compressor.");
    return { entries: message.entries, seconds: message.seconds };
  });
}

function send(
  body: { op: "compress"; files: InFile[]; level: Level } | { op: "extract"; buffer: ArrayBuffer },
  transfers: ArrayBuffer[],
  onProgress: (progress: Progress) => void,
): Promise<ResponseMessage> {
  if (pending) cancelJob();
  worker ??= spawn();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending = { id, resolve, reject, onProgress };
    worker?.postMessage({ ...body, id }, transfers);
  });
}
