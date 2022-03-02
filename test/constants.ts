import { configFilePath, maxGithubApiFilesPerPage } from "src/constants"
import { AndRule, BasicRule, OrRule, PR } from "src/types"

export const org = "org"
export const repo = "repo"
export const user = "user"

export const team = "team"
export const team2 = "team2"
export const team3 = "team3"
export const userCoworker = "userCoworker"
export const userCoworker2 = "userCoworker2"
export const userCoworker3 = "userCoworker3"
export const coworkers = [userCoworker, userCoworker2]

export const prNumber = 1
export const condition = "condition"

export const githubApi = "https://api.github.com"
export const githubWebsite = "https://github.com"
export const prApiPath = `/repos/${org}/${repo}/pulls/${prNumber}`
export const reviewsApiPath = `${prApiPath}/reviews`
export const changedFilesApiPath = `${prApiPath}/files?per_page=${maxGithubApiFilesPerPage}`
export const requestedReviewersApiPath = `${prApiPath}/requested_reviewers`
export const configFileContentsApiPath = `/repos/${org}/${repo}/contents/${encodeURIComponent(
  configFilePath,
)}`
export const teamApiPath = `/orgs/${org}/teams/${team}/members`

export const basePR: PR = {
  number: prNumber,
  base: { repo: { name: repo, owner: { login: org } } },
  head: { sha: "foo" },
  user: { login: user },
  html_url: `${githubWebsite}${org}/${repo}/pull/${prNumber}`,
}

export const rulesExamples: {
  BasicRule: BasicRule
  AndRule: AndRule
  OrRule: OrRule
} = {
  BasicRule: {
    name: condition,
    condition: condition,
    check_type: "diff",
    min_approvals: 1,
  },
  AndRule: {
    name: condition,
    condition: condition,
    check_type: "diff",
    all: [],
  },
  OrRule: {
    name: condition,
    condition: condition,
    check_type: "diff",
    any: [],
  },
}
