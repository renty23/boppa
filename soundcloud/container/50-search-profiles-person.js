boppa.data.register(credentialedData(['SOUNDCLOUD_CLIENT_ID'], {
  "search/profiles/person": async function(params) {
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

    function mapProfile(u) {
      return {
        id: u.id,
        name: u.username,
        lowResArtworkUrl: u.avatar_url,
        highResArtworkUrl: upgradeArtwork(u.avatar_url),
        url: u.permalink_url,
        metadata: { id: u.id }
      };
    }

    const query = params.query;
    let nextHref = params.previousResult?.nextHref
      || 'https://api-v2.soundcloud.com/search/users?q=' + encodeURIComponent(query);
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
      for (const item of (data.collection || []).map(mapProfile)) {
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
