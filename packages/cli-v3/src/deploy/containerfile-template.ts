import type { GenerateContainerfileOptions } from "./buildImage.js";

export interface ContainerfileTemplate {
  generate(options: GenerateContainerfileOptions): Promise<string> | string;
}

// Helper function to format build args
export function formatBuildArgs(env: Record<string, string | undefined> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .filter(([_, value]) => value !== undefined)
    .map(([key]) => `ARG ${key}`)
    .join("\n");
}

// Helper function to format env vars
export function formatEnvVars(env: Record<string, string | undefined> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .filter(([_, value]) => value !== undefined)
    .map(([key]) => `ENV ${key}=$${key}`)
    .join("\n");
}

// Helper function to format RUN commands
export function formatRunCommands(commands: string[] | undefined): string {
  if (!commands || commands.length === 0) return "";
  return commands.map(cmd => `RUN ${cmd}`).join("\n");
} 