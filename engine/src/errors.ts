export type KittyErrorCode =
  /** The data is damaged, truncated, or not something this engine produced. */
  | "CORRUPT"
  /** Decompressed data does not match the checksum stored when it was compressed. */
  | "CHECKSUM"
  /** The file is a .kitty archive, but from a format version this engine can't read. */
  | "UNSUPPORTED"
  /** The caller passed something invalid (bad path, duplicate entry, bad option...). */
  | "INVALID_INPUT"
  /** The data is too big to hold in memory. */
  | "TOO_LARGE";

export class KittyError extends Error {
  readonly code: KittyErrorCode;

  constructor(code: KittyErrorCode, message: string) {
    super(message);
    this.name = "KittyError";
    this.code = code;
  }
}

export function corrupt(message: string): KittyError {
  return new KittyError("CORRUPT", message);
}
