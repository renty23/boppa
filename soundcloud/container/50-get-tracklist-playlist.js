boppa.data.register(credentialedData(['SOUNDCLOUD_CLIENT_ID'], {
  "get/tracklist/playlist": async function(params) {
    const clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID');
    function upgradeArtwork(url) {
      if (!url) return url;
      return url.replace(/-large(\.[a-zA-Z]+)$/, '-t1080x1080$1');
    }
    const resp = await credentialFetch('https://api-v2.soundcloud.com/playlists/' + params.id + '?client_id=' + clientId);
    const data = await resp.json();
    return {
      id: data.id, title: data.title, subtitle: data.user?.username,
      trackCount: data.track_count,
      lowResArtworkUrl: data.artwork_url || data.user?.avatar_url,
      highResArtworkUrl: upgradeArtwork(data.artwork_url || data.user?.avatar_url),
      url: data.permalink_url
    };
  },
}));
