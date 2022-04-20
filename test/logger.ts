import { inspect } from "util"

import { ActionLoggerInterface } from "src/github/action/logger"

export class TestLogger implements ActionLoggerInterface {
  relevantStartingLine = 0
  logHistory: string[]
  enableRequestLogging = true

  constructor(logHistory: string[]) {
    this.logHistory = logHistory
  }

  log(...args: any[]) {
    const message = args
      .map((arg) => {
        return typeof arg === "string" ? arg : inspect(arg)
      })
      .join(" ")
    this.logHistory.push(message)
  }

  info(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log(...args)
  }

  error(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log("ERROR: ", ...args)
  }

  warn(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log("WARNING: ", ...args)
  }

  fatal(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.error(...args)
  }

  markNextLineAsRelevantStartingLine = (_: number) => {}
}
