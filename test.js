const test = require('brittle')
const promClient = require('prom-client')
const createTestnet = require('hyperdht/testnet')
const RPC = require('protomux-rpc')
const cenc = require('compact-encoding')
const { once } = require('events')
const safetyCatch = require('safety-catch')

const DhtPromClient = require('./index')
const HyperDHT = require('hyperdht')

test('Scraper can get metrics', async t => {
  t.plan(3)
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

  const metrics = await lookup(scraperDht, clientKey)
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
    { responseEncoding: cenc.string }
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
