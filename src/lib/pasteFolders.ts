const folders = new Map<string, string>();

export function setPasteFolder(machineId: string, folder: string | undefined): void {
  if (folder) folders.set(machineId, folder);
  else folders.delete(machineId);
}

export function pasteFolder(machineId: string): string | undefined {
  return folders.get(machineId);
}

/** The folder as a regular expression's literal text, valid with the `u` flag as without it. */
export function folderPattern(folder: string): string {
  return folder.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}
