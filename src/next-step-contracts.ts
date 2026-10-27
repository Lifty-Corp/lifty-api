import { z } from "zod";
import { SetupGatesSchema } from "./business-contracts.js";

export const NextStepSchema = z
  .object({
    state: z.enum([
      "action_required",
      "pending",
      "blocked",
      "review",
      "complete",
    ]),
    step: z.enum([
      "business",
      "interview",
      "configuration",
      "submission",
      "import",
      "sample-review",
      "campaign",
      "linkedin",
      "email",
    ]),
    reason: z.string().min(1),
    section: z
      .enum(["leads", "outreach", "email", "kickoff"])
      .describe(
        "Roadmap part: 1 leads (interview, search, sample, CRM), 2 outreach (LinkedIn), 3 email (mailbox preparation), 4 kickoff (ready mailbox and email campaign).",
      ),
    actions: z
      .array(z.string().min(1))
      .min(1)
      .max(8)
      .describe("What to do now, in order. Tool names are MCP names."),
    gates: SetupGatesSchema.nullable().describe(
      "Interview decisions still missing, during the interview only.",
    ),
    workspace_ref: z.string().nullable(),
    recommended_tools: z.array(z.string()).max(12),
    guide: z
      .record(z.string(), z.unknown())
      .describe("The current API-owned guide for this step."),
    context_task: z
      .string()
      .nullable()
      .describe("Stage whose full guide, references and operations summary_context returns for this step."),
    related_contexts: z
      .array(z.string())
      .max(10)
      .describe(
        "Other stages this step's actions lead to, such as targeting or research-criteria for calibration during the sample review. Read one with summary_context when the founder asks for it.",
      ),
    saved: z.record(z.string(), z.unknown()).nullable(),
    receipt: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type NextStep = z.infer<typeof NextStepSchema>;
