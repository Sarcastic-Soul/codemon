import { z } from "zod";

export type PermissionLevel = "read" | "write" | "bash";

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: TSchema;
  permissionLevel: PermissionLevel;
  execute(args: z.infer<TSchema>): Promise<unknown>;
}
