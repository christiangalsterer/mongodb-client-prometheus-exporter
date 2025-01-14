import type {
  CommandFailedEvent,
  CommandSucceededEvent,
  ConnectionCheckedInEvent,
  ConnectionCheckedOutEvent,
  ConnectionCheckOutFailedEvent,
  ConnectionCheckOutStartedEvent,
  ConnectionClosedEvent,
  ConnectionCreatedEvent,
  ConnectionPoolClosedEvent,
  ConnectionPoolCreatedEvent,
  MongoClient
} from 'mongodb'
import { Gauge, Histogram, type Registry } from 'prom-client'

import type { MongoDBDriverExporterOptions } from './exporter'
import { mergeLabelNamesWithStandardLabels, mergeLabelsWithStandardLabels } from './utils'

const MILLISECONDS_IN_A_SECOND = 1000
const METRIC_INITIAL_ZERO = 0

export class MongoDBDriverExporter {
  private readonly register: Registry
  private readonly mongoClient: MongoClient
  private readonly options: MongoDBDriverExporterOptions
  private readonly defaultOptions: MongoDBDriverExporterOptions = {
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    mongodbDriverCommandsSecondsHistogramBuckets: [0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    waitQueueSecondsHistogramBuckets: [0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]
  }

  // pool metrics
  private readonly poolSize: Gauge
  private readonly minSize: Gauge
  private readonly maxSize: Gauge
  private readonly checkedOut: Gauge
  private readonly waitQueueSize: Gauge
  private readonly waitQueueSeconds: Histogram

  private readonly MONGODB_DRIVER_POOL_SIZE = 'mongodb_driver_pool_size'
  private readonly MONGODB_DRIVER_POOL_MIN = 'mongodb_driver_pool_min'
  private readonly MONGODB_DRIVER_POOL_MAX = 'mongodb_driver_pool_max'
  private readonly MONGODB_DRIVER_POOL_CHECKEDOUT = 'mongodb_driver_pool_checkedout'
  private readonly MONGODB_DRIVER_POOL_WAITQUEUESIZE = 'mongodb_driver_pool_waitqueuesize'
  private readonly MONGODB_DRIVER_POOL_WAITQUEUE_SECONDS = 'mongodb_driver_pool_waitqueue_seconds'

  // command metrics
  private readonly commands: Histogram
  private readonly MONGODB_DRIVER_COMMANDS_SECONDS = 'mongodb_driver_commands_seconds'

  constructor(mongoClient: MongoClient, register: Registry, options?: MongoDBDriverExporterOptions) {
    this.mongoClient = mongoClient
    this.register = register
    this.options = { ...this.defaultOptions, ...options }

    const prefix = options?.prefix ?? ''

    const poolSizeMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_SIZE}`)
    this.poolSize =
      poolSizeMetric instanceof Gauge
        ? poolSizeMetric
        : new Gauge({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_SIZE}`,
            help: 'the current size of the connection pool, including idle and in-use members',
            labelNames: mergeLabelNamesWithStandardLabels(['server_address'], this.options.defaultLabels),
            registers: [this.register]
          })

    const minSizeMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_MIN}`)
    this.minSize =
      minSizeMetric instanceof Gauge
        ? minSizeMetric
        : new Gauge({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_MIN}`,
            help: 'the minimum size of the connection pool',
            labelNames: mergeLabelNamesWithStandardLabels(['server_address'], this.options.defaultLabels),
            registers: [this.register]
          })

    const maxSizeMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_MAX}`)
    this.maxSize =
      maxSizeMetric instanceof Gauge
        ? maxSizeMetric
        : new Gauge({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_MAX}`,
            help: 'the maximum size of the connection pool',
            labelNames: mergeLabelNamesWithStandardLabels(['server_address'], this.options.defaultLabels),
            registers: [this.register]
          })

    const checkedOutMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_CHECKEDOUT}`)
    this.checkedOut =
      checkedOutMetric instanceof Gauge
        ? checkedOutMetric
        : new Gauge({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_CHECKEDOUT}`,
            help: 'the count of connections that are currently in use',
            labelNames: mergeLabelNamesWithStandardLabels(['server_address'], this.options.defaultLabels),
            registers: [this.register]
          })

    const waitQueueSizeMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_WAITQUEUESIZE}`)
    this.waitQueueSize =
      waitQueueSizeMetric instanceof Gauge
        ? waitQueueSizeMetric
        : new Gauge({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_WAITQUEUESIZE}`,
            help: 'the current size of the wait queue for a connection from the pool',
            labelNames: mergeLabelNamesWithStandardLabels(['server_address'], this.options.defaultLabels),
            registers: [this.register]
          })

    const waitQueueSecondsMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_POOL_WAITQUEUE_SECONDS}`)
    this.waitQueueSeconds =
      waitQueueSecondsMetric instanceof Histogram
        ? waitQueueSecondsMetric
        : new Histogram({
            name: `${prefix}${this.MONGODB_DRIVER_POOL_WAITQUEUE_SECONDS}`,
            help: 'Duration of waiting for a connection from the pool',
            buckets: this.options.waitQueueSecondsHistogramBuckets,
            labelNames: mergeLabelNamesWithStandardLabels(['server_address', 'status'], this.options.defaultLabels),
            registers: [this.register]
          })

    if (this.monitorCommands()) {
      const commandsMetric = this.register.getSingleMetric(`${prefix}${this.MONGODB_DRIVER_COMMANDS_SECONDS}`)
      this.commands =
        commandsMetric instanceof Histogram
          ? commandsMetric
          : new Histogram({
              name: `${prefix}${this.MONGODB_DRIVER_COMMANDS_SECONDS}`,
              help: 'Timer of mongodb commands',
              buckets: this.options.mongodbDriverCommandsSecondsHistogramBuckets,
              labelNames: mergeLabelNamesWithStandardLabels(['command', 'server_address', 'status'], this.options.defaultLabels),
              registers: [this.register]
            })
    }
  }

  enableMetrics(): void {
    this.mongoClient.on('connectionPoolCreated', (event) => {
      this.onConnectionPoolCreated(event)
    })
    this.mongoClient.on('connectionPoolClosed', (event) => {
      this.onConnectionPoolClosed(event)
    })
    this.mongoClient.on('connectionCreated', (event) => {
      this.onConnectionCreated(event)
    })
    this.mongoClient.on('connectionClosed', (event) => {
      this.onConnectionClosed(event)
    })
    this.mongoClient.on('connectionCheckOutStarted', (event) => {
      this.onConnectionCheckOutStarted(event)
    })
    this.mongoClient.on('connectionCheckedOut', (event) => {
      this.onConnectionCheckedOut(event)
    })
    this.mongoClient.on('connectionCheckOutFailed', (event) => {
      this.onConnectionCheckOutFailed(event)
    })
    this.mongoClient.on('connectionCheckedIn', (event) => {
      this.onConnectionCheckedIn(event)
    })
    this.options.logger?.info('Successfully enabled connection pool metrics for the MongoDB Node.js driver.')

    // command metrics
    if (this.monitorCommands()) {
      this.mongoClient.on('commandSucceeded', (event) => {
        this.onCommandSucceeded(event)
      })
      this.mongoClient.on('commandFailed', (event) => {
        this.onCommandFailed(event)
      })
      this.options.logger?.info('Successfully enabled command metrics for the MongoDB Node.js driver.')
    }
  }

  private monitorCommands(): boolean {
    return this.mongoClient.options.monitorCommands.valueOf()
  }

  private onConnectionPoolCreated(event: ConnectionPoolCreatedEvent): void {
    this.poolSize.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), METRIC_INITIAL_ZERO)
    this.minSize.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), event.options.minPoolSize)
    this.maxSize.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), event.options.maxPoolSize)
    this.checkedOut.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), METRIC_INITIAL_ZERO)
    this.waitQueueSize.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), METRIC_INITIAL_ZERO)
  }

  private onConnectionCreated(event: ConnectionCreatedEvent): void {
    this.poolSize.inc(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
  }

  private onConnectionClosed(event: ConnectionClosedEvent): void {
    this.poolSize.dec(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
  }

  private onConnectionCheckOutStarted(event: ConnectionCheckOutStartedEvent): void {
    this.waitQueueSize.inc(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
  }

  private onConnectionCheckedOut(event: ConnectionCheckedOutEvent): void {
    this.checkedOut.inc(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
    this.waitQueueSize.dec(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (event.durationMS !== undefined) {
      // conditional observation for backward compatibility with `mongodb` <6.9.0
      this.waitQueueSeconds.observe(
        mergeLabelsWithStandardLabels({ server_address: event.address, status: 'SUCCESS' }, this.options.defaultLabels),
        event.durationMS / MILLISECONDS_IN_A_SECOND
      )
    }
  }

  private onConnectionCheckOutFailed(event: ConnectionCheckOutFailedEvent): void {
    this.waitQueueSize.dec(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (event.durationMS !== undefined) {
      // conditional observation for backward compatibility with `mongodb` <6.9.0
      this.waitQueueSeconds.observe(
        mergeLabelsWithStandardLabels({ server_address: event.address, status: 'FAILED' }, this.options.defaultLabels),
        event.durationMS / MILLISECONDS_IN_A_SECOND
      )
    }
  }

  private onConnectionCheckedIn(event: ConnectionCheckedInEvent): void {
    this.checkedOut.dec(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels))
  }

  private onConnectionPoolClosed(event: ConnectionPoolClosedEvent): void {
    this.poolSize.set(mergeLabelsWithStandardLabels({ server_address: event.address }, this.options.defaultLabels), METRIC_INITIAL_ZERO)
    this.minSize.reset()
    this.maxSize.reset()
    this.checkedOut.reset()
    this.waitQueueSize.reset()
  }

  private onCommandSucceeded(event: CommandSucceededEvent): void {
    this.commands.observe(
      mergeLabelsWithStandardLabels({ command: event.commandName, server_address: event.address, status: 'SUCCESS' }, this.options.defaultLabels),
      event.duration / MILLISECONDS_IN_A_SECOND
    )
  }

  private onCommandFailed(event: CommandFailedEvent): void {
    this.commands.observe(
      mergeLabelsWithStandardLabels({ command: event.commandName, server_address: event.address, status: 'FAILED' }, this.options.defaultLabels),
      event.duration / MILLISECONDS_IN_A_SECOND
    )
  }
}
