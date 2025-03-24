import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { ServerZoneType } from '@amplitude/analytics-types'
import fastifyAuth from '@fastify/auth'
import { fastifyAwilixPlugin } from '@fastify/awilix'
import { fastifyCors } from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import type { Secret } from '@fastify/jwt'
import fastifyJWT from '@fastify/jwt'
import fastifySchedule from '@fastify/schedule'
import fastifySwagger from '@fastify/swagger'
import {
  amplitudePlugin,
  bugsnagPlugin,
  commonHealthcheckPlugin,
  getRequestIdFastifyAppConfig,
  metricsPlugin,
  newrelicTransactionManagerPlugin,
  requestContextProviderPlugin,
} from '@lokalise/fastify-extras'
import { type CommonLogger, resolveLogger } from '@lokalise/node-core'
import { resolveGlobalErrorLogObject } from '@lokalise/node-core'
import scalarFastifyApiReference from '@scalar/fastify-api-reference'
import { type AwilixContainer, asFunction, createContainer } from 'awilix'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifyGracefulShutdown from 'fastify-graceful-shutdown'
import fastifyNoIcon from 'fastify-no-icon'
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { merge } from 'ts-deepmerge'
import type { PartialDeep } from 'type-fest'
import { type Config, getConfig, isDevelopment } from './infrastructure/config.js'
import type { DIOptions } from './infrastructure/diConfigUtils.js'
import { errorHandler } from './infrastructure/errors/errorHandler.js'
import {
  dbHealthCheck,
  redisHealthCheck,
} from './infrastructure/healthchecks/healthchecksWrappers.js'
import { SINGLETON_CONFIG, registerDependencies } from './infrastructure/parentDiConfig.js'
import type { DependencyOverrides } from './infrastructure/parentDiConfig.js'
import { getRoutes } from './modules/routes.js'
import { jwtTokenPlugin } from './plugins/jwtTokenPlugin.js'

EventEmitter.defaultMaxListeners = 12

const GRACEFUL_SHUTDOWN_TIMEOUT_IN_MSECS = 10000

export type AppInstance = FastifyInstance<
  http.Server,
  http.IncomingMessage,
  http.ServerResponse,
  CommonLogger
>

export type ConfigOverrides = DIOptions & {
  diContainer?: AwilixContainer
  jwtKeys?: {
    public: Secret
    private: Secret
  }
  healthchecksEnabled?: boolean
  monitoringEnabled?: boolean
} & PartialDeep<Config>

