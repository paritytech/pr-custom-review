import github from "@actions/github"
import {
  PullRequestEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types"

export type Octokit = ReturnType<typeof github.getOctokit>

export type PR =
  | PullRequestEvent["pull_request"]
  | PullRequestReviewEvent["pull_request"]

export type Rule = {
  name: string
  condition: string
  check_type: "diff" | "changed_files"
  min_approvals: number
  users: Array<string> | undefined | null
  teams: Array<string> | undefined | null
}

export type Configuration = {
  rules: Rule[]
}

export type RuleUserInfo = { team: string | null }
