import type { Level } from "../../engine/src/lz77.ts";
import { download, h } from "./dom.ts";
import { formatBytes, formatPercent, formatSeconds, percentSmaller, savedLabel } from "./format.ts";
import { cancelJob, compressJob, extractJob, type Progress } from "./jobs.ts";
import { fromDataTransfer, fromFileList, type Picked } from "./pick.ts";
import type { ExtractedFile, ListedEntry } from "./protocol.ts";
import { buildZip } from "./zip.ts";

interface QueueItem extends Picked {
  id: string;
}

type Phase = "pick" | "reading" | "working" | "done";
type Tone = "warn" | "error";

interface CompressResult {
  url: string;
  filename: string;
  original: number;
  packed: number;
  seconds: number;
  entries: ListedEntry[];
}

interface Notice {
  text: string;
  tone: Tone;
}

const LEVELS: Array<[Level, string, string]> = [
  ["fast", "Fast", "Finishes sooner. Files come out a little larger."],
  ["balanced", "Balanced", "The default. Strong compression without a long wait."],
  ["max", "Smallest", "Spends longer to make the archive as small as it can."],
];

const LEVEL_NAME: Record<Level, string> = { fast: "Fast", balanced: "Balanced", max: "Smallest" };
const LARGE_BYTES = 200 * 1024 * 1024;

let stage: HTMLElement;
let overlay: HTMLElement;
let tabCompress: HTMLButtonElement;
let tabExtract: HTMLButtonElement;
let fileInput: HTMLInputElement;
let folderInput: HTMLInputElement;
let archiveInput: HTMLInputElement;

let mode: "compress" | "extract" = "compress";
let runToken = 0;

const compress = {
  phase: "pick" as Phase,
  items: [] as QueueItem[],
  level: "balanced" as Level,
  progress: null as Progress | null,
  notice: null as Notice | null,
  result: null as CompressResult | null,
};

const extract = {
  phase: "pick" as Phase,
  filename: "",
  progress: null as Progress | null,
  notice: null as Notice | null,
  savedNote: null as string | null,
  result: null as { entries: ExtractedFile[]; seconds: number } | null,
};

export function startApp(): void {
  const missing = (name: string) => {
    throw new Error(`KittyPress could not find #${name}`);
  };
  stage = document.querySelector("#stage") ?? missing("stage");
  overlay = document.querySelector("#drop-overlay") ?? missing("drop-overlay");
  tabCompress = document.querySelector("#tab-compress") ?? missing("tab-compress");
  tabExtract = document.querySelector("#tab-extract") ?? missing("tab-extract");

  fileInput = hiddenFileInput(false);
  folderInput = hiddenFileInput(true);
  archiveInput = hiddenFileInput(false);
  document.body.append(fileInput, folderInput, archiveInput);

  tabCompress.addEventListener("click", () => setMode("compress"));
  tabExtract.addEventListener("click", () => setMode("extract"));
  fileInput.addEventListener("change", () => takeFileList(fileInput, false));
  folderInput.addEventListener("change", () => takeFileList(folderInput, true));
  archiveInput.addEventListener("change", () => {
    const file = archiveInput.files?.[0];
    archiveInput.value = "";
    if (file) void openArchive(file);
  });

  stage.addEventListener("click", onClick);
  stage.addEventListener("change", onLevelChange);
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", (event) => void onDrop(event));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && busy()) {
      event.preventDefault();
      cancel();
    }
  });

  render();
}

function hiddenFileInput(folder: boolean): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.tabIndex = -1;
  input.className = "sr-only";
  input.setAttribute("aria-hidden", "true");
  if (folder) input.setAttribute("webkitdirectory", "");
  return input;
}

function setMode(next: "compress" | "extract"): void {
  if (busy() || mode === next) return;
  mode = next;
  render();
}

function busy(): boolean {
  return compress.phase === "reading" || compress.phase === "working" || extract.phase === "reading" || extract.phase === "working";
}

function onClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-drop]") && !target.closest("button, a, input, label")) {
    if (mode === "compress") fileInput.click();
    else archiveInput.click();
    return;
  }
  const button = target.closest<HTMLElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "browse") fileInput.click();
  else if (action === "folder") folderInput.click();
  else if (action === "choose-archive") archiveInput.click();
  else if (action === "sample") addSample();
  else if (action === "remove" && button.dataset.id) removeItem(button.dataset.id);
  else if (action === "compress") void startCompress();
  else if (action === "cancel") cancel();
  else if (action === "back") backToFiles();
  else if (action === "reset-compress") resetCompress();
  else if (action === "extract-another") resetExtract();
  else if (action === "download-file" && button.dataset.path) downloadOne(button.dataset.path);
  else if (action === "download-zip") downloadZip();
  else if (action === "save-folder") void saveFolder();
}

function onLevelChange(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== "level" || !input.checked) return;
  if (input.value !== "fast" && input.value !== "balanced" && input.value !== "max") return;
  compress.level = input.value;
  const desc = document.querySelector("[data-level-desc]");
  if (desc) desc.textContent = LEVELS.find(([id]) => id === compress.level)?.[2] ?? "";
}

function takeFileList(input: HTMLInputElement, fromFolder: boolean): void {
  if (!input.files || input.files.length === 0) return;
  addPicked(fromFileList(input.files, fromFolder));
  input.value = "";
}

function addSample(): void {
  const line =
    "KittyPress looks for repeated pieces of a file, then stores the repeats as short instructions. This sample repeats so you can see that working.\n";
  const file = new File([line.repeat(1200)], "sample.txt", { type: "text/plain" });
  addPicked([{ path: file.name, kind: "file", file, size: file.size, modified: Date.now() }]);
}

function addPicked(incoming: Picked[]): void {
  if (incoming.length === 0) {
    compress.notice = { text: "That drop didn't contain any files.", tone: "warn" };
    render();
    return;
  }
  const seen = new Set(compress.items.map((item) => item.path));
  let duplicates = 0;
  for (const item of incoming) {
    if (seen.has(item.path)) {
      duplicates++;
      continue;
    }
    seen.add(item.path);
    compress.items.push({ ...item, id: crypto.randomUUID() });
  }
  compress.items.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  forgetResult();
  compress.phase = "pick";
  compress.notice = duplicates
    ? {
        text: duplicates === 1 ? "One file was already in the list, so it was skipped." : `${duplicates} files were already in the list, so they were skipped.`,
        tone: "warn",
      }
    : null;
  render();
}

function removeItem(id: string): void {
  const item = compress.items.find((entry) => entry.id === id);
  if (!item) return;
  compress.items =
    item.kind === "directory"
      ? compress.items.filter((entry) => entry.path !== item.path && !entry.path.startsWith(`${item.path}/`))
      : compress.items.filter((entry) => entry.id !== id);
  render();
}

function filesOf(items: QueueItem[]): QueueItem[] {
  return items.filter((item) => item.kind === "file");
}

async function startCompress(): Promise<void> {
  if (compress.items.length === 0 || busy()) return;
  const token = ++runToken;
  compress.phase = "reading";
  compress.progress = null;
  compress.notice = null;
  forgetResult();
  render();
  announce("Reading files");

  let payload;
  try {
    payload = await readPayload(token);
  } catch (err) {
    if (token !== runToken) return;
    compress.phase = "pick";
    compress.notice = { text: err instanceof Error ? err.message : "Couldn't read the files.", tone: "error" };
    render();
    return;
  }
  if (!payload || token !== runToken) return;

  compress.phase = "working";
  compress.progress = null;
  render();
  announce("Compressing");
  try {
    const result = await compressJob(payload, compress.level, (progress) => paintProgress(progress));
    if (token !== runToken) return;
    const filename = suggestArchiveName(compress.items);
    compress.result = {
      url: URL.createObjectURL(new Blob([result.buffer], { type: "application/octet-stream" })),
      filename,
      original: result.entries.reduce((sum, entry) => sum + entry.originalSize, 0),
      packed: result.buffer.byteLength,
      seconds: result.seconds,
      entries: result.entries,
    };
    compress.phase = "done";
    render();
    announce(`${compress.result.filename} is ready`);
    document.getElementById("result-title")?.focus();
  } catch (err) {
    if (token !== runToken) return;
    compress.phase = "pick";
    compress.notice = { text: err instanceof Error ? err.message : "Compression failed.", tone: "error" };
    render();
  }
}

