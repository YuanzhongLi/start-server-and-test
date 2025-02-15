// @ts-check
'use strict'

const la = require('lazy-ass')
const is = require('check-more-types')
const execa = require('execa')
const waitOn = require('wait-on')
const Promise = require('bluebird')
const psTree = require('ps-tree')
const debug = require('debug')('start-server-and-test')

/**
 * Used for timeout (ms)
 */
const fiveMinutes = 5 * 60 * 1000
const waitOnTimeout = process.env.WAIT_ON_TIMEOUT
  ? Number(process.env.WAIT_ON_TIMEOUT)
  : fiveMinutes

const isDebug = () =>
  process.env.DEBUG && process.env.DEBUG.indexOf('start-server-and-test') !== -1

const endServerAfterTest = true && !(process.env.END_SERVER == "false")

const isInsecure = () => process.env.START_SERVER_AND_TEST_INSECURE

function waitAndRun ({ start, url, runFn }) {
  la(is.unemptyString(start), 'missing start script name', start)
  la(is.fn(runFn), 'missing test script name', runFn)
  la(
    is.unemptyString(url) || is.unemptyArray(url),
    'missing url to wait on',
    url
  )

  debug('starting server with command "%s", verbose mode?', start, isDebug())

  const server = execa(start, { shell: true, stdio: 'inherit' })
  let serverStopped

  function stopServer () {
    debug('getting child processes')
    if (!serverStopped) {
      serverStopped = true
      return Promise.fromNode(cb => psTree(server.pid, cb))
        .then(children => {
          debug('stopping child processes')
          children.forEach(child => {
            try {
              process.kill(child.PID, 'SIGINT')
            } catch (e) {
              if (e.code === 'ESRCH') {
                console.log(
                  `Child process ${child.PID} exited before trying to stop it`
                )
              } else {
                throw e
              }
            }
          })
        })
        .then(() => {
          debug('stopping server')
          server.kill()
        })
    }
  }

  const waited = new Promise((resolve, reject) => {
    const onClose = () => {
      reject(new Error('server closed unexpectedly'))
    }

    server.on('close', onClose)

    debug('starting waitOn %s', url)
    const options = {
      resources: Array.isArray(url) ? url : [url],
      interval: 2000,
      window: 1000,
      timeout: waitOnTimeout,
      verbose: isDebug(),
      strictSSL: !isInsecure(),
      log: isDebug(),
      headers: {
        Accept: 'text/html, application/json, text/plain, */*'
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    }
    debug('wait-on options %o', options)

    waitOn(options, err => {
      if (err) {
        debug('error waiting for url', url)
        debug(err.message)
        return reject(err)
      }
      debug('waitOn finished successfully')
      server.removeListener('close', onClose)
      resolve()
    })
  })

  return waited
    .tapCatch(stopServer)
    .then(runFn)
    .finally(() => {
      if (endServerAfterTest) { stopServer(); }
    })
}

const runTheTests = testCommand => () => {
  debug('running test script command: %s', testCommand)
  return execa(testCommand, { shell: true, stdio: 'inherit' })
}

/**
 * Starts a single service and runs tests or recursively
 * runs a service, then goes to the next list, until it reaches 1 service and runs test.
 */
function startAndTest ({ services, test }) {
  if (services.length === 0) {
    throw new Error('Got zero services to start ...')
  }

  if (services.length === 1) {
    const runTests = runTheTests(test)
    debug('single service "%s" to run and test', services[0].start)
    return waitAndRun({
      start: services[0].start,
      url: services[0].url,
      runFn: runTests
    })
  }

  return waitAndRun({
    start: services[0].start,
    url: services[0].url,
    runFn: () => {
      debug('previous service started, now going to the next one')
      return startAndTest({ services: services.slice(1), test })
    }
  })
}

module.exports = {
  startAndTest
}
