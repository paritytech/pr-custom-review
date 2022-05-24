import { Octokit } from "@octokit/rest"

import { ExtendedOctokit } from "src/github/octokit"

import { ServerLogger } from "./logger"

export type ServerContext = {
  octokit: ExtendedOctokit<Octokit>
  logger: ServerLogger
  github: {
    accessToken: string
    accessTokenOwner: string
  }
}
