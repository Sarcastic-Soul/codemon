import { z } from "zod";

/**
 * What a tool is capable of, which is what the gate rules are written against.
 *
 * `network` covers anything that reaches outside the region — MCP tools and
 * web fetches. It is its own level rather than a reuse of `write` because
 * `standard` auto-allows `write`: an unclassified remote tool filed under it
 * would execute silently in the default mode, which is the opposite of failing
 * closed.
 */
export type PermissionLevel = "read" | "write" | "bash" | "network";

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: TSchema;
  permissionLevel: PermissionLevel;
  execute(args: z.infer<TSchema>): Promise<unknown>;
}
