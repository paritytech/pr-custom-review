import { Octokit } from "@octokit/rest"

import { getOctokit } from "src/github/octokit"
import { envNumberVar, envVar } from "src/utils"

import { ServerLogger } from "./logger"
import { setup } from "./setup"
import { ServerContext } from "./types"

const main = async () => {
  const logFormat = (() => {
    const value = process.env.LOG_FORMAT
    switch (value) {
      case undefined: {
        return null
      }
      case "json": {
        return value
      }
      default: {
        throw new Error(`Invalid $LOG_FORMAT: ${value}`)
      }
    }
  })()

  const logger = new ServerLogger({
    name: "app",
    impl: console,
    logFormat,
    minLogLevel: "info",
  })

  /*
    Instead of spamming error messages once some uncaught error is found, log
    only the first event as "error" and subsequent ones as "info", then
    immediately exit the application.
  */
  let isTerminating = false
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    /*
      https://nodejs.org/api/process.html#event-uncaughtexception
      https://nodejs.org/api/process.html#event-unhandledrejection
    */
    process.on(event, (error, origin) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const errorData = { event, error, origin }

      if (isTerminating) {
        logger.info(
          errorData,
          "Caught error event; it will not be logged as an error because the application is being terminated...",
        )
        return
      }
      isTerminating = true

      logger.error(
        errorData,
        "Caught error event; application will exit with an error exit code",
      )

      process.exit(1)
    })
  }

  const serverPort = envNumberVar("PORT")

  const githubAccessToken = envVar("GITHUB_ACCESS_TOKEN")
  const githubAccessTokenOwner = envVar("GITHUB_ACCESS_TOKEN_OWNER")

  const octokit = getOctokit(new Octokit(), logger, () => {
    return { authorization: `token ${githubAccessToken}` }
  })

  const ctx: ServerContext = {
    logger,
    octokit,
    github: {
      accessToken: githubAccessToken,
      accessTokenOwner: githubAccessTokenOwner,
    },
  }

  const server = setup(ctx)
  await server.listen({ host: "0.0.0.0", port: serverPort })
}

void main()
