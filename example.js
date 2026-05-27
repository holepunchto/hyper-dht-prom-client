const HyperDHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const promClient = require('prom-client')
const hypCrypto = require('hypercore-crypto')

const DhtPromClient = require('.') // require('dht-prom-client')
const Scraper = require('./scraper') // require('dht-prom-client/scraper')
const ProtomuxRpcClient = require('protomux-rpc-client')

async function main() {
  // To not rely on the public DHT
  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const scraperDht = new HyperDHT({ bootstrap })
  const scraperRpcClient = new ProtomuxRpcClient(scraperDht)
  const scraperPubKey = scraperDht.defaultKeyPair.publicKey

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
  await new Promise((resolve) => setTimeout(resolve, 500)) // Flush, for race conditions

  const scraper = new Scraper(scraperRpcClient, dhtPromClient.publicKey)
  const res = await scraper.requestMetrics()

  console.log(res)

  await scraperRpcClient.close()
  await dht.destroy()
  await scraperDht.destroy()
  await dhtPromClient.close()
  await testnet.destroy()
  console.log('done')
}

main()
