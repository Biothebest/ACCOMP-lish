export const CORE_ROOT: string;
export const PRODUCT_NAME: "ACCOMP-lish";
export const REGISTRY_SCHEMA_VERSION: 1;

export interface AccomplishProject {
  projectId: string;
  name: string;
  repositoryRoot: string;
  ownerDisplayName: string;
  ompProfile: string;
  port: number;
  createdAt: string;
  updatedAt: string;
  capsuleDirectory: string;
  configPath: string;
  dataDirectory: string;
  runtimePath: string;
  logPath: string;
  url: string;
}

export interface ProjectRuntime {
  schemaVersion: 1;
  projectId: string;
  instanceId: string;
  processId: number;
  port: number;
  startedAt: string;
}

export interface ProjectHealth {
  status: "ok";
  productName: "ACCOMP-lish";
  version: string;
  safetyMode: "local_only";
  projectId: string;
  organizationName: string;
  processId: number;
  instanceId: string;
  port: number;
}

export type ProjectStatus =
  | { state: "running"; project: AccomplishProject; runtime: ProjectRuntime; health: ProjectHealth }
  | {
      state: "port_conflict";
      project: AccomplishProject;
      runtime: ProjectRuntime | null;
      health: ProjectHealth;
    }
  | {
      state: "unverified_process" | "stale";
      project: AccomplishProject;
      runtime: ProjectRuntime;
      health: null;
    }
  | { state: "stopped"; project: AccomplishProject; runtime: null; health: null };

interface ProjectSelection {
  home?: string;
  cwd?: string;
  projectId?: string;
}

interface LifecycleOptions {
  coreRoot?: string;
  serverEntry?: string;
  healthTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export function defaultAccomplishHome(environment?: NodeJS.ProcessEnv, userHome?: string): string;
export function projectIdentifier(repositoryRoot: string): string;
export function projectPaths(
  home: string,
  projectId: string,
): {
  capsuleDirectory: string;
  configPath: string;
  dataDirectory: string;
  runtimePath: string;
  logPath: string;
};
export function canonicalRepositoryRoot(cwd?: string): Promise<string>;
export function initializeProject(
  options?: ProjectSelection & {
    name?: string;
    ownerDisplayName?: string;
    ompProfile?: string;
    port?: number;
    now?: Date;
  },
): Promise<AccomplishProject>;
export function listProjects(options?: { home?: string }): Promise<AccomplishProject[]>;
export function resolveProject(options?: ProjectSelection): Promise<AccomplishProject>;
export function projectStatus(project: AccomplishProject, options?: LifecycleOptions): Promise<ProjectStatus>;
export function startProject(
  project: AccomplishProject,
  options?: LifecycleOptions,
): Promise<ProjectStatus & { state: "running" }>;
export function stopProject(
  project: AccomplishProject,
  options?: LifecycleOptions,
): Promise<ProjectStatus & { state: "stopped" }>;
export function buildTaskUrl(
  project: AccomplishProject,
  input: { task: string; description: string; outcome: string },
): string;
export function openUrl(url: string, options?: { noOpen?: boolean; opener?: string }): Promise<void>;
export function prepareTask(
  project: AccomplishProject,
  input: { task: string; description: string; outcome: string },
  options?: LifecycleOptions & { noOpen?: boolean; opener?: string },
): Promise<{ project: AccomplishProject; status: ProjectStatus; url: string }>;
export function installGlobalCommand(options?: {
  binDirectory?: string;
  sourcePath?: string;
}): Promise<{ targetPath: string; sourcePath: string; installed: boolean }>;
