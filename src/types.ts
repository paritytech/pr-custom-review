import githubActions from "@actions/github"

import { ActionLoggerInterface } from "./github/action/logger"
import { ExtendedOctokit } from "./github/octokit"
import { CommitState } from "./github/types"

export type Context = {
  logger: ActionLoggerInterface
  octokit: ExtendedOctokit<ReturnType<typeof githubActions.getOctokit>>
  finishProcessReviews: ((state: CommitState) => Promise<void>) | null
}

export interface CommonLoggerInterface {
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
}

export type PR = {
  number: number
  base: {
    repo: {
      name: string
      owner: {
        login: string
      }
    }
  }
  head: {
    sha: string
  }
  user: {
    login: string
  }
}

export type BaseRule = {
  name: string
  condition:
    | string
    | { include: string }
    | { exclude: string }
    | { include: string; exclude: string }
  check_type: "diff" | "changed_files"
}

export type RuleCriteria = {
  min_approvals: number
  name?: string
  users?: string[] | null
  teams?: string[] | null
}

export type BasicRule = BaseRule & RuleCriteria

export type OrRule = BaseRule & {
  any: RuleCriteria[]
}

export type AndRule = BaseRule & {
  all: RuleCriteria[]
}

export type AndDistinctRule = BaseRule & {
  all_distinct: RuleCriteria[]
}

export type RuleKind = "BasicRule" | "OrRule" | "AndRule" | "AndDistinctRule"
export type Rule = BasicRule | OrRule | AndRule | AndDistinctRule

export type RulesConfigurations = {
  basic: {
    kind: "BasicRule"
    uniqueFields: ["min_approvals", "teams", "users"]
    invalidFields: ["any", "all", "all_distinct"]
  }
  and: {
    kind: "AndRule"
    uniqueFields: ["all"]
    invalidFields: ["min_approvals", "teams", "users", "any", "all_distinct"]
  }
  or: {
    kind: "OrRule"
    uniqueFields: ["any"]
    invalidFields: ["min_approvals", "teams", "users", "all", "all_distinct"]
  }
  and_distinct: {
    kind: "AndDistinctRule"
    uniqueFields: ["all_distinct"]
    invalidFields: ["min_approvals", "teams", "users", "all", "any"]
  }
}

export type Configuration = {
  rules: Rule[]
  "locks-review-team": string
  "team-leads-team": string
  "action-review-team": string
  "prevent-review-request":
    | {
        users: string[]
        teams: string[]
      }
    | undefined
    | null
}

export type RuleUserInfo = {
  teams: Set<string> | null
  teamsHistory?: Set<string>
}

type MatchedRuleBase = {
  name: string
  users: Map<string, RuleUserInfo>
  id: number
  kind: RuleKind
  min_approvals: number
}
export type MatchedRule =
  | (MatchedRuleBase & {
      kind: "AndRule" | "OrRule" | "BasicRule"
    })
  | (MatchedRuleBase & {
      kind: "AndDistinctRule"
      subConditions: RuleCriteria[]
    })

export class RuleSuccess {
  constructor(public rule: MatchedRule) {}
}
export class RuleFailure {
  constructor(
    public rule: MatchedRule,
    public problem: string,
    public usersToAskForReview: Map<string, RuleUserInfo>,
  ) {}
}
