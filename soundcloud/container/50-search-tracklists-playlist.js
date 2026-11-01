boppa.data.register(credentialedData(['SOUNDCLOUD_CLIENT_ID'], {
  "search/tracklists/playlist": async function(params) {
    const clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID');
    const targetPageSize = 10;
    const requestDelayMs = 500;

    function upgradeArtwork(url) {
      if (!url) return url;
      return url.replace(/-large(\.[a-zA-Z]+)$/, '-t1080x1080$1');
    }

    function withClientId(url) {
      return url + (url.includes('?') ? '&' : '?') + 'client_id=' + encodeURIComponent(clientId);
    }

    function createPacedFetch() {
      let madeRequest = false;
      return async function(url) {
        if (madeRequest) {
          await new Promise(resolve => setTimeout(resolve, requestDelayMs));
        }
        madeRequest = true;
        return credentialFetch(url);
      };
    }

    function mapPlaylist(p) {
      return {
        id: p.id,
        title: p.title,
        subtitle: p.user?.username,
        trackCount: p.track_count,
        lowResArtworkUrl: p.artwork_url || p.user?.avatar_url,
        highResArtworkUrl: upgradeArtwork(p.artwork_url || p.user?.avatar_url),
        url: p.permalink_url,
        metadata: {
          id: p.id,
          trackIds: (p.tracks || []).map(t => t.id)
        }
      };
    }

    const query = params.query;
    let nextHref = params.previousResult?.nextHref
      || 'https://api-v2.soundcloud.com/search/playlists_without_albums?q='
        + encodeURIComponent(query);
    const pacedFetch = createPacedFetch();
    const items = [];
    const seenItemIds = {};
    const seenPageHrefs = {};

    while (nextHref && items.length < targetPageSize) {
      if (seenPageHrefs[nextHref]) {
        nextHref = null;
        break;
      }
      seenPageHrefs[nextHref] = true;
      const resp = await pacedFetch(withClientId(nextHref));
      const data = await resp.json();
      for (const item of (data.collection || []).map(mapPlaylist)) {
        const id = String(item.id);
        if (seenItemIds[id]) continue;
        seenItemIds[id] = true;
        items.push(item);
      }
      nextHref = data.next_href || null;
    }

    return { items: items, nextHref: nextHref };
  },
}));
