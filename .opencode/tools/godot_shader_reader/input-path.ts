import path from "node:path"

export function resolveInputPath(inputPath: string, worktree: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(worktree, inputPath)
}
