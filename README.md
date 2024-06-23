# (WIP) DHT Prom Client

Expose Prometheus metrics over a hyperdht server.

Warning: still in alpha, breaking changes possible until v1.0.0.

## Install

```
npm i dht-prom-client
```

## Usage

```
const dht = new HyperDHT()
const promClient = require('prom-client')
const scraperPubKey = b4a.from('<hex pub key of scraper>', 'hex')

const dhtPromClient = new DhtPromClient(dht, promClient, scraperPubKey)

await dhtPromClient.ready() // Listening for 'metrics' requests
```
