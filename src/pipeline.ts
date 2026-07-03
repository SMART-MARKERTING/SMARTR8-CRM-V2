/**
 * Sales pipeline stages (the "Select Stage" picker). Order defines the pipeline flow;
 * colors match the design. `stage` is stored on each lead; new leads default to "Lead-In".
 */
export interface PipelineStage {
  name: string;
  color: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { name: "Lead-In", color: "#1f7a33" },
  { name: "Replied", color: "#2a8d7a" },
  { name: "Not Replying", color: "#1f4e79" },
  { name: "Quote Sent", color: "#311b92" },
  { name: "App Completed", color: "#8e2497" },
  { name: "Suspended", color: "#7b1e3a" },
  { name: "Processing", color: "#7a4a1e" },
  { name: "Funded", color: "#6b8e23" },
  // Terminal "dead deal" stage. Selecting it (or setting Status to Lost) moves the lead
  // here and clears its active stage; kept in sync with the lead's Status (see updateLead).
  { name: "Lost", color: "#b91c1c" },
];

export const DEFAULT_STAGE = PIPELINE_STAGES[0].name; // "Lead-In"

const NAMES = new Set(PIPELINE_STAGES.map((s) => s.name));
export function isPipelineStage(name: string): boolean {
  return NAMES.has(name);
}
export function stageColor(name: string | null | undefined): string | null {
  return PIPELINE_STAGES.find((s) => s.name === name)?.color ?? null;
}