async function readPayload(token: number) {
  const total = filesOf(compress.items).length;
  const payload = [];
  let seen = 0;
  for (const item of compress.items) {
    if (token !== runToken) return null;
    if (item.kind === "directory" || !item.file) {
      payload.push({ path: item.path, kind: "directory" as const, modified: item.modified });
      continue;
    }
    seen++;
    setStatusText(`Reading ${seen} of ${total} · ${item.path}`);
    let buffer: ArrayBuffer;
    try {
      buffer = await item.file.arrayBuffer();
    } catch {
      throw new Error(`Couldn't read ${item.path}. It may have been moved.`);
    }
    if (token !== runToken) return null;
    payload.push({ path: item.path, kind: "file" as const, modified: item.modified, buffer });
  }
  return payload;
}

async function openArchive(file: File): Promise<void> {
  if (busy()) return;
  const token = ++runToken;
  extract.filename = file.name;
  extract.phase = "reading";
  extract.progress = null;
  extract.notice = null;
  extract.savedNote = null;
  extract.result = null;
  render();
  announce(`Opening ${file.name}`);

  let buffer: ArrayBuffer;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (token !== runToken) return;
    const magic = String.fromCharCode(...head);
    if (magic !== "KP05") {
      extract.phase = "pick";
      extract.notice = {
        text: magic.startsWith("KP0")
          ? `This archive was made by an older KittyPress (${magic}), which this app can't open.`
          : "That isn't a KittyPress archive. Choose a .kitty file.",
        tone: "error",
      };
      render();
      return;
    }
    setStatusText("Reading the archive…");
    buffer = await file.arrayBuffer();
  } catch {
    if (token !== runToken) return;
    extract.phase = "pick";
    extract.notice = { text: "Couldn't read that file. It may have been moved.", tone: "error" };
    render();
    return;
  }
  if (token !== runToken) return;

  extract.phase = "working";
  extract.progress = null;
  render();
  try {
    const result = await extractJob(buffer, (progress) => paintProgress(progress));
    if (token !== runToken) return;
    extract.result = result;
    extract.phase = "done";
    render();
    const count = result.entries.filter((entry) => entry.kind === "file").length;
    announce(`${count} ${count === 1 ? "file" : "files"} extracted. Checksums verified.`);
    document.getElementById("result-title")?.focus();
  } catch (err) {
    if (token !== runToken) return;
    extract.phase = "pick";
    extract.notice = { text: friendlyError(err instanceof Error ? err.message : "Couldn't open that archive."), tone: "error" };
    render();
  }
}

function cancel(): void {
  runToken++;
  cancelJob();
  if (mode === "compress") {
    compress.phase = "pick";
    compress.progress = null;
  } else {
    extract.phase = "pick";
    extract.progress = null;
  }
  render();
  announce("Cancelled");
}

function backToFiles(): void {
  forgetResult();
  compress.phase = "pick";
  compress.progress = null;
  render();
}

function resetCompress(): void {
  forgetResult();
  compress.items = [];
  compress.phase = "pick";
  compress.notice = null;
  compress.progress = null;
  render();
}

function resetExtract(): void {
  extract.phase = "pick";
  extract.result = null;
  extract.notice = null;
  extract.savedNote = null;
  extract.progress = null;
  extract.filename = "";
  render();
}

