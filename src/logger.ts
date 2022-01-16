import os from "os"
import { inspect } from "util"

// GitHub by default logs N lines when the job is starting.
// N = 4 for pr-custom-review:
// 1. Run org/pr-custom-review@tag
// 2.   with:
// 3.     token: ***
// 4.     config-file: ./.github/pr-custom-review-config.yml
const githubLogsInitialLineCount = 4

export class Logger {
  lineCount: number = 0
  public relevantStartingLine: number = 1

  constructor() {}

  doLog = (...args: any[]) => {
    const message = args
      .map(function (arg) {
        return typeof arg === "string" ? arg : inspect(arg)
      })
      .join(" ")
    process.stdout.write(`${message}${os.EOL}`)
    this.lineCount += (message.match(/\n/g) || "").length + 1
  }

  public log = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog(...args)
  }

  public error = (...args: any[]) => {
    // Uses escape codes for displaying the error line as red.
    // https://dustinpfister.github.io/2019/09/19/nodejs-ansi-escape-codes/
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog("\n\u001b[31;1;4mERROR: ", ...args, "\u001b[39m")
  }

  public warning = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.doLog("WARNING: ", ...args)
  }

  public failure = (...args: any[]) => {
    this.markNextLineAsRelevantStartingLine(
      // This uses delta = 2 because the error logging adds an extra newline at
      // the start
      2,
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.error(...args)
  }

  public markNextLineAsRelevantStartingLine = (delta = 1) => {
    this.relevantStartingLine =
      this.lineCount + githubLogsInitialLineCount + delta
  }
}

export default Logger
