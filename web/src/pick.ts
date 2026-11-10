export interface Picked {
  path: string;
  kind: "file" | "directory";
  file?: File;
  size: number;
  modified?: number;
}

type DirReader = ReturnType<FileSystemDirectoryEntry["createReader"]>;

/** Files chosen with the normal file picker, or a folder picker (which sets webkitRelativePath). */
export function fromFileList(files: FileList, fromFolder: boolean): Picked[] {
  const picked: Picked[] = [];
  for (const file of files) {
    const relative = fromFolder ? file.webkitRelativePath.replace(/\\/g, "/") : "";
    picked.push({
      path: relative || file.name,
      kind: "file",
      file,
      size: file.size,
      modified: file.lastModified,
    });
  }
  if (fromFolder) addParentFolders(picked);
  return picked;
}

/** Files and folders dropped onto the page. Folders keep their internal paths. */
export async function fromDataTransfer(transfer: DataTransfer): Promise<Picked[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of transfer.items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return [...transfer.files].map((file) => ({
      path: file.name,
      kind: "file" as const,
      file,
      size: file.size,
      modified: file.lastModified,
    }));
  }
  const picked: Picked[] = [];
  for (const entry of entries) await walk(entry, "", picked);
  return picked;
}

async function walk(entry: FileSystemEntry, parent: string, out: Picked[]): Promise<void> {
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    out.push({ path, kind: "file", file, size: file.size, modified: file.lastModified });
    return;
  }
  if (!entry.isDirectory) return;
  out.push({ path, kind: "directory", size: 0 });
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) await walk(child, path, out);
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries returns the directory in batches and must be called until a batch is empty. */
function readAll(reader: DirReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    };
    next();
  });
}

function addParentFolders(picked: Picked[]): void {
  const dirs = new Set(picked.filter((item) => item.kind === "directory").map((item) => item.path));
  for (const item of picked) {
    const parts = item.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const path of dirs) {
    if (!picked.some((item) => item.path === path)) picked.push({ path, kind: "directory", size: 0 });
  }
}
