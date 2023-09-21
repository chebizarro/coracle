import {prop, uniqBy, uniq} from "ramda"
import {Tags, appDataKeys} from "src/util/nostr"
import {tryJson} from "src/util/misc"
import type {Channel} from "src/engine/model"
import {sessions, channels} from "src/engine/state"
import {nip04, getNip24ChannelId, canSign} from "src/engine/queries"
import {projections} from "src/engine/projections/core"

projections.addHandler(30078, async e => {
  if (!canSign.get()) {
    return
  }

  if (Tags.from(e).getMeta("d") === appDataKeys.NIP24_LAST_CHECKED) {
    await tryJson(async () => {
      const payload = JSON.parse(await nip04.get().decryptAsUser(e.content, e.pubkey))

      channels.mapStore.update($channels => {
        for (const [id, ts] of Object.entries(payload) as [string, number][]) {
          const channel = $channels.get(id)

          $channels.set(id, {
            ...channel,
            last_checked: Math.max(ts, channel?.last_checked || 0),
          })
        }

        return $channels
      })
    })
  }
})

projections.addHandler(14, e => {
  const tags = Tags.from(e)
  const pubkeys = tags.type("p").values().all().concat(e.pubkey)
  const channelId = getNip24ChannelId(pubkeys)

  for (const pubkey of Object.keys(sessions.get())) {
    if (!pubkeys.includes(pubkey)) {
      continue
    }

    channels.key(channelId).update($channel => {
      const updates = {
        ...$channel,
        id: channelId,
        type: "nip24",
        relays: uniq(tags.relays().concat($channel?.relays || [])),
        messages: uniqBy(prop("id"), [e].concat($channel?.messages || [])),
      }

      if (e.pubkey === pubkey) {
        updates.last_sent = Math.max(updates.last_sent || 0, e.created_at)
      } else {
        updates.last_received = Math.max(updates.last_received || 0, e.created_at)
      }

      return updates as Channel
    })
  }
})