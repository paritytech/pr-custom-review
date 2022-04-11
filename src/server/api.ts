import Fastify from "fastify"

import { getFinishProcessReviews, processReviews } from "src/core"
import { ActionLogger } from "src/github/action/logger"
import { ActionData } from "src/github/action/types"
import { Context } from "src/types"

import { ServerContext } from "./types"

enum ApiVersion {
  v1 = "v1",
}
const getApiRoute = (version: ApiVersion, route: string) => {
  return `/api/${version}/${route}`
}

export const checkReviewsV1Route = getApiRoute(ApiVersion.v1, "check_reviews")

export const setupApi = ({ octokit, logger }: ServerContext) => {
  const server = Fastify({ logger: logger.getFastifyLogger() })

  server.route({
    method: "POST",
    url: checkReviewsV1Route,
    schema: {
      body: {
        type: "object",
        properties: {
          detailsUrl: { type: "string" },
          jobName: { type: "string" },
          runId: { type: "number" },
          pr: {
            type: "object",
            properties: {
              number: { type: "number" },
              base: {
                type: "object",
                properties: {
                  repo: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      owner: {
                        type: "object",
                        properties: { login: { type: "string" } },
                      },
                    },
                  },
                },
              },
              head: { type: "object", properties: { sha: { type: "string" } } },
              user: {
                type: "object",
                properties: { login: { type: "string" } },
              },
              html_url: { type: "string" },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const actionData = req.body as ActionData

      const lines: string[] = []
      const actionLogger = new ActionLogger((line) => {
        return lines.push(line)
      })

      const incompleteContext = { logger: actionLogger, octokit }
      const finishProcessReviews = getFinishProcessReviews(
        incompleteContext,
        actionData,
      )
      const ctx: Context = { ...incompleteContext, finishProcessReviews }

      await processReviews(ctx, actionData)

      reply.statusCode = 200
      void reply.send(lines)
    },
  })

  return server
}
