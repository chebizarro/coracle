import type {Writable} from "svelte/store"
import Loki from "lokijs"
import IncrementalIndexedAdapter from "lokijs/src/incremental-indexeddb-adapter"
import {partition, sortBy, prop, pluck, without, is} from "ramda"
import {throttle} from "throttle-debounce"
import {writable} from "svelte/store"
import {ensurePlural, createMap} from "hurdak/lib/hurdak"
import {log} from "src/util/logger"
import {Tags} from "src/util/nostr"
import user from "src/agent/user"

const loki = new Loki("agent.db", {
  autoload: true,
  autosave: true,
  adapter: window.indexedDB ? new IncrementalIndexedAdapter() : new Loki.LokiMemoryAdapter(),
  autoloadCallback: () => ready.set(true),
})

// ----------------------------------------------------------------------------
// Database table abstraction around loki

const registry = {} as Record<string, Table>

class Table {
  name: string
  pk: string
  _max: number
  _sort: (xs: Array<Record<string, any>>) => Array<Record<string, any>>
  _coll: Loki
  constructor(name, pk, {max = 500, sort = null} = {}) {
    this.name = name
    this.pk = pk
    this._max = max
    this._sort = sort
    this._coll = loki.addCollection(name, {unique: [pk]})

    registry[name] = this
  }
  subscribe(cb) {
    const keys = ["insert", "update"]

    this._coll.addListener(keys, cb)

    cb(this)

    return () => this._coll.removeListener(keys, cb)
  }
  patch(items) {
    const [updates, creates] = partition(item => this.get(item[this.pk]), ensurePlural(items))

    if (creates.length > 0) {
      this._coll.insert(creates)
    }

    if (updates.length > 0) {
      const updatesByPk = createMap(this.pk, updates)

      this._coll.updateWhere(
        item => Boolean(updatesByPk[item[this.pk]]),
        item => ({...item, ...updatesByPk[item[this.pk]]})
      )
    }
  }
  remove(ks) {
    this._coll.chain().removeWhere({[this.pk]: {$in: ks}})
  }
  prune() {
    if (this._coll.count() < this._max * 1.1) {
      return
    }

    let data = this.all()

    if (this._sort) {
      data = this._sort(data)
    }

    const pks = pluck(this.pk, data.slice(this._max))

    this._coll.findAndRemove({[this.pk]: {$in: pks}})
  }
  drop() {
    this._coll.clear({removeIndices: true})
  }
  all(spec = null) {
    return this._coll.find(spec)
  }
  find(spec = null) {
    return this._coll.findOne(spec)
  }
  get(k) {
    return this._coll.by(this.pk, k)
  }
}

const listener = (() => {
  let listeners = []

  return {
    connect: () => {
      for (const table of Object.values(registry) as Array<Table>) {
        table.subscribe(() => listeners.forEach(f => f(table.name)))
      }
    },
    subscribe: f => {
      listeners.push(f)

      return () => {
        listeners = without([f], listeners)
      }
    },
  }
})()

// Periodically prune data. One table at a time to avoid interfering with the UI
setInterval(() => {
  const tables = Object.values(registry)
  const table = tables[Math.floor(tables.length * Math.random())]

  table.prune()
}, 10_000)

type WatchStore<T> = Writable<T> & {
  refresh: () => void
}

export const watch = (names, f) => {
  names = ensurePlural(names)

  const store = writable(null) as WatchStore<any>
  const tables = names.map(name => registry[name])

  // Initialize synchronously if possible
  const initialValue = f(...tables)
  if (is(Promise, initialValue)) {
    initialValue.then(v => store.set(v))
  } else {
    store.set(initialValue)
  }

  // Debounce refresh so we don't get UI lag
  store.refresh = throttle(300, async () => store.set(await f(...tables)))

  // Listen for changes
  listener.subscribe(name => {
    if (names.includes(name)) {
      store.refresh()
    }
  })

  return store
}

export const dropAll = async () => {
  for (const table of Object.values(registry)) {
    await table.drop()

    log(`Successfully dropped table ${table.name}`)
  }
}

// ----------------------------------------------------------------------------
// Domain-specific collections

const sortByCreatedAt = sortBy(prop("created_at"))
const sortByLastSeen = sortBy(prop("last_seen"))

export const people = new Table("people", "pubkey", {
  max: 5000,
  // Don't delete the user's own profile or those of direct follows
  sort: xs => {
    const follows = Tags.wrap(user.getPetnames()).values().all()
    const whitelist = new Set(follows.concat(user.getPubkey()))

    return sortBy(x => (whitelist.has(x.pubkey) ? 0 : x.created_at), xs)
  },
})

export const userEvents = new Table("userEvents", "id", {max: 2000, sort: sortByCreatedAt})
export const notifications = new Table("notifications", "id")
export const contacts = new Table("contacts", "pubkey")
export const rooms = new Table("rooms", "id")
export const relays = new Table("relays", "url")
export const routes = new Table("routes", "id", {max: 3000, sort: sortByLastSeen})

listener.connect()

export const getPersonWithFallback = pubkey => people.get(pubkey) || {pubkey}
export const getRelayWithFallback = url => relays.get(url) || {url}

const ready = writable(false)

export const onReady = cb => {
  const unsub = ready.subscribe($ready => {
    if ($ready) {
      cb()
      setTimeout(() => unsub())
    }
  })
}