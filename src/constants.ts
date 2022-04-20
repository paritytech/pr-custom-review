import { CommitState } from "./github/types"
import { RulesConfigurations } from "./types"

export const configFilePath = ".github/pr-custom-review.yml"
export const actionReviewTeamFiles = [configFilePath]

export const commitStateSuccess: CommitState = "success"
export const commitStateFailure: CommitState = "failure"

export const maxGithubApiFilesPerPage = 100
export const maxGithubApiTeamMembersPerPage = 100
export const maxGithubApiReviewsPerPage = 100

export const rulesConfigurations: RulesConfigurations = {
  basic: {
    kind: "BasicRule",
    uniqueFields: ["min_approvals", "teams", "users"],
    invalidFields: ["any", "all", "all_distinct"],
  },
  and: {
    kind: "AndRule",
    uniqueFields: ["all"],
    invalidFields: ["min_approvals", "teams", "users", "any", "all_distinct"],
  },
  or: {
    kind: "OrRule",
    uniqueFields: ["any"],
    invalidFields: ["min_approvals", "teams", "users", "all", "all_distinct"],
  },
  and_distinct: {
    kind: "AndDistinctRule",
    uniqueFields: ["all_distinct"],
    invalidFields: ["min_approvals", "teams", "users", "all", "any"],
  },
}
