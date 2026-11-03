import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("outreach writing context", () => {
  it("supplies the same versioned public playbook through both campaign entry points without reading private state", async () => {
    const never = async () => { throw new Error("Writing guidance must not load tenant data or execution prompts"); };
    const app = createApp({ authenticate: never, getWorkspace: never,
      businessOperation: never });
    const playbooks: string[] = [];
    const antiSlopLists: string[] = [];
    for (const task of ["journeys", "campaigns"]) {
      const response = await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v11`);
      expect(response.status).toBe(200);
      const context = await response.json();
      expect(context.references.writing).toEqual(expect.any(String));
      expect(context.references.writing).toMatch(/^# LIFT outreach writing guide\n\nVersion: lifty-writing\.v22\n/);
      expect(context.references.writing).toContain("Email shape");
      expect(context.references.writing).toContain("Subject line");
      expect(context.references.writing).toContain("Use a consistent subject so follow-ups read as one thread");
      expect(context.references.writing).toContain("Jobs by step follow the saved count");
      expect(context.references.writing).toContain("Problem emails focus on a pain");
      expect(context.references.writing).toContain("The offer email presents the founder's product");
      expect(context.references.writing).not.toContain("It looks like...");
      expect(context.references.writing).toContain("Two short asks only");
      expect(context.references.writing).toContain("must name the same job");
      expect(context.references.writing).toContain("one connected thought");
      expect(context.references.writing).toContain("Name the author");
      expect(context.references.writing).toContain("{first_name}");
      expect(context.references.writing).not.toContain("{{");
      expect(context.references.writing).toContain("I'm asking");
      expect(context.references.writing).toContain("LinkedIn message 2 still needs an I");
      expect(context.references.writing).toContain("reframes the last note");
      expect(context.references.writing).toContain("already has that number");
      expect(context.references.writing).toContain("not mandatory sequence lengths or mandatory questions");
      expect(context.references.writing).toContain("single greeting stays a single greeting");
      expect(context.references.writing).toContain("require information from them");
      expect(context.references.writing).toContain("ties the main focus to the CTA");
      expect(context.references.writing).toContain("may ask in the founder's own words");
      expect(context.references.writing).toContain("hypothetical");
      expect(context.references.writing).toContain("Do not comment");
      expect(context.references.writing).toContain("need more before you can draft");
      expect(context.references.writing).toContain("We cannot replace");
      expect(context.references.writing).toContain("yes or no answer");
      expect(context.references.writing).toContain("humanizes the outreach");
      expect(context.references.writing).toContain("what they solve");
      expect(context.references.writing).toContain("Email quality bar");
      expect(context.references.writing).toContain("its object implied");
      expect(context.references.writing).toContain("15min intro call later this week or next");
      expect(context.references.writing).toContain("Checking back in case this got buried");
      expect(context.references.writing).toContain("Do not find-replace");
      expect(context.references.writing).toContain("Email 1 may omit the opener");
      expect(context.references.anti_slop).toEqual(expect.any(String));
      expect(context.references.anti_slop).toMatch(/^# Workspace writing rules\n\nVersion: lifty-anti-slop\.v13\n/);
      // The phrases are each workspace's own copy (tests/workspace-writing-rules.test.ts).
      expect(context.references.anti_slop).toContain("Never rewrite the founder's fixed template text because of a rule.");
      playbooks.push(context.references.writing);
      antiSlopLists.push(context.references.anti_slop);
    }
    expect(playbooks[0]).toBe(playbooks[1]);
    expect(antiSlopLists[0]).toBe(antiSlopLists[1]);
  });
});
