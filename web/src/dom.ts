export interface Props {
  class?: string;
  id?: string;
  type?: string;
  href?: string;
  download?: string;
  role?: string;
  title?: string;
  tabindex?: string;
  disabled?: boolean;
  hidden?: boolean;
  data?: Record<string, string>;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.type && "type" in node) (node as HTMLInputElement).type = props.type;
  if (props.href && node instanceof HTMLAnchorElement) node.href = props.href;
  if (props.download !== undefined && node instanceof HTMLAnchorElement) node.download = props.download;
  if (props.role) node.setAttribute("role", props.role);
  if (props.title) node.title = props.title;
  if (props.tabindex !== undefined) node.tabIndex = Number(props.tabindex);
  if (props.disabled && "disabled" in node) (node as HTMLButtonElement).disabled = true;
  if (props.hidden) node.hidden = true;
  if (props.data) {
    for (const [key, value] of Object.entries(props.data)) node.dataset[key] = value;
  }
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (children.length) node.append(...children);
  return node;
}

/** Downloads bytes with a file name. The temporary link is revoked after the click. */
export function download(filename: string, data: Blob | Uint8Array): void {
  const url = URL.createObjectURL(data instanceof Blob ? data : blobFromBytes(data));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

/** Copies into a fresh ArrayBuffer so the result is a plain BlobPart. */
function blobFromBytes(data: Uint8Array): Blob {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return new Blob([copy]);
}
