# DHT Prom Client

Expose Prometheus metrics over a [hyperdht](https://github.com/holepunchto/hyperdht) server.

## Install

```
npm i dht-prom-client
```

## Usage

See [./example](./example)

## Architecture

A DHT Prom Client exposes a DHT server, and registers it with the scraper on startup. It then regularly reregisters itself. A shared secret is used for authentication.

Registering entails mapping the metrics server's public key to an alias. The alias should uniquely identify the client to the scraper.

Registering includes the hostname and service name as metadata, to facilitate combining related clients when analysing the collected metrics.

Alias-register connections are ephemeral: they close after succeeding (or failing).

Once the alias is registered, the scraper opens a connection to the client's metrics server. The client authenticates the server based on its public key.

Scraper connections are kept open, since scrape requests are frequent. Whenever the connection is lost, regular attempts are made to re-open the connection (leveraging the hyperswarm reconnect logic).

The DHT-prom client either returns its metrics, or an error message.

Currently, each client only supports getting scraped by one scraper, but it would be straightforward to extend this to multiple scrapers.

## DHT Prom Client API

#### `const dhtPromClient = new DhtPromClient(dht, promClient|getMetrics, scraperPublicKey, alias, scraperSecret, service, opts)`

Create a new DHT Prom client.

- `dht` is a [HyperDHT](https://github.com/holepunchto/hyperdht) instance. Its lifecycle is managed by the DHT Prom Client.
- `promClient|getMetrics` is either a [prom-client](https://github.com/siimon/prom-client) instance, or a function which returns metrics in Prometheus format.
-  `scraperPublicKey` is the public key of the [DHT Prometheus](https://github.com/HDegroote/dht-prometheus) instance which will scrape us, in any format (hex, z32 or binary)
- `alias` is the alias we wish to register with the scraper. Each alias should be unique for that scraper (the previous entry gets overwritten)
- `scraperSecret` is the secret with which we prove our right to register our alias with the scraper. It is a 32-byte buffer (or equivalent hex/z32 string)
- `service` is the name of the service of which we are an instance (useful for grouping processes in a Prometheus dashboard)

`opts` include:
- `registerIntervalMs`: how frequently you wish to re-register yourself with the scraper (in ms). It should be less than the `entryExpiryMs` option of DHT Prometheus. Defaults to 1 hour.
- `hostname`: the hostname where you run. Defaults to `os.hostname()`. Useful for filtering processes in a Prometheus dashboard.

#### `dhtPromClient.publicKey`

The public key where the metrics server listens.

#### `dhtPromClient.promClient`

The prom-client used, or null if a function was passed in to collect the metrics.

#### `dhtPromClient.ready()`

Start listening on the metrics server, and start registering the alias with the scraper.

#### `dhtPromClient.close()`

Close the DHT instance, and stop registering the alias with the scraper.

#### `dhtPromClient.registerLogger(logger)`

Helper function which adds default logs for all relevant state changes.

`logger` is a [pino](https://github.com/pinojs/pino) logger object.

### Events

#### `dhtPromClient.on('register-alias-success', { updated })`

Emitted every time the alias was successfully registered with the scraper. `updated` is a boolean indicating whether the entry changed.

#### `dhtPromClient.on('register-alias-error', error)`

Emitted when an attempt to register an alias failed.

Occasional failures are expected, for example if the dhtPromClient cannot be reached.

#### `dhtPromClient.on('connection-open', { uid, remotePublicKey })`

Emitted every time a connection is opened to the scraper identified by `remotePublicKey`. The `uid` is unique to the connection, and is included in all events related to it.

#### `dhtPromClient.on('connection-close', { uid, remotePublicKey })`

Emitted every time a connection to the scraper is closed.

#### `dhtPromClient.on('connection-error', { error, uid, remotePublicKey })`

Emitted when a connection to the scraper errors. Connection errors are expected, so do not imply any need for action. The event is mostly useful for logging.

#### `dhtPromClient.on('metrics-request', { uid, remotePublicKey })`

Emitted every time a metrics request is received.

#### `dhtPromClient.on('metrics-success', { uid, remotePublicKey })`

Emitted every time a metrics request is successfully processed.

#### `dhtPromClient.on('metrics-error', { uid, remotePublicKey })`

Emitted every time a metrics request results in an error. It is recommended to log this event, so issues can be debugged: the error message contains the full error, whereas the client only receives an error message indicating the uid of the request.

#### `dhtPromClient.on('firewall-block', { remotePublicKey, payload, address })`

Emitted whenever someone other than the scraper tries to open a connection to the metrics server.

`payload` is the `remoteHandshakePayload` as document in HyperDHT's firewall documentation.

`address` is the `ip:port`  of the firewalled peer.

## Scraper API

#### `const scraper = new DhtPromScraper(swarm, promClientPubKey, opts)`

Create a new scraper.

- `swarm` is a hyperswarm instance. Its lifetime is NOT managed by the scraper.
- `promClientPubKey` is the public key of a metrics server exposed by a DHT Prom Client
- `opts` include `requestTimeoutMs`: the amount of ms before a request times out (default 5000)



#### `scraper.ready()`

Instructs the scraper to connect to the client. It it cannot connect or gets disconnected at some point, it will continuously attempt to reconnect.

#### `scraper.close()`

Instructs the scraper to disconnect from the client.

#### `const result = scraper.requestMetrics()`

Requests the metrics from the client.

Throws is the client is unavailable, or if some other connection or protocol error occurs.

Otherwise, returns either a success or a failure response:

```
// on success
{
  success: true,
  metrics: str
}

// on failure
{
  success: false,
  errorMessage: str
}
```

### Events

All events include a unique id `uid`, the public key of the remote peer (`remotePublicKey`) and their `ip:port` address (`remoteAddress`).

#### `scraper.on('connection-open', { uid, remotePublicKey, remoteAddress })`

Emitted whenever a new connection to the client is opened.

#### `scraper.on('connection-close', { uid, remotePublicKey, remoteAddress })`

Emitted whenever a connection to the client is closed.

#### `scraper.on('connection-error', { error, uid, remotePublicKey, remoteAddress })`

Emitted whenever a connection to the client errors. Errors are expected, and to not imply a need for action, but logging them can be useful.

#### `scraper.on('connection-ignore', { uid, remotePublicKey, remoteAddress })`

Emitted whenever a connection is ignored because it is not from the scraper. Since this event triggers every time the swarm opens a connection to another peer, it is only useful for debugging