function forgetResult(): void {
  if (compress.result) URL.revokeObjectURL(compress.result.url);
  compress.result = null;
}

function downloadOne(path: string): void {
  const entry = extract.result?.entries.find((item) => item.path === path && item.kind === "file");
  if (!entry) return;
  const names = extract.result?.entries.filter((item) => item.kind === "file").map((item) => item.path) ?? [];
  download(uniqueDownloadName(path, names), new Uint8Array(entry.buffer));
}

function downloadZip(): void {
  const entries = extract.result?.entries;
  if (!entries) return;
  const zip = buildZip(
    entries.map((entry) =>
      entry.kind === "directory"
        ? { path: entry.path, modified: entry.modified }
        : { path: entry.path, data: new Uint8Array(entry.buffer), modified: entry.modified },
    ),
  );
  const base = extract.filename.replace(/\.kitty$/i, "") || "archive";
  download(`${base}.zip`, zip);
}

async function saveFolder(): Promise<void> {
  const entries = extract.result?.entries;
  const choose = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!entries || !choose) return;
  let root: FileSystemDirectoryHandle;
  try {
    root = await choose.call(window);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    extract.savedNote = "The browser didn't allow saving to a folder.";
    render();
    return;
  }
  try {
    for (const entry of entries) {
      const parts = entry.path.split("/");
      let directory = root;
      const folders = entry.kind === "directory" ? parts : parts.slice(0, -1);
      for (const part of folders) directory = await directory.getDirectoryHandle(part, { create: true });
      if (entry.kind === "file") {
        const handle = await directory.getFileHandle(parts[parts.length - 1] ?? entry.path, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(entry.buffer));
        await writable.close();
      }
    }
    extract.savedNote = "Saved into the folder you picked.";
  } catch {
    extract.savedNote = "Couldn't write every file into that folder.";
  }
  render();
}

function uniqueDownloadName(path: string, all: string[]): string {
  const base = path.split("/").pop() || path;
  const same = all.filter((item) => (item.split("/").pop() || item) === base);
  return same.length > 1 ? path.replaceAll("/", " · ") : base;
}

function suggestArchiveName(items: QueueItem[]): string {
  const tops = new Set(items.map((item) => item.path.split("/")[0]).filter((part): part is string => !!part));
  if (tops.size === 1) {
    const name = [...tops][0];
    return name.toLowerCase().endsWith(".kitty") ? name : `${name}.kitty`;
  }
  return "archive.kitty";
}

function paintProgress(progress: Progress): void {
  if (mode === "compress") compress.progress = progress;
  else extract.progress = progress;
  const bar = document.querySelector<HTMLElement>("[data-bar]");
  if (!bar) return;
  const pct = progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;
  bar.style.width = `${pct}%`;
  bar.parentElement?.classList.remove("indeterminate");
  bar.parentElement?.setAttribute("aria-valuenow", String(pct));
  setStatusText(progress.label ? `${pct}% · ${progress.label}` : `${pct}%`);
}

function setStatusText(text: string): void {
  const label = document.querySelector("[data-progress-label]");
  if (label) label.textContent = text;
}

function friendlyError(message: string): string {
  if (message === "Archive ends unexpectedly") return "This archive is incomplete. The file looks cut off.";
  return message;
}

function announce(text: string): void {
  const live = document.getElementById("live");
  if (live) live.textContent = text;
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (busy()) return;
  overlay.hidden = false;
  overlay.textContent = mode === "extract" ? "Drop a .kitty archive" : "Drop files to compress";
}

function onDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = busy() ? "none" : "copy";
}

function onDragLeave(event: DragEvent): void {
  if (event.relatedTarget instanceof Node && document.body.contains(event.relatedTarget)) return;
  overlay.hidden = true;
}

