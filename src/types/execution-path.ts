import { z } from "zod";

/** How native-loop workflows execute agent work: LangGraph or in-process A2A bus. */
export const AgentExecutionPathSchema = z.enum(["graph", "a2a"]);
export type AgentExecutionPath = z.infer<typeof AgentExecutionPathSchema>;
