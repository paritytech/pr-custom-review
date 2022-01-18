import { CommitState, RulesConfigurations } from "./types"

export const configFilePath = ".github/pr-custom-review.yml"
export const workflowFilePath = ".github/workflows/pr-custom-review.yml"
export const actionReviewTeamFiles = [configFilePath, workflowFilePath]

export const commitStateSuccess: CommitState = "success"
export const commitStateFailure: CommitState = "failure"

export const rulesConfigurations: RulesConfigurations = {
  basic: {
    kind: "BasicRule",
    uniqueFields: ["min_approvals", "teams", "users"],
    invalidFields: ["any", "all"],
  },
  and: {
    kind: "AndRule",
    uniqueFields: ["all"],
    invalidFields: ["min_approvals", "teams", "users", "any"],
  },
  or: {
    kind: "OrRule",
    uniqueFields: ["any"],
    invalidFields: ["min_approvals", "teams", "users", "all"],
  },
}

export const variableNameToActionInputName = {
  teamLeadsTeam: "team-leads-team",
  locksReviewTeam: "locks-review-team",
  actionReviewTeam: "action-review-team",
}
