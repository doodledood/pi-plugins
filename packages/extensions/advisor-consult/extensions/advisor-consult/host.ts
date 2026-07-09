import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/** Minimal seam over the Pi API used by the advisor-consult event wiring. */
export interface AdvisorConsultHost {
  registerTool<TParams extends TSchema>(tool: ToolDefinition<TParams>): void;
}
