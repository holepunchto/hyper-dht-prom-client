const HyperDHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const promClient = require('prom-client')
const Hyperswarm = require('hyperswarm')
const hypCrypto = require('hypercore-crypto')

const DhtPromClient = require('.') // require('dht-prom-client')
const Scraper = require('./scraper') // require('dht-prom-client/scraper')

async function main () {
  // To not rely on the public DHT
  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const scraperSwarm = new Hyperswarm({ bootstrap })
  const scraperPubKey = scraperSwarm.keyPair.publicKey

  promClient.collectDefaultMetrics() // So we have something to scrape
  const dht = new HyperDHT({ bootstrap })

  // Used to register the alias, which is not included in this demo
  // (see dht-prometheus for that)
  const dummySecret = hypCrypto.randomBytes(32)

  const dhtPromClient = new DhtPromClient(
    dht,
    promClient,
    scraperPubKey,
    'dummy-alias',
    dummySecret,
    'my-service'
  )

  await dhtPromClient.ready() // Listening for 'metrics' requests

  const scraper = new Scraper(scraperSwarm, dhtPromClient.publicKey)

  await scraper.ready()
  await scraper.swarm.flush() // For race conditions

  const res = await scraper.requestMetrics()

  console.log(res)

  await scraper.close()
  await scraperSwarm.destroy()
  await dhtPromClient.close()
  await testnet.destroy()
  console.log('done')
}

main()
