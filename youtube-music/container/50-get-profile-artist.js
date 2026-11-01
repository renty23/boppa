boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "get/profile/artist": async function(params) {
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

    // Artist pages come with one of two headers. Official artists get
    // musicImmersiveHeaderRenderer (a single square-ish thumbnail). User channels
    // promoted to artist pages get musicVisualHeaderRenderer, where `thumbnail` is
    // the wide banner (540x225 .. 2048x853) and the square avatar lives in
    // `foregroundThumbnail`. Prefer the avatar so artwork stays square.
    const header = data.header?.musicImmersiveHeaderRenderer
      || data.header?.musicVisualHeaderRenderer
      || {};
    const artistName = header.title?.runs?.[0]?.text || '';

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    function thumbnailsOf(container) {
      return container?.musicThumbnailRenderer?.thumbnail?.thumbnails
        || container?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails
        || [];
    }
    const artistThumbnails = thumbnailsOf(header.foregroundThumbnail).length
      ? thumbnailsOf(header.foregroundThumbnail)
      : thumbnailsOf(header.thumbnail);
    const artistLowResArtworkUrl = artistThumbnails[1]?.url || artistThumbnails[0]?.url;
    const artistHighResArtworkUrl = artistThumbnails.length > 0 ? upgradeArtwork(artistThumbnails[artistThumbnails.length - 1].url) : undefined;

    function extractArtistData(response) {
      const songs = [];
      const albums = [];
      const videos = [];
      const sectionOrder = [];

      try {
        const sections = response.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const section of sections) {
          if (section.musicShelfRenderer) {
            sectionOrder.push('songs');
            const shelf = section.musicShelfRenderer;
            for (const item of (shelf.contents || [])) {
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
                const bid = run.navigationEndpoint?.browseEndpoint?.browseId;
                if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
                  artists.push({ id: bid || run.text, name: run.text });
                }
              }
              let albumName = '';
              let albumBrowseId = '';
              const col3Runs = flexColumns[3]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
              for (const run of col3Runs) {
                const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                const bid = run.navigationEndpoint?.browseEndpoint?.browseId;
                if (pt === 'MUSIC_PAGE_TYPE_ALBUM' && bid) { albumName = run.text; albumBrowseId = bid; }
              }
              const result = {
                id: videoId, title: title,
                subtitle: artists.length > 0 ? artists.map(a => a.name).join(', ') : undefined,
                lowResArtworkUrl: listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
                highResArtworkUrl: upgradeArtwork(listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
                url: 'https://music.youtube.com/watch?v=' + videoId
              };
              if (artists.length > 0) result.profiles = artists;
              if (albumBrowseId) result.tracklists = [{ id: albumBrowseId, title: albumName }];
              songs.push(result);
            }
          }
          if (section.musicCarouselShelfRenderer) {
            const carousel = section.musicCarouselShelfRenderer;
            const headerText = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || '';
            if (headerText === 'Albums' || headerText === 'Singles & EPs') {
              if (!sectionOrder.includes('albums')) sectionOrder.push('albums');
              for (const item of (carousel.contents || [])) {
                const twoRow = item.musicTwoRowItemRenderer;
                if (!twoRow) continue;
                const albumBrowseId = twoRow.navigationEndpoint?.browseEndpoint?.browseId;
                const pageType = twoRow.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                if (!albumBrowseId || pageType !== 'MUSIC_PAGE_TYPE_ALBUM') continue;
                const title = twoRow.title?.runs?.[0]?.text || '';
                const subtitleRuns = twoRow.subtitle?.runs || [];
                let albumYear = null;
                for (const run of subtitleRuns) {
                  if (run.text && /^\d{4}$/.test(run.text)) { albumYear = parseInt(run.text, 10); break; }
                }
                const albumItem = {
                  id: albumBrowseId, title: title, subtitle: artistName || undefined,
                  lowResArtworkUrl: twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
                  highResArtworkUrl: upgradeArtwork(twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
                  url: 'https://music.youtube.com/browse/' + albumBrowseId
                };
                if (albumYear !== null) albumItem.year = albumYear;
                albums.push(albumItem);
              }
            }
            if (headerText === 'Videos') {
              sectionOrder.push('videos');
              for (const item of (carousel.contents || [])) {
                const twoRow = item.musicTwoRowItemRenderer;
                if (!twoRow) continue;
                const videoId = twoRow.navigationEndpoint?.watchEndpoint?.videoId;
                if (!videoId) continue;
                const title = twoRow.title?.runs?.[0]?.text || '';
                const artists = [];
                const subtitleRuns = twoRow.subtitle?.runs || [];
                for (const run of subtitleRuns) {
                  const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                  const bid = run.navigationEndpoint?.browseEndpoint?.browseId;
                  if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
                    artists.push({ id: bid || run.text, name: run.text });
                  }
                }
                if (artists.length === 0 && subtitleRuns.length > 0 && subtitleRuns[0].text && subtitleRuns[0].text !== ' \u2022 ') {
                  artists.push({ id: subtitleRuns[0].text, name: subtitleRuns[0].text });
                }
                const result = {
                  id: videoId, title: title,
                  subtitle: artists.map(a => a.name).join(', ') || undefined,
                  lowResArtworkUrl: twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
                  highResArtworkUrl: upgradeArtwork(twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
                  url: 'https://music.youtube.com/watch?v=' + videoId
                };
                if (artists.length > 0) result.profiles = artists;
                videos.push(result);
              }
            }
          }
        }
      } catch (e) {}
      albums.sort((a, b) => {
        const yearA = a.year || 0;
        const yearB = b.year || 0;
        if (yearB !== yearA) return yearB - yearA;
        return a.title.localeCompare(b.title);
      });
      return { songs: songs, albums: albums, videos: videos, sectionOrder: sectionOrder };
    }

    const result = extractArtistData(data);
    const output = {
      lowResArtworkUrl: artistLowResArtworkUrl,
      highResArtworkUrl: artistHighResArtworkUrl
    };
    const sectionKeys = { songs: 'tracks.song', albums: 'tracklists.album', videos: 'tracks.video' };
    output.tracks = {};
    output.tracklists = {};
    if (result.songs.length > 0) output.tracks.song = result.songs;
    if (result.albums.length > 0) output.tracklists.album = result.albums;
    if (result.videos.length > 0) output.tracks.video = result.videos;
    output.sectionOrder = result.sectionOrder.map(key => sectionKeys[key]);
    return output;
  },
}));
