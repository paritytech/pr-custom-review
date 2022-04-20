import { setupApi } from "./api"
import { ServerContext } from "./types"

export const setup = (ctx: ServerContext) => {
  return setupApi(ctx)
}
