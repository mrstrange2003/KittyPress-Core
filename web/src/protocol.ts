export type Level = "fast" | "balanced" | "max";

export interface InFile {
  path: string;
  kind: "file" | "directory";
  modified?: number;
  buffer?: ArrayBuffer;
}

/** What one archive entry looks like after compression, before any file bytes are attached. */
export interface ListedEntry {
  path: string;
  kind: "file" | "directory";
  originalSize: number;
  storedSize: number;
  method: number;
  modified?: number;
}

export interface ExtractedFile extends ListedEntry {
  buffer: ArrayBuffer;
}

export type RequestMessage =
  | { id: number; op: "compress"; files: InFile[]; level: Level }
  | { id: number; op: "extract"; buffer: ArrayBuffer };

export type ResponseMessage =
  | { id: number; type: "progress"; done: number; total: number; label: string }
  | { id: number; type: "compressed"; buffer: ArrayBuffer; entries: ListedEntry[]; seconds: number }
  | { id: number; type: "extracted"; entries: ExtractedFile[]; seconds: number }
  | { id: number; type: "error"; message: string };
