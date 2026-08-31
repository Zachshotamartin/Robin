export {
  CREATE_FILE_V1_SCHEMA,
  APPLY_PATCH_V1_SCHEMA,
  DELETE_FILE_V1_SCHEMA,
  MOVE_FILE_V1_SCHEMA,
} from "./edit-schema.js";
export {
  EditLedger,
} from "./edit-ledger.js";
export type {
  EditAttribution,
  EditLedgerEntry,
  EditLedgerSnapshot,
  InitialFileFact,
  InitialGitPathState,
} from "./edit-ledger.js";
export {
  WorkspaceEditService,
} from "./patch-application.js";
export type {
  EditExecutionAuthority,
  WorkspaceEditLimits,
  WorkspaceEditResult,
} from "./patch-application.js";
export {
  atomicCreatePhysicalFile,
  atomicReplacePhysicalFile,
} from "./atomic-file.js";
export type {
  AtomicWriteHooks,
  AtomicWritePhase,
  AtomicWriteResult,
} from "./atomic-file.js";
export { createDiffArtifact } from "./diff-artifact.js";
export type { DiffArtifact } from "./diff-artifact.js";
export {
  applyStructuredPatch,
  parseApplyPatchV1,
  parseCreateFileV1,
} from "./structured-patch.js";
export type {
  ApplyPatchV1,
  CreateFileV1,
  ExactReplacementHunk,
  StructuredPatchCandidate,
  StructuredPatchLimits,
} from "./structured-patch.js";
export {
  classifyTextBytes,
  classifyWorkspacePath,
  mediaTypeForPath,
} from "./file-classification.js";
export type {
  NewlineStyle,
  PathClassification,
  TextClassification,
  TextEncoding,
} from "./file-classification.js";
export {
  compileIgnoreRules,
  createWorkspaceIgnorePolicy,
  WorkspaceIgnorePolicy,
} from "./ignore-rules.js";
export type {
  GitIgnoreProbe,
  IgnoreDecision,
  IgnorePolicyOptions,
  IgnoreSource,
} from "./ignore-rules.js";
export { walkPhysicalWorkspace } from "./file-walker.js";
export type {
  FileWalkDependencies,
  FileWalkEntry,
  FileWalkLimits,
  FileWalkOmission,
  FileWalkResult,
} from "./file-walker.js";
export { listPhysicalFiles } from "./physical-list-files.js";
export type {
  PhysicalListFilesRequest,
  PhysicalListFilesResult,
} from "./physical-list-files.js";
export { searchPhysicalText } from "./physical-search-text.js";
export type {
  PhysicalSearchDependencies,
  PhysicalSearchTextRequest,
  PhysicalSearchTextResult,
} from "./physical-search-text.js";
export { readPhysicalFile } from "./physical-read-file.js";
export type {
  PhysicalReadDependencies,
  PhysicalReadFileRequest,
  PhysicalReadFileResult,
  PhysicalReadSelector,
} from "./physical-read-file.js";
export {
  assertContained,
  closeStableFile,
  finishStableRead,
  isGitAdministrativePath,
  MAXIMUM_WORKSPACE_COMPONENT_BYTES,
  MAXIMUM_WORKSPACE_COMPONENTS,
  MAXIMUM_WORKSPACE_PATH_BYTES,
  normalizeWorkspaceRelativePath,
  observePhysicalParentForCreate,
  observePhysicalPath,
  openStableRegularFile,
  physicalObjectKind,
} from "./physical-path.js";
export type {
  PhysicalPathObservation,
  PhysicalPathRaceHooks,
  StableOpenFile,
  WorkspaceRelativePath,
} from "./physical-path.js";
export {
  assertWorkspaceRootStable,
  discoverPhysicalWorkspace,
} from "./physical-workspace.js";
export type {
  DiscoverPhysicalWorkspaceDependencies,
  DiscoverPhysicalWorkspaceRequest,
  WorkspaceHandle,
} from "./physical-workspace.js";
export {
  createGitWorkspaceIdentity,
  createWorkspaceIdentity,
  fileBindingFromStats,
  fileIdentityFromStats,
  sameFileBinding,
  sameFileIdentity,
} from "./workspace-identity.js";
export type {
  FileBinding,
  FileIdentity,
  GitWorkspaceIdentity,
  GitWorkspaceProbeResult,
  MountCapabilities,
  PhysicalObjectKind,
  WorkspaceGitProbe,
  WorkspaceIdentity,
  WorkspaceOrigin,
} from "./workspace-identity.js";