async function onDrop(event: DragEvent): Promise<void> {
  overlay.hidden = true;
  if (!event.dataTransfer) return;
  event.preventDefault();
  if (busy()) return;
  try {
    if (mode === "extract") {
      const picked = await fromDataTransfer(event.dataTransfer);
      const files = picked.filter((item) => item.kind === "file" && item.file);
      if (files.length !== 1 || !files[0].file) {
        extract.notice = { text: "Drop a single .kitty archive.", tone: "error" };
        extract.phase = "pick";
        render();
        return;
      }
      await openArchive(files[0].file);
      return;
    }
    addPicked(await fromDataTransfer(event.dataTransfer));
  } catch {
    const text = "Couldn't read what you dropped.";
    if (mode === "extract") extract.notice = { text, tone: "error" };
    else compress.notice = { text, tone: "error" };
    render();
  }
}

function render(): void {
  tabCompress.setAttribute("aria-selected", mode === "compress" ? "true" : "false");
  tabExtract.setAttribute("aria-selected", mode === "extract" ? "true" : "false");
  const isBusy = busy();
  tabCompress.disabled = isBusy;
  tabExtract.disabled = isBusy;
  document.body.dataset.mode = mode;
  stage.replaceChildren(mode === "compress" ? renderCompress() : renderExtract());
}

function renderCompress(): HTMLElement {
  if (compress.phase === "reading" || compress.phase === "working") {
    const title = compress.phase === "reading" ? "Reading files" : "Compressing";
    return progressPanel(title, compress.progress, "This stays on your computer. You can cancel and nothing is saved.");
  }
  if (compress.phase === "done" && compress.result) return renderCompressResult(compress.result);
  return renderCompressPick();
}

function renderCompressPick(): HTMLElement {
  const files = filesOf(compress.items);
  const folders = compress.items.length - files.length;
  const total = files.reduce((sum, item) => sum + item.size, 0);
  const panel = h("section", { class: "panel" }, [levelPicker(), notice(compress.notice)]);

  if (compress.items.length === 0) {
    panel.append(
      h("div", { class: "drop", data: { drop: "true" } }, [
        h("h2", {}, ["Drop files or a folder"]),
        h("p", { class: "quiet" }, ["Or browse. Nothing you add is uploaded."]),
        h("div", { class: "actions center" }, [
          h("button", { class: "btn primary", type: "button", data: { action: "browse" } }, ["Browse files"]),
          h("button", { class: "btn ghost", type: "button", data: { action: "folder" } }, ["Add a folder"]),
        ]),
        h("button", { class: "btn link", type: "button", data: { action: "sample" } }, ["Try a sample file"]),
      ]),
    );
    return panel;
  }

  const count =
    folders > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"} in ${folders} ${folders === 1 ? "folder" : "folders"}` : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  panel.append(
    h("div", { class: "add-row", data: { drop: "true" } }, [
      h("span", {}, ["Drop more, or"]),
      h("button", { class: "btn ghost", type: "button", data: { action: "browse" } }, ["Browse files"]),
      h("button", { class: "btn ghost", type: "button", data: { action: "folder" } }, ["Add a folder"]),
    ]),
    fileList(
      compress.items.map((item) => ({
        path: item.path,
        meta: item.kind === "directory" ? "Folder" : formatBytes(item.size),
        side: h("button", { class: "icon-btn", type: "button", data: { action: "remove", id: item.id }, attrs: { "aria-label": `Remove ${item.path}` } }, ["×"]),
      })),
    ),
    h("div", { class: "footer-bar" }, [
      h("p", {}, [count, " · ", formatBytes(total)]),
      h("button", { class: "btn primary", type: "button", data: { action: "compress" }, disabled: files.length === 0 && folders === 0 }, [
        files.length === 0 ? "Create archive" : files.length === 1 ? "Compress 1 file" : `Compress ${files.length} files`,
      ]),
    ]),
  );
  if (total > LARGE_BYTES) {
    panel.append(h("p", { class: "hint" }, ["This is over 200 MB. Very large files can run out of memory in a browser."]));
  }
  return panel;
}

