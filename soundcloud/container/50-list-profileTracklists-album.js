boppa.data.register(credentialedData(['SOUNDCLOUD_CLIENT_ID'], {
  "list/profileTracklists/album": async function(params) {
    const clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID');
    const targetPageSize = 10;
    const trackBatchSize = 50;
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

    // Catalog tracks expose encrypted AAC plus MP3 placeholders that resolve as 404.
    function isDrmOnlyTrack(track) {
      const transcodings = track?.media?.transcodings || [];
      const protocol = x => String(x?.format?.protocol || x?.protocol || '');
      const hasEncryptedStream = transcodings.some(x =>
        protocol(x).includes('encrypted'));
      const hasPublicAac = transcodings.some(x =>
        !protocol(x).includes('encrypted')
          && (x?.preset === 'aac_160k' || x?.preset === 'aac_96k')
          && protocol(x) === 'hls');
      return hasEncryptedStream && !hasPublicAac;
    }

    function hasTranscodingMetadata(track) {
      return Array.isArray(track?.media?.transcodings);
    }

    async function hydrateNeededAlbumTracks(albums) {
      const trackMap = {};
      const missingIds = [];
      const seenIds = {};

      for (const album of albums) {
        const tracks = album?.tracks || [];
        if (album?.track_count == null || Number(album.track_count) !== tracks.length) continue;
        const hydrated = tracks.filter(hasTranscodingMetadata);
        for (const track of hydrated) trackMap[String(track.id)] = track;

        // One public track proves the album is not DRM-only, so its remaining stubs
        // do not need to be fetched.
        if (hydrated.some(track => !isDrmOnlyTrack(track))) continue;

        for (const track of tracks) {
          if (track?.id == null || hasTranscodingMetadata(track)) continue;
          const id = String(track.id);
          if (!seenIds[id]) {
            seenIds[id] = true;
            missingIds.push(id);
          }
        }
      }

      for (let offset = 0; offset < missingIds.length; offset += trackBatchSize) {
        const ids = missingIds.slice(offset, offset + trackBatchSize);
        try {
          const response = await pacedFetch(
            'https://api-v2.soundcloud.com/tracks?ids=' +
            ids.map(encodeURIComponent).join('%2C') + '&client_id=' + clientId
          );
          if (!response.ok) continue;
          const data = await response.json();
          const tracks = Array.isArray(data) ? data : (data?.collection || []);
          for (const track of tracks) {
            if (track?.id != null && hasTranscodingMetadata(track)) {
              trackMap[String(track.id)] = track;
            }
          }
        } catch (_) {
          // Keep albums whose complete DRM status cannot be proven.
        }
      }

      return trackMap;
    }

    function isDrmOnlyAlbum(album, trackMap) {
      const tracks = album?.tracks || [];
      if (tracks.length === 0) return false;
      if (album?.track_count == null || Number(album.track_count) !== tracks.length) return false;

      const resolved = tracks.map(track =>
        hasTranscodingMetadata(track) ? track : trackMap[String(track?.id)]);
      return resolved.every(track => hasTranscodingMetadata(track) && isDrmOnlyTrack(track));
    }

    const userId = params.id;
    let nextHref = params.previousResult?.nextHref
      || 'https://api-v2.soundcloud.com/users/' + userId
        + '/albums?limit=10&linked_partitioning=1';
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
      const albums = data.collection || [];
      const trackMap = await hydrateNeededAlbumTracks(albums);
      const pageItems = albums.filter(a => !isDrmOnlyAlbum(a, trackMap)).map(a => ({
        id: a.id, title: a.title, subtitle: a.user?.username,
        trackCount: a.track_count,
        lowResArtworkUrl: a.artwork_url || a.user?.avatar_url,
        highResArtworkUrl: upgradeArtwork(a.artwork_url || a.user?.avatar_url),
        url: a.permalink_url
      }));
      for (const item of pageItems) {
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
