boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "get/tracklist/album": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');

    // Tie the request to the same visitor the site would use; InnerTube varies
    // both result sets and continuation behaviour without a visitor id.
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    const browseId = params.id;

    const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;
    const resp = await credentialFetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        context: clientContext(),
        browseId: browseId
      })
    });
    const data = await resp.json();

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    try {
      const sections = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const header = sections[0]?.musicResponsiveHeaderRenderer;
      const title = header?.title?.runs?.[0]?.text || '';
      const subtitle = header?.straplineTextOne?.runs?.[0]?.text || undefined;
      let year = null;
      for (const run of (header?.subtitle?.runs || [])) {
        if (run.text && /^\d{4}$/.test(run.text)) { year = parseInt(run.text, 10); break; }
      }
      const thumbnails = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
      const lowResArtworkUrl = thumbnails ? (thumbnails[1]?.url || thumbnails[0]?.url) : null;
      const highResArtworkUrl = thumbnails ? upgradeArtwork(thumbnails[thumbnails.length - 1]?.url) : null;
      const result = { id: browseId, title: title, subtitle: subtitle, lowResArtworkUrl: lowResArtworkUrl, highResArtworkUrl: highResArtworkUrl, url: 'https://music.youtube.com/browse/' + browseId };
      if (year !== null) result.year = year;
      return result;
    } catch (e) {
      return { id: browseId, title: '' };
    }
  },
}));