function levelPicker(): HTMLElement {
  const selected = LEVELS.find(([id]) => id === compress.level) ?? LEVELS[1];
  return h("div", { class: "level-block" }, [
    h("fieldset", { class: "levels" }, [
      h("legend", { class: "sr-only" }, ["Compression level"]),
      ...LEVELS.map(([id, label]) => {
        const input = h("input", { type: "radio", attrs: { name: "level", value: id } });
        input.checked = id === compress.level;
        return h("label", { class: "choice" }, [input, h("span", {}, [label])]);
      }),
    ]),
    h("p", { class: "quiet", data: { levelDesc: "true" } }, [selected[2]]),
  ]);
}

function renderCompressResult(result: CompressResult): HTMLElement {
  const pct = percentSmaller(result.original, result.packed);
  const headline = headlineFor(result.original, result.packed);
  const files = result.entries.filter((entry) => entry.kind === "file");
  const stored = files.some((entry) => entry.method === 0 && entry.originalSize > 0);
  return h("section", { class: "panel" }, [
    h("p", { class: "eyebrow" }, ["Archive ready"]),
    h("h2", { id: "result-title", class: pct > 0.5 ? "hero accent" : "hero", tabindex: "-1" }, [headline.title]),
    h("p", { class: "detail" }, [headline.detail]),
    h("p", { class: "quiet" }, [
      `${result.filename} · ${LEVEL_NAME[compress.level]} · ${formatSeconds(result.seconds)} · ${files.length} ${files.length === 1 ? "file" : "files"}`,
    ]),
    h("div", { class: "actions" }, [
      h("a", { class: "btn primary", href: result.url, download: result.filename }, ["Download .kitty"]),
      h("button", { class: "btn ghost", type: "button", data: { action: "back" } }, ["Change files"]),
      h("button", { class: "btn ghost", type: "button", data: { action: "reset-compress" } }, ["Start over"]),
    ]),
    fileList(
      files.map((entry) => ({
        path: entry.path,
        meta: `${formatBytes(entry.originalSize)} → ${formatBytes(entry.storedSize)}`,
        side: h("span", { class: entry.method === 0 ? "tag" : "tag good" }, [savedLabel(entry.originalSize, entry.storedSize, entry.method)]),
      })),
    ),
    stored
      ? h("p", { class: "hint" }, ["Files marked stored as-is were already compact, so compressing them would not have helped."])
      : "",
  ]);
}

function headlineFor(original: number, packed: number): { title: string; detail: string } {
  const moved = `${formatBytes(original)} → ${formatBytes(packed)}`;
  if (original === 0) return { title: "Empty archive", detail: "There was nothing to shrink." };
  const pct = percentSmaller(original, packed);
  if (Math.abs(pct) < 0.5) return { title: "Same size", detail: `These files were already compact. ${moved}` };
  if (pct < 0) return { title: `${formatPercent(pct, packed)}% larger`, detail: `The archive header added a little overhead. ${moved}` };
  return { title: `${formatPercent(pct, packed)}% smaller`, detail: moved };
}

function renderExtract(): HTMLElement {
  if (extract.phase === "reading" || extract.phase === "working") {
    const title = extract.phase === "reading" ? "Reading archive" : "Checking files";
    return progressPanel(title, extract.progress, extract.filename || "Verifying every file against its checksum.");
  }
  if (extract.phase === "done" && extract.result) return renderExtractResult();
  return h("section", { class: "panel" }, [
    notice(extract.notice),
    h("div", { class: "drop", data: { drop: "true" } }, [
      h("h2", {}, ["Drop a .kitty archive"]),
      h("p", { class: "quiet" }, ["KittyPress checks each file's checksum while extracting, so damage can't slip through."]),
      h("div", { class: "actions center" }, [
        h("button", { class: "btn primary", type: "button", data: { action: "choose-archive" } }, ["Choose a file"]),
      ]),
    ]),
  ]);
}

