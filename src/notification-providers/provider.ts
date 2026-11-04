import type { z } from "zod";
import type { AuthSession } from "../app.js";
import type { NotificationConnectionSchema } from "../contracts.js";

export interface NotificationProvider {
  status(session: AuthSession): Promise<z.infer<typeof NotificationConnectionSchema>>;
  requireConnected(session: AuthSession): Promise<void>;
  address: z.ZodType<string>;
}
