import { inspect } from "util"

import { LoggerInterface } from "src/logger"

export class Logger implements LoggerInterface {
  logHistory: string[]

  constructor(logHistory: string[]) {
    this.logHistory = logHistory
  }

  doLog = (...args: any[]) => {
    const message = args
      .map(function (arg) {
        return typeof arg === "string" ? arg : inspect(arg)
      })
      .join(" ")
    this.logHistory.push(message)
  }

  public log = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog(...args)
  }

  public error = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog("ERROR: ", ...args)
  }

  public warning = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog("WARNING: ", ...args)
  }

  public failure = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.error(...args)
  }

  public markNextLineAsRelevantStartingLine = (_: number) => {}
}

export default Logger
