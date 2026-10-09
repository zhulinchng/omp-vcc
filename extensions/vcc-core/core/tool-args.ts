// @ts-nocheck
export const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

/**
 * False for host-internal device URIs (`xd://propose`, `local://…`,
 * `artifact://…`, `ssh://…`, `proc://…`, `mcp://…`). They are not repository
 * files: listing them in `[Files And Changes]` or the recall touched index
 * misreports the change set, and a brief one-liner `* write "xd://propose"`
 * carries no recoverable information.
 */
const NON_FILESYSTEM_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export const isFilesystemPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !NON_FILESYSTEM_PATH_RE.test(value);

export const extractPath = (args: Record<string, unknown>): string | null => {
  if (args === null || typeof args !== "object") return null;
  // Skip a key whose value is a device URI and keep scanning: a tool call can
  // carry both a device target and a real path, and the device target must not
  // shadow it.
  for (const key of PATH_KEYS) {
    if (isFilesystemPath(args[key])) return args[key] as string;
  }
  return null;
};

export const summarizeToolArgs = (args: Record<string, unknown>): string => {
  if (args === null || typeof args !== "object") return "";
  const path = extractPath(args);
  if (path) return `path=${path}`;
  if (typeof args.command === "string") return `command=${args.command}`;
  if (typeof args.query === "string") return `query=${args.query}`;
  return Object.keys(args).join(", ");
};
