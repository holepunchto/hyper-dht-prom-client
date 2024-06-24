const test = require('brittle')
const promClient = require('prom-client')
const createTestnet = require('hyperdht/testnet')
const RPC = require('protomux-rpc')
const { once } = require('events')
const safetyCatch = require('safety-catch')

const DhtPromClient = require('./index')
const HyperDHT = require('hyperdht')
const { MetricsReplyEnc } = require('./lib/encodings')

test('Scraper can get metrics', async t => {
  t.plan(4)
  const { dhtPromClient, scraperDht } = await setup(t)

  await dhtPromClient.ready()
  const clientKey = dhtPromClient.publicKey

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid, remotePublicKey }) => {
    reqUid = uid
    t.alike(
      remotePublicKey,
      scraperDht.defaultKeyPair.publicKey,
      'metrics-request emitted'
    )
  })

  dhtPromClient.on('metrics-success', ({ uid }) => {
    t.is(uid, reqUid, 'metrics-success emitted with same uid')
  })

  const res = await lookup(scraperDht, clientKey)
  t.is(res.success, true, 'Success is true')

  const metrics = res.metrics
  t.is(
    metrics.includes('process_cpu_system_seconds_total'),
    true,
    'Got prometheus metrics'
  )
})

test('Other clients cannot get metrics', async t => {
  t.plan(1)

  const { dhtPromClient, bootstrap } = await setup(t)

  await dhtPromClient.ready()
  const clientKey = dhtPromClient.publicKey

  const otherDht = new HyperDHT({ bootstrap })

  dhtPromClient.on('firewall-block', async ({ remotePublicKey }) => {
    t.alike(
      remotePublicKey,
      otherDht.defaultKeyPair.publicKey,
      'Firewall blocked the request'
    )

    await otherDht.destroy().catch(safetyCatch)
  })

  // Expected to throw a PEER_NOT_FOUND error after ~5s
  const lookupProm = lookup(otherDht, clientKey)
  lookupProm.catch(safetyCatch)
  // TODO: find a way to make it throw faster, and
  // test for it explicitly
})

test('Error handling when getting metrics throws', async t => {
  t.plan(4)
  const { dhtPromClient, scraperDht } = await setup(t)

  new promClient.Gauge({ // eslint-disable-line no-new
    name: 'broken_metric',
    help: 'A metric which throws on collecting it',
    collect () {
      throw new Error('I break stuff')
    }
  })

  await dhtPromClient.ready()

  const clientKey = dhtPromClient.publicKey

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid, remotePublicKey }) => {
    reqUid = uid
  })

  dhtPromClient.on('metrics-error', ({ uid, error }) => {
    t.is(uid, reqUid, 'metrics-error emitted with same uid')
    t.is(error.message, 'I break stuff', 'Correct error on event')
  })

  const res = await lookup(scraperDht, clientKey)
  t.is(res.success, false, 'no success on error')

  const errorMessage = res.errorMessage
  t.is(
    errorMessage,
    `Failed to obtain metrics (uid ${reqUid})`,
    'Expected error message (no inside info)'
  )
})

async function lookup (dht, key) {
  // TODO: expose a proper client method as part of the API
  const socket = dht.connect(key)
  socket.on('error', safetyCatch)

  await socket.opened

  if (!socket.connected) {
    throw new Error('Could not open socket')
  }

  const rpc = new RPC(socket, { protocol: 'prometheus-metrics' })
  await once(rpc, 'open')

  const res = await rpc.request(
    'metrics',
    null,
    { responseEncoding: MetricsReplyEnc }
  )

  return res
}

async function setup (t) {
  promClient.collectDefaultMetrics() // So we have something to scrape
  t.teardown(() => promClient.register.clear())

  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const dht = new HyperDHT({ bootstrap })
  const scraperDht = new HyperDHT({ bootstrap })
  const scraperPubKey = scraperDht.defaultKeyPair.publicKey
  const dhtPromClient = new DhtPromClient(dht, promClient, scraperPubKey)

  t.teardown(async () => {
    await dhtPromClient.close()
    await scraperDht.destroy()
    await testnet.destroy()
  })

  return { dhtPromClient, scraperDht, bootstrap }
}
