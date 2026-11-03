import type { AppDependencies, AuthSession } from "./app.js";
import { VoiceGetSchema } from "./business-contracts.js";

// LIF-1724: each workspace owns one copy of its writing rules (anti-slop
// Markdown), saved in its commercial voice as `writing_rules`. Every workspace
// starts from LIFT's default and the founder edits theirs freely. The copy is
// context for the founder's agent and Lifty's writer, never enforcement:
// nothing here checks copy against it, so a saved template ships as saved.

/** The caller workspace's copy as drafting context reads it. `no_session`
 * is a public read: it has no workspace to read. */
export type WorkspaceWritingRules =
  | { state: "saved"; markdown: string; voice_version: number }
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "no_session" };

/** Read the copy through the tenant-scoped commercial voice read, with the
 * caller's own session. A voice of another workspace than `workspaceRef`, or
 * any failed read, is unavailable: never another workspace's rules, and never
 * "none" for a read that did not succeed. An absent or blank copy is none. */
export async function readWorkspaceWritingRules(
  businessOperation: AppDependencies["businessOperation"],
  session: AuthSession,
  workspaceRef?: string | null,
): Promise<WorkspaceWritingRules> {
  try {
    const parsed = VoiceGetSchema.safeParse(await businessOperation(session, "commercial-voice.get"));
    if (!parsed.success || (workspaceRef && parsed.data.workspace_ref !== workspaceRef)) return { state: "unavailable" };
    const markdown = parsed.data.voice.writing_rules?.trim() ?? "";
    return markdown ? { state: "saved", markdown, voice_version: parsed.data.voice.version } : { state: "none" };
  } catch {
    return { state: "unavailable" };
  }
}

const READ_VOICE = "Read commercial voice (`lifty get commercial-voice`, MCP commercial_voice_get) and follow its `writing_rules` before suggesting copy.";

/** The section appended to the anti-slop context file. */
export function writingRulesSection(rules: WorkspaceWritingRules): string {
  switch (rules.state) {
    case "saved":
      return `## Workspace copy\n\nThe workspace's writing rules as saved (commercial voice version ${rules.voice_version}):\n\n${rules.markdown}`;
    case "none":
      return "## Workspace copy\n\nThis workspace has no writing rules saved. Its commercial voice `writing_rules` is empty, so no phrase list applies; do not use LIFT's default or another list instead. If the founder wants rules, save them in commercial voice.";
    case "unavailable":
      return `## Workspace copy\n\nThe workspace's writing rules could not be read right now. ${READ_VOICE} A failed read is not an empty list.`;
    case "no_session":
      return `## Workspace copy\n\nThis context was read without a workspace session, so it does not include the workspace's rules. ${READ_VOICE}`;
  }
}
