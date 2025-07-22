const { spawn } = require('child_process')
const path = require('path')

const test = require('brittle')
const promClient = require('prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const hypCrypto = require('hypercore-crypto')
const NewlineDecoder = require('newline-decoder')

const DhtPromClient = require('./index')
const Scraper = require('./scraper')
const ProtomuxRpcClient = require('protomux-rpc-client')

const EXAMPLE_PATH = path.join(__dirname, 'example.js')

test('Scraper can get metrics', async t => {
  t.plan(10)
  const { dhtPromClient, scraperProtomuxRpcClient, scraperPubKey } = await setup(t)

  const infoMessages = []
  const debugMessages = []
  dhtPromClient.registerLogger({
    info: msg => {
      infoMessages.push(msg)
    },
    debug: msg => {
      debugMessages.push(msg)
    },
    level: 'debug'
  })

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid, remotePublicKey }) => {
    reqUid = uid
    t.alike(
      remotePublicKey,
      scraperPubKey,
      'metrics-request emitted'
    )
  })

  dhtPromClient.on('metrics-success', ({ uid }) => {
    t.is(uid, reqUid, 'metrics-success emitted with same uid')
  })

  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperProtomuxRpcClient, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics.includes('process_cpu_system_seconds_total'),
    true,
    'Got prometheus metrics'
  )

  // log messages (subset hit in this test)

  // Note: if the test takes very long we might see the 'failed to register alias' message
  t.is(infoMessages.length, 2, 'no unexpected info messages')
  t.ok(infoMessages[0].includes('Prom client attempting to register dummy-alias'), 'alias-attempt log')

  t.ok(infoMessages[1].includes('Prom client opened connection to'), 'connection-open log')

  t.is(debugMessages.length, 2, 'No unexpected messages')
  t.ok(debugMessages[0].includes('Prom client received metrics request from'), 'metric req received log')
  t.ok(debugMessages[1].includes('Prom client successfully processed metrics request'), 'metric req processed log')
})

test('Can pass own getMetrics', async t => {
  const bootstrap = await setupTestnet(t)

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })
  const rpcClient = new ProtomuxRpcClient(dht, { requestTimeout: 1000, backoffValues: [100, 250, 500] })

  const { scraperProtomuxRpcClient, scraperPubKey } = await setupscraperRpcClient(t, bootstrap)
  const getMetrics = () => 'Some metrics'
  const dhtPromClient = new DhtPromClient(dht, rpcClient, getMetrics, scraperPubKey, 'dummy-alias', dummySecret)
  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperProtomuxRpcClient, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics === 'Some metrics',
    true,
    'Got prometheus metrics'
  )

  await scraperProtomuxRpcClient.close()
  await rpcClient.close()
  await dhtPromClient.close()
})

test('Scraper can timeout', async t => {
  const bootstrap = await setupTestnet(t)

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })
  const rpcClient = new ProtomuxRpcClient(dht, { requestTimeout: 1000, backoffValues: [100, 250, 500] })

  const { scraperProtomuxRpcClient, scraperPubKey } = await setupscraperRpcClient(t, bootstrap)
  const getMetrics = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    return 'late reply'
  }
  const dhtPromClient = new DhtPromClient(dht, rpcClient, getMetrics, scraperPubKey, 'dummy-alias', dummySecret)
  await dhtPromClient.ready()

  const scraper = await setupScraper(
    t,
    scraperProtomuxRpcClient,
    dhtPromClient
  )

  await t.exception(
    async () => scraper.requestMetrics({ timeout: 50 }),
    /REQUEST_TIMEOUT/,
    'Timeout error'
  )

  await dhtPromClient.close()
  await rpcClient.close()
})

test('Other clients cannot get metrics', async t => {
  t.plan(3)

  const { dhtPromClient, bootstrap } = await setup(t)

  const infoMessages = []
  dhtPromClient.registerLogger({
    info: msg => {
      infoMessages.push(msg)
    }
  })

  await dhtPromClient.ready()

  const { scraperProtomuxRpcClient, scraperPubKey: otherPubKey } = await setupscraperRpcClient(t, bootstrap)

  dhtPromClient.on('firewall-block', async ({ payload, remotePublicKey, address }) => {
    t.alike(
      remotePublicKey,
      otherPubKey,
      'Firewall blocked the request'
    )
  })

  const scraper = await setupScraper(t, scraperProtomuxRpcClient, dhtPromClient)

  await t.exception(
    async () => scraper.requestMetrics(),
    /REQUEST_TIMEOUT/,
    'Client cannot connect'
  )

  t.ok(infoMessages[1].includes('Firewall blocked unauthorised connection attempt from'), 'firewall-block log')
})

test('client regularly re-registers itself', async t => {
  t.plan(10)

  let nrAttempts = 0
  const { dhtPromClient } = await setup(t, { registerIntervalMs: 200 })
  dhtPromClient.aliasClient.on(
    'alias-attempt',
    ({ alias, targetKey, hostname, service }) => {
      if (nrAttempts++ >= 2) return
      t.is(alias, 'dummy-alias', 'correct alias')
      t.alike(targetKey, dhtPromClient.publicKey, 'correct key')
      t.is(hostname, 'my-hostname', 'correct hostname')
      t.is(service, 'my-service', 'correct service')
    }
  )

  let nrRegisterErrors = 0
  dhtPromClient.on('register-alias-error', () => {
    nrRegisterErrors++
    if (nrRegisterErrors === 1) t.pass('init register (sanity check)')
    else if (nrRegisterErrors === 2) {
      t.pass('re-registered')
      t.end()
    }
  })

  await dhtPromClient.ready()
})

