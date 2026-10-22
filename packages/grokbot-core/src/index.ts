export const GROKBOT_BACKEND = "https://api2.cursor.sh";

export { type AgentRef, isSameAgent, parseAgentRef } from "./agent-ref.js";
export {
  type Awaiting,
  type BoxHandoff,
  IDLE_STATUS,
  isActive,
  type LiveStatus,
} from "./agent-status.js";
export {
  type Agent,
  type AgentId,
  type AgentSuggestion,
  listAgents,
  noAgentError,
  parseListAgentsResponse,
  pickAgentQuery,
  resolveAgent,
} from "./agents.js";
export {
  compareVersions,
  INSTALLED_APP_PATH,
  isNewerVersion,
  isVersion,
  parseBundleVersion,
  parseCatalogAppVersion,
  readBundleVersion,
  readInstalledAppVersion,
} from "./app-version.js";
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
  BOT_SETUP_PROMPT,
  botUpdatePrompt,
  SETUP_CHECK_PROJECT,
} from "./bot-setup-prompt.js";
export {
  type BotsVersionRecord,
  type BotsVersionStore,
  botsVersionStore,
  describeUpdateNotice,
  type UpdateNotice,
} from "./bots-version-store.js";
export {
  type BoxEntry,
  type BoxFile,
  type BoxSnapshot,
  type BoxStore,
  boxStore,
} from "./box-store.js";
export {
  type CallerSession,
  type CallerSessionInput,
  type DetectedSession,
  detectCallerSession,
  hasSession,
  SESSION_ACTIVE_MS,
} from "./caller-session.js";
export {
  type CardDescription,
  CLI_RESOLVABLE,
  describeBoxHandoff,
  describeCard,
  OWNER_ONLY_NOTE,
} from "./card-descriptions.js";
export {
  type CliConfig,
  type CliConfigStore,
  cliConfigStore,
  DEFAULT_CLI_CONFIG,
  isKeychainAccess,
  isUsageSetting,
  KEYCHAIN_ACCESS_MODES,
  type KeychainAccess,
  type UsageSetting,
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
export type {
  DeliveredItem,
  InboxDisplay,
  InboxNotice,
  InboxRow,
  InboxRowState,
} from "./command-outputs-inbox.js";
export { createCommandRunner } from "./command-runner.js";
export type {
  CommandOutput,
  CommandOutputs,
  CommandResult,
  CommandRunner,
  CommandRunnerOptions,
  DispatchedEvent,
  JobOutcome,
  QueuedEvent,
  RunEvent,
  RunOptions,
  TeamMember,
} from "./command-runner-contract.js";
export type { CommandSafety, ParamSpec, ParamType } from "./command-spec.js";
export type { DispatchCommandName } from "./command-specs-dispatch.js";
export type { GovernanceCommandName } from "./command-specs-governance.js";
export type { InboxCommandName } from "./command-specs-inbox.js";
export type { WorkforceCommandName } from "./command-specs-workforce.js";
export {
  type CallOptions,
  type GatewayTransport,
  GrokBotError,
  type GrokBotErrorCode,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
export type { ConversationMatch } from "./conversation-search.js";
export {
  type BusyAtSend,
  type CardEntry,
  type DoneVerdict,
  evaluateDoneRule,
  type ReplyEntry,
  type RunningReason,
} from "./done-rule.js";
export { createGatewayTransport } from "./gateway-transport.js";
export { inboxGitInfo } from "./inbox-git.js";
export {
  credentialKind,
  formatInboxMessage,
  INBOX_CLOSED_RETENTION_DAYS,
  INBOX_DEFAULT_SEVERITY,
  INBOX_EXPIRES_IN,
  INBOX_EXPIRY_DAYS,
  INBOX_ITEM_JSON_SCHEMA,
  INBOX_KINDS,
  INBOX_LIMITS,
  INBOX_NEEDS,
  INBOX_NEXT_BY,
  INBOX_OUTCOMES,
  INBOX_PLACES,
  INBOX_ROOT,
  INBOX_ROOT_ENV,
  INBOX_SCHEMA_ID,
  INBOX_SEVERITIES,
  INBOX_STATUSES,
  INBOX_WORK_STATES,
  type InboxAction,
  type InboxAsk,
  type InboxClosed,
  type InboxDetails,
  type InboxDraft,
  type InboxFile,
  type InboxFrom,
  type InboxGit,
  type InboxIssue,
  type InboxItem,
  type InboxKind,
  type InboxLink,
  type InboxMachine,
  type InboxNeed,
  type InboxNext,
  type InboxNextBy,
  type InboxOutcome,
  type InboxPlace,
  type InboxPlaceAt,
  type InboxSeverity,
  type InboxStatus,
  type InboxTrailStep,
  type InboxUpdate,
  type InboxValidation,
  type InboxWork,
  type InboxWorkState,
  inboxExpiresAt,
  inboxFileName,
  inboxSlug,
  inboxTimestamp,
  isInboxExpired,
  parseInboxExpiresIn,
  parseInboxFileName,
  validateInboxDraft,
} from "./inbox-schema.js";
export {
  type InboxHandled,
  type InboxHandledAction,
  type InboxState,
  type InboxStateStore,
  inboxStateStore,
} from "./inbox-state-store.js";
export {
  type InboxCloseRequest,
  type InboxExpired,
  type InboxFailure,
  type InboxPosted,
  type InboxPostRequest,
  type InboxResult,
  type InboxStore,
  type InboxStoreOptions,
  type InboxUpdateRequest,
  type InboxWritten,
  inboxRoot,
  inboxStore,
} from "./inbox-store.js";
export {
  describeChecked,
  describeInboxItem,
  describeNotice,
  describeWaited,
  formatAge,
  listNotes,
  oneLine,
  rowCells,
  rowTitle,
  WAIT_TIMED_OUT,
} from "./inbox-text.js";
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
  assertBackgroundComposerMethodAllowed,
  assertGatewayMethodAllowed,
  assertMethodAllowed,
  BACKGROUND_COMPOSER_METHOD_SAFETY,
  GATEWAY_METHOD_SAFETY,
  type MethodSafety,
} from "./method-safety.js";
export { CATALOG_APP_VERSION } from "./method-safety-table.js";
export { readPrimaryAgentId } from "./primary-agent.js";
export { type ProcessChain, readProcessChain } from "./process-chain.js";
export {
  type MatchedRoute,
  normalizeRemote,
  projectKeys,
  routeForFolder,
} from "./project-routes.js";
export {
  isPathKey,
  type ProjectRoute,
  type ProjectRoutes,
  type ProjectRoutesStore,
  projectRoutesStore,
} from "./project-routes-store.js";
export {
  isProtectedRole,
  normalizeAgentId,
  PROTECTED_ROLES,
  type ProtectedBots,
  type ProtectedBotsStore,
  type ProtectedRole,
  protectedBotsStore,
} from "./protected-bots-store.js";
export {
  describeProxy,
  type ProxyConfig,
  resolveProxy,
} from "./proxy-config.js";
export type {
  PlaceSummary,
  ProductSummary,
  PurchaseSummary,
  ReplyCard,
  ShipmentItem,
  ShipmentStage,
  ShipmentSummary,
  WeatherSummary,
} from "./reply-cards.js";
export { describeReply } from "./reply-summary.js";
export type { SystemLocale } from "./send-locale.js";
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
  CLIENT_LABELS,
  CLIENT_NAMES,
  type ClientLabel,
  type ClientSignals,
  type DetectedClient,
  detectClient,
} from "./usage-client.js";
export {
  DEFAULT_USAGE_DIR,
  localHour,
  type UsageEvent,
  type UsageLog,
  usageLog,
} from "./usage-log.js";
export {
  type UsageRunnerOptions,
  usageEnabled,
  withUsageLog,
} from "./usage-runner.js";
export {
  type BotMessageCount,
  ownerMessageCounts,
  summarizeUsage,
  type UsageSummary,
} from "./usage-stats.js";
export { GROKBOT_VERSION } from "./version.js";
export {
  type WaitEvent,
  type WaitForDoneOptions,
  type WaitJob,
  type WaitResult,
  waitForDone,
} from "./wait-for-done.js";
export { clipText, describeReviewChange } from "./workforce-team-review.js";
