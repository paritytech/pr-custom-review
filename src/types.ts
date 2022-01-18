import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"

export type CommitState =
  RestEndpointMethodTypes["repos"]["createCommitStatus"]["parameters"]["state"]
