import * as path from "path";
import { shellExecArgv } from "./shell-executor.ts";
import type { ExecResult } from "./shell-executor.ts";
import { logger } from "../utils/logger.ts";

const SANDBOX_IMAGE = "codemon-sandbox:latest";
const DOCKERFILE_PATH = path.join(import.meta.dir, "Dockerfile");

let _dockerAvailable: boolean | null = null;
let _imageBuilt: boolean | null = null;

/** Check if Docker is installed and the daemon is running. */
export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  const result = await shellExecArgv(["docker", "info", "--format", "{{.ServerVersion}}"], 5000);
  _dockerAvailable = result.exitCode === 0 && result.stdout.trim() !== "";
  return _dockerAvailable;
}

/** Check if the sandbox image exists locally. */
async function isSandboxImageBuilt(): Promise<boolean> {
  if (_imageBuilt) return true;
  const result = await shellExecArgv(
    ["docker", "image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"],
    5000,
  );
  _imageBuilt = result.exitCode === 0;
  return _imageBuilt;
}

/** Build the sandbox image from the embedded Dockerfile. Idempotent. */
export async function buildSandboxImage(): Promise<void> {
  if (await isSandboxImageBuilt()) return;
  logger.info("docker-executor: building sandbox image", { image: SANDBOX_IMAGE });
  const result = await shellExecArgv(
    ["docker", "build", "-t", SANDBOX_IMAGE, "-f", DOCKERFILE_PATH, path.dirname(DOCKERFILE_PATH)],
    300_000, // 5 min build timeout
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to build sandbox image:\n${result.stderr}`);
  }
  _imageBuilt = true;
  logger.info("docker-executor: sandbox image built");
}

/**
 * Execute a shell command inside the Docker sandbox. The project root is mounted
 * read-write at /workspace, and the network is disabled by default.
 */
export async function dockerExec(
  command: string,
  projectRoot: string,
  options: {
    timeoutMs?: number;
    allowNetwork?: boolean;
    readOnly?: boolean;
    memoryLimit?: string;
    cpuLimit?: string;
  } = {},
): Promise<ExecResult> {
  const {
    timeoutMs = 30_000,
    allowNetwork = false,
    readOnly = false,
    memoryLimit = "512m",
    cpuLimit = "1",
  } = options;

  logger.info("docker-executor: running command", { command, projectRoot });

  // Assembled as argv so the host never parses this through a shell: `command`
  // is one element, interpreted only by the container's bash.
  const argv = [
    "docker",
    "run",
    "--rm",
    "--init",
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    ...(allowNetwork ? [] : ["--network", "none"]),
    "-v",
    readOnly ? `${projectRoot}:/workspace:ro` : `${projectRoot}:/workspace`,
    "-w",
    "/workspace",
    `--stop-timeout=${Math.ceil(timeoutMs / 1000)}`,
    SANDBOX_IMAGE,
    "bash",
    "-c",
    command,
  ];

  return shellExecArgv(argv, timeoutMs + 5000); // Extra 5s for docker overhead
}

/**
 * Check Docker availability and build the image if needed. Returns false when
 * Docker is unavailable, so the caller can fall back to a subprocess.
 */
export async function ensureSandbox(): Promise<boolean> {
  try {
    if (!(await isDockerAvailable())) return false;
    await buildSandboxImage();
    return true;
  } catch (err) {
    logger.warn("docker-executor: sandbox setup failed", { error: String(err) });
    return false;
  }
}
