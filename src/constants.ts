import {
  AndRule,
  BasicRule,
  CommitState,
  OrRule,
  RulesConfigurations,
} from "./types"

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

// Fields used for detecting the different kinds of rules
export const simpleRuleUniqueFields: RulesConfigurations["basic"]["uniqueFields"] =
  ["min_approvals", "teams", "users"]
export const andRuleUniqueFields: RulesConfigurations["and"]["uniqueFields"] = [
  "all",
]
export const orRuleUniqueFields: RulesConfigurations["or"]["uniqueFields"] = [
  "any",
]
