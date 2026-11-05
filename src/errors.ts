export interface UpstreamDiagnostics {
  upstream_operation: string;
  upstream_code?: string;
  upstream_kind: "database_storage" | "database_timeout" | "database_error" | "transport" | "edge_function" | "provider";
  /** The provider's documented error type and request id, so a failure can be explained and traced. */
  provider_error?: string;
  provider_request_id?: string;
}

export interface PublicErrorOptions {
  status: number;
  code: string;
  message: string;
  cause?: unknown;
  diagnostics?: UpstreamDiagnostics;
  issues?: { code: string; path: string; message: string; suggestion: string }[];
  current_version?: number;
  stale_sources?: string[];
  workspaces?: { workspace_ref: string; name: string; slug: string }[];
  limit?: number;
  resets_at?: string;
}

export class PublicError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics: UpstreamDiagnostics | undefined;
  readonly issues: PublicErrorOptions["issues"];
  readonly current_version: number | undefined;
  readonly stale_sources: string[] | undefined;
  readonly workspaces: PublicErrorOptions["workspaces"];
  readonly limit: number | undefined;
  readonly resets_at: string | undefined;

  constructor(options: PublicErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "PublicError";
    this.status = options.status;
    this.code = options.code;
    this.diagnostics = options.diagnostics;
    this.issues = options.issues; this.current_version = options.current_version;
    this.stale_sources = options.stale_sources; this.workspaces = options.workspaces;
    this.limit = options.limit; this.resets_at = options.resets_at;
  }
}
