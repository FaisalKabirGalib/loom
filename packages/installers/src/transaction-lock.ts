import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface InstallerTransactionLock {
  release(): Promise<void>;
}

const TRANSACTION_LOCK_PATH = ".loom/.installer-transaction.lock";
const activeTransactionLocks = new Set<string>();

async function assertSafeDirectory(root: string, path: string): Promise<void> {
  const rootPath = resolve(root);
  const directory = resolve(path);
  const pathFromRoot = relative(rootPath, directory);
  if (
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot === ".." ||
    isAbsolute(pathFromRoot)
  )
    throw new Error("Installer transaction lock is unsafe");
  let current = rootPath;
  for (const part of pathFromRoot.split(sep).filter(Boolean)) {
    const state = await lstat(current).catch(() => undefined);
    if (!state?.isDirectory() || state.isSymbolicLink())
      throw new Error("Installer transaction lock is unsafe");
    current = join(current, part);
  }
  const state = await lstat(current).catch(() => undefined);
  if (state !== undefined && (!state.isDirectory() || state.isSymbolicLink()))
    throw new Error("Installer transaction lock is unsafe");
}

export async function acquireInstallerTransactionLock(
  root: string,
): Promise<InstallerTransactionLock> {
  const projectRoot = resolve(root);
  if (activeTransactionLocks.has(projectRoot))
    throw new Error("Installer transaction is already active");
  const lockPath = resolve(projectRoot, TRANSACTION_LOCK_PATH);
  const loomPath = dirname(lockPath);
  const loomExisted = await lstat(loomPath)
    .then(() => true)
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return false;
      throw cause;
    });
  await mkdir(loomPath, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(projectRoot, loomPath);
  const owner = `${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(join(lockPath, "owner.json"), owner, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (cause) {
        await rm(lockPath, { recursive: true, force: true });
        throw cause;
      }
      activeTransactionLocks.add(projectRoot);
      return {
        async release(): Promise<void> {
          try {
            if (
              (await readFile(join(lockPath, "owner.json"), "utf8")) !== owner
            )
              throw new Error("Installer transaction lock changed");
            await rm(lockPath, { recursive: true, force: true });
            if (!loomExisted) await rmdir(loomPath).catch(() => undefined);
          } finally {
            activeTransactionLocks.delete(projectRoot);
          }
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const state = await lstat(lockPath).catch(() => undefined);
      if (state === undefined || !state.isDirectory() || state.isSymbolicLink())
        throw new Error("Installer transaction lock is unsafe");
      const stale = await readFile(join(lockPath, "owner.json"), "utf8")
        .then((content) => {
          const value = JSON.parse(content) as { pid?: unknown };
          if (!Number.isInteger(value.pid) || (value.pid as number) <= 0)
            return false;
          try {
            process.kill(value.pid as number, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        })
        .catch(() => false);
      if (!stale || attempt === 1)
        throw new Error("Installer transaction is already active");
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error("Installer transaction is already active");
}