// do not delete // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is intentional. Don't remove.
export async function getApp(
  configOverrides: ConfigOverrides = {},
  dependencyOverrides: DependencyOverrides = {},
): Promise<AppInstance> {
  const config = getConfig()
  const appConfig = config.app
  const logger = resolveLogger(appConfig)
  const enableRequestLogging = ['debug', 'trace'].includes(appConfig.logLevel)

  const app = fastify<http.Server, http.IncomingMessage, http.ServerResponse, CommonLogger>({
    ...getRequestIdFastifyAppConfig(),
    loggerInstance: logger,
    disableRequestLogging: !enableRequestLogging,
  })

  const diContainer =
    configOverrides.diContainer ??
    createContainer({
      injectionMode: 'PROXY',
    })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // In production this should ideally be handled outside of application, e. g.
  // on nginx or kubernetes level, but for local development it is convenient
  // to have these headers set by application.
  // If this service is never called from the browser, this entire block can be removed.
  if (isDevelopment()) {
    await app.register(fastifyCors, {
      origin: '*',
      credentials: true,
      methods: ['GET', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Accept', 'Content-Type', 'Authorization'],
      exposedHeaders: [
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
      ],
    })
  }

  await app.register(
    fastifyHelmet,
    isDevelopment()
      ? {
          contentSecurityPolicy: false,
        }
      : {},
  )

  if (!isDevelopment()) {
    await app.register(fastifyGracefulShutdown, {
      resetHandlersOnInit: true,
      timeout: GRACEFUL_SHUTDOWN_TIMEOUT_IN_MSECS,
    })
  }

  await app.register(fastifyNoIcon.default)

  await app.register(fastifyAuth)
  await app.register(fastifySwagger, {
    transform: createJsonSchemaTransform({
      skipList: [
        '/documentation/',
        '/documentation/initOAuth',
        '/documentation/uiConfig',
        '/documentation/yaml',
        '/documentation/*',
        '/documentation/static/*',
        '*',
      ],
    }),
    openapi: {
      info: {
        title: 'SampleApi',
        description: 'Sample backend service',
        version: '1.0.0',
      },
      servers: [
        {
          url:
            appConfig.baseUrl ||
            `http://${
              appConfig.bindAddress === '0.0.0.0' ? 'localhost' : appConfig.bindAddress
            }:${appConfig.port}`,
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  // Since DI config relies on having app-scoped NewRelic instance to be set by the plugin, we instantiate it earlier than we run the DI initialization.
  await app.register(newrelicTransactionManagerPlugin, {
    isEnabled: config.vendors.newrelic.isEnabled,
  })

  await app.register(scalarFastifyApiReference, {
    routePrefix: '/documentation',
  })

  await app.register(fastifyAwilixPlugin, {
    container: diContainer,
    disposeOnClose: true,
    asyncDispose: true,
    asyncInit: true,
    eagerInject: true,
    disposeOnResponse: false,
  })
  await app.register(fastifySchedule)

  await app.register(fastifyJWT, {
    secret: configOverrides.jwtKeys ?? {
      private: '-', // Private key blank, as this service won't create JWT tokens, only verify them
      public: appConfig.jwtPublicKey,
    },
  })

  await app.register(jwtTokenPlugin, {
    skipList: new Set([
      '/favicon.ico',
      '/login',
      '/access-token',
      '/refresh-token',
      '/documentation',
      '/documentation/',
      '/documentation/openapi.json',
      '/documentation/js/scalar.js',
      '/',
      '/health',
      '/metrics',
    ]),
  })

  app.setErrorHandler(errorHandler)

  const dependencies: DependencyOverrides = configOverrides
    ? {
        ...dependencyOverrides,
        config: asFunction(() => {
          return merge(getConfig(), configOverrides) as Config
        }, SINGLETON_CONFIG),
      }
    : dependencyOverrides

  registerDependencies(
    diContainer,
    {
      app,
      logger: app.log,
    },
    dependencies,
    /**
     * Running consumers and jobs introduces additional overhead and fragility when running tests,
     * so we avoid doing that unless we intend to actually use them
     */
    {
      enqueuedJobsEnabled: configOverrides.enqueuedJobsEnabled,
      enqueuedJobQueuesEnabled: configOverrides.enqueuedJobQueuesEnabled,
      amqpConsumersEnabled: configOverrides.amqpConsumersEnabled,
      arePeriodicJobsEnabled: !!configOverrides.arePeriodicJobsEnabled,
    },
  )

  if (configOverrides.monitoringEnabled) {
    await app.register(metricsPlugin, {
      bindAddress: appConfig.bindAddress,
      errorObjectResolver: resolveGlobalErrorLogObject,
      logger,
      disablePrometheusRequestLogging: true,
    })
  }

  if (configOverrides.healthchecksEnabled !== false) {
    await app.register(commonHealthcheckPlugin, {
      healthChecks: [
        {
          name: 'postgres',
          isMandatory: true,
          checker: dbHealthCheck,
        },
        {
          name: 'redis',
          isMandatory: true,
          checker: redisHealthCheck,
        },
      ],
      responsePayload: {
        version: appConfig.appVersion,
        gitCommitSha: appConfig.gitCommitSha,
      },
    })
  }
  await app.register(requestContextProviderPlugin)

  // Vendor-specific plugins
  await app.register(bugsnagPlugin, {
    isEnabled: config.vendors.bugsnag.isEnabled,
    bugsnag: {
      apiKey: config.vendors.bugsnag.apiKey ?? '',
      releaseStage: appConfig.appEnv,
      appVersion: appConfig.appVersion,
      ...(config.vendors.bugsnag.appType && { appType: config.vendors.bugsnag.appType }),
    },
  })

  await app.register(amplitudePlugin, {
    isEnabled: config.vendors.amplitude.isEnabled,
    apiKey: config.vendors.amplitude.apiKey,
    options: {
      serverZone: config.vendors.amplitude.serverZone as ServerZoneType,
      flushIntervalMillis: config.vendors.amplitude.flushIntervalMillis,
      flushMaxRetries: config.vendors.amplitude.flushMaxRetries,
      flushQueueSize: config.vendors.amplitude.flushQueueSize,
    },
  })

  app.after(() => {
    // Register routes
    const { routes } = getRoutes()
    for (const route of routes) {
      app.withTypeProvider<ZodTypeProvider>().route(route)
    }

    // Graceful shutdown hook
    if (!isDevelopment()) {
      app.gracefulShutdown((_signal) => {
        app.log.info('Starting graceful shutdown')
        return Promise.resolve()
      })
    }
  })

  try {
    await app.ready()
  } catch (err) {
    app.log.error('Error while initializing app: ', err)
    throw err
  }

  return app
}
