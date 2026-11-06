import { describe, expect, it } from "vitest";
import fixtures from "./outreach-sql-fixtures.json" with { type: "json" };
import catalogCampaign from "./outreach-catalog-sql-fixture.json" with { type: "json" };
import { JourneyResultSchema, CampaignResultSchema, JourneysSchema, CampaignsSchema, CampaignActivationReceiptSchema } from "../src/outreach-contracts.js";

// Captured from real RPCs on the LIF-1188 scratch database, with artificial
// fixture identities. Protects SQL/API drift beyond synthetic HTTP mocks.
describe("canonical Outreach SQL receipts", () => {
  const receipts = { ...fixtures, catalog_campaign_detail: catalogCampaign };
  it.each([
    ["journey_detail", JourneyResultSchema], ["campaign_detail", CampaignResultSchema],
    ["journeys_list", JourneysSchema], ["campaigns_list", CampaignsSchema],
    ["campaign_activation", CampaignActivationReceiptSchema],
    ["catalog_campaign_detail", CampaignResultSchema],
  ] as const)("parses %s", (key, schema) => {
    expect(schema.safeParse(receipts[key])).toMatchObject({ success: true });
  });
});
