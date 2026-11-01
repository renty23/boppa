boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "list/profileTracks/video": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');
    // InnerTube only serves the full video grid for user channels when the
    // request carries a visitor id; without one the same browseId+params answers
    // "This user doesn't have any public YouTube Music content".
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    const artistBrowseId = params.id;
    const continuation = params.previousResult?.continuation;

    const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }

    function parseDuration(timeStr) {
      const parts = timeStr.split(':').map(p => parseInt(p, 10));
      if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
      if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      return undefined;
    }

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    function extractVideos(response) {
      const results = [];
      let nextContinuation = null;
      try {
        let shelfContents = [];
        if (response.onResponseReceivedActions) {
          for (const action of response.onResponseReceivedActions) {
            if (action.appendContinuationItemsAction) {
              shelfContents = action.appendContinuationItemsAction.continuationItems || [];
              break;
            }
          }
        } else {
          const sections = response.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
          for (const section of sections) {
            if (section.musicPlaylistShelfRenderer) {
              shelfContents = section.musicPlaylistShelfRenderer.contents || [];
              break;
            }
            if (section.gridRenderer) {
              // User channels get a grid of the same two-row tiles the artist page's
              // carousel uses. The grid has no continuation (the site caps it at 180).
              return { items: extractTwoRowVideos(section.gridRenderer.items), continuation: null };
            }
          }
        }
        for (let i = shelfContents.length - 1; i >= 0; i--) {
          if (shelfContents[i].continuationItemRenderer) {
            const token = shelfContents[i].continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
            if (token) nextContinuation = token;
            shelfContents.splice(i, 1);
            break;
          }
        }
        for (const item of shelfContents) {
          const listItem = item.musicResponsiveListItemRenderer;
          if (!listItem) continue;
          const videoId = listItem.playlistItemData?.videoId
            || listItem.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) continue;
          const flexColumns = listItem.flexColumns || [];
          const title = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
          const artists = [];
          const col1Runs = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          for (const run of col1Runs) {
            const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
            if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
              artists.push({ id: browseId || run.text, name: run.text });
            }
          }
          if (artists.length === 0 && col1Runs.length > 0 && col1Runs[0].text && col1Runs[0].text !== ' • ') {
            artists.push({ id: col1Runs[0].text, name: col1Runs[0].text });
          }
          let duration;
          const fixedCols = listItem.fixedColumns || [];
          const durationText = fixedCols[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
          if (durationText && /^\d+:\d+/.test(durationText.trim())) duration = parseDuration(durationText.trim());
          const result = {
            id: videoId, title: title,
            subtitle: artists.length > 0 ? artists.map(a => a.name).join(', ') : undefined,
            duration: duration,
            lowResArtworkUrl: listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
            highResArtworkUrl: upgradeArtwork(listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
            url: 'https://music.youtube.com/watch?v=' + videoId
          };
          if (artists.length > 0) result.profiles = artists;
          results.push(result);
        }
      } catch (e) {}
      return { items: results, continuation: nextContinuation };
    }

    /// The artist page's own "Videos" carousel. Its "more" button leads to a
    /// playlist shelf (official artists) or a grid (user channels). If that page
    /// yields nothing, the carousel is the only list left to offer.
    function findVideosCarousel(artistData) {
      const sections = artistData.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        const carousel = section.musicCarouselShelfRenderer;
        const headerText = carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || '';
        if (carousel && headerText === 'Videos') return carousel;
      }
      return null;
    }

    // musicTwoRowItemRenderer tiles, as used by both the carousel and the grid.
    function extractTwoRowVideos(items) {
      const results = [];
      for (const item of (items || [])) {
        const twoRow = item.musicTwoRowItemRenderer;
        const videoId = twoRow?.navigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;
        const artists = [];
        for (const run of (twoRow.subtitle?.runs || [])) {
          const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
          const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
          if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
            artists.push({ id: browseId || run.text, name: run.text });
          }
        }
        const thumbnails = twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        const result = {
          id: videoId,
          title: twoRow.title?.runs?.[0]?.text || '',
          subtitle: artists.length > 0 ? artists.map(a => a.name).join(', ') : undefined,
          lowResArtworkUrl: thumbnails[1]?.url || thumbnails[0]?.url,
          highResArtworkUrl: upgradeArtwork(thumbnails[0]?.url),
          url: 'https://music.youtube.com/watch?v=' + videoId
        };
        if (artists.length > 0) result.profiles = artists;
        results.push(result);
      }
      return results;
    }

    let videosData;
    if (continuation) {
      const resp = await credentialFetch(url, {
        method: 'POST', headers: headers,
        body: JSON.stringify({ context: clientContext(), continuation: continuation })
      });
      videosData = await resp.json();
    } else {
      const artistResp = await credentialFetch(url, {
        method: 'POST', headers: headers,
        body: JSON.stringify({ context: clientContext(), browseId: artistBrowseId })
      });
      const artistData = await artistResp.json();
      const carousel = findVideosCarousel(artistData);
      const moreBtn = carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint;
      let moreResult = null;
      if (moreBtn?.browseId) {
        const resp = await credentialFetch(url, {
          method: 'POST', headers: headers,
          body: JSON.stringify({ context: clientContext(), browseId: moreBtn.browseId, params: moreBtn.params || 'ggMCCAI%3D' })
        });
        moreResult = extractVideos(await resp.json());
      }
      if (moreResult && moreResult.items.length > 0) {
        const output = { items: moreResult.items };
        if (moreResult.continuation) output.continuation = moreResult.continuation;
        return output;
      } else {
        // The "more" page had nothing to list (or there was no button); the
        // carousel on the artist page is the complete list available.
        return { items: extractTwoRowVideos(carousel?.contents) };
      }
    }

    if (videosData) {
      const result = extractVideos(videosData);
      const output = { items: result.items };
      if (result.continuation) output.continuation = result.continuation;
      return output;
    }
  },
}));
