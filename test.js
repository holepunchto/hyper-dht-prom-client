const { spawn } = require('child_process')
const path = require('path')

const test = require('brittle')
const promClient = require('prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const hypCrypto = require('hypercore-crypto')
const NewlineDecoder = require('newline-decoder')

const DhtPromClient = require('./index')
const Scraper = require('./scraper')

const EXAMPLE_PATH = path.join(__dirname, 'example.js')

test('Scraper can get metrics', async t => {
  t.plan(11)
  const { dhtPromClient, scraperSwarm } = await setup(t)

  const infoMessages = []
  const debugMessages = []
  dhtPromClient.registerLogger({
    info: msg => {
      infoMessages.push(msg)
    },
    debug: msg => {
      debugMessages.push(msg)
    }
  })

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid, remotePublicKey }) => {
    reqUid = uid
    t.alike(
      remotePublicKey,
      scraperSwarm.keyPair.publicKey,
      'metrics-request emitted'
    )
  })

  dhtPromClient.on('metrics-success', ({ uid }) => {
    t.is(uid, reqUid, 'metrics-success emitted with same uid')
  })

  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperSwarm, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics.includes('process_cpu_system_seconds_total'),
    true,
    'Got prometheus metrics'
  )

  // log messages (subset hit in this test)

  t.is(infoMessages.length, 3, 'no unexpected info messages')
  t.ok(infoMessages[0].includes('Prom client attempting to register dummy-alias'), 'alias-attempt log')

  // Since there is no alias service, it errors
  t.ok(infoMessages[1].includes('Prom client failed to register alias Error'), 'alias-error log')
  t.ok(infoMessages[2].includes('Prom client opened connection to'), 'connection-open log')

  t.is(debugMessages.length, 2, 'No unexpected messages')
  t.ok(debugMessages[0].includes('Prom client received metrics request from'), 'metric req received log')
  t.ok(debugMessages[1].includes('Prom client successfully processed metrics request'), 'metric req processed log')
})

test('Can pass own getMetrics', async t => {
  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })

  const scraperSwarm = new Hyperswarm({ bootstrap })
  const scraperPubKey = scraperSwarm.keyPair.publicKey
  const getMetrics = () => 'Some metrics'
  const dhtPromClient = new DhtPromClient(dht, getMetrics, scraperPubKey, 'dummy-alias', dummySecret)
  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperSwarm, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics === 'Some metrics',
    true,
    'Got prometheus metrics'
  )

  await scraperSwarm.destroy()
  await dhtPromClient.close()
  await testnet.destroy()
})

test('Scraper can timeout', async t => {
  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })

  const scraperSwarm = new Hyperswarm({ bootstrap })
  const scraperPubKey = scraperSwarm.keyPair.publicKey
  const getMetrics = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    return 'late reply'
  }
  const dhtPromClient = new DhtPromClient(dht, getMetrics, scraperPubKey, 'dummy-alias', dummySecret)
  await dhtPromClient.ready()

  const scraper = await setupScraper(
    t,
    scraperSwarm,
    dhtPromClient,
    { requestTimeoutMs: 50 }
  )

  await t.exception(
    async () => scraper.requestMetrics(),
    /TIMEOUT_EXCEEDED/,
    'Timeout error'
  )

  await scraperSwarm.destroy()
  await dhtPromClient.close()
  await testnet.destroy()
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

  const otherSwarm = new Hyperswarm({ bootstrap })

  dhtPromClient.on('firewall-block', async ({ payload, remotePublicKey, address }) => {
    t.alike(
      remotePublicKey,
      otherSwarm.keyPair.publicKey,
      'Firewall blocked the request'
    )
    console.log(payload, address)
    await otherSwarm.destroy()
  })

  const scraper = await setupScraper(t, otherSwarm, dhtPromClient)

  await t.exception(
    async () => scraper.requestMetrics(),
    /Not connected/,
    'Client cannot connect'
  )

  t.ok(infoMessages[2].includes('Firewall blocked unauthorised connection attempt from'), 'firewall-block log')
})

test('client regularly re-registers itself', async t => {
  t.plan(10)

  const { dhtPromClient } = await setup(t, { registerIntervalMs: 200 })
  dhtPromClient.aliasClient.on(
    'alias-attempt',
    ({ alias, targetKey, hostname, service }) => {
      t.is(alias, 'dummy-alias', 'correct alias')
      t.alike(targetKey, dhtPromClient.publicKey, 'correct key')
      t.is(hostname, 'my-hostname', 'correct hostname')
      t.is(service, 'my-service', 'correct service')
    }
  )

  let nrRegisterAttempts = 0
  dhtPromClient.on('register-alias-error', () => {
    nrRegisterAttempts++
    if (nrRegisterAttempts === 1) t.pass('init register (sanity check)')
    else if (nrRegisterAttempts === 2) {
      t.pass('re-registered')
      t.end()
    }
  })

  await dhtPromClient.ready()
})

test('Error handling when getting metrics throws', async t => {
  t.plan(5)
  const { dhtPromClient, scraperSwarm } = await setup(t)

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

  const scraper = await setupScraper(t, scraperSwarm, dhtPromClient)

  const res = await scraper.requestMetrics()
  t.is(res.success, false, 'no success on error')

  const errorMessage = res.errorMessage
  t.is(
    errorMessage,
    `Failed to obtain metrics (uid ${reqUid})`,
    'Expected error message (no inside info)'
  )

  t.ok(infoMessages[3].includes('Prom client failed to process metrics request'), 'metrics-error log')
})

test('scrape with different versions', async t => {
  const { dhtPromClient, scraperSwarm } = await setup(t)

  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperSwarm, dhtPromClient)
  await scraper.ready()
  // const res = await scraper.requestMetrics({ major: 1000 })
  // console.log(res)

  await t.exception(
    async () => await scraper.requestMetrics({ major: 1000 }),
    /other major version/,
    'Cannot use other major version'
  )

  await t.exception(
    async () => await scraper.requestMetrics({ minor: 1000 }),
    /higher minor version/,
    'Cannot use higher minor version'
  )

  await scraper.close()
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
  const scraperSwarm = new Hyperswarm({ bootstrap })
  const scraperPubKey = scraperSwarm.keyPair.publicKey
  const dhtPromClient = new DhtPromClient(
    dht,
    promClient,
    scraperPubKey,
    'dummy-alias',
    dummySecret,
    'my-service',
    { ...clientOpts, hostname: 'my-hostname' }
  )

  t.teardown(async () => {
    await dhtPromClient.close()
    await scraperSwarm.destroy()
    await testnet.destroy()
  })

  return { dhtPromClient, scraperSwarm, bootstrap }
}

async function setupScraper (t, scraperSwarm, dhtPromClient, opts = {}) {
  const scraper = new Scraper(scraperSwarm, dhtPromClient.publicKey, opts)

  t.teardown(async () => await scraper.close())

  await scraper.ready()
  await scraper.swarm.flush() // For race conditions

  return scraper
}
