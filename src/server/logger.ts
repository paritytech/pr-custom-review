import { FastifyLoggerInstance } from "fastify"

import { CommonLoggerInterface } from "src/types"
import { normalizeValue } from "src/utils"

type LoggingImplementation = {
  log: (...args: any[]) => void
  error: (...args: any[]) => void
}

enum LoggingLevel {
  trace,
  debug,
  info,
  warn,
  error,
  fatal,
}
type LoggingLevels = keyof typeof LoggingLevel

export class ServerLogger implements CommonLoggerInterface {
  enableRequestLogging = true

  constructor(
    public options: {
      name: string
      logFormat: "json" | null
      minLogLevel: LoggingLevels
      impl: LoggingImplementation
      context?: Record<string, any>
    },
  ) {}

  getFastifyLogger(): FastifyLoggerInstance {
    return {
      ...this,
      debug: this.loggerCallback("debug"),
      trace: this.loggerCallback("trace"),
      fatal: this.loggerCallback("fatal"),
      child: (context: Record<string, unknown>) => {
        return this.child(context).getFastifyLogger()
      },
    }
  }

  child(context: Record<string, unknown>) {
    /*
      Adjust keys in order to prevent overriding existing data in the context
      with the same key
    */
    const currentContextKeys = Object.keys(this.options.context ?? {})
    const adjustedContext: { [key: string]: unknown } = {}
    for (const [key, value] of Object.entries(context)) {
      let suggestedName = key
      while (currentContextKeys.includes(suggestedName)) {
        suggestedName = `${suggestedName} (${new Date().toISOString()})`
      }
      adjustedContext[suggestedName] = value
      currentContextKeys.push(suggestedName)
    }
    return new ServerLogger({
      ...this.options,
      context: currentContextKeys.length
        ? { ...this.options.context, ...adjustedContext }
        : undefined,
    })
  }

  log<T = string>(
    level: LoggingLevels,
    item: unknown,
    description?: T,
    ...extra: unknown[]
  ) {
    if (LoggingLevel[level] < LoggingLevel[this.options.minLogLevel]) {
      return
    }

    const loggingFunction = (() => {
      switch (level) {
        case "trace":
        case "debug":
        case "info":
        case "warn": {
          return this.options.impl.log
        }
        case "fatal":
        case "error": {
          return this.options.impl.error
        }
        default: {
          const exhaustivenessCheck: never = level
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          throw new Error(`Not exhaustive: ${exhaustivenessCheck}`)
        }
      }
    })()

    switch (this.options.logFormat) {
      case "json": {
        loggingFunction(
          JSON.stringify({
            level,
            name: this.options.name,
            context: this.options.context,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            msg: normalizeValue(item),
            description,
            extra,
          }),
        )
        break
      }
      case null: {
        const tag = `${level.toUpperCase()} (${this.options.name}):`
        const normalizedContext = normalizeValue(this.options.context)
        loggingFunction(
          tag,
          ...(description === undefined ? [] : [description]),
          ...(normalizedContext === undefined
            ? []
            : ["~@ Context:", normalizedContext]),
          ...(extra.length === 0 ? [] : ["~@ Extra:", normalizeValue(extra)]),
          normalizeValue(item),
        )
        break
      }
      default: {
        const exhaustivenessCheck: never = this.options.logFormat
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Not exhaustive: ${exhaustivenessCheck}`)
      }
    }
  }

  private loggerCallback(level: LoggingLevels) {
    return <T = string>(
      item: unknown,
      description?: T,
      ...extra: unknown[]
    ) => {
      return this.log(level, item, description, ...extra)
    }
  }
  info = this.loggerCallback("info")
  warn = this.loggerCallback("warn")
  error = this.loggerCallback("error")
  fatal = this.loggerCallback("fatal")
}
