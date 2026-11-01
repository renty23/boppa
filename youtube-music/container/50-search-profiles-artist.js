boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "search/profiles/artist": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');
    // Tie every page of a search to one visitor so InnerTube's continuation
    // (which embeds the ids already delivered) is applied to a stable result set
    // instead of a freshly ranked one; without it items shift and repeat.
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    const query = params.query;
    const continuation = params.previousResult?.continuation;

    const url = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false&key=' + apiKey;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }

    async function fetchResults(params) {
      const body = continuation
        ? {
            context: clientContext(),
            continuation: continuation
          }
        : {
            context: clientContext(),
            query: query,
            params: params
          };
      const resp = await credentialFetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
      return await resp.json();
    }

    const [artistsData, profilesData] = await Promise.all([
      fetchResults('EgWKAQIgAWoOEAMQBRAEEAkQChAVEBA%3D'),
      fetchResults('EgWKAQJYAWoOEAMQBRAEEAkQChAVEBA%3D')
    ]);

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    function extractArtists(response) {
      const results = [];
      let nextContinuation = null;
      try {
        let shelfContents = [];
        let continuations = null;
        if (response.continuationContents) {
          shelfContents = response.continuationContents.musicShelfContinuation?.contents || [];
          continuations = response.continuationContents.musicShelfContinuation?.continuations;
        } else {
          const sections = response.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
          for (const section of sections) {
            if (section.musicShelfRenderer) {
              shelfContents = section.musicShelfRenderer.contents || [];
              continuations = section.musicShelfRenderer.continuations;
            }
          }
        }
        if (continuations?.[0]?.nextContinuationData) {
          nextContinuation = continuations[0].nextContinuationData.continuation;
        }
        for (const item of shelfContents) {
          const listItem = item.musicResponsiveListItemRenderer;
          if (listItem) {
            const browseId = listItem.navigationEndpoint?.browseEndpoint?.browseId;
            const pageType = listItem.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            if (browseId && (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL')) {
              const flexColumns = listItem.flexColumns || [];
              const name = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
              const isArtist = pageType === 'MUSIC_PAGE_TYPE_ARTIST';
              results.push({
                id: browseId,
                name: name,
                lowResArtworkUrl: listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
                highResArtworkUrl: upgradeArtwork(listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
                url: 'https://music.youtube.com/channel/' + browseId,
                type: isArtist ? 'artist' : 'channel',
                metadata: { browseId: browseId }
              });
            }
          }
        }
      } catch (e) {}
      return { items: results, continuation: nextContinuation };
    }

    const artistsResult = extractArtists(artistsData);
    const profilesResult = extractArtists(profilesData);
    const combinedItems = [...artistsResult.items, ...profilesResult.items];
    combinedItems.sort((a, b) => {
      if (a.type === 'artist' && b.type === 'channel') return -1;
      if (a.type === 'channel' && b.type === 'artist') return 1;
      return 0;
    });
    const output = { items: combinedItems };
    if (artistsResult.continuation) {
      output.continuation = artistsResult.continuation;
    }
    return output;
  },
}));
