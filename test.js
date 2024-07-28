const test = require('brittle')
const promClient = require('prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const hypCrypto = require('hypercore-crypto')

const DhtPromClient = require('./index')
const Scraper = require('./scraper')

test('Scraper can get metrics', async t => {
  t.plan(4)
  const { dhtPromClient, scraperSwarm } = await setup(t)

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

  const res = await scraper.lookup()
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics.includes('process_cpu_system_seconds_total'),
    true,
    'Got prometheus metrics'
  )
})

test('Can pass own getMetrics', async t => {
  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const dummySecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })
  const scraperSwarm = new Hyperswarm({ bootstrap })
  const scraperPubKey = scraperSwarm.keyPair.publicKey
  const getMetrics = () => 'Some metrics'
  const dhtPromClient = new DhtPromClient(dht, getMetrics, scraperPubKey, 'dummy-alias', dummySecret, { bootstrap })
  await dhtPromClient.ready()

  const scraper = await setupScraper(t, scraperSwarm, dhtPromClient)

  const res = await scraper.lookup()
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

test('Other clients cannot get metrics', async t => {
  t.plan(2)

  const { dhtPromClient, bootstrap } = await setup(t)

  await dhtPromClient.ready()

  const otherSwarm = new Hyperswarm({ bootstrap })

  dhtPromClient.on('firewall-block', async ({ remotePublicKey }) => {
    t.alike(
      remotePublicKey,
      otherSwarm.keyPair.publicKey,
      'Firewall blocked the request'
    )

    await otherSwarm.destroy()
  })

  const scraper = await setupScraper(t, otherSwarm, dhtPromClient)

  await t.exception(
    async () => scraper.lookup(),
    /Not connected/,
    'Client cannot connect'
  )
})

test('client regularly re-registers itself', async t => {
  t.plan(10)

  const { dhtPromClient } = await setup(t, { registerIntervalMs: 200 })
  dhtPromClient.aliasClient.on(
    'register-alias-attempt',
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
  t.plan(4)
  const { dhtPromClient, scraperSwarm } = await setup(t)

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

  const res = await scraper.lookup()
  t.is(res.success, false, 'no success on error')

  const errorMessage = res.errorMessage
  t.is(
    errorMessage,
    `Failed to obtain metrics (uid ${reqUid})`,
    'Expected error message (no inside info)'
  )
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
    { ...clientOpts, bootstrap, hostname: 'my-hostname' }
  )

  t.teardown(async () => {
    await dhtPromClient.close()
    await scraperSwarm.destroy()
    await testnet.destroy()
  })

  return { dhtPromClient, scraperSwarm, bootstrap }
}

async function setupScraper (t, scraperSwarm, dhtPromClient) {
  const scraper = new Scraper(scraperSwarm, dhtPromClient.publicKey)

  t.teardown(async () => await scraper.close())

  await scraper.ready()
  await scraper.swarm.flush() // For race conditions

  return scraper
}
