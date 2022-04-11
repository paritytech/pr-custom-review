import { ExtendedOctokit } from "src/types"

import { ServerLogger } from "./logger"

export type ServerContext = {
  octokit: ExtendedOctokit
  logger: ServerLogger
}
