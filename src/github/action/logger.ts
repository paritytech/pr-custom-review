import { inspect } from "util"

import { CommonLoggerInterface } from "src/types"

export interface ActionLoggerInterface extends CommonLoggerInterface {
  relevantStartingLine: number
  log: (...args: any[]) => void
  fatal: (...args: any[]) => void
  markNextLineAsRelevantStartingLine: (delta: number) => void
}

export class ActionLogger implements ActionLoggerInterface {
  private lineCount = 0
  relevantStartingLine = 1

  /*
     The action log is expected to start like this:
     1. Run org/pr-custom-review@tag
     2. with:
     3.  input: something
  */
  private githubLogsInitialLineCount: number = 3

  constructor(private logFn: (msg: string) => void) {}

  log(...args: any[]) {
    const message = args
      .map((arg) => {
        return typeof arg === "string" ? arg : inspect(arg)
      })
      .join(" ")
    this.logFn(`${message}\n`)
    this.lineCount += (message.match(/\n/g) || "").length + 1
  }

  info(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log(...args)
  }

  error(...args: any[]) {
    /*
      Uses escape codes for displaying the error line as red.
      https://dustinpfister.github.io/2019/09/19/nodejs-ansi-escape-codes/
    */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log("\n\u001b[31;1;4mERROR: ", ...args, "\u001b[39m")
  }

  warn(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.log("WARNING: ", ...args)
  }

  fatal(...args: any[]) {
    this.markNextLineAsRelevantStartingLine(
      /*
        This uses delta = 2 because the error logging adds an extra newline at
        the start
      */
      2,
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.error(...args)
  }

  markNextLineAsRelevantStartingLine(delta = 1) {
    this.relevantStartingLine =
      this.lineCount + this.githubLogsInitialLineCount + delta
  }
}