function renderExtractResult(): HTMLElement {
  const entries = extract.result?.entries ?? [];
  const files = entries.filter((entry) => entry.kind === "file");
  const total = files.reduce((sum, entry) => sum + entry.originalSize, 0);
  const nested = files.some((entry) => entry.path.includes("/"));
  const title = files.length === 1 ? "1 file ready" : `${files.length} files ready`;
  const canSave = "showDirectoryPicker" in window;
  const only = files.length === 1 ? files[0] : undefined;
  const actions: Array<Node | string> = [];
  if (only && !nested) {
    actions.push(h("button", { class: "btn primary", type: "button", data: { action: "download-file", path: only.path } }, ["Download file"]));
  } else if (files.length > 0) {
    actions.push(
      h("button", { class: "btn primary", type: "button", data: { action: "download-zip" } }, [
        files.length === 1 ? "Download as .zip" : "Download all as .zip",
      ]),
    );
  }
  if (canSave && entries.length > 0) {
    actions.push(h("button", { class: "btn ghost", type: "button", data: { action: "save-folder" } }, ["Save to folder"]));
  }
  return h("section", { class: "panel" }, [
    h("p", { class: "eyebrow" }, [extract.filename || "Archive"]),
    h("h2", { id: "result-title", class: "hero", tabindex: "-1" }, [files.length === 0 ? "Nothing inside" : title]),
    h("p", { class: "detail" }, [
      files.length === 0
        ? "This archive has no files."
        : `Checksums verified · ${formatBytes(total)} · ${formatSeconds(extract.result?.seconds ?? 0)}`,
    ]),
    actions.length ? h("div", { class: "actions" }, actions) : "",
    extract.savedNote ? h("p", { class: "notice" }, [extract.savedNote]) : "",
    fileList(
      entries.map((entry) => ({
        path: entry.path,
        meta: entry.kind === "directory" ? "Folder" : formatBytes(entry.originalSize),
        side:
          entry.kind === "file"
            ? h("button", { class: "btn ghost slim", type: "button", data: { action: "download-file", path: entry.path } }, ["Download"])
            : h("span", {}),
      })),
    ),
    nested
      ? h("p", { class: "hint" }, ["Save to folder and the zip keep the folders. A single download uses the file name only."])
      : "",
    h("div", { class: "actions" }, [h("button", { class: "btn ghost", type: "button", data: { action: "extract-another" } }, ["Open another archive"])]),
  ]);
}

function progressPanel(title: string, progress: Progress | null, sub: string): HTMLElement {
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;
  const bar = h("span", { data: { bar: "true" } });
  if (progress) bar.style.width = `${pct}%`;
  const label = progress ? (progress.label ? `${pct}% · ${progress.label}` : `${pct}%`) : title === "Reading files" || title === "Reading archive" ? "Reading…" : "Starting…";
  return h("section", { class: "panel" }, [
    h("h2", {}, [title]),
    h("div", {
      class: progress ? "bar" : "bar indeterminate",
      role: "progressbar",
      attrs: { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": title },
    }, [bar]),
    h("p", { class: "quiet", data: { progressLabel: "true" } }, [label]),
    h("p", { class: "hint" }, [sub]),
    h("button", { class: "btn ghost", type: "button", data: { action: "cancel" } }, ["Cancel"]),
  ]);
}

function fileList(rows: Array<{ path: string; meta: string; side: Node }>): HTMLElement {
  if (rows.length === 0) return h("div");
  return h(
    "ul",
    { class: "list" },
    rows.map((row) =>
      h("li", {}, [h("span", { class: "path", title: row.path }, [row.path]), h("span", { class: "meta" }, [row.meta]), row.side]),
    ),
  );
}

function notice(item: Notice | null): HTMLElement | string {
  if (!item) return "";
  return h("p", { class: item.tone === "error" ? "alert error" : "alert warn", role: item.tone === "error" ? "alert" : "status" }, [item.text]);
}
