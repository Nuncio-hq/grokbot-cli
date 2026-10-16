export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_VERSION = "0.1.1";

export { type AgentRef, isSameAgent, parseAgentRef } from "./agent-ref.js";
export {
  type Awaiting,
  IDLE_STATUS,
  isActive,
  type LiveStatus,
} from "./agent-status.js";
export {
  type Agent,
  type AgentId,
  listAgents,
  parseListAgentsResponse,
  pickAgentQuery,
  resolveAgent,
} from "./agents.js";
export {
  type CredentialStore,
  credentialStore,
  type TokenPairStore,
} from "./auth-credential-store.js";
export type { TokenPair } from "./auth-http.js";
export {
  type BrowserLoginOptions,
  type LoginResult,
  loginWithApiKey,
  loginWithBrowser,
} from "./auth-login.js";
export { tokenExpiresAt } from "./auth-refresh.js";
export {
  createTokenSource,
  type SignInInfo,
  type TokenSource,
} from "./auth-token-source.js";
export {
  type CliConfig,
  type CliConfigStore,
  cliConfigStore,
  DEFAULT_CLI_CONFIG,
  isKeychainAccess,
  KEYCHAIN_ACCESS_MODES,
  type KeychainAccess,
} from "./cli-config.js";
export {
  type Command,
  type CommandInput,
  type CommandName,
  isCommandName,
  listCommands,
} from "./command-catalog.js";
export {
  type CommandJsonSchema,
  commandJsonSchema,
  type ParseResult,
  paramsJsonSchema,
  parseCommandInput,
} from "./command-input.js";
export { createCommandRunner } from "./command-runner.js";
export type {
  CommandOutput,
  CommandOutputs,
  CommandRunner,
  CommandRunnerOptions,
  DispatchedEvent,
  JobOutcome,
  RunEvent,
  RunOptions,
  TeamMember,
} from "./command-runner-contract.js";
export type { CommandSafety, ParamSpec, ParamType } from "./command-spec.js";
export type { DispatchCommandName } from "./command-specs-dispatch.js";
export type { GovernanceCommandName } from "./command-specs-governance.js";
export type { WorkforceCommandName } from "./command-specs-workforce.js";
export {
  type CallOptions,
  type GatewayTransport,
  GrokBotError,
  type GrokBotErrorCode,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
export {
  type BusyAtSend,
  type CardEntry,
  type DoneVerdict,
  evaluateDoneRule,
  type ReplyEntry,
  type RunningReason,
} from "./done-rule.js";
export { createGatewayTransport } from "./gateway-transport.js";
export {
  DEFAULT_JOBS_DIR,
  type JobRecord,
  type JobState,
  type JobStore,
  jobStore,
} from "./job-store.js";
export {
  decryptSafeStorageV10,
  type GrokBotTokenSources,
  readGrokBotAccessToken,
} from "./keychain-token.js";
export {
  assertGatewayMethodAllowed,
  assertMethodAllowed,
  GATEWAY_METHOD_SAFETY,
  type MethodSafety,
} from "./method-safety.js";
export {
  createServerTransport,
  type FetchLike,
  type ServerTransportOptions,
} from "./server-transport.js";
export {
  type CardType,
  compareSeq,
  type Generation,
  parseTranscriptEntries,
  type Reply,
  type Seq,
  type TranscriptEntry,
  type TranscriptEntryKind,
} from "./transcript.js";
export {
  readTranscriptSince,
  type StreamEvent,
  type TranscriptCursor,
  transcriptCursor,
  watchTranscripts,
} from "./transcript-stream.js";
export {
  type WaitEvent,
  type WaitForDoneOptions,
  type WaitJob,
  type WaitResult,
  waitForDone,
} from "./wait-for-done.js";
