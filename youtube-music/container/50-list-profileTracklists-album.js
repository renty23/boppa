boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "list/profileTracklists/album": async function(params) {
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
    const artistBrowseId = params.id;

    const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const artistResp = await credentialFetch(url, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ context: clientContext(), browseId: artistBrowseId })
    });
    const artistData = await artistResp.json();

    let albumsBrowseId = null, albumsParams = null;
    let singlesBrowseId = null, singlesParams = null;
    let artistName = '';

    try {
      const header = artistData.header?.musicImmersiveHeaderRenderer;
      if (header) artistName = header.title?.runs?.[0]?.text || '';
      const sections = artistData.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        if (section.musicCarouselShelfRenderer) {
          const carousel = section.musicCarouselShelfRenderer;
          const headerText = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || '';
          const moreBtn = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint;
          if (headerText === 'Albums' && moreBtn) { albumsBrowseId = moreBtn.browseId; albumsParams = moreBtn.params; }
          if (headerText === 'Singles & EPs' && moreBtn) { singlesBrowseId = moreBtn.browseId; singlesParams = moreBtn.params; }
        }
      }
      if (!albumsBrowseId) {
        albumsBrowseId = 'MPAD' + artistBrowseId;
        albumsParams = 'ggMIegYIARoCAQI%3D';
        singlesBrowseId = 'MPAD' + artistBrowseId;
        singlesParams = 'ggMIegYIAhoCAQI%3D';
      }
    } catch (e) {}

    if (!albumsBrowseId) {
      return { items: [] };
    } else {
      const fetches = [
        credentialFetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ context: clientContext(), browseId: albumsBrowseId, params: albumsParams }) })
      ];
      if (singlesBrowseId) {
        fetches.push(credentialFetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ context: clientContext(), browseId: singlesBrowseId, params: singlesParams }) }));
      }
      const responses = await Promise.all(fetches);
      const [albumsData, singlesData] = await Promise.all(responses.map(r => r.json()));

      function upgradeArtwork(url) {
        if (!url) return url;
        if (url.indexOf('ytimg.com') !== -1) {
          return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
        }
        return url.replace(/=w\d+-h\d+/, '=w544-h544');
      }

      function extractAlbums(response) {
        const results = [];
        try {
          let gridItems = [];
          const sections = response.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
          for (const section of sections) {
            if (section.gridRenderer) { gridItems = section.gridRenderer.items || []; break; }
          }
          for (const item of gridItems) {
            const twoRow = item.musicTwoRowItemRenderer;
            if (!twoRow) continue;
            const browseId = twoRow.navigationEndpoint?.browseEndpoint?.browseId;
            const pageType = twoRow.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            if (!browseId || pageType !== 'MUSIC_PAGE_TYPE_ALBUM') continue;
            const title = twoRow.title?.runs?.[0]?.text || '';
            const subtitleRuns = twoRow.subtitle?.runs || [];
            let albumYear = null;
            for (const run of subtitleRuns) {
              if (run.text && /^\d{4}$/.test(run.text)) { albumYear = parseInt(run.text, 10); break; }
            }
            const result = {
              id: browseId, title: title, subtitle: artistName || undefined,
              lowResArtworkUrl: twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
              highResArtworkUrl: upgradeArtwork(twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
              url: 'https://music.youtube.com/browse/' + browseId
            };
            if (albumYear !== null) result.year = albumYear;
            results.push(result);
          }
        } catch (e) {}
        return results;
      }

      const albums = extractAlbums(albumsData);
      const singles = singlesData ? extractAlbums(singlesData) : [];
      const allItems = [...albums, ...singles];
      allItems.sort((a, b) => {
        const yearA = a.year || 0;
        const yearB = b.year || 0;
        if (yearB !== yearA) return yearB - yearA;
        return a.title.localeCompare(b.title);
      });
      return { items: allItems };
    }
  },
}));
