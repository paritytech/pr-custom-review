import { RestEndpointMethodTypes } from "@octokit/rest";

export type CommitState = RestEndpointMethodTypes["repos"]["createCommitStatus"]["parameters"]["state"];