test('Error handling when getting metrics throws', async t => {
  t.plan(5)
  const { dhtPromClient, scraperProtomuxRpcClient } = await setup(t)

  const infoMessages = []
  dhtPromClient.registerLogger({
    info: msg => {
      infoMessages.push(msg)
    },
    debug: () => {}
  })

  new promClient.Gauge({ // eslint-disable-line no-new
    name: 'broken_metric',
    help: 'A metric which throws on collecting it',
    collect () {
      throw new Error('I break stuff')
    }
  })

  await dhtPromClient.ready()

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid, remotePublicKey }) => {
    reqUid = uid
  })

  dhtPromClient.on('metrics-error', ({ uid, error }) => {
    t.is(uid, reqUid, 'metrics-error emitted with same uid')
    t.is(error.message, 'I break stuff', 'Correct error on event')
  })

  const scraper = await setupScraper(t, scraperProtomuxRpcClient, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, false, 'no success on error')

  const errorMessage = res.errorMessage
  t.is(
    errorMessage,
    `Failed to obtain metrics (uid ${reqUid})`,
    'Expected error message (no inside info)'
  )

  t.ok(infoMessages[2].includes('Prom client failed to process metrics request'), 'metrics-error log')
})

test('scrape with different versions', async t => {
  const { dhtPromClient, scraperProtomuxRpcClient } = await setup(t)

  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperProtomuxRpcClient, dhtPromClient)

  try {
    await scraper.requestMetrics({ major: 1000 })
    t.fail()
  } catch (e) {
    t.is(e.code, 'DECODE_ERROR')
    t.is(e.cause.message.includes('Cannot decode RegisterRequest of other major version'), true)
  }

  try {
    await scraper.requestMetrics({ minor: 1000 })
    t.fail()
  } catch (e) {
    t.is(e.code, 'DECODE_ERROR')
    t.is(e.cause.message.includes('Cannot decode RegisterRequest of higher minor version'), true)
  }
})

test('Example works (sanity check)', async t => {
  t.plan(3)

  const exProc = spawn(
    process.execPath,
    [EXAMPLE_PATH]
  )

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    // TODO: unset this handler on clean run
    exProc.kill('SIGKILL')
  })

  exProc.stderr.on('data', d => {
    console.error(d.toString())
    t.fail('There should be no stderr')
  })

  const lines = []
  const stdoutDec = new NewlineDecoder('utf-8')
  exProc.stdout.on('data', async d => {
    for (const line of stdoutDec.push(d)) {
      lines.push(line)
    }
  })

  exProc.on('close', (code) => {
    const output = lines.join('')
    t.is(code, 0, 'example process exited cleanly')
    t.is(output.includes('success: true'), true, 'success metrics result')
    t.is(output.includes('process_cpu_user_seconds_total'), true, 'sanity check: includes metrics')
  })
})

async function setup (t, clientOpts = {}) {
  promClient.collectDefaultMetrics() // So we have something to scrape
  t.teardown(() => promClient.register.clear())

  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })
  const scraperDht = new HyperDHT({ bootstrap })
  const scraperProtomuxRpcClient = new ProtomuxRpcClient(scraperDht, { requestTimeout: 1000, backoffValues: [100, 250, 500] })
  const scraperPubKey = scraperDht.defaultKeyPair.publicKey
  const protomuxRpcClient = new ProtomuxRpcClient(dht, { requestTimeout: 1000, backoffValues: [100, 250, 500] })
  const dhtPromClient = new DhtPromClient(
    dht,
    protomuxRpcClient,
    promClient,
    scraperPubKey,
    'dummy-alias',
    dummySecret,
    'my-service',
    { ...clientOpts, hostname: 'my-hostname' }
  )

  t.teardown(async () => {
    await dhtPromClient.close()
    await protomuxRpcClient.close()
    await scraperProtomuxRpcClient.close()
    await scraperDht.destroy()
    await testnet.destroy()
  })

  return { dhtPromClient, scraperPubKey, scraperProtomuxRpcClient, bootstrap }
}

async function setupScraper (t, protomuxRpcClient, dhtPromClient, opts = {}) {
  const scraper = new Scraper(protomuxRpcClient, dhtPromClient.publicKey, opts)
  await new Promise(resolve => setTimeout(resolve, 250)) // scraper.swarm.flush() // For race conditions
  return scraper
}

async function setupscraperRpcClient (t, bootstrap) {
  const scraperDht = new HyperDHT({ bootstrap })
  const scraperProtomuxRpcClient = new ProtomuxRpcClient(scraperDht, { requestTimeout: 1000, backoffValues: [100, 250, 500] })
  t.teardown(async () => {
    await scraperProtomuxRpcClient.close()
    await scraperDht.destroy()
  })

  const scraperPubKey = scraperDht.defaultKeyPair.publicKey
  return { scraperProtomuxRpcClient, scraperPubKey }
}

async function setupTestnet (t) {
  const testnet = await createTestnet()
  t.teardown(async () => {
    await testnet.destroy()
  }, { order: 9999999 })
  return testnet.bootstrap
}
